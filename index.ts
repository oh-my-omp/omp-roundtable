import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {getAgentDir,logger,z,type ExtensionAPI,type ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import {register} from '@oh-my-pi/pi-coding-agent/config/registry';
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {launcherCommand} from './src/launcher/commands.ts';
import {buildPublicGrammar} from './src/domain/public-grammar.ts';
import {parseToolParameters} from './src/domain/parse.ts';
import type {Caller,ParseError,Policy,PortError,Result} from './src/domain/model.ts';
import {createAgendaFiles} from './src/ports/state.ts';
import {createGitHubPort} from './src/ports/github.ts';
import {createHostPort} from './src/ports/host.ts';
import {coordinatorBriefing,parseCoordinatorFlag,type CoordinatorIdentity} from './src/runtime/coordinator.ts';
import {RoundtableController,type ControllerOutput,type RuntimeError} from './src/runtime/controller.ts';

const SLOT=Symbol.for('omp-roundtable.runtime.v3');
type SessionBinding={pi:ExtensionAPI;ctx:ExtensionContext;caller:Caller;activation:Promise<void>};
type ToolResponse=Result<ControllerOutput,RuntimeError|{kind:'parse';error:ParseError}>;
/** Read once per process: `absent` stays inert, `invalid` reports once, `coordinator` is the fixed role. */
type Identity={kind:'absent'}|{kind:'invalid';message:string}|({kind:'coordinator'}&CoordinatorIdentity);

function requireText(value:unknown):void {if(value===undefined)return;if(typeof value!=='string'||value.trim().length===0)throw new Error('Roundtable setting must be a nonempty string');}
function requireInterval(value:unknown):void {if(value===undefined)return;if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>2_147_483)throw new Error('Roundtable recompute interval must be a positive safe whole number of seconds within the native timer range');}
function errorText(error:RuntimeError):string {return JSON.stringify(error);}

/** Native reevaluates module graphs per seat; this object lives in the process slot. */
class ProcessRuntime {
  private readonly interval=register({id:'roundtable.recomputeIntervalSeconds',type:'number',default:120,env:'OMP_ROUNDTABLE_RECOMPUTE_SECONDS',validate:requireInterval});
  private readonly directory=register({id:'roundtable.dataDir',type:'string',default:join(getAgentDir(),'omp-roundtable'),env:'OMP_ROUNDTABLE_DIR',validate:requireText});
  private readonly owner=register({id:'roundtable.ownerAgent',type:'string',default:'task:high',env:'OMP_ROUNDTABLE_OWNER_AGENT',validate:requireText});
  private readonly gate=register({id:'roundtable.gateAgent',type:'string',default:'task:mid',env:'OMP_ROUNDTABLE_GATE_AGENT',validate:requireText});
  private readonly bindings=new Map<ExtensionContext['sessionManager'],SessionBinding>();
  private readonly reminded=new Set<string>();
  private readonly host=createHostPort(id=>this.controller?.request(id));
  private unsubscribe:(()=>void)|null=null;
  private identity:Identity|null=null;
  private controller:RoundtableController|null=null;
  private mainPrompt:readonly string[]|null=null;
  private notification:Promise<void>=Promise.resolve();
  private lastError:string|null=null;
  private started=false;
  private closed=false;

