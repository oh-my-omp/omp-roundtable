import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {Agenda,Caller,DomainError,Effect,Facts,IssueRef,IssueSnapshot,MaintenanceObservation,PrSnapshot,Repo,RepoSnapshot,Result,Role,Target,Ticket,Workflow} from '../src/domain/model.ts';
import {applyOperation,availableRoles,closureRoles,confirmEffect,createAgenda,effectPrecondition,reconcile,satisfiedResult} from '../src/domain/engine.ts';
import {YAML} from 'bun';
import {parseAgenda,parseWorkflow} from '../src/domain/parse.ts';

const defaultWorkflow=unwrap(parseWorkflow(YAML.parse(await Bun.file(new URL('../src/default-workflow.yml',import.meta.url)).text())),'default workflow');

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

function seat(role:Role,sessionFile:string,revision:number):Extract<Caller,{kind:'seat'}> {
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

function conveneTicket(workflow:Workflow=defaultWorkflow):Agenda {
  return unwrap(createAgenda({op:'convene',parent:null,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:null}]},workflow,openSource(),AT,'agenda-1'),'convene');
}

/** Drive convene → Owner submit → source-confirmed publication (Reviewing with both gates pending). */
function publishTicket(workflow:Workflow=defaultWorkflow):{agenda:Agenda;facts:Facts} {
  const publishing=unwrap(applyOperation(conveneTicket(workflow),{op:'submit',ticketId:TICKET,revision:1,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,1),openSource(),AT),'owner submit');
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
    expect(published.gates.pullRequest?.verdicts).toEqual([{role:'review',status:'pending',note:''},{role:'accept',status:'pending',note:''}]);
    expect(availableRoles(submitted,published)).toEqual(['review','accept']);
  });

  test('a rejecting review returns the ticket to Coding with its finding and owner session',()=>{
    const {agenda,facts}=publishTicket();
    const before=ticketOf(agenda);
    const rejecting=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision:before.revision,role:'review',ok:false,note:'Missing regression for the drift check.'},seat('review',REVIEW_SESSION,before.revision),facts,AT),'review verdict');

    const after=ticketOf(rejecting);
    expect(after.state).toBe('Coding');
    expect(after.revision).toBe(before.revision+1);
    expect(after.gates.pullRequest).toBeNull();
    expect(after.gates.mergeCommit).toBeNull();
    expect(after.ownerSessionFile).toBe(OWNER_SESSION);
    const finding=after.notes.find(note=>note.author.kind==='seat'&&note.author.role==='review'&&note.kind==='finding');
    expect(finding?.text).toBe('Missing regression for the drift check.');
    expect(rejecting.effects.some(item=>item.action.kind==='merge')).toBe(false);
  });

  test('an accept rejection after a passing review resets both gates and returns to Coding',()=>{
    const {agenda,facts}=publishTicket();
    const revision=ticketOf(agenda).revision;
    const reviewed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision,role:'review',ok:true,note:'Review approves.'},seat('review',REVIEW_SESSION,revision),facts,AT),'review verdict');
    expect(ticketOf(reviewed).gates.pullRequest?.verdicts.find(verdict=>verdict.role==='review')?.status).toBe('passed');

    const rejected=unwrap(applyOperation(reviewed,{op:'verdict',ticketId:TICKET,revision,role:'accept',ok:false,note:'Accept demands a regression.'},seat('accept',ACCEPT_SESSION,revision),facts,AT),'accept verdict');
    const ticket=ticketOf(rejected);
    expect(ticket.state).toBe('Coding');
    expect(ticket.revision).toBe(revision+1);
    expect(ticket.gates.pullRequest).toBeNull();
    expect(ticket.gates.mergeCommit).toBeNull();
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
    expect(verifying.gates.mergeCommit?.verdicts).toEqual([{role:'postMerge',status:'pending',note:''}]);

    const postMerged=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision:verifying.revision,role:'postMerge',ok:true,note:'Post-merge verified.'},seat('postMerge',POST_MERGE_SESSION,verifying.revision),mergedFacts,AT),'postMerge verdict');
    expect(ticketOf(postMerged).gates.mergeCommit?.verdicts).toEqual([{role:'postMerge',status:'passed',note:'Post-merge verified.'}]);

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
    expect(ticket.gates.pullRequest).toBeNull();
    expect(ticket.gates.mergeCommit).toBeNull();
    expect(effectPrecondition(agenda,mergeEffect,drifted)).not.toBeNull();

    const escalated=structuredClone(agenda);
    reconcile(agenda,drifted,AT+200);
    expect(agenda).toEqual(escalated);
  });

  test('review and accept open only once the PR is mergeable with passing required checks',()=>{
    const submitted=unwrap(applyOperation(conveneTicket(),{op:'submit',ticketId:TICKET,revision:1,branch:BRANCH,head:HEAD,title:PR_TITLE,body:PR_BODY},seat('owner',OWNER_SESSION,1),openSource(),AT),'owner submit');
    const effect=effectOf(submitted,item=>item.action.kind==='publishPr');
    const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
    const pr=facts.prs[0]!;pr.mergeable='unknown';
    const published=satisfiedResult(submitted,effect,facts);
    if(!published)throw new Error('publication was not source-confirmed');
    confirmEffect(submitted,effect,published,facts,AT);
    expect(ticketOf(submitted).state).toBe('Reviewing');
    expect(availableRoles(submitted,ticketOf(submitted))).toEqual([]);

    pr.mergeable='yes';pr.checks={kind:'pending',required:[{identity:{name:'ci',source:{kind:'any'}},head:HEAD}]};
    reconcile(submitted,facts,AT+1);
    expect(availableRoles(submitted,ticketOf(submitted))).toEqual([]);

    pr.checks={kind:'passing',required:[]};
    reconcile(submitted,facts,AT+2);
    expect(availableRoles(submitted,ticketOf(submitted))).toEqual(['review','accept']);
  });

  test('a new head on the open PR restarts both gates on its fingerprint instead of escalating',()=>{
    const {agenda,facts}=publishTicket();
    const revision=ticketOf(agenda).revision;
    const reviewed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision,role:'review',ok:true,note:'Review approves.'},seat('review',REVIEW_SESSION,revision),facts,AT),'review verdict');
    reconcile(reviewed,scenario({prHead:DRIFTED_HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'}),AT+1);
    const ticket=ticketOf(reviewed);
    expect(ticket.state).toBe('Reviewing');
    expect(ticket.revision).toBe(revision+1);
    expect(ticket.pr?.head).toBe(DRIFTED_HEAD);
    expect(ticket.gates.pullRequest).toMatchObject({stamp:{head:DRIFTED_HEAD},verdicts:[{role:'review',status:'pending'},{role:'accept',status:'pending'}]});
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
  ]},defaultWorkflow,source,AT,'agenda-parallel'),'convene parallel graph');
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
  ]},defaultWorkflow,source,AT,'agenda-cycle');
  expect(result).toMatchObject({ok:false,error:{kind:'invalidTopology'}});
});

