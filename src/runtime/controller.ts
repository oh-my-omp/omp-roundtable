import {randomUUID} from 'node:crypto';
import type {Agenda,Caller,DomainError,Effect,EffectResult,Facts,PortError,PortInput,Result,Role} from '../domain/model.ts';
import {applyOperation,availableRoles,confirmEffect,createAgenda,effectPrecondition,failEffect,reconcile,satisfiedResult} from '../domain/engine.ts';
import {canonical,sameRef} from '../domain/identity.ts';
import {seatBrief} from '../domain/briefs.ts';
import type {AgendaFiles,GitHubPort,HostPort,StateError} from '../ports/contracts.ts';
import {createSourceReader,type SourceReceipt} from './source.ts';

export type RuntimeError={kind:'domain';error:DomainError}|{kind:'storage';error:StateError}|{kind:'source'|'host';error:PortError};
export type AgendaView={agenda:Agenda;available:{ticketId:string;revision:number;roles:Role[]}[]};
export type ControllerOutput=AgendaView|{active:string[]}|{ticket:Agenda['tickets'][number]|NonNullable<Agenda['closure']>}|{launched:{agentId:string;sessionFile:string;jobId:string}};
export type ControllerOptions={files:AgendaFiles;github:GitHubPort;host:HostPort;ownerAgent:string;gateAgent:string;intervalSeconds:number;onChange:()=>void;onError:(error:RuntimeError)=>void};
function domain(kind:DomainError['kind'],message:string):{ok:false;error:RuntimeError}{return {ok:false,error:{kind:'domain',error:{kind,message}}};}

