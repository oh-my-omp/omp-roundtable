import {join,resolve} from 'node:path';
import {getAgentDir,logger,z,type ExtensionAPI,type ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import {register} from '@oh-my-pi/pi-coding-agent/config/registry';
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {launcherCommand} from './src/launcher/commands.ts';
import {buildPublicGrammar} from './src/domain/public-grammar.ts';
import {parseToolParameters} from './src/domain/parse.ts';
import {Attention} from './src/runtime/attention.ts';
import {createAgendaFiles} from './src/ports/state.ts';
import {createGitHubPort} from './src/ports/github.ts';
import {createHostPort} from './src/ports/host.ts';
import {loadWorkflow} from './src/ports/workflow.ts';
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
  private readonly workflowFile=register({id:'roundtable.workflowFile',type:'string',default:undefined,env:'OMP_ROUNDTABLE_WORKFLOW',validate:requireText});
  private identity:Identity|null=null;
  private binding:{pi:ExtensionAPI;ctx:ExtensionContext}|null=null;
  private controller:RoundtableController|null=null;
  private host:HostPort|null=null;
  private readonly attention=new Attention();
  private started=false;
  private deferred=false;
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
  /**
   * Main wakes only for a decision still open when its turn ends: a launchable ticket, an Escalated ticket or
   * closure, or a finished agenda. While Main is busy it sees the agenda through its own calls, so a decision it
   * settles within the same turn (launching what convene unlocked, resolving an escalation) never wakes it again.
   */
  private changed(turnEnded=false):void {
    const agenda=this.controller?.snapshot(),binding=this.binding,host=this.host;
    if(!agenda||!binding||!host)return;
    if(!turnEnded&&!binding.ctx.isIdle()){this.deferred=true;return;}
    this.deferred=false;
    const fresh=this.attention.observe(agenda,(ticketId,role)=>host.active(ticketId,role));
    if(!fresh.length)return;
    binding.pi.sendMessage({customType:'roundtable-attention',display:true,content:`Roundtable needs Main: ${fresh.join(', ')}. launch:<ticket> may be put on the table; escalated:<ticket>:<revision> awaits read and resolve; finish means every ticket and the closure are Done. Call roundtable status for the source-confirmed agenda; this notification is not a ticket snapshot.`},{triggerTurn:true,deliverAs:'nextTurn'});
  }
  mainTurnEnded(ctx:ExtensionContext):void {
    if(this.deferred&&this.binding?.ctx.sessionManager===ctx.sessionManager)this.changed(true);
  }
  async start(pi:ExtensionAPI,ctx:ExtensionContext,identity:CoordinatorIdentity):Promise<void> {
    if(this.started)return;
    const root=AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
    if(ctx.agent.id!==MAIN_AGENT_ID||ctx.agent.kind!=='main'||!root||root.sessionManager!==ctx.sessionManager)throw new Error('Roundtable requires the actual native Main');
    this.started=true;this.binding={pi,ctx};
    const directory=resolve(ctx.cwd,this.directory.get(root.settings));
    this.host=createHostPort({dataDir:directory,
      ticketRevision:ticketId=>this.controller?.ticketRevision(ticketId)??null,
      execute:async(caller,input)=>{
        if(!this.controller)return {ok:false,error:{kind:'domain',error:{kind:'ownershipBlocked',message:'Coordinator has not started'}}};
        return this.controller.execute(caller,input);
      },
      onExit:(seat,handedOff,error)=>{
        if(handedOff&&error)this.report({kind:'host',error:{kind:'unavailable',message:`Ticket ${seat.ticketId} ${seat.role} seat cleanup: ${error}`}});
        this.controller?.seatExited(seat,handedOff,error);
        this.changed();
      },
      onSeatError:(ticketId,message)=>this.report({kind:'host',error:{kind:'unavailable',message:`Ticket ${ticketId} seat: ${message}`}}),
    });
    this.controller=new RoundtableController({files:createAgendaFiles(directory),github:createGitHubPort(),host:this.host,cwd:ctx.cwd,
      // Read at each convene: a configured file must exist; otherwise the data directory may override the built-in workflow.
      workflow:()=>{const file=this.workflowFile.get(root.settings);return loadWorkflow(file===undefined?{kind:'dataDir',path:join(directory,'workflow.yml')}:{kind:'configured',path:resolve(ctx.cwd,file)});},
      intervalSeconds:this.interval.get(root.settings),onChange:()=>this.changed(),onError:error=>this.report(error)});
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
    const result=await this.controller.execute(caller.value,parsed.value.input);
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
  pi.registerTool({name:'roundtable',label:'Roundtable',description:'Main coordinates a durable ticket graph and launches each ticket once; the roundtable then relays its seats until Done or Escalated. Seats read one ticket and hand off with submit/verdict/escalate. GitHub writes are performed and freshly confirmed by the state machine.',parameters:buildPublicGrammar(z).toolParametersSchema,defaultInactive:true,
    async execute(_id,params,_signal,_update,ctx){const response=await runtime.execute(ctx,params);return {content:[{type:'text',text:JSON.stringify(response)}],details:response,isError:!response.ok};},
  });
  pi.registerCommand('roundtable-launcher',{description:'Install, uninstall, or inspect the local Roundtable link launcher (install|uninstall|status)',async handler(args,ctx){const result=await launcherCommand(args.trim().split(/\s+/).filter(part=>part.length>0));ctx.ui.notify(result.ok?result.value:result.error,result.ok?'info':'error');}});
  pi.on('session_start',async(_event,ctx)=>{
    const identity=runtime.readIdentity(pi);
    if(identity.kind==='absent')return;
    if(identity.kind==='invalid'){ctx.ui.notify(identity.message,'error');return;}
    if(ctx.agent.id===MAIN_AGENT_ID&&ctx.agent.kind==='main')await runtime.start(pi,ctx,identity);
  });
  pi.on('agent_end',(_event,ctx)=>runtime.mainTurnEnded(ctx));
  pi.on('session_shutdown',async(_event,ctx)=>runtime.shutdown(ctx));
}