  /**
   * Flags are resolved after extensions load, so the launch identity is read on
   * first use and then fixed for the process.
   */
  readIdentity(pi:ExtensionAPI):Identity {
    if(this.identity)return this.identity;
    const raw=pi.getFlag('roundtable');
    if(raw===undefined)return this.identity={kind:'absent'};
    const parsed=parseCoordinatorFlag(raw);
    return this.identity=parsed.ok?{kind:'coordinator',issue:parsed.value.issue,reference:parsed.value.reference}:{kind:'invalid',message:parsed.error};
  }
  bind(pi:ExtensionAPI,ctx:ExtensionContext):Result<SessionBinding,PortError> {
    if(this.closed)return {ok:false,error:{kind:'precondition',message:'Roundtable runtime has shut down; start a new OMP process'}};
    const identity=this.readIdentity(pi);
    if(identity.kind==='absent')return {ok:false,error:{kind:'precondition',message:'This OMP process was not started as a Roundtable coordinator; there is no in-session way to enter Roundtable'}};
    if(identity.kind==='invalid')return {ok:false,error:{kind:'precondition',message:identity.message}};
    if(!this.controller){
      if(ctx.agent.id!==MAIN_AGENT_ID||ctx.agent.kind!=='main')return {ok:false,error:{kind:'precondition',message:'Main must initialize Roundtable before child sessions'}};
      const session=AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
      if(!session||session.sessionManager!==ctx.sessionManager)return {ok:false,error:{kind:'precondition',message:'Main settings do not belong to the current native session'}};
      this.mainPrompt=ctx.getSystemPrompt();
      this.unsubscribe=AgentRegistry.global().onChange(()=>this.controller?.registryChanged());
      this.controller=new RoundtableController({
        files:createAgendaFiles(resolve(ctx.cwd,this.directory.get(session.settings))),github:createGitHubPort(),host:this.host,
        policy:()=>this.readPolicy(),intervalSeconds:this.interval.get(session.settings),
        onChange:()=>this.changed(),onError:error=>this.report(error),
      });
    }
    const caller=this.host.bind(ctx,this.controller.runId);if(!caller.ok)return caller;
    if(caller.value.kind==='main')this.controller.setMain(caller.value);
    const prior=this.bindings.get(ctx.sessionManager);
    const binding:SessionBinding={pi,ctx,caller:caller.value,activation:prior?.activation??Promise.resolve()};
    this.bindings.set(ctx.sessionManager,binding);return {ok:true,value:binding};
  }
  capture(ctx:ExtensionContext,prompt:readonly string[]):void {if(ctx.agent.id===MAIN_AGENT_ID&&ctx.agent.kind==='main')this.mainPrompt=[...prompt];}
  private async readPolicy():Promise<Result<Policy,PortError>> {
    const session=AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
    if(!session||!this.mainPrompt?.length)return {ok:false,error:{kind:'unavailable',message:'The actual Main system policy is not available'}};
    let text=this.mainPrompt.join('\n\n');
    try {
      const appendix=await readFile(join(getAgentDir(),'APPEND_SYSTEM.md'),'utf8');
      if(appendix.length&&!text.includes(appendix))text+=`\n\n${appendix}`;
    }catch(error){
      if(!(typeof error==='object'&&error!==null&&'code'in error&&error.code==='ENOENT'))return {ok:false,error:{kind:'unavailable',message:`Cannot read Main APPEND_SYSTEM.md: ${error instanceof Error?error.message:'filesystem failure'}`}};
    }
    return {ok:true,value:{text,ownerAgent:this.owner.get(session.settings),gateAgent:this.gate.get(session.settings)}};
  }
  private report(error:RuntimeError):void {
    const text=errorText(error);logger.error('Roundtable runtime error',{error:text});
    const main=[...this.bindings.values()].find(binding=>binding.caller.kind==='main');
    if(main&&text!==this.lastError){this.lastError=text;main.ctx.ui.notify(`Roundtable: ${text}`,'error');main.pi.sendMessage({customType:'roundtable-error',content:text,display:true},{triggerTurn:false});}
  }
  private failed(error:unknown):void {this.report({kind:'host',error:{kind:'unavailable',message:error instanceof Error?error.message:'Unexpected native extension failure'}});}
  async activate(binding:SessionBinding):Promise<void> {
    const refresh=async()=>{
      const tools=binding.pi.getActiveTools();const visible=this.controller?.visible(binding.caller)??false;
      const present=tools.includes('roundtable');if(present===visible)return;
      await binding.pi.setActiveTools(visible?[...tools,'roundtable']:tools.filter(name=>name!=='roundtable'));
    };
    binding.activation=binding.activation.then(refresh,refresh);await binding.activation;
  }
  private changed():void {
    this.notification=this.notification.then(async()=>{
      for(const binding of this.bindings.values())await this.activate(binding);
      const main=[...this.bindings.values()].find(binding=>binding.caller.kind==='main');
      if(!main||!this.controller)return;
      const result=await this.controller.context(main.caller);if(!result.ok){this.report(result.error);return;}
      if(!result.value)return;
      const newTickets=result.value.tickets.filter(ticket=>ticket.runDisposition==='mustRun'&&!this.reminded.has(`${this.controller!.runId}:${ticket.id}:${ticket.revision}`));
      if(!newTickets.length)return;
      for(const ticket of newTickets)this.reminded.add(`${this.controller.runId}:${ticket.id}:${ticket.revision}`);
      const content='Roundtable requested Main attention. Call roundtable tickets and act only on the current injected tickets; this queued reminder does not establish that an earlier ticket is still actionable. Relay text is not a protocol response.';
      main.pi.sendMessage({customType:'roundtable-attention',content,display:true},{triggerTurn:true,deliverAs:'nextTurn'});
    }).catch(error=>this.failed(error));
  }
  /**
   * The coordinator's first turn. The briefing is the only thing that tells
   * Main what to do, and it is built from the launch reference plus the
   * startup check of already saved agendas.
   */
  async start(binding:SessionBinding,identity:CoordinatorIdentity):Promise<void> {
    if(this.started||!this.controller)return;
    this.started=true;
    const checked=await this.controller.startup(binding.caller);
    if(!checked.ok)this.report(checked.error);
    const agenda=checked.ok?(checked.value.active.length?`active: ${checked.value.active.join(', ')}`:'no saved active agenda'):`the startup check failed with ${errorText(checked.error)}`;
    // nextTurn delivery keeps the briefing out of the editable pending queue and
    // queues it behind an in-flight start (a programmatic `-p` prompt) instead of
    // throwing AgentBusyError at it; an idle Main still gets a triggering turn.
    binding.pi.sendMessage({customType:'roundtable-start',content:coordinatorBriefing({reference:identity.reference,agenda}),display:true},{triggerTurn:true,deliverAs:'nextTurn'});
  }
  async execute(binding:SessionBinding,params:unknown):Promise<ToolResponse> {
    const parsed=parseToolParameters(params);
    if(!parsed.ok)return {ok:false,error:{kind:'parse',error:parsed.error}};
    if(!this.controller)return {ok:false,error:{kind:'domain',error:{kind:'roundtableInactive',message:'This OMP process was not started as a Roundtable coordinator',current:null}}};
    return this.controller.execute(binding.caller,parsed.value.input,binding.ctx.cwd);
  }
  visible(binding:SessionBinding):boolean {return this.controller?.visible(binding.caller)??false;}
  async context(binding:SessionBinding):Promise<string|null> {
    if(!this.controller)return null;
    const result=await this.controller.context(binding.caller);
    if(!result.ok)return `Roundtable operation is blocked by an actual runtime error: ${errorText(result.error)}`;
    const view=result.value;if(!view)return null;
    return `Roundtable ${view.agenda}, version ${view.version}, ${view.lifecycle}. Source error: ${JSON.stringify(view.sourceError)}.\n\n${view.tickets.map(ticket=>ticket.brief).join('\n\n')}\n\nCurrent applying/waiting effects and cases, external merge notices, and report:\n${JSON.stringify({cases:view.cases,effects:view.effects,externalMerges:view.externalMerges,report:view.report})}`;
  }
  async yieldBlock(binding:SessionBinding):Promise<string|null> {
    if(binding.caller.kind!=='sub'||!this.controller||!this.visible(binding))return null;
    const result=await this.controller.context(binding.caller);if(!result.ok)return `Roundtable cannot establish the current work: ${errorText(result.error)}`;
    const mustRun=result.value?.tickets.filter(ticket=>ticket.runDisposition==='mustRun')??[];
    return mustRun.length?`An ordinary yield is not a protocol completion. Submit the required reply or open your own claim before yielding.\n${mustRun.map(ticket=>ticket.brief).join('\n\n')}`:null;
  }
  async end(binding:SessionBinding):Promise<void> {
    this.controller?.noteTurnEnd(binding.caller);
    if(binding.caller.kind!=='main'||!this.controller)return;
    const result=await this.controller.context(binding.caller);
    if(result.ok&&result.value?.tickets.some(ticket=>ticket.attentionRequired))binding.ctx.ui.notify('Roundtable still has unanswered Main tickets; they remain open and visible through roundtable tickets','warning');
  }
  release(ctx:ExtensionContext):void {
    const binding=this.bindings.get(ctx.sessionManager);
    this.host.release(ctx);this.bindings.delete(ctx.sessionManager);
    if(binding?.caller.kind==='main'){
      this.closed=true;this.unsubscribe?.();this.unsubscribe=null;this.controller?.shutdown();
    }
  }
}