test('parent membership remains valid after a topology ruling and closure rejects ticket-only fields',()=>{
  const parent={repo:REPO,number:1},other={repo:REPO,number:190};
  const facts=openSource();
  facts.issues.push({...issueSnapshot('open',null),ref:other},{...issueSnapshot('open',null),ref:parent,children:[ISSUE,other]});
  const agenda=unwrap(createAgenda({op:'convene',parent,tickets:[
    {id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:null},
    {id:'other',issue:other,target:TARGET,dependsOn:[],adoptPr:null},
  ]},defaultWorkflow,facts,AT,'parent-agenda'),'parent convene');
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
    expect(ticket.gates.pullRequest).toBeNull();
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

test('postMerge keeps its merge anchor across independent target advances but rejects lost ancestry',()=>{
  const {agenda}=driveToMerging();
  const mergedFacts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'closed',lastClose:{id:'merge-close',at:MERGED_AT}});
  const effect=effectOf(agenda,item=>item.action.kind==='merge');
  const result=satisfiedResult(agenda,effect,mergedFacts);
  if(!result)throw new Error('Merge was not source-confirmed');
  confirmEffect(agenda,effect,result,mergedFacts,AT);
  const revision=ticketOf(agenda).revision,stamp=structuredClone(ticketOf(agenda).gates.mergeCommit?.stamp);
  const advanced=scenario({prHead:HEAD,baseHead:DRIFTED_HEAD,prState:MERGED_STATE,issueState:'closed',lastClose:{id:'merge-close',at:MERGED_AT}});
  advanced.commits.push({repo:REPO,ancestor:MERGE,descendant:DRIFTED_HEAD,result:'contains'});
  reconcile(agenda,advanced,AT+1);
  expect(ticketOf(agenda).revision).toBe(revision);
  expect(ticketOf(agenda).gates.mergeCommit?.stamp).toEqual(stamp);
  const lost=structuredClone(agenda),rewritten=structuredClone(advanced);
  rewritten.commits[0]!.result='notContained';
  reconcile(lost,rewritten,AT+2);
  expect(ticketOf(lost).state).toBe('Escalated');
  expect(ticketOf(lost).gates.mergeCommit).toBeNull();
  const passed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision,role:'postMerge',ok:true,note:'Target still contains the exact merge after an independent delivery.'},seat('postMerge',POST_MERGE_SESSION,revision),advanced,AT+3),'stable postMerge');
  expect(ticketOf(passed).state).toBe('Done');
});

