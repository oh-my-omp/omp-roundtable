import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {Agenda,Caller,Effect,Facts,IssueRef,IssueSnapshot,MaintenanceObservation,PrSnapshot,Repo,RepoSnapshot,Result,Role,Target,Ticket} from '../src/domain/model.ts';
import {applyOperation,availableRoles,confirmEffect,createAgenda,effectPrecondition,reconcile,satisfiedResult} from '../src/domain/engine.ts';

// These typed in-memory source snapshots exercise domain transitions only.
// GitHub subprocess pagination and real TUI delivery have separate integration coverage.

const REPO:Repo={owner:'RiriAgent',name:'rt-lifecycle'};
const ISSUE:IssueRef={repo:REPO,number:189};
const PR:IssueRef={repo:REPO,number:99};
const TARGET:Target={repo:REPO,base:'main'};
const TICKET='T1';
const BRANCH='feature/189';
const CONTRACT='Deliver the ticket-state-machine regression.\n';
const DRIFTED_CONTRACT='Rewritten contract after approval.\n';
const PR_TITLE='Ticket lifecycle regression';
const PR_BODY='Closes #189';
const HEAD='1'.repeat(40);
const DRIFTED_HEAD='2'.repeat(40);
const MERGE='3'.repeat(40);
const BASE='4'.repeat(40);
const AT=1_000;
const MERGED_AT=3_000;
const CLOSED_AT=4_000;
const OWNER_SESSION='/tmp/roundtable/T1-owner.json';
const REVIEW_SESSION='/tmp/roundtable/T1-review.json';
const ACCEPT_SESSION='/tmp/roundtable/T1-accept.json';
const POST_MERGE_SESSION='/tmp/roundtable/T1-postmerge.json';

function sha256(value:string):string{return createHash('sha256').update(value).digest('hex');}

function unwrap<T,E>(result:Result<T,E>,label:string):T {
  if(!result.ok)throw new Error(`${label} failed: ${JSON.stringify(result.error)}`);
  return result.value;
}

function ticketOf(state:Agenda,id=TICKET):Ticket {
  const ticket=state.tickets.find(item=>item.id===id);
  if(!ticket)throw new Error(`ticket ${id} is missing`);
  return ticket;
}

function effectOf(state:Agenda,match:(effect:Effect)=>boolean):Effect {
  const effect=state.effects.find(match);
  if(!effect)throw new Error('effect is missing');
  return effect;
}

function seat(role:Role,sessionFile:string,revision:number):Caller {
  return {agentId:`${role}-agent`,sessionId:`${role}-session`,sessionFile,kind:'seat',ticketId:TICKET,role,revision};
}

function buildFacts(input:{
  issues:Facts['issues'];
  prs?:Facts['prs'];
  repos?:Facts['repos'];
  branches?:Facts['branches'];
  maintenance?:Facts['maintenance'];
}):Facts {
  return {
    viewer:'RiriAgent',
    issues:input.issues,
    prs:input.prs??[],
    links:[],
    repos:input.repos??[],
    branches:input.branches??[],
    maintenance:input.maintenance??[],
    commits:[],
    checkAttempts:[],
    createdIssues:[],
  };
}

function issueSnapshot(state:'open'|'closed',lastClose:IssueSnapshot['lastClose'],body=CONTRACT):IssueSnapshot {
  return {ref:ISSUE,body,bodyHash:sha256(body),updatedAt:1_000,state,lastClose,lastReopen:null,children:[]};
}

function repoSnapshot(head:string):RepoSnapshot {
  return {repo:REPO,defaultBranch:'main',defaultHead:head,bases:[{name:'main',state:{kind:'present',head,isDefault:true,rules:{required:[],strict:true,constraints:[]}}}]};
}

function branch(head:string):Facts['branches'][number] {
  return {repo:REPO,name:BRANCH,state:{kind:'present',head}};
}

const OPEN_STATE:PrSnapshot['state']={kind:'open'};
const MERGED_STATE:PrSnapshot['state']={kind:'merged',sha:MERGE,at:MERGED_AT};

const MAINTAINABLE:MaintenanceObservation={pr:PR,result:{kind:'maintainable',basis:{headRepo:REPO,headBranch:BRANCH,viewerPermission:'ADMIN',author:'RiriAgent',maintainerCanModify:true,authorization:{kind:'actorIsAuthor',actor:'RiriAgent'}}}};

/** Facts before the Owner opens a PR: only issue, target base, and branch exist. */
function openSource():Facts {
  return buildFacts({issues:[issueSnapshot('open',null)],repos:[repoSnapshot(BASE)],branches:[branch(HEAD)]});
}