/** The controller is the sole writer of its agenda. GitHub observations are never optimistic writes. */
export class RoundtableController {
  readonly runId=randomUUID();
  private readonly source;
  private state:Agenda|null=null;
  private main:Extract<Caller,{kind:'main'}>|null=null;
  private tail:Promise<void>=Promise.resolve();
  private pending:{expected:number|null;state:Agenda}|null=null;
  private timer:ReturnType<typeof setInterval>|null=null;
  private scheduled:ReturnType<typeof setTimeout>|null=null;
  private closed=false;
  constructor(private readonly options:ControllerOptions){this.source=createSourceReader(options.github);}
  setMain(caller:Extract<Caller,{kind:'main'}>):void {
    if(this.main&&this.main.sessionId!==caller.sessionId)throw new Error('The coordinator session cannot change within a run');
    this.main=caller;
  }
  /** The agenda owns ticket revisions; the host uses this only to end superseded seat lifetimes. */
  ticketRevision(ticketId:string):number|null {
    if(this.state?.lifecycle!=='active')return null;
    return this.state.tickets.find(ticket=>ticket.id===ticketId)?.revision??(this.state.closure?.id===ticketId?this.state.closure.revision:null);
  }
  visible(caller:Caller):boolean {
    if(this.closed||!this.main)return false;
    if(caller.kind==='main')return caller.agentId===this.main.agentId&&caller.sessionId===this.main.sessionId;
    return this.state?.lifecycle==='active'&&(this.state.tickets.some(ticket=>ticket.id===caller.ticketId)||this.state.closure?.id===caller.ticketId);
  }
  private serial<T>(work:()=>Promise<T>):Promise<T>{const result=this.tail.then(work);this.tail=result.then(()=>{},()=>{});return result;}
  private async flush():Promise<Result<null,RuntimeError>> {
    if(!this.pending)return {ok:true,value:null};
    const result=await this.options.files.save(this.pending.expected,this.pending.state);
    if(!result.ok)return {ok:false,error:{kind:'storage',error:result.error}};
    this.state=this.pending.state;this.pending=null;this.options.onChange();
    if(this.state.lifecycle==='active'&&!this.timer){
      this.timer=setInterval(()=>{void this.run().catch(error=>this.unexpected(error));},this.options.intervalSeconds*1000);this.timer.unref();
    }
    if(this.state.lifecycle==='completed'){clearInterval(this.timer??undefined);this.timer=null;}
    return {ok:true,value:null};
  }
  private async save(state:Agenda,expected:number|null):Promise<Result<null,RuntimeError>> {
    if(this.pending)throw new Error('Unresolved durable write must be flushed before a new transition');
    this.pending={state,expected};return this.flush();
  }
  private view():Result<ControllerOutput,RuntimeError> {
    if(!this.state)return domain('notFound','No agenda is attached');
    return {ok:true,value:{agenda:structuredClone(this.state),available:[
      ...this.state.tickets.map(ticket=>({ticketId:ticket.id,revision:ticket.revision,roles:availableRoles(this.state!,ticket).filter(role=>!this.options.host.active(ticket.id,role))})),
      ...(this.state.closure?[{ticketId:this.state.closure.id,revision:this.state.closure.revision,roles:this.state.closure.state==='Reviewing'&&this.state.closure.gate.status==='pending'&&!this.options.host.active(this.state.closure.id,'closure')?['closure' as const]:[]}]:[]),
    ]}};
  }
  async startup(caller:Caller):Promise<Result<ControllerOutput,RuntimeError>> {
    if(caller.kind!=='main'||!this.visible(caller))return domain('unauthorized','Only the native coordinator may inspect saved agendas');
    const list=await this.options.files.list();if(!list.ok)return {ok:false,error:{kind:'storage',error:list.error}};
    return {ok:true,value:{active:list.value.filter(state=>state.lifecycle==='active').map(state=>state.id)}};
  }
  async execute(caller:Caller,operation:PortInput,cwd:string):Promise<Result<ControllerOutput,RuntimeError>> {
    return this.serial(async()=>{
      const flushed=await this.flush();if(!flushed.ok)return flushed;
      if(!this.visible(caller))return domain('unauthorized','Caller is not a native session of this coordinator');
      if(operation.op==='convene'||operation.op==='resume'){
        if(caller.kind!=='main')return domain('unauthorized','Only Main may attach an agenda');
        if(this.state?.lifecycle==='active')return domain('ownershipBlocked','A live agenda is already attached');
        const list=await this.options.files.list();if(!list.ok)return {ok:false,error:{kind:'storage',error:list.error}};
        const active=list.value.filter(state=>state.lifecycle==='active');
        if(operation.op==='convene'){
          if(active.length)return domain('ownershipBlocked','Resume the saved active agenda instead of creating a second owner');
          const facts=await this.source.read(null,operation,'convene');if(!facts.ok)return {ok:false,error:{kind:'source',error:facts.error}};
          const created=createAgenda(operation,facts.value,Date.now(),randomUUID());if(!created.ok)return {ok:false,error:{kind:'domain',error:created.error}};
          created.value.run={kind:'attached',id:this.runId,mainAgentId:caller.agentId,mainSessionId:caller.sessionId};
          const saved=await this.save(created.value,null);if(!saved.ok)return saved;
        }else{
          if(active.length!==1||active[0]?.id!==operation.agenda)return domain('ownershipBlocked','Exactly one matching saved active agenda is required');
          const saved=await this.options.files.load(operation.agenda);if(!saved.ok)return {ok:false,error:{kind:'storage',error:saved.error}};
          const next=saved.value;next.version++;next.run={kind:'attached',id:this.runId,mainAgentId:caller.agentId,mainSessionId:caller.sessionId};
          // A durable executing intent after a restart is never called again.
          for(const effect of next.effects)if(effect.state.kind==='executing')failEffect(next,effect,{kind:'uncertainOutcome',message:'Previous process ended after executing intent; source reconciliation required'},true,Date.now());
          const committed=await this.save(next,saved.value.version-1);if(!committed.ok)return committed;
        }
        this.kick();return this.view();
      }
      if(!this.state)return domain('notFound','Convene or resume an agenda first');
      if(operation.op==='read'){
        if(caller.kind==='seat'&&caller.ticketId!==operation.ticketId)return domain('unauthorized','A seat can read only its bound ticket');
        const ticket=this.state.tickets.find(ticket=>ticket.id===operation.ticketId)??(this.state.closure?.id===operation.ticketId?this.state.closure:null);
        return ticket?{ok:true,value:{ticket:structuredClone(ticket)}}:domain('notFound','Unknown ticket');
      }
      if(operation.op==='status'||operation.op==='tickets'){
        if(caller.kind!=='main')return domain('unauthorized','A seat reads its one ticket with read');
        return this.view();
      }
      const fresh=await this.source.read(this.state,operation,operation.op);if(!fresh.ok)return {ok:false,error:{kind:'source',error:fresh.error}};
      const settled=await this.settle(fresh.value);if(!settled.ok)return settled;
      if(operation.op==='launch'){
        if(caller.kind!=='main')return domain('unauthorized','Only Main chooses which seat to launch');
        const ticket=this.state.tickets.find(ticket=>ticket.id===operation.ticketId),closure=this.state.closure?.id===operation.ticketId?this.state.closure:null;
        const revision=ticket?.revision??closure?.revision;
        const allowed=ticket?availableRoles(this.state,ticket).includes(operation.role):closure?.state==='Reviewing'&&closure.gate.status==='pending'&&operation.role==='closure';
        if(!allowed||!revision)return domain('invalidTransition','This ticket role is not actionable');
        if(this.options.host.active(operation.ticketId,operation.role))return domain('ownershipBlocked','This ticket role already has a live seat');
        const launched=await this.options.host.launch({agendaId:this.state.id,ticketId:operation.ticketId,revision,role:operation.role,agent:operation.role==='owner'?this.options.ownerAgent:this.options.gateAgent,cwd,
          sourceSessionFile:operation.role==='owner'?ticket?.ownerSessionFile??null:null,prompt:seatBrief(this.state,operation.ticketId,operation.role),
          ticket:ticket??closure!,workspace:ticket?.target??this.state.tickets[0]!.target});
        if(!launched.ok)return {ok:false,error:{kind:'host',error:launched.error}};
        return {ok:true,value:{launched:launched.value}};
      }
      if(operation.op==='finish'||operation.op==='resolve'&&operation.remove?.length){
        const retiring=operation.op==='finish'?this.state.tickets:this.state.tickets.filter(ticket=>operation.remove?.includes(ticket.id));
        const live=retiring.some(ticket=>(['owner','review','accept','postMerge'] as const).some(role=>this.options.host.active(ticket.id,role)));
        if(live||operation.op==='finish'&&this.state.closure&&this.options.host.active(this.state.closure.id,'closure'))return domain('ownershipBlocked','Wait for retiring one-shot seat jobs to exit before finishing or removing their tickets');
      }
      const changed=applyOperation(this.state,operation,caller,fresh.value,Date.now());if(!changed.ok)return {ok:false,error:{kind:'domain',error:changed.error}};
      if(operation.op==='finish'){
        const cleaned=await this.options.host.finish(this.state.id);
        if(!cleaned.ok)return {ok:false,error:{kind:'host',error:cleaned.error}};
      }
      const committed=await this.save(changed.value,this.state.version);if(!committed.ok)return committed;
      this.kick();
      // A seat's result exposes its own ticket, never the other tickets or effects.
      if(caller.kind==='seat'){
        const ticket=this.state.tickets.find(ticket=>ticket.id===caller.ticketId)??this.state.closure;
        return ticket?{ok:true,value:{ticket:structuredClone(ticket)}}:domain('notFound','Ticket was removed');
      }
      return this.view();
    });
  }
  private async settle(facts:Facts):Promise<Result<null,RuntimeError>> {
    if(!this.state)return {ok:true,value:null};
    const next=structuredClone(this.state);
    reconcile(next,facts,Date.now());
    if(canonical(next)===canonical(this.state))return {ok:true,value:null};
    next.version++;return this.save(next,this.state.version);
  }
  private kick():void {
    if(this.closed||this.scheduled)return;
    this.scheduled=setTimeout(()=>{this.scheduled=null;void this.run().catch(error=>this.unexpected(error));},0);this.scheduled.unref();
  }
  private unexpected(error:unknown):void {this.options.onError({kind:'host',error:{kind:'unavailable',message:error instanceof Error?error.message:String(error)}});}
  /** Exposed for deterministic integration driving; the production timer uses the same entry. */
  async run():Promise<void> {
    await this.serial(async()=>{
      const flushed=await this.flush();if(!flushed.ok){this.options.onError(flushed.error);return;}
      if(this.closed||!this.state||this.state.lifecycle!=='active')return;
      const observed=await this.source.read(this.state,null,'refresh');if(!observed.ok){this.options.onError({kind:'source',error:observed.error});return;}
      const settled=await this.settle(observed.value);if(!settled.ok){this.options.onError(settled.error);return;}
      const runnable=(effect:Effect):boolean=>{
        if(effect.state.kind!=='ready')return false;
        if(effect.action.kind!=='merge')return true;
        const reference=effect.action.pr;
        const pr=observed.value.prs.find(pr=>sameRef(pr.ref,reference));
        return pr?.mergeable==='yes'&&pr.checks.kind==='passing';
      };
      const effect=this.state.effects.find(effect=>effect.state.kind==='executing')??this.state.effects.find(effect=>effect.state.kind==='uncertain'&&satisfiedResult(this.state!,effect,observed.value))??this.state.effects.find(runnable);
      if(!effect)return;
      const result=await this.drive(effect,observed.value);if(!result.ok){this.options.onError(result.error);return;}
      if(this.state.effects.some(effect=>runnable(effect)||effect.state.kind==='executing'))this.kick();
    });
  }
  private async drive(effect:Effect,facts:Facts):Promise<Result<null,RuntimeError>> {
    if(!this.state)return domain('notFound','Agenda was detached');
    const confirmed=satisfiedResult(this.state,effect,facts);
    if(confirmed){
      const next=structuredClone(this.state),item=next.effects.find(item=>item.id===effect.id)!;
      confirmEffect(next,item,confirmed,facts,Date.now());next.version++;return this.save(next,this.state.version);
    }
    if(effect.state.kind==='uncertain')return {ok:true,value:null};
    if(effect.state.kind==='executing'){
      const next=structuredClone(this.state),item=next.effects.find(item=>item.id===effect.id)!;
      failEffect(next,item,{kind:'uncertainOutcome',message:'Executing intent has no source-confirmed result; explicit Main resolution is required'},true,Date.now());next.version++;
      return this.save(next,this.state.version);
    }
    const premise=effectPrecondition(this.state,effect,facts);
    if(premise){
      const next=structuredClone(this.state),item=next.effects.find(item=>item.id===effect.id)!;
      failEffect(next,item,{kind:'precondition',message:premise},false,Date.now());next.version++;return this.save(next,this.state.version);
    }
    const executing=structuredClone(this.state),item=executing.effects.find(item=>item.id===effect.id)!;
    item.attempt++;item.state={kind:'executing',startedAt:Date.now()};executing.version++;
    const started=await this.save(executing,this.state.version);if(!started.ok)return started;
    let called:Result<EffectResult|null,PortError>;
    try {called=await this.call(item);}catch(error){called={ok:false,error:{kind:'uncertainOutcome',message:error instanceof Error?error.message:String(error)}};}
    const receipt:SourceReceipt|undefined=called.ok&&called.value?{effectId:item.id,result:called.value}:undefined;
    const observed=await this.source.read(this.state,null,'effectConfirmation',receipt);
    const next=structuredClone(this.state),current=next.effects.find(effect=>effect.id===item.id)!;
    const result=observed.ok?satisfiedResult(next,current,observed.value):null;
    if(result&&observed.ok)confirmEffect(next,current,result,observed.value,Date.now());
    else {
      const error:PortError=!observed.ok?observed.error:!called.ok?called.error:{kind:'uncertainOutcome',message:'External call returned without source confirmation'};
      const knownFailure=!called.ok&&['permission','precondition','rateLimited'].includes(called.error.kind);
      failEffect(next,current,error,!knownFailure,Date.now());
    }
    next.version++;return this.save(next,this.state.version);
  }
  private async call(effect:Effect):Promise<Result<EffectResult|null,PortError>> {
    const action=effect.action,github=this.options.github;
    switch(action.kind){
      case 'publishPr':{
        const input={headRepo:action.headRepo,branch:action.branch,head:action.head,target:action.target,title:action.title,body:action.body};
        if(action.pr){const result=await github.editPr(action.pr,input);return result.ok?{ok:true,value:{kind:'published',pr:action.pr}}:result;}
        const result=await github.createPr(input);return result.ok?{ok:true,value:{kind:'published',pr:result.value}}:result;
      }
      case 'merge':{const result=await github.mergePr(action.pr,action.head);return result.ok?{ok:true,value:null}:result;}
      case 'setIssueState':{const result=await github.setIssueOpen(action.issue,action.open);return result.ok?{ok:true,value:null}:result;}
      case 'replaceBody':{const result=await github.editIssueBody(action.issue,action.expectedHash,action.body);return result.ok?{ok:true,value:null}:result;}
      case 'createIssue':{const result=await github.createIssue(action);return result.ok?{ok:true,value:{kind:'created',issue:result.value}}:result;}
      case 'attachChild':{const result=await github.addSubIssue(action.parent,action.child);return result.ok?{ok:true,value:null}:result;}
      case 'rerunChecks':{const result=await github.rerunCheck(action.repo,action.workflowRunId);return result.ok?{ok:true,value:null}:result;}
    }
  }
  snapshot():Agenda|null{return this.state?structuredClone(this.state):null;}
  async shutdown():Promise<void> {
    this.closed=true;clearInterval(this.timer??undefined);clearTimeout(this.scheduled??undefined);this.timer=null;this.scheduled=null;
    await this.tail;await this.options.host.dispose();
  }
}