test('closure fingerprints survive unrelated forward merges but reject lost child ancestry',()=>{
  const parent={repo:REPO,number:1};
  const source=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'closed',lastClose:{id:'child-close',at:MERGED_AT}});
  source.issues.push({...issueSnapshot('open',null),ref:parent,children:[ISSUE]});
  let agenda=unwrap(createAgenda({op:'convene',parent,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:PR}]},defaultWorkflow,source,AT,'closure-anchor'),'adopt merged child');
  agenda=unwrap(applyOperation(agenda,{op:'verdict',ticketId:TICKET,revision:1,role:'postMerge',ok:true,note:'Verified the merged child.'},seat('postMerge',POST_MERGE_SESSION,1),source,AT),'postMerge');
  const closure=agenda.closure;if(!closure)throw new Error('Expected closure after child Done');
  const original=structuredClone(closure.gate.stamp),revision=closure.revision;
  const advanced=structuredClone(source);
  const base=advanced.repos[0]!.bases[0]!;
  if(base.state.kind!=='present')throw new Error('Expected target');
  base.state.head=DRIFTED_HEAD;advanced.repos[0]!.defaultHead=DRIFTED_HEAD;
  advanced.commits.push({repo:REPO,ancestor:MERGE,descendant:DRIFTED_HEAD,result:'contains'});
  reconcile(agenda,advanced,AT+1);
  expect(agenda.closure?.revision).toBe(revision);
  expect(agenda.closure?.gate.stamp).toEqual(original);
  const lost=structuredClone(agenda),rewritten=structuredClone(advanced);
  rewritten.commits[0]!.result='notContained';
  reconcile(lost,rewritten,AT+2);
  expect(lost.closure?.state).toBe('Escalated');
  const caller:Caller={kind:'seat',agentId:'closure',sessionId:'closure',sessionFile:'/tmp/closure.jsonl',ticketId:closure.id,revision,role:'closure'};
  const passed=unwrap(applyOperation(agenda,{op:'verdict',ticketId:closure.id,revision,role:'closure',ok:true,note:'Every terminal remains contained in the current target.'},caller,advanced,AT+3),'stable closure');
  expect(passed.closure?.gate.verdicts).toEqual([{role:'closure',status:'passed',note:'Every terminal remains contained in the current target.'}]);
});

const customWorkflow:Workflow={
  owner:{agent:'task:high',brief:'Implement the requested delivery.'},
  judges:{
    pullRequest:[{role:'security',agent:'task:mid',brief:'Audit the change.'},{role:'usability',agent:'task:mid',brief:'Check user behavior.'}],
    mergeCommit:[{role:'deployment',agent:'task:mid',brief:'Verify the merged delivery.'}],
    parent:[{role:'product',agent:'task:mid',brief:'Check all child outcomes.'},{role:'operations',agent:'task:mid',brief:'Confirm readiness.'}],
  },
};
function verdict(agenda:Agenda,facts:Facts,role:Role,ok=true,ticketId=TICKET):Result<Agenda,DomainError> {
  const revision=ticketId===agenda.closure?.id?agenda.closure.revision:ticketOf(agenda,ticketId).revision;
  return applyOperation(agenda,{op:'verdict',ticketId,revision,role,ok,note:`${role} ${ok?'approves':'rejects'} the delivery.`},{...seat(role,`/tmp/${role}.jsonl`,revision),ticketId},facts,AT);
}
function adoptMerged(workflow:Workflow,parent:IssueRef|null=null):{agenda:Agenda;facts:Facts} {
  const facts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:parent?'closed':'open',lastClose:parent?{id:'child-closed',at:CLOSED_AT}:null});
  if(parent)facts.issues.push({...issueSnapshot('open',null),ref:parent,children:[ISSUE]});
  const agenda=unwrap(createAgenda({op:'convene',parent,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:PR}]},workflow,facts,AT,'aaaabbbb-1111-4111-8111-111111111111'),'adopt merged');
  return {agenda,facts};
}