/** Facts for a submitted or published ticket, with an observed PR at the given head. */
function scenario(options:{
  prHead:string;
  baseHead:string;
  prState:PrSnapshot['state'];
  issueState:'open'|'closed';
  lastClose?:IssueSnapshot['lastClose'];
  prBody?:string;
  contractBody?:string;
}):Facts {
  return buildFacts({
    issues:[issueSnapshot(options.issueState,options.lastClose??null,options.contractBody??CONTRACT)],
    repos:[repoSnapshot(options.baseHead)],
    branches:[branch(options.prHead)],
    prs:[{ref:PR,headRepo:REPO,headBranch:BRANCH,head:options.prHead,target:TARGET,title:PR_TITLE,body:options.prBody??PR_BODY,bodyHash:sha256(options.prBody??PR_BODY),updatedAt:2_000,state:options.prState,closes:[ISSUE],mergeable:'yes',checks:{kind:'passing',required:[]}}],
    maintenance:[MAINTAINABLE],
  });
}

function conveneTicket():Agenda {
  return unwrap(createAgenda({op:'convene',parent:null,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:null}]},openSource(),AT,'agenda-1'),'convene');
}

/** Drive convene → Owner submit → source-confirmed publication (Reviewing with both gates pending). */
function publishTicket():{agenda:Agenda;facts:Facts} {
  const publishing=unwrap(applyOperation(conveneTicket(),{op:'submit',ticketId:TICKET,revision:1,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,1),openSource(),AT),'owner submit');
  const effect=effectOf(publishing,item=>item.action.kind==='publishPr');
  const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
  const result=satisfiedResult(publishing,effect,facts);
  if(!result)throw new Error('publication was not source-confirmed');
  confirmEffect(publishing,effect,result,facts,AT);
  return {agenda:publishing,facts};
}

/** Drive publication → both gate approvals, which reconcile the ticket into Merging. */
function driveToMerging():{agenda:Agenda;facts:Facts} {
  const {agenda,facts}=publishTicket();
  const reviewed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision:1,role:'review',ok:true,note:'Review approves.'},seat('review',REVIEW_SESSION,1),facts,AT),'review verdict');
  const accepted=unwrap(applyOperation(reviewed,{op:'verdict',ticketId:TICKET,revision:1,role:'accept',ok:true,note:'Accept approves.'},seat('accept',ACCEPT_SESSION,1),facts,AT),'accept verdict');
  return {agenda:accepted,facts};
}

