import {join,resolve} from 'node:path';
import {getAgentDir,logger,z,type ExtensionAPI,type ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import {register} from '@oh-my-pi/pi-coding-agent/config/registry';
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {launcherCommand} from './src/launcher/commands.ts';
import {buildPublicGrammar} from './src/domain/public-grammar.ts';
import {parseToolParameters} from './src/domain/parse.ts';
import {canonical} from './src/domain/identity.ts';
import {availableRoles} from './src/domain/engine.ts';
import {createAgendaFiles} from './src/ports/state.ts';
import {createGitHubPort} from './src/ports/github.ts';
import {createHostPort} from './src/ports/host.ts';
import type {HostPort} from './src/ports/contracts.ts';
import {coordinatorBriefing,parseCoordinatorFlag,type CoordinatorIdentity} from './src/runtime/coordinator.ts';
import {RoundtableController,type RuntimeError} from './src/runtime/controller.ts';

const SLOT=Symbol.for('omp-roundtable.runtime.v4');
type Identity={kind:'absent'}|{kind:'invalid';message:string}|({kind:'coordinator'}&CoordinatorIdentity);
function requireText(value:unknown):void {if(value!==undefined&&(typeof value!=='string'||!value.trim()))throw new Error('Roundtable setting must be a nonempty string');}
function requireInterval(value:unknown):void {if(value!==undefined&&(typeof value!=='number'||!Number.isSafeInteger(value)||value<1||value>2_147_483))throw new Error('Roundtable recompute interval must be positive whole seconds within the native timer range');}

/** Main is one native session for the whole process; seats own their own SDK lifetimes. */
class ProcessRuntime {
  private readonly interval=register({id:'roundtable.recomputeIntervalSeconds',type:'number',default:120,env:'OMP_ROUNDTABLE_RECOMPUTE_SECONDS',validate:requireInterval});
  private readonly directory=register({id:'roundtable.dataDir',type:'string',default:join(getAgentDir(),'omp-roundtable'),env:'OMP_ROUNDTABLE_DIR',validate:requireText});
  private readonly owner=register({id:'roundtable.ownerAgent',type:'string',default:'task:high',env:'OMP_ROUNDTABLE_OWNER_AGENT',validate:requireText});
  private readonly gate=register({id:'roundtable.gateAgent',type:'string',default:'task:mid',env:'OMP_ROUNDTABLE_GATE_AGENT',validate:requireText});
  private identity:Identity|null=null;
  private binding:{pi:ExtensionAPI;ctx:ExtensionContext}|null=null;
  private controller:RoundtableController|null=null;
  private host:HostPort|null=null;
  private notified:string|null=null;
  private started=false;
  readIdentity(pi:ExtensionAPI):Identity {
    if(this.identity)return this.identity;
    const flag=pi.getFlag('roundtable');
    if(flag===undefined)return this.identity={kind:'absent'};
    const parsed=parseCoordinatorFlag(flag);
    return this.identity=parsed.ok?{kind:'coordinator',...parsed.value}:{kind:'invalid',message:parsed.error};
  }
  private report(error:RuntimeError):void {
    logger.error('Roundtable runtime error',{error:JSON.stringify(error)});
    this.binding?.ctx.ui.notify(`Roundtable: ${JSON.stringify(error)}`,'error');
  }
  private changed():void {
    const agenda=this.controller?.snapshot(),binding=this.binding;
    if(!agenda||!binding)return;
    const available=agenda.tickets.map(ticket=>({id:ticket.id,revision:ticket.revision,state:ticket.state,roles:availableRoles(agenda,ticket).filter(role=>!this.host?.active(ticket.id,role))}));
    const signature=canonical({tickets:available,closure:agenda.closure?.state,closureRevision:agenda.closure?.revision,lifecycle:agenda.lifecycle});
    if(signature===this.notified)return;
    this.notified=signature;
    if(agenda.lifecycle==='completed')return;
    binding.pi.sendMessage({customType:'roundtable-attention',display:true,content:'Roundtable ticket availability or escalation changed. Call roundtable status for the current source-confirmed tickets, launch ready seats according to your topology, and resolve Escalated tickets. This notification is not a ticket snapshot.'},{triggerTurn:true,deliverAs:'nextTurn'});
  }
  async start(pi:ExtensionAPI,ctx:ExtensionContext,identity:CoordinatorIdentity):Promise<void> {
    if(this.started)return;
    const root=AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
    if(ctx.agent.id!==MAIN_AGENT_ID||ctx.agent.kind!=='main'||!root||root.sessionManager!==ctx.sessionManager)throw new Error('Roundtable requires the actual native Main');
    this.started=true;this.binding={pi,ctx};
    const directory=resolve(ctx.cwd,this.directory.get(root.settings));
    this.host=createHostPort({sessionDir:join(directory,'sessions'),
      ticketRevision:ticketId=>this.controller?.ticketRevision(ticketId)??null,
      execute:async(caller,input,cwd)=>{
        if(!this.controller)return {ok:false,error:{kind:'domain',error:{kind:'ownershipBlocked',message:'Coordinator has not started'}}};
        return this.controller.execute(caller,input,cwd);
      },
      onExit:(ticketId,handedOff,error)=>{
        if(error||!handedOff)pi.sendMessage({customType:'roundtable-seat-exit',display:true,content:`Ticket ${ticketId} seat exited ${handedOff?'after handoff':'without a handoff'}${error?`: ${error}`:''}. Inspect roundtable status before deciding the next action.`},{triggerTurn:true,deliverAs:'nextTurn'});
        this.changed();
      },
    });
    this.controller=new RoundtableController({files:createAgendaFiles(directory),github:createGitHubPort(),host:this.host,ownerAgent:this.owner.get(root.settings),gateAgent:this.gate.get(root.settings),intervalSeconds:this.interval.get(root.settings),onChange:()=>this.changed(),onError:error=>this.report(error)});
    const caller=this.host.bind(ctx);if(!caller.ok||caller.value.kind!=='main')throw new Error('Cannot bind Main to the coordinator');
    this.controller.setMain(caller.value);
    await pi.setActiveTools([...new Set([...pi.getActiveTools(),'roundtable'])]);
    const saved=await this.controller.startup(caller.value);
    if(!saved.ok)this.report(saved.error);
    const agenda=saved.ok&&'active' in saved.value?(saved.value.active.length?`active: ${saved.value.active.join(', ')}`:'no saved active agenda'):JSON.stringify(saved);
    pi.sendMessage({customType:'roundtable-start',display:true,content:coordinatorBriefing({reference:identity.reference,agenda})},{triggerTurn:true,deliverAs:'nextTurn'});
  }
  async execute(ctx:ExtensionContext,params:unknown) {
    const parsed=parseToolParameters(params);
    if(!parsed.ok)return {ok:false,error:{kind:'parse',error:parsed.error}};
    if(!this.host||!this.controller)return {ok:false,error:{kind:'inactive',message:'This process is not a Roundtable coordinator'}};
    const caller=this.host.bind(ctx);
    if(!caller.ok)return {ok:false,error:{kind:'host',error:caller.error}};
    const result=await this.controller.execute(caller.value,parsed.value.input,ctx.cwd);
    this.changed();return result;
  }
  async shutdown(ctx:ExtensionContext):Promise<void> {
    if(this.binding?.ctx.sessionManager===ctx.sessionManager)await this.controller?.shutdown();
  }
}
const slots=globalThis as typeof globalThis&{[SLOT]?:ProcessRuntime};

export default function roundtable(pi:ExtensionAPI):void {
  const runtime=slots[SLOT]??(slots[SLOT]=new ProcessRuntime());
  pi.registerFlag('roundtable',{description:'Start Main as coordinator for <owner>/<repo>#<number>',type:'string'});
  pi.registerTool({name:'roundtable',label:'Roundtable',description:'Main coordinates a durable ticket graph; launch chooses one one-shot seat. Seats read one ticket and hand off with submit/verdict/escalate. GitHub writes are performed and freshly confirmed by the state machine.',parameters:buildPublicGrammar(z).toolParametersSchema,defaultInactive:true,
    async execute(_id,params,_signal,_update,ctx){const response=await runtime.execute(ctx,params);return {content:[{type:'text',text:JSON.stringify(response)}],details:response,isError:!response.ok};},
  });
  pi.registerCommand('roundtable-launcher',{description:'Install, uninstall, or inspect the local Roundtable link launcher (install|uninstall|status)',async handler(args,ctx){const result=await launcherCommand(args.trim().split(/\s+/).filter(part=>part.length>0));ctx.ui.notify(result.ok?result.value:result.error,result.ok?'info':'error');}});
  pi.on('session_start',async(_event,ctx)=>{
    const identity=runtime.readIdentity(pi);
    if(identity.kind==='absent')return;
    if(identity.kind==='invalid'){ctx.ui.notify(identity.message,'error');return;}
    if(ctx.agent.id===MAIN_AGENT_ID&&ctx.agent.kind==='main')await runtime.start(pi,ctx,identity);
  });
  pi.on('session_shutdown',async(_event,ctx)=>runtime.shutdown(ctx));
}