test('a custom pullRequest roster requires both named judges before enqueuing merge',()=>{
  const {agenda,facts}=publishTicket(customWorkflow);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['security','usability']);
  const first=unwrap(verdict(agenda,facts,'security'),'first custom verdict');
  expect(ticketOf(first).state).toBe('Reviewing');
  expect(availableRoles(first,ticketOf(first))).toEqual(['usability']);
  expect(first.effects.filter(effect=>effect.action.kind==='merge')).toEqual([]);
  const second=unwrap(verdict(first,facts,'usability'),'second custom verdict');
  expect(ticketOf(second).state).toBe('Merging');
  expect(second.effects.filter(effect=>effect.action.kind==='merge')).toHaveLength(1);
});

test('either custom pullRequest judge can reject the delivery back to Coding',()=>{
  for(const role of ['security','usability']){
    const {agenda,facts}=publishTicket(customWorkflow);
    const other=role==='security'?'usability':'security';
    const approved=unwrap(verdict(agenda,facts,other),'other judge approval');
    const rejected=unwrap(verdict(approved,facts,role,false),'custom rejection');
    expect(ticketOf(rejected)).toMatchObject({state:'Coding',revision:2,gates:{pullRequest:null,mergeCommit:null}});
    expect(rejected.effects.some(effect=>effect.action.kind==='merge')).toBe(false);
    expect(ticketOf(rejected).notes.at(-1)).toMatchObject({author:{kind:'seat',role},kind:'finding',text:`${role} rejects the delivery.`});
  }
});

test('a verdict from another stage or an unknown role cannot approve a pullRequest',()=>{
  const {agenda,facts}=publishTicket(customWorkflow),before=structuredClone(agenda);
  for(const role of ['deployment','product','stranger'])expect(verdict(agenda,facts,role).ok).toBe(false);
  expect(agenda).toEqual(before);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['security','usability']);
});

test('an empty pullRequest roster still waits for mergeability and checks then merges without verdicts',()=>{
  const workflow=structuredClone(customWorkflow);workflow.judges.pullRequest=[];
  const facts=scenario({prHead:HEAD,baseHead:BASE,prState:OPEN_STATE,issueState:'open'});
  facts.prs[0]!.mergeable='unknown';
  const agenda=unwrap(createAgenda({op:'convene',parent:null,tickets:[{id:TICKET,issue:ISSUE,target:TARGET,dependsOn:[],adoptPr:PR}]},workflow,facts,AT,'empty-review'),'adopt PR');
  expect(ticketOf(agenda)).toMatchObject({state:'Reviewing',gates:{pullRequest:null}});
  expect(agenda.effects).toEqual([]);
  facts.prs[0]!.mergeable='yes';facts.prs[0]!.checks={kind:'pending',required:[{identity:{name:'ci',source:{kind:'any'}},head:HEAD}]};
  reconcile(agenda,facts,AT+1);
  expect(ticketOf(agenda).state).toBe('Reviewing');
  expect(agenda.effects).toEqual([]);
  facts.prs[0]!.checks={kind:'passing',required:[]};
  reconcile(agenda,facts,AT+2);
  expect(ticketOf(agenda)).toMatchObject({state:'Merging',gates:{pullRequest:{verdicts:[]}}});
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual([]);
  expect(effectPrecondition(agenda,effectOf(agenda,effect=>effect.action.kind==='merge'),facts)).toBeNull();
});

test('an empty mergeCommit roster queues issue closure after merge confirmation and reaches Done',()=>{
  const workflow=structuredClone(customWorkflow);workflow.judges.pullRequest=[];workflow.judges.mergeCommit=[];
  const {agenda}=publishTicket(workflow);
  const facts=scenario({prHead:HEAD,baseHead:MERGE,prState:MERGED_STATE,issueState:'open'});
  const merge=effectOf(agenda,effect=>effect.action.kind==='merge');
  const merged=satisfiedResult(agenda,merge,facts);if(!merged)throw new Error('Expected merged source');
  confirmEffect(agenda,merge,merged,facts,AT);
  expect(ticketOf(agenda)).toMatchObject({state:'Verifying',gates:{mergeCommit:{verdicts:[]}}});
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual([]);
  const close=effectOf(agenda,effect=>effect.action.kind==='setIssueState');
  expect(close.action).toMatchObject({issue:ISSUE,open:false});
  expect(effectPrecondition(agenda,close,facts)).toBeNull();
  facts.issues[0]!.state='closed';facts.issues[0]!.lastClose={id:'closed',at:CLOSED_AT};
  const closed=satisfiedResult(agenda,close,facts);if(!closed)throw new Error('Expected issue closure');
  confirmEffect(agenda,close,closed,facts,AT);
  expect(ticketOf(agenda).state).toBe('Done');
});

