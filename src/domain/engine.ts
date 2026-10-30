import type {Action,Agenda,Caller,ConveneInput,DomainError,Effect,EffectResult,Entry,Facts,MergeCommitStamp,NoteAuthor,ParentStamp,PortError,PortInput,PrSnapshot,PullRequestStamp,Result,Role,Ticket,Workflow} from './model.ts';
import {bodyHash,canonical,contains,dependenciesDone,digest,exactClosingBody,nextId,sameRef,sameRepo,sameTarget,targetHead} from './identity.ts';
import {validateTopology} from './parse.ts';
import {OWNER,openVerdicts,pendingRoles,seatOf,stagePassed} from './workflow.ts';

const SYSTEM:NoteAuthor={kind:'system'},MAIN:NoteAuthor={kind:'main'};
function reject(kind:DomainError['kind'],message:string):{ok:false;error:DomainError}{return {ok:false,error:{kind,message}};}
function note(ticket:Ticket,author:NoteAuthor,kind:Ticket['notes'][number]['kind'],text:string,at:number):void {ticket.notes.push({at,author,kind,text});}
function invalidate(ticket:Ticket):void {ticket.revision++;ticket.gates={pullRequest:null,mergeCommit:null};}
function escalate(ticket:Ticket,text:string,at:number,kind:Ticket['notes'][number]['kind']='sourceChange'):void {
  invalidate(ticket);ticket.state='Escalated';note(ticket,SYSTEM,kind,text,at);
}
export function enqueue(state:Agenda,ticketId:string,action:Action):Effect {
  const effect:Effect={id:nextId(state,'effect'),ticketId,action,attempt:0,state:{kind:'ready'}};
  state.effects.push(effect);return effect;
}
function ticketFrom(entry:Entry,facts:Facts):Result<Ticket,DomainError> {
  const source=facts.issues.find(issue=>sameRef(issue.ref,entry.issue));
  if(!source)return reject('sourceUnavailable',`Issue ${entry.id} was not returned by GitHub`);
  if(!targetHead(facts,entry.target))return reject('sourceUnavailable',`Target for ${entry.id} does not exist`);
  const ticket:Ticket={id:entry.id,revision:1,issue:entry.issue,target:entry.target,dependsOn:entry.dependsOn,
    contract:{revision:1,bodyHash:source.bodyHash,body:source.body},state:'Coding',ownerSessionFile:null,started:false,pr:null,
    gates:{pullRequest:null,mergeCommit:null},rulings:[],notes:[],terminal:null};
  if(entry.adoptPr){
    const pr=facts.prs.find(pr=>sameRef(pr.ref,entry.adoptPr!));
    if(!pr||!sameTarget(pr.target,ticket.target)||pr.closes.length!==1||!sameRef(pr.closes[0]!,ticket.issue))return reject('sourceChanged','Adopted PR must close exactly this issue at the target');
    ticket.pr={ref:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,head:pr.head,title:pr.title,body:pr.body};
    if(pr.state.kind==='merged'){
      ticket.terminal={kind:'merged',pr:pr.ref,mergeSha:pr.state.sha,at:pr.state.at};ticket.state='Verifying';
    }else if(pr.state.kind==='open')ticket.state='Reviewing';
    else return reject('invalidTransition','A closed unmerged PR cannot be adopted');
  }else if(source.state==='closed')ticket.state='Escalated';
  return {ok:true,value:ticket};
}
export function createAgenda(input:ConveneInput,workflow:Workflow,facts:Facts,at:number,id:string):Result<Agenda,DomainError> {
  const state:Agenda={id,version:1,nextId:1,convenedAt:at,lifecycle:'active',parent:input.parent,workflow,tickets:[],closure:null,effects:[],run:{kind:'detached'},summary:null};
  for(const entry of input.tickets){const ticket=ticketFrom(entry,facts);if(!ticket.ok)return ticket;state.tickets.push(ticket.value);}
  const topology=validateTopology(state);if(topology)return reject('invalidTopology',topology);
  if(input.parent){
    const parent=facts.issues.find(issue=>sameRef(issue.ref,input.parent!));
    if(!parent||parent.children.some(child=>!state.tickets.some(ticket=>sameRef(ticket.issue,child))))return reject('invalidTopology','Every current parent sub-issue must be represented by a ticket');
    if(state.tickets.some(ticket=>sameRef(ticket.issue,input.parent!)))return reject('invalidTopology','Parent cannot be its own delivery ticket');
  }
  reconcile(state,facts,at);return {ok:true,value:state};
}
export function availableRoles(state:Agenda,ticket:Ticket):Role[] {
  if(!dependenciesDone(state,ticket))return [];
  switch(ticket.state){
    case 'Coding':return [OWNER];
    case 'Reviewing':return ticket.gates.pullRequest?pendingRoles(state.workflow.judges.pullRequest,ticket.gates.pullRequest.verdicts):[];
    case 'Verifying':return ticket.gates.mergeCommit?pendingRoles(state.workflow.judges.mergeCommit,ticket.gates.mergeCommit.verdicts):[];
    case 'Publishing':case 'Merging':case 'Escalated':case 'Done':return [];
  }
}
/** The parent closure's judges still owing a verdict on its current stamp. */
export function closureRoles(state:Agenda):Role[] {
  const closure=state.closure;
  return closure?.state==='Reviewing'?pendingRoles(state.workflow.judges.parent,closure.gate.verdicts):[];
}
/** A Coding ticket Main has not put on the table yet, whose dependencies are all Done. */
export function awaitsLaunch(state:Agenda,ticket:Ticket):boolean {
  return ticket.state==='Coding'&&!ticket.started&&dependenciesDone(state,ticket);
}
function contractIssue(ticket:Ticket,facts:Facts){
  const issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
  return issue&&issue.bodyHash===ticket.contract.bodyHash?issue:null;
}
/** What every pullRequest judge judges: the exact open PR head that closes this issue at its target. */
export function pullRequestStamp(ticket:Ticket,facts:Facts):PullRequestStamp|null {
  const issue=contractIssue(ticket,facts),pr=sourcePr(ticket,facts);
  if(!issue||!pr||pr.state.kind!=='open'||pr.head!==ticket.pr?.head||!sameTarget(pr.target,ticket.target)||!exactClosingBody(pr.body,ticket.issue,pr.ref.repo)||pr.closes.length!==1||!sameRef(pr.closes[0]!,ticket.issue))return null;
  return {kind:'pullRequest',pr:pr.ref,head:pr.head,target:pr.target,bodyHash:issue.bodyHash,prBodyHash:pr.bodyHash,contractRevision:ticket.contract.revision,rulingsHash:digest(ticket.rulings)};
}
/** What every mergeCommit judge judges: the ticket's merge commit, still contained in its target. */
export function mergeCommitStamp(ticket:Ticket,facts:Facts):MergeCommitStamp|null {
  const issue=contractIssue(ticket,facts),terminal=ticket.terminal,head=targetHead(facts,ticket.target);
  if(!issue||terminal?.kind!=='merged'||!head||!contains(facts,ticket.target.repo,terminal.mergeSha,head))return null;
  const pr=facts.prs.find(pr=>sameRef(pr.ref,terminal.pr));
  if(pr?.state.kind!=='merged'||pr.state.sha!==terminal.mergeSha||!sameTarget(pr.target,ticket.target))return null;
  return {kind:'mergeCommit',issue:ticket.issue,bodyHash:issue.bodyHash,contractRevision:ticket.contract.revision,terminal,target:ticket.target,commit:terminal.mergeSha,rulingsHash:digest(ticket.rulings)};
}
function parentStamp(state:Agenda,facts:Facts):ParentStamp|null {
  if(!state.parent||state.tickets.some(ticket=>ticket.state!=='Done'||!ticket.terminal))return null;
  const parent=facts.issues.find(issue=>sameRef(issue.ref,state.parent!));
  if(!parent||parent.children.some(child=>!state.tickets.some(ticket=>sameRef(ticket.issue,child))))return null;
  const targets:Ticket['target'][]=[];
  const children:{id:string;issue:Ticket['issue'];terminal:NonNullable<Ticket['terminal']>}[]=[];
  for(const ticket of state.tickets){
    const issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
    if(issue?.state!=='closed'||issue.bodyHash!==ticket.contract.bodyHash||!ticket.terminal)return null;
    const head=targetHead(facts,ticket.target);if(!head)return null;
    if(ticket.terminal.kind==='merged'&&!contains(facts,ticket.target.repo,ticket.terminal.mergeSha,head))return null;
    if(!targets.some(item=>sameTarget(item,ticket.target)))targets.push(ticket.target);
    children.push({id:ticket.id,issue:ticket.issue,terminal:ticket.terminal});
  }
  return {kind:'parent',parent:state.parent,bodyHash:parent.bodyHash,children,targets,rulingsHash:digest(state.closure?.rulings??[])};
}
function mergeCommitPassed(state:Agenda,ticket:Ticket):boolean {
  return ticket.gates.mergeCommit!==null&&stagePassed(state.workflow.judges.mergeCommit,ticket.gates.mergeCommit.verdicts);
}
function sourcePr(ticket:Ticket,facts:Facts):PrSnapshot|undefined{return ticket.pr?.ref?facts.prs.find(pr=>sameRef(pr.ref,ticket.pr!.ref!)):undefined;}
function mergeReady(ticket:Ticket,pr:PrSnapshot,facts:Facts):boolean {
  const base=facts.repos.find(item=>sameRepo(item.repo,ticket.target.repo))?.bases.find(item=>item.name===ticket.target.base);
  return pr.state.kind==='open'&&pr.mergeable==='yes'&&pr.checks.kind==='passing'&&base?.state.kind==='present';
}
/** Reconcile only fresh, complete GitHub observations. No local intent establishes source state. */
export function reconcile(state:Agenda,facts:Facts,at:number):void {
  for(const ticket of state.tickets){
    const issue=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
    if(!issue)continue;
    if(issue.bodyHash!==ticket.contract.bodyHash){
      if(ticket.state!=='Escalated')escalate(ticket,'GitHub issue body changed; Main must synchronize the contract and rule.',at);
      continue;
    }
    if(ticket.state==='Done'){
      const head=targetHead(facts,ticket.target);
      if(issue.state!=='closed'||ticket.terminal?.kind==='merged'&&(!head||!contains(facts,ticket.target.repo,ticket.terminal.mergeSha,head)))escalate(ticket,'Completed source was reopened or its merge is no longer in the target.',at);
      continue;
    }
    if(ticket.state==='Reviewing'||ticket.state==='Merging'){
      const pr=sourcePr(ticket,facts);
      // A new head or description of the same open PR restarts review on its new fingerprint; only Merging pins the approved one.
      // GitHub fixes a PR's head repository and branch at creation, so only these fields can legitimately move.
      if(ticket.state==='Reviewing'&&pr?.state.kind==='open'&&ticket.pr&&(pr.head!==ticket.pr.head||pr.body!==ticket.pr.body||pr.title!==ticket.pr.title)){
        ticket.pr={...ticket.pr,head:pr.head,title:pr.title,body:pr.body};
        note(ticket,SYSTEM,'sourceChange',`Open PR changed to head ${pr.head}; gates restart on the new fingerprint.`,at);
      }
      const stamp=pullRequestStamp(ticket,facts),roster=state.workflow.judges.pullRequest;
      const stale=ticket.gates.pullRequest!==null&&canonical(ticket.gates.pullRequest.stamp)!==canonical(stamp);
      if(!pr||!stamp||stale&&ticket.state==='Merging'){
        escalate(ticket,ticket.state==='Merging'?'PR head, target, closing link, body, or review contract changed after approval; fresh gates are required.':'PR is closed, missing, retargeted, or no longer closes exactly this issue.',at);
      }else if(pr.checks.kind==='unknown'){
        escalate(ticket,`Required CI observations cannot be verified: ${pr.checks.reason}`,at,'checks');
      }else if(pr.mergeable==='draft'){
        escalate(ticket,'The PR is a draft; Main must obtain a source change or adopt a ready PR.',at);
      }else if(pr.checks.kind==='failing'||pr.mergeable==='no'||pr.mergeable==='behind'){
        invalidate(ticket);ticket.state='Coding';
        note(ticket,SYSTEM,pr.mergeable==='no'||pr.mergeable==='behind'?'conflict':'checks',
          pr.mergeable==='no'?'PR conflicts with the target.':pr.mergeable==='behind'?'GitHub requires this branch to be updated with the target.':JSON.stringify(pr.checks),at);
      }else if(ticket.state==='Reviewing'){
        if(stale)invalidate(ticket);
        // The stage opens only on a mergeable PR with passing required checks; a stage without judges passes at once.
        if(mergeReady(ticket,pr,facts)){
          ticket.gates.pullRequest??={stamp,verdicts:openVerdicts(roster)};
          if(stagePassed(roster,ticket.gates.pullRequest.verdicts)&&dependenciesDone(state,ticket)){
            ticket.state='Merging';enqueue(state,ticket.id,{kind:'merge',issue:ticket.issue,pr:pr.ref,head:pr.head,target:ticket.target,stampHash:digest(stamp)});
          }
        }
      }
    }
    if(ticket.state==='Verifying'){
      const stamp=mergeCommitStamp(ticket,facts),roster=state.workflow.judges.mergeCommit;
      if(!stamp)escalate(ticket,'Merged commit or post-merge contract is not present in the target.',at);
      else if(ticket.gates.mergeCommit&&canonical(ticket.gates.mergeCommit.stamp)!==canonical(stamp)){
        ticket.revision++;ticket.gates.mergeCommit={stamp,verdicts:openVerdicts(roster)};
      }else ticket.gates.mergeCommit??={stamp,verdicts:openVerdicts(roster)};
      if(ticket.state==='Verifying'&&mergeCommitPassed(state,ticket)){
        if(issue.state==='closed')ticket.state='Done';
        else if(!state.effects.some(effect=>effect.ticketId===ticket.id&&effect.action.kind==='setIssueState'&&effect.state.kind!=='cancelled'&&effect.state.kind!=='confirmed'))enqueue(state,ticket.id,{kind:'setIssueState',issue:ticket.issue,open:false,bodyHash:issue.bodyHash,afterEvent:issue.lastReopen?.id??null});
      }
    }
  }
  for(const effect of state.effects){
    if(effect.state.kind!=='ready')continue;
    const ticket=state.tickets.find(ticket=>ticket.id===effect.ticketId);
    if(effect.action.kind==='merge'&&ticket?.state!=='Merging'||effect.action.kind==='publishPr'&&ticket?.state!=='Publishing')effect.state={kind:'cancelled',reason:'Ticket no longer authorizes this effect'};
    if(ticket&&effect.action.kind==='setIssueState'&&!effect.action.open&&!(ticket.state==='Escalated'&&ticket.terminal?.kind==='noCode'||ticket.state==='Verifying'&&mergeCommitPassed(state,ticket)))effect.state={kind:'cancelled',reason:'Ticket no longer authorizes issue closure'};
  }
  const stamp=parentStamp(state,facts),roster=state.workflow.judges.parent;
  if(state.parent){
    if(stamp){
      if(!state.closure)state.closure={id:`${state.id}/closure`,revision:1,state:'Reviewing',gate:{stamp,verdicts:openVerdicts(roster)},rulings:[],notes:[]};
      else if(canonical(state.closure.gate.stamp)!==canonical(stamp)){
        state.closure.revision++;state.closure.state='Reviewing';state.closure.gate={stamp,verdicts:openVerdicts(roster)};
      }
      if(state.closure.state==='Reviewing'&&stagePassed(roster,state.closure.gate.verdicts)){
        const parent=facts.issues.find(issue=>sameRef(issue.ref,state.parent!));
        if(parent?.state==='closed')state.closure.state='Done';
        else if(parent&&!state.effects.some(effect=>effect.ticketId===state.closure!.id&&effect.action.kind==='setIssueState'&&effect.state.kind!=='cancelled'&&effect.state.kind!=='confirmed'))enqueue(state,state.closure.id,{kind:'setIssueState',issue:parent.ref,open:false,bodyHash:parent.bodyHash,afterEvent:parent.lastReopen?.id??null});
      }
    }else if(state.closure&&state.closure.state!=='Escalated'){
      state.closure.revision++;state.closure.state='Escalated';state.closure.notes.push('Parent, child membership, terminal, or target verification changed.');
    }
  }
}