describe('ticket delivery lifecycle',()=>{
  test('an Owner submission is published into the dual-gate review',()=>{
    const convened=conveneTicket();
    const coding=ticketOf(convened);
    expect(coding.state).toBe('Coding');
    expect(coding.ownerSessionFile).toBeNull();

    const submitted=unwrap(applyOperation(convened,{op:'submit',ticketId:TICKET,revision:coding.revision,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,coding.revision),openSource(),AT),'owner submit');
    const publishing=ticketOf(submitted);
    expect(publishing.state).toBe('Publishing');
    expect(publishing.ownerSessionFile).toBe(OWNER_SESSION);

    const effect=effectOf(submitted,item=>item.action.kind==='publishPr');
    const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
    expect(effect.state.kind).toBe('ready');
    expect(effectPrecondition(submitted,effect,facts)).toBeNull();

    const confirmed=satisfiedResult(submitted,effect,facts);
    if(!confirmed)throw new Error('publication was not source-confirmed');
    confirmEffect(submitted,effect,confirmed,facts,AT);

    const published=ticketOf(submitted);
    expect(published.state).toBe('Reviewing');
    expect(published.pr?.ref).toEqual(PR);
    expect(published.gates.review?.status).toBe('pending');
    expect(published.gates.accept?.status).toBe('pending');
    expect(availableRoles(submitted,published)).toEqual(['review','accept']);
  });

  test('a rejecting review returns the ticket to Coding with its finding and owner session',()=>{
    const {agenda,facts}=publishTicket();
    const before=ticketOf(agenda);
    const rejecting=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision:before.revision,role:'review',ok:false,note:'Missing regression for the drift check.'},seat('review',REVIEW_SESSION,before.revision),facts,AT),'review verdict');

    const after=ticketOf(rejecting);
    expect(after.state).toBe('Coding');
    expect(after.revision).toBe(before.revision+1);
    expect(after.gates.review).toBeNull();
    expect(after.gates.accept).toBeNull();
    expect(after.ownerSessionFile).toBe(OWNER_SESSION);
    const finding=after.notes.find(note=>note.role==='review'&&note.kind==='finding');
    expect(finding?.text).toBe('Missing regression for the drift check.');
    expect(rejecting.effects.some(item=>item.action.kind==='merge')).toBe(false);
  });

  test('an accept rejection after a passing review resets both gates and returns to Coding',()=>{
    const {agenda,facts}=publishTicket();
    const revision=ticketOf(agenda).revision;
    const reviewed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision,role:'review',ok:true,note:'Review approves.'},seat('review',REVIEW_SESSION,revision),facts,AT),'review verdict');
    expect(ticketOf(reviewed).gates.review?.status).toBe('passed');

    const rejected=unwrap(applyOperation(reviewed,{op:'verdict',ticketId:TICKET,revision,role:'accept',ok:false,note:'Accept demands a regression.'},seat('accept',ACCEPT_SESSION,revision),facts,AT),'accept verdict');
    const ticket=ticketOf(rejected);
    expect(ticket.state).toBe('Coding');
    expect(ticket.revision).toBe(revision+1);
    expect(ticket.gates.review).toBeNull();
    expect(ticket.gates.accept).toBeNull();
    expect(rejected.effects.some(item=>item.action.kind==='merge')).toBe(false);
  });

  test('both gate approvals merge and postMerge complete the ticket',()=>{
    const {agenda,facts}=driveToMerging();
    expect(ticketOf(agenda).state).toBe('Merging');
    const mergeEffect=effectOf(agenda,item=>item.action.kind==='merge');
    expect(effectPrecondition(agenda,mergeEffect,facts)).toBeNull();

    const mergedFacts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'open'});
    const merged=satisfiedResult(agenda,mergeEffect,mergedFacts);
    if(!merged)throw new Error('merge was not source-confirmed');
    confirmEffect(agenda,mergeEffect,merged,mergedFacts,AT);

    const verifying=ticketOf(agenda);
    expect(verifying.state).toBe('Verifying');
    expect(verifying.terminal).toEqual({kind:'merged',pr:PR,mergeSha:MERGE,at:MERGED_AT});
    expect(verifying.gates.postMerge?.status).toBe('pending');

    const postMerged=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision:verifying.revision,role:'postMerge',ok:true,note:'Post-merge verified.'},seat('postMerge',POST_MERGE_SESSION,verifying.revision),mergedFacts,AT),'postMerge verdict');
    expect(ticketOf(postMerged).gates.postMerge?.status).toBe('passed');

    const closingEffect=effectOf(postMerged,item=>item.action.kind==='setIssueState'&&item.state.kind==='ready');
    const closedFacts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'closed',lastClose:{id:'close-1',at:CLOSED_AT}});
    const closed=satisfiedResult(postMerged,closingEffect,closedFacts);
    if(!closed)throw new Error('issue closure was not source-confirmed');
    confirmEffect(postMerged,closingEffect,closed,closedFacts,AT);

    const done=ticketOf(postMerged);
    expect(done.state).toBe('Done');
    expect(availableRoles(postMerged,done)).toEqual([]);

    const terminal=structuredClone(postMerged);
    reconcile(postMerged,closedFacts,AT+100);
    expect(postMerged).toEqual(terminal);
    const reVerdict=applyOperation(postMerged,{op:'verdict',ticketId:TICKET,revision:done.revision,role:'postMerge',ok:true,note:'Post-merge again.'},seat('postMerge',POST_MERGE_SESSION,done.revision),closedFacts,AT);
    expect(reVerdict.ok).toBe(false);
    expect(postMerged).toEqual(terminal);
  });

  test('a drifted PR head after both approvals cancels the merge and escalates',()=>{
    const {agenda,facts}=driveToMerging();
    const mergeEffect=effectOf(agenda,item=>item.action.kind==='merge');
    const revision=ticketOf(agenda).revision;
    expect(effectPrecondition(agenda,mergeEffect,facts)).toBeNull();

    const drifted=scenario({prHead:DRIFTED_HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
    reconcile(agenda,drifted,AT+100);
    const ticket=ticketOf(agenda);
    expect(ticket.state).toBe('Escalated');
    expect(ticket.revision).toBe(revision+1);
    expect(ticket.gates.review).toBeNull();
    expect(ticket.gates.accept).toBeNull();
    expect(effectPrecondition(agenda,mergeEffect,drifted)).not.toBeNull();

    const escalated=structuredClone(agenda);
    reconcile(agenda,drifted,AT+200);
    expect(agenda).toEqual(escalated);
  });

  test('a contract body change after both approvals escalates without an authorized merge',()=>{
    const {agenda,facts}=driveToMerging();
    const mergeEffect=effectOf(agenda,item=>item.action.kind==='merge');
    expect(effectPrecondition(agenda,mergeEffect,facts)).toBeNull();

    const drifted=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open',contractBody:DRIFTED_CONTRACT});
    reconcile(agenda,drifted,AT+100);
    expect(ticketOf(agenda).state).toBe('Escalated');
    expect(effectPrecondition(agenda,mergeEffect,drifted)).not.toBeNull();
  });

  test('a removed closing keyword after both approvals escalates without an authorized merge',()=>{
    const {agenda,facts}=driveToMerging();
    const mergeEffect=effectOf(agenda,item=>item.action.kind==='merge');
    expect(effectPrecondition(agenda,mergeEffect,facts)).toBeNull();

    const drifted=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open',prBody:'Relates to #189'});
    reconcile(agenda,drifted,AT+100);
    expect(ticketOf(agenda).state).toBe('Escalated');
    expect(effectPrecondition(agenda,mergeEffect,drifted)).not.toBeNull();
  });

  test('reconcile and effect confirmation are idempotent while review is pending',()=>{
    const {agenda,facts}=publishTicket();
    const unpublished=structuredClone(agenda);
    reconcile(agenda,facts,AT);
    expect(agenda).toEqual(unpublished);

    const publishEffect=effectOf(agenda,item=>item.action.kind==='publishPr'&&item.state.kind==='confirmed');
    if(publishEffect.state.kind!=='confirmed')throw new Error('publishPr effect did not confirm');
    const confirmed=structuredClone(agenda);
    confirmEffect(agenda,publishEffect,publishEffect.state.result,facts,AT);
    expect(agenda).toEqual(confirmed);

    const {agenda:merging,facts:mergeFacts}=driveToMerging();
    const mergingSnapshot=structuredClone(merging);
    reconcile(merging,mergeFacts,AT);
    expect(merging).toEqual(mergingSnapshot);
    expect(merging.effects.filter(item=>item.action.kind==='merge').length).toBe(1);
  });
});