test('a custom mergeCommit judge rejection escalates instead of returning to Coding',()=>{
  const {agenda,facts}=adoptMerged(customWorkflow);
  expect(availableRoles(agenda,ticketOf(agenda))).toEqual(['deployment']);
  const rejected=unwrap(verdict(agenda,facts,'deployment',false),'merged rejection');
  expect(ticketOf(rejected)).toMatchObject({state:'Escalated',revision:2});
  expect(rejected.effects.some(effect=>effect.action.kind==='setIssueState')).toBe(false);
});

test('parent closure needs both custom judges and one failure escalates it',()=>{
  const parent={repo:REPO,number:1},workflow=structuredClone(customWorkflow);workflow.judges.mergeCommit=[];
  const {agenda,facts}=adoptMerged(workflow,parent),id=agenda.closure!.id;
  expect(closureRoles(agenda)).toEqual(['product','operations']);
  expect(agenda.effects).toEqual([]);
  const first=unwrap(verdict(agenda,facts,'product',true,id),'first parent verdict');
  expect(first.closure?.state).toBe('Reviewing');
  expect(closureRoles(first)).toEqual(['operations']);
  expect(first.effects).toEqual([]);
  const failed=unwrap(verdict(first,facts,'operations',false,id),'failed parent verdict');
  expect(failed.closure).toMatchObject({state:'Escalated',revision:2});
  expect(closureRoles(failed)).toEqual([]);
  expect(failed.effects).toEqual([]);
  const passed=unwrap(verdict(first,facts,'operations',true,id),'second parent verdict');
  const close=effectOf(passed,effect=>effect.ticketId===id&&effect.action.kind==='setIssueState');
  expect(effectPrecondition(passed,close,facts)).toBeNull();
  expect(close.action).toMatchObject({issue:parent,open:false});
  facts.issues.find(issue=>issue.ref.number===parent.number)!.state='closed';
  const closed=satisfiedResult(passed,close,facts);if(!closed)throw new Error('Expected parent closure');
  confirmEffect(passed,close,closed,facts,AT);
  expect(passed.closure?.state).toBe('Done');
});

test('an empty parent roster closes the parent without offering a seat',()=>{
  const parent={repo:REPO,number:1},workflow=structuredClone(customWorkflow);workflow.judges.mergeCommit=[];workflow.judges.parent=[];
  const {agenda,facts}=adoptMerged(workflow,parent);
  expect(agenda.closure).toMatchObject({state:'Reviewing',gate:{verdicts:[]}});
  expect(closureRoles(agenda)).toEqual([]);
  const close=effectOf(agenda,effect=>effect.ticketId===agenda.closure!.id&&effect.action.kind==='setIssueState');
  expect(effectPrecondition(agenda,close,facts)).toBeNull();
  facts.issues.find(issue=>issue.ref.number===parent.number)!.state='closed';
  const closed=satisfiedResult(agenda,close,facts);if(!closed)throw new Error('Expected parent closure');
  confirmEffect(agenda,close,closed,facts,AT);
  expect(agenda.closure?.state).toBe('Done');
});

test('parseAgenda rejects missing, extra, reordered or wrong-stage pullRequest verdict roles',()=>{
  const {agenda}=publishTicket(customWorkflow);agenda.id='aaaabbbb-1111-4111-8111-111111111111';
  expect(parseAgenda(agenda).ok).toBe(true);
  const original=ticketOf(agenda).gates.pullRequest!.verdicts;
  for(const roles of [['security'],['security','usability','extra'],['usability','security'],['security','deployment']]){
    const invalid=structuredClone(agenda);
    ticketOf(invalid).gates.pullRequest!.verdicts=roles.map(role=>({role,status:'pending',note:''}));
    expect(parseAgenda(invalid)).toMatchObject({ok:false,error:{path:'tickets'}});
  }
  expect(ticketOf(agenda).gates.pullRequest!.verdicts).toEqual(original);
});

test('parseAgenda rejects mergeCommit and parent verdicts outside their frozen rosters',()=>{
  const {agenda}=adoptMerged(customWorkflow);
  expect(parseAgenda(agenda).ok).toBe(true);
  ticketOf(agenda).gates.mergeCommit!.verdicts[0]!.role='security';
  expect(parseAgenda(agenda)).toMatchObject({ok:false,error:{path:'tickets'}});
  const workflow=structuredClone(customWorkflow);workflow.judges.mergeCommit=[];
  const {agenda:parent}=adoptMerged(workflow,{repo:REPO,number:1});
  expect(parseAgenda(parent).ok).toBe(true);
  parent.closure!.gate.verdicts.reverse();
  expect(parseAgenda(parent)).toMatchObject({ok:false,error:{path:'closure'}});
});