export function effectPrecondition(state:Agenda,effect:Effect,facts:Facts):string|null {
  const action=effect.action,ticket=state.tickets.find(ticket=>ticket.id===effect.ticketId);
  switch(action.kind){
    case 'publishPr':{
      if(!ticket||ticket.state!=='Publishing'||ticket.contract.bodyHash!==facts.issues.find(issue=>sameRef(issue.ref,action.issue))?.bodyHash)return 'Publishing contract changed';
      const branch=facts.branches.find(branch=>sameRepo(branch.repo,action.headRepo)&&branch.name===action.branch);
      if(branch?.state.kind!=='present'||branch.state.head!==action.head)return 'Submitted branch head changed';
      if(!exactClosingBody(action.body,action.issue,action.target.repo))return 'PR must close exactly its issue';
      if(action.pr){
        const pr=facts.prs.find(pr=>sameRef(pr.ref,action.pr!));
        if(!pr||pr.state.kind!=='open'||pr.bodyHash!==action.expectedBodyHash)return 'PR edit baseline changed';
        if(!facts.maintenance.some(item=>sameRef(item.pr,action.pr!)&&item.result.kind==='maintainable'))return 'The authenticated actor does not own an authorized editable PR';
      }
      return null;
    }
    case 'merge':{
      if(!ticket||ticket.state!=='Merging'||!dependenciesDone(state,ticket))return 'Ticket no longer authorizes merging';
      const pr=facts.prs.find(pr=>sameRef(pr.ref,action.pr)),stamp=pullRequestStamp(ticket,facts),gate=ticket.gates.pullRequest;
      if(!pr||!stamp||!gate||pr.head!==action.head||!sameTarget(pr.target,action.target)||digest(stamp)!==action.stampHash||canonical(gate.stamp)!==canonical(stamp)||!stagePassed(state.workflow.judges.pullRequest,gate.verdicts)||!mergeReady(ticket,pr,facts))return 'Fresh gates, exact PR head, CI, or mergeability no longer permit merging';
      return null;
    }
    case 'setIssueState':{
      const issue=facts.issues.find(issue=>sameRef(issue.ref,action.issue));
      if(!issue||issue.bodyHash!==action.bodyHash||(action.open?issue.lastClose:issue.lastReopen)?.id!==(action.afterEvent??undefined))return 'Issue body or opposite lifecycle event changed';
      if(!action.open){
        if(ticket){if(ticket.state==='Escalated'&&ticket.terminal?.kind==='noCode'&&ticket.terminal.bodyHash===issue.bodyHash)return null;if(ticket.state==='Verifying'&&mergeCommitPassed(state,ticket))return null;return 'Ticket has no accepted closure';}
        const closure=state.closure,stamp=parentStamp(state,facts);
        if(closure?.id!==effect.ticketId||closure.state!=='Reviewing'||!stagePassed(state.workflow.judges.parent,closure.gate.verdicts)||!stamp||canonical(closure.gate.stamp)!==canonical(stamp))return 'Parent closure gate changed';
      }
      return null;
    }
    case 'replaceBody':return facts.issues.find(issue=>sameRef(issue.ref,action.issue))?.bodyHash===action.expectedHash?null:'Issue body edit baseline changed';
    case 'createIssue':return null;
    case 'attachChild':return facts.issues.some(issue=>sameRef(issue.ref,action.parent))&&facts.issues.some(issue=>sameRef(issue.ref,action.child))?null:'Attachment source missing';
    case 'rerunChecks':{
      const pr=facts.prs.find(pr=>sameRef(pr.ref,action.pr)),attempt=facts.checkAttempts.find(item=>sameRepo(item.repo,action.repo)&&item.workflowRunId===action.workflowRunId);
      return pr?.head===action.head&&attempt?.attempt===action.previousAttempt?null:'Workflow attempt or PR head changed';
    }
  }
}
export function satisfiedResult(state:Agenda,effect:Effect,facts:Facts):EffectResult|null {
  const action=effect.action;
  switch(action.kind){
    case 'publishPr':{
      const candidates=facts.prs.filter(pr=>(!action.pr||sameRef(pr.ref,action.pr))&&pr.state.kind==='open'&&sameRepo(pr.headRepo,action.headRepo)&&pr.headBranch===action.branch&&pr.head===action.head&&sameTarget(pr.target,action.target)&&pr.title===action.title&&pr.body===action.body&&pr.closes.length===1&&sameRef(pr.closes[0]!,action.issue));
      const pr=candidates.length===1?candidates[0]:undefined;
      const maintained=pr&&facts.maintenance.some(item=>sameRef(item.pr,pr.ref)&&item.result.kind==='maintainable');
      return pr&&maintained?{kind:'published',pr:pr.ref}:null;
    }
    case 'merge':{
      const pr=facts.prs.find(pr=>sameRef(pr.ref,action.pr));
      return pr?.state.kind==='merged'&&pr.head===action.head&&sameTarget(pr.target,action.target)&&pr.closes.length===1&&sameRef(pr.closes[0]!,action.issue)?{kind:'merged',pr:pr.ref,mergeSha:pr.state.sha,at:pr.state.at}:null;
    }
    case 'setIssueState':{
      const issue=facts.issues.find(issue=>sameRef(issue.ref,action.issue));
      return issue&&issue.bodyHash===action.bodyHash&&issue.state===(action.open?'open':'closed')?{kind:'issueState',issue:action.issue,open:action.open}:null;
    }
    case 'replaceBody':return facts.issues.find(issue=>sameRef(issue.ref,action.issue))?.body===action.body?{kind:'bodyReplaced',issue:action.issue,hash:bodyHash(action.body)}:null;
    case 'createIssue':{
      const candidates=facts.createdIssues.filter(issue=>sameRepo(issue.issue.repo,action.repo)&&issue.title===action.title&&issue.body===action.body&&issue.actor.toLowerCase()===facts.viewer.toLowerCase()&&issue.createdAt>=state.convenedAt);
      return candidates.length===1?{kind:'created',issue:candidates[0]!.issue}:null;
    }
    case 'attachChild':return facts.issues.find(issue=>sameRef(issue.ref,action.parent))?.children.some(child=>sameRef(child,action.child))?{kind:'attached',parent:action.parent,child:action.child}:null;
    case 'rerunChecks':{
      const attempt=facts.checkAttempts.find(item=>sameRepo(item.repo,action.repo)&&item.workflowRunId===action.workflowRunId&&item.head===action.head&&item.attempt>action.previousAttempt);
      return attempt?{kind:'rerun',repo:action.repo,workflowRunId:action.workflowRunId,attempt:attempt.attempt}:null;
    }
  }
}
export function confirmEffect(state:Agenda,effect:Effect,result:EffectResult,facts:Facts,at:number):void {
  effect.state={kind:'confirmed',result};
  const ticket=state.tickets.find(ticket=>ticket.id===effect.ticketId);
  if(ticket)switch(result.kind){
    case 'published':
      if(ticket.pr){ticket.pr.ref=result.pr;if(ticket.state==='Publishing')ticket.state='Reviewing';}
      break;
    case 'merged':
      ticket.terminal={kind:'merged',pr:result.pr,mergeSha:result.mergeSha,at:result.at};
      if(ticket.state==='Merging')ticket.state='Verifying';
      break;
    case 'issueState':if(!result.open&&ticket.terminal?.kind==='noCode')ticket.state='Done';break;
    case 'created':case 'attached':case 'bodyReplaced':case 'rerun':break;
  }
  reconcile(state,facts,at);
}
export function failEffect(state:Agenda,effect:Effect,error:PortError,uncertain:boolean,at:number):void {
  const startedAt=effect.state.kind==='executing'?effect.state.startedAt:at;
  effect.state={kind:uncertain?'uncertain':'failed',startedAt,error};
  const ticket=state.tickets.find(ticket=>ticket.id===effect.ticketId);
  if(ticket)escalate(ticket,`Effect ${effect.id} ${effect.state.kind}: ${error.message}`,at,'escalation');
  else if(state.closure){state.closure.state='Escalated';state.closure.revision++;state.closure.notes.push(`Effect ${effect.id}: ${error.message}`);}
}
/**
 * A seat that left its still-current revision without a handoff, or could not be seated at all, needs Main's
 * ruling rather than an automatic relaunch loop. Superseded seats return false: their successor is already due.
 */