// The cast only declares a process-owned symbol slot. No domain/source payload is
// cast or reconstructed across graphs, and constructor identity is never tested.
const processSlots=globalThis as typeof globalThis&{[SLOT]?:ProcessRuntime};

export default function roundtable(pi:ExtensionAPI):void {
  const runtime=processSlots[SLOT]??(processSlots[SLOT]=new ProcessRuntime());
  const grammar=buildPublicGrammar(z);
  const identity=()=>runtime.readIdentity(pi);
  const bind=(ctx:ExtensionContext)=>runtime.bind(pi,ctx);
  pi.registerFlag('roundtable',{description:'Start this Main as the Roundtable coordinator for <owner>/<repo>#<number>; the identity holds for the whole process',type:'string'});
  pi.registerTool({
    name:'roundtable',label:'Roundtable',description:'Operate the current Roundtable delivery protocol. Active only in a process launched for a Roundtable issue, for its Main and its exact current seats. Use tickets before replying; terminal receipts are durable, not relay acknowledgements.',
    parameters:grammar.toolParametersSchema,defaultInactive:true,
    async execute(_toolCallId,params,_signal,_onUpdate,ctx){
      const binding=bind(ctx);
      const response:ToolResponse=binding.ok?await runtime.execute(binding.value,params):{ok:false,error:{kind:'host',error:binding.error}};
      return {content:[{type:'text',text:JSON.stringify(response)}],details:response};
    },
  });
  pi.registerCommand('roundtable-launcher',{description:'Install, uninstall, or inspect the local Roundtable link launcher (install|uninstall|status)',async handler(args,ctx){const result=await launcherCommand(args.trim().split(/\s+/).filter(part=>part.length>0));ctx.ui.notify(result.ok?result.value:result.error,result.ok?'info':'error');}});
  pi.on('session_start',async(_event,ctx)=>{
    const current=identity();
    if(current.kind==='absent')return;
    if(current.kind==='invalid'){ctx.ui.notify(current.message,'error');return;}
    const binding=bind(ctx);
    if(!binding.ok){ctx.ui.notify(binding.error.message,'error');return;}
    await runtime.activate(binding.value);
    if(binding.value.caller.kind==='main')await runtime.start(binding.value,current);
  });
  pi.on('before_agent_start',async(event,ctx)=>{
    if(identity().kind!=='coordinator')return;
    runtime.capture(ctx,event.systemPrompt);const binding=bind(ctx);if(binding.ok)await runtime.activate(binding.value);
  });
  pi.on('context',async(event,ctx)=>{
    if(identity().kind!=='coordinator')return;
    const binding=bind(ctx);if(!binding.ok)return;
    const content=await runtime.context(binding.value);if(content===null)return;
    return {messages:[...event.messages.filter(message=>!(message.role==='custom'&&message.customType==='roundtable-current')),{role:'custom',customType:'roundtable-current',content,display:false,attribution:'agent',timestamp:Date.now()}]};
  });
  pi.on('tool_call',async(event,ctx)=>{
    if(identity().kind!=='coordinator')return;
    if(event.toolName!=='roundtable'&&event.toolName!=='yield')return;
    const binding=bind(ctx);
    if(event.toolName==='roundtable'&&(!binding.ok||!runtime.visible(binding.value)))return {block:true,reason:'Roundtable is not active for this exact native session/request/holder'};
    if(event.toolName==='yield'&&binding.ok){const reason=await runtime.yieldBlock(binding.value);if(reason)return {block:true,reason};}
  });
  pi.on('agent_end',async(_event,ctx)=>{
    if(identity().kind!=='coordinator')return;
    const binding=bind(ctx);if(binding.ok)await runtime.end(binding.value);
  });
  pi.on('session_shutdown',(_event,ctx)=>{
    if(identity().kind!=='coordinator')return;
    runtime.release(ctx);
  });
}