test('independent tickets are runnable while a dependent waits for source-confirmed noCode closure',()=>{
  const source=openSource();
  const second={repo:REPO,number:190},third={repo:REPO,number:191};
  source.issues.push({...issueSnapshot('open',null),ref:second},{...issueSnapshot('open',null),ref:third});
  let agenda=unwrap(createAgenda({op:'convene',parent:null,tickets:[
    {id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:null},
    {id:'B',issue:second,target:TARGET,dependsOn:[],adoptPr:null},
    {id:'C',issue:third,target:TARGET,dependsOn:[TICKET],adoptPr:null},
  ]},source,AT,'agenda-parallel'),'convene parallel graph');
  const main:Caller={kind:'main',agentId:'Main',sessionId:'coordinator',sessionFile:null};
  agenda.run={kind:'attached',id:'run',mainAgentId:main.agentId,mainSessionId:main.sessionId};
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['owner']);
  expect(availableRoles(agenda,ticketOf(agenda,'B'))).toEqual(['owner']);
  expect(availableRoles(agenda,ticketOf(agenda,'C'))).toEqual([]);
  agenda=unwrap(applyOperation(agenda,{op:'escalate',ticketId:TICKET,revision:1,kind:'noCode',reason:'The required behavior already exists.'},seat('owner',OWNER_SESSION,1),source,AT),'noCode escalation');
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:ticketOf(agenda).revision,ruling:'Verified the existing behavior.',to:'Done',noCode:'Already satisfied at source.'},main,source,AT),'noCode ruling');
  expect(ticketOf(agenda).state).not.toBe('Done');
  expect(availableRoles(agenda,ticketOf(agenda,'C'))).toEqual([]);
  source.issues[0]!.state='closed';
  source.issues[0]!.lastClose={id:'no-code-close',at:AT+1};
  const effect=effectOf(agenda,item=>item.action.kind==='setIssueState');
  const result=satisfiedResult(agenda,effect,source);
  if(!result)throw new Error('Closure was not observed');
  confirmEffect(agenda,effect,result,source,AT+1);
  expect(ticketOf(agenda).terminal?.kind).toBe('noCode');
  expect(ticketOf(agenda).state).toBe('Done');
  expect(availableRoles(agenda,ticketOf(agenda,'C'))).toEqual(['owner']);
});