export function abandonSeat(state:Agenda,ticketId:string,role:Role,revision:number,reason:string,at:number):boolean {
  const ticket=state.tickets.find(ticket=>ticket.id===ticketId);
  if(ticket){
    if(ticket.revision!==revision||!availableRoles(state,ticket).includes(role))return false;
    escalate(ticket,`The ${role} seat ended without a handoff: ${reason}`,at,'escalation');return true;
  }
  const closure=state.closure;
  if(closure?.id!==ticketId||closure.revision!==revision||!closureRoles(state).includes(role))return false;
  closure.state='Escalated';closure.revision++;closure.notes.push(`The ${role} seat ended without a handoff: ${reason}`);return true;
}

export function applyOperation(state:Agenda,operation:PortInput,caller:Caller,facts:Facts,at:number):Result<Agenda,DomainError> {
  const next=structuredClone(state);
  if(next.lifecycle!=='active')return reject('invalidTransition','Agenda has completed');
  const main=caller.kind==='main'&&next.run.kind==='attached'&&caller.agentId===next.run.mainAgentId&&caller.sessionId===next.run.mainSessionId;
  if(operation.op==='finish'){
    if(!main)return reject('unauthorized','Only the attached Main may finish');
    reconcile(next,facts,at);
    if(next.tickets.some(ticket=>ticket.state!=='Done')||next.parent&&next.closure?.state!=='Done'||next.effects.some(effect=>effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled'))return reject('invalidTransition','All tickets, effects, and parent closure must be complete');
    next.summary=operation.summary;next.lifecycle='completed';next.version++;return {ok:true,value:next};
  }
  if(!('ticketId' in operation))return reject('invalidTransition','Operation is not a ticket transition');
  const ticket=next.tickets.find(ticket=>ticket.id===operation.ticketId),closure=next.closure?.id===operation.ticketId?next.closure:null;
  if(!ticket&&!closure)return reject('notFound','Unknown ticket');
  if(operation.op==='launch'){
    if(!main)return reject('unauthorized','Only the attached Main puts a ticket on the table');
    if(!ticket)return reject('invalidTransition','The parent closure seat is relayed automatically once every ticket is Done');
    if(ticket.started)return reject('invalidTransition','This ticket is already on the table; the roundtable relays its seats until it is Done or Escalated');
    if(ticket.state==='Escalated'||ticket.state==='Done')return reject('invalidTransition','Resolve an Escalated ticket before launching it; a Done ticket needs no seat');
    if(!dependenciesDone(next,ticket))return reject('invalidTransition','Every dependency must be Done before this ticket is launched');
    // The optional role only names a seat the ticket's current stage already offers; every such seat starts either way.
    if(operation.role&&!availableRoles(next,ticket).includes(operation.role))return reject('invalidTransition',`This ticket's current stage does not offer a ${operation.role} seat`);
    ticket.started=true;next.version++;return {ok:true,value:next};
  }
  if(!('revision' in operation)||operation.revision!==(ticket?.revision??closure?.revision))return reject('staleRevision',caller.kind==='seat'?'This seat revision has been superseded. Exit; the roundtable relays a fresh seat.':'Read the current ticket revision');
  const seat=caller.kind==='seat'&&caller.ticketId===operation.ticketId&&caller.revision===operation.revision;
  if(operation.op==='resolve'){
    if(!main)return reject('unauthorized','Only the attached Main may resolve');
    if(operation.noCode&&operation.to!=='Done')return reject('invalidTransition','noCode is valid only when resolving to Done');
    if(closure){
      if(operation.add||operation.remove||operation.dependsOn||operation.target||operation.adoptPr!==undefined||operation.noCode)return reject('invalidTransition','Closure resolution accepts only a ruling and effect dispositions; edit topology on a delivery ticket');
      if(operation.to!=='Reviewing')return reject('invalidTransition','Closure can only return to Reviewing');
      closure.rulings.push({at,summary:operation.ruling});closure.state='Reviewing';closure.revision++;
      const stamp=parentStamp(next,facts);if(!stamp)return reject('sourceChanged','Children are not complete at source');
      closure.gate={stamp,verdicts:openVerdicts(next.workflow.judges.parent)};
    }else if(ticket){
      if(operation.add)for(const entry of operation.add){const added=ticketFrom(entry,facts);if(!added.ok)return added;next.tickets.push(added.value);}
      if(operation.remove){
        for(const id of operation.remove)if(next.effects.some(effect=>effect.ticketId===id&&effect.state.kind!=='confirmed'&&effect.state.kind!=='cancelled'))return reject('invalidTransition','Cannot remove a ticket with unsettled effects');
        next.tickets=next.tickets.filter(item=>!operation.remove!.includes(item.id));
        next.effects=next.effects.filter(effect=>!operation.remove!.includes(effect.ticketId));
        if(!next.tickets.includes(ticket))return reject('invalidTransition','Resolution cannot remove its own ticket');
      }
      if(next.parent){
        const parent=facts.issues.find(issue=>sameRef(issue.ref,next.parent!));
        if(!parent||parent.children.some(child=>!next.tickets.some(item=>sameRef(item.issue,child)))||next.tickets.some(item=>sameRef(item.issue,next.parent!)))return reject('invalidTopology','Every attached child must retain a ticket, and the parent cannot be a delivery ticket');
      }
      const source=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));if(!source)return reject('sourceUnavailable','Issue contract is unavailable');
      if(source.bodyHash!==ticket.contract.bodyHash)ticket.contract={revision:ticket.contract.revision+1,bodyHash:source.bodyHash,body:source.body};
      ticket.rulings.push({at,summary:operation.ruling});note(ticket,MAIN,'ruling',operation.ruling,at);invalidate(ticket);
      if(operation.dependsOn)ticket.dependsOn=operation.dependsOn;
      if(operation.target)ticket.target=operation.target;
      if(operation.adoptPr===null){ticket.pr=null;ticket.terminal=null;}
      else if(operation.adoptPr){
        const pr=facts.prs.find(pr=>sameRef(pr.ref,operation.adoptPr!));
        if(!pr||!sameTarget(pr.target,ticket.target)||pr.closes.length!==1||!sameRef(pr.closes[0]!,ticket.issue))return reject('sourceChanged','Adopted PR does not close this issue at the target');
        ticket.pr={ref:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,head:pr.head,title:pr.title,body:pr.body};
        ticket.terminal=pr.state.kind==='merged'?{kind:'merged',pr:pr.ref,mergeSha:pr.state.sha,at:pr.state.at}:null;
      }else if(ticket.pr?.ref){
        const pr=sourcePr(ticket,facts);if(pr&&pr.state.kind==='open')ticket.pr={ref:pr.ref,headRepo:pr.headRepo,branch:pr.headBranch,head:pr.head,title:pr.title,body:pr.body};
      }
      ticket.state=operation.to;
      if(operation.to!=='Done'&&ticket.terminal?.kind==='noCode')ticket.terminal=null;
      if(operation.to==='Done'){
        if(operation.noCode){
          ticket.terminal={kind:'noCode',bodyHash:source.bodyHash,reason:operation.noCode,at};
          if(source.state!=='closed'){
            ticket.state='Escalated';
            if(!next.effects.some(effect=>effect.ticketId===ticket.id&&effect.action.kind==='setIssueState'&&!effect.action.open&&effect.action.bodyHash===source.bodyHash&&effect.state.kind!=='cancelled'&&effect.state.kind!=='confirmed'))enqueue(next,ticket.id,{kind:'setIssueState',issue:ticket.issue,open:false,bodyHash:source.bodyHash,afterEvent:source.lastReopen?.id??null});
          }
        }
      }
    }
    for(const resolution of operation.effects??[]){
      const effect=next.effects.find(effect=>effect.id===resolution.effectId&&effect.ticketId===operation.ticketId);
      if(!effect||effect.state.kind!=='uncertain'&&effect.state.kind!=='failed')return reject('invalidTransition','Only this ticket’s failed or uncertain effects can be resolved');
      switch(resolution.disposition){
        case 'cancel':effect.state={kind:'cancelled',reason:operation.ruling};break;
        case 'adopt':{const result=satisfiedResult(next,effect,facts);if(!result)return reject('sourceChanged','Source does not confirm the effect');confirmEffect(next,effect,result,facts,at);break;}
        case 'retry':{
          const result=satisfiedResult(next,effect,facts);
          if(result)confirmEffect(next,effect,result,facts,at);
          else if(effect.action.kind==='merge'){
            effect.state={kind:'cancelled',reason:'Main requested retry; merge must acquire fresh gates'};
            if(ticket)ticket.state='Reviewing';
          }else {effect.state={kind:'ready'};if(ticket&&effect.action.kind==='publishPr')ticket.state='Publishing';}
          break;
        }
      }
    }
    if(next.effects.some(effect=>effect.ticketId===operation.ticketId&&(effect.state.kind==='failed'||effect.state.kind==='uncertain'||effect.state.kind==='executing')))return reject('invalidTransition','Resolve every failed or uncertain effect before reopening work on this ticket');
    if(ticket){
      const source=facts.issues.find(issue=>sameRef(issue.ref,ticket.issue));
      if(ticket.state==='Done'&&!operation.noCode&&(ticket.terminal?.kind!=='merged'||source?.state!=='closed'||!mergeCommitStamp(ticket,facts)))return reject('sourceChanged','Done requires source-confirmed noCode or a valid closed merged issue');
      if(ticket.state==='Verifying'&&ticket.terminal?.kind!=='merged')return reject('invalidTransition','Verifying requires a source-confirmed merged PR');
      if(ticket.state==='Reviewing'&&!pullRequestStamp(ticket,facts))return reject('sourceChanged','Reviewing requires a current open PR');
    }
    for(const action of operation.actions??[])enqueue(next,operation.ticketId,action);
    const topology=validateTopology(next);if(topology)return reject('invalidTopology',topology);
  }else if(operation.op==='submit'){
    if(!seat||caller.kind!=='seat'||caller.role!==OWNER||!ticket||ticket.state!=='Coding'||!dependenciesDone(next,ticket))return reject('unauthorized','Only the active runnable Owner may submit');
    if(facts.issues.find(issue=>sameRef(issue.ref,ticket.issue))?.bodyHash!==ticket.contract.bodyHash)return reject('sourceChanged','Issue contract changed');
    if(!exactClosingBody(operation.body,ticket.issue,ticket.target.repo))return reject('invalidTransition','PR body must contain exactly one closing keyword for this issue');
    const prior=sourcePr(ticket,facts);
    ticket.pr={ref:ticket.pr?.ref??null,headRepo:ticket.pr?.headRepo??ticket.target.repo,branch:operation.branch,head:operation.head,title:operation.title,body:operation.body};
    ticket.ownerSessionFile=caller.sessionFile;ticket.state='Publishing';
    enqueue(next,ticket.id,{kind:'publishPr',issue:ticket.issue,headRepo:ticket.pr.headRepo,branch:ticket.pr.branch,head:ticket.pr.head,title:ticket.pr.title,body:ticket.pr.body,pr:ticket.pr.ref,target:ticket.target,expectedBodyHash:prior?.bodyHash??null});
  }else if(operation.op==='escalate'){
    if(!seat||caller.kind!=='seat')return reject('unauthorized','Only the active ticket seat may escalate');
    if(ticket){
      if(!availableRoles(next,ticket).includes(caller.role))return reject('invalidTransition','Seat is no longer actionable');
      if(caller.role===OWNER)ticket.ownerSessionFile=caller.sessionFile;
      invalidate(ticket);ticket.state='Escalated';note(ticket,{kind:'seat',role:caller.role},'escalation',`${operation.kind}: ${operation.reason}`,at);
    }else if(closure&&seatOf(next.workflow,caller.role)?.stage==='parent'){
      closure.state='Escalated';closure.revision++;closure.notes.push(operation.reason);
    }else return reject('unauthorized','Seat does not own the closure');
  }else if(operation.op==='verdict'){
    if(!seat||caller.kind!=='seat'||caller.role!==operation.role)return reject('unauthorized','Only the active gate may submit its own verdict');
    // The role's stage in the frozen workflow, never its name, decides what it judges and where a failure leads.
    const stage=seatOf(next.workflow,operation.role)?.stage;
    if(closure&&stage==='parent'){
      const stamp=parentStamp(next,facts),verdict=closure.gate.verdicts.find(item=>item.role===operation.role);
      if(closure.state!=='Reviewing'||verdict?.status!=='pending'||!stamp||canonical(stamp)!==canonical(closure.gate.stamp))return reject('sourceChanged','Closure stamp changed');
      verdict.status=operation.ok?'passed':'failed';verdict.note=operation.note;
      if(!operation.ok){closure.state='Escalated';closure.revision++;closure.notes.push(operation.note);}
    }else if(ticket&&(stage==='pullRequest'||stage==='mergeCommit')){
      const gate=ticket.gates[stage],stamp=stage==='pullRequest'?pullRequestStamp(ticket,facts):mergeCommitStamp(ticket,facts);
      const verdict=gate?.verdicts.find(item=>item.role===operation.role);
      if(!availableRoles(next,ticket).includes(operation.role)||!gate||verdict?.status!=='pending'||!stamp||canonical(stamp)!==canonical(gate.stamp))return reject('sourceChanged','Gate stamp changed or gate is no longer pending');
      verdict.status=operation.ok?'passed':'failed';verdict.note=operation.note;
      note(ticket,{kind:'seat',role:operation.role},'finding',operation.note,at);
      if(!operation.ok){invalidate(ticket);ticket.state=stage==='mergeCommit'?'Escalated':'Coding';}
    }else return reject('invalidTransition','Wrong gate role');
  }else return reject('invalidTransition','Operation does not change a ticket');
  reconcile(next,facts,at);next.version++;return {ok:true,value:next};
}