test('a cyclic dependency graph is rejected before an agenda can run',()=>{
  const source=openSource(),other={repo:REPO,number:190};
  source.issues.push({...issueSnapshot('open',null),ref:other});
  const result=createAgenda({op:'convene',parent:null,tickets:[
    {id:'A',issue:ISSUE,target:TARGET,dependsOn:['B'],adoptPr:null},
    {id:'B',issue:other,target:TARGET,dependsOn:['A'],adoptPr:null},
  ]},source,AT,'agenda-cycle');
  expect(result).toMatchObject({ok:false,error:{kind:'invalidTopology'}});
});

test('parent membership remains valid after a topology ruling and closure rejects ticket-only fields',()=>{
  const parent={repo:REPO,number:1},other={repo:REPO,number:190};
  const facts=openSource();
  facts.issues.push({...issueSnapshot('open',null),ref:other},{...issueSnapshot('open',null),ref:parent,children:[ISSUE,other]});
  const agenda=unwrap(createAgenda({op:'convene',parent,tickets:[
    {id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:null},
    {id:'other',issue:other,target:TARGET,dependsOn:[],adoptPr:null},
  ]},facts,AT,'parent-agenda'),'parent convene');
  const main:Caller={kind:'main',agentId:'Main',sessionId:'parent-main',sessionFile:null};
  agenda.run={kind:'attached',id:'run',mainAgentId:main.agentId,mainSessionId:main.sessionId};
  expect(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:1,to:'Coding',ruling:'Remove still attached child.',remove:['other']},main,facts,AT)).toMatchObject({ok:false,error:{kind:'invalidTopology'}});
  expect(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:1,to:'Coding',ruling:'Add parent as child.',add:[{id:'parent',issue:parent,target:TARGET,dependsOn:[],adoptPr:null}]},main,facts,AT)).toMatchObject({ok:false,error:{kind:'invalidTopology'}});
  for(const ticket of agenda.tickets){ticket.state='Done';ticket.terminal={kind:'noCode',bodyHash:ticket.contract.bodyHash,reason:'Already satisfied',at:AT};}
  for(const issue of facts.issues)if(issue.ref.number!==parent.number)issue.state='closed';
  reconcile(agenda,facts,AT);
  const closure=agenda.closure;if(!closure)throw new Error('Expected closure');
  expect(applyOperation(agenda,{op:'resolve',ticketId:closure.id,revision:closure.revision,to:'Reviewing',ruling:'Invalid closure topology edit.',remove:['other']},main,facts,AT)).toMatchObject({ok:false,error:{kind:'invalidTransition'}});
});

test('GitHub draft and behind observations cannot authorize a merge or masquerade as a conflict',()=>{
  for(const status of ['behind','draft'] as const){
    const {agenda,facts}=driveToMerging();facts.prs[0]!.mergeable=status;
    reconcile(agenda,facts,AT);
    const ticket=ticketOf(agenda);
    expect(ticket.state).toBe(status==='behind'?'Coding':'Escalated');
    expect(ticket.gates.review).toBeNull();
    expect(ticket.notes.at(-1)?.text).not.toBe('PR conflicts with the target.');
    expect(effectPrecondition(agenda,effectOf(agenda,effect=>effect.action.kind==='merge'),facts)).not.toBeNull();
  }
});

test('Main revoking noCode cancels its queued close before coding resumes',()=>{
  const facts=openSource();
  let agenda=conveneTicket();
  const main:Caller={kind:'main',agentId:'Main',sessionId:'revocation-main',sessionFile:null};
  agenda.run={kind:'attached',id:'run',mainAgentId:main.agentId,mainSessionId:main.sessionId};
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:1,to:'Done',noCode:'Already satisfied.',ruling:'First inspection.'},main,facts,AT),'noCode');
  const close=effectOf(agenda,effect=>effect.action.kind==='setIssueState');
  expect(close.state.kind).toBe('ready');
  agenda=unwrap(applyOperation(agenda,{op:'resolve',ticketId:TICKET,revision:ticketOf(agenda).revision,to:'Coding',ruling:'New evidence requires code before closure.'},main,facts,AT+1),'revoke noCode');
  expect(ticketOf(agenda).state).toBe('Coding');
  expect(ticketOf(agenda).terminal).toBeNull();
  expect(effectOf(agenda,effect=>effect.action.kind==='setIssueState').state.kind).toBe('cancelled');
  expect(effectPrecondition(agenda,close,facts)).not.toBeNull();
});
