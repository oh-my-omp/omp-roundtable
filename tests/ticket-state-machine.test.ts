import {describe,expect,test} from 'bun:test';
import {createHash} from 'node:crypto';
import type {Agenda,Caller,Effect,Facts,IssueRef,IssueSnapshot,MaintenanceObservation,PrSnapshot,Repo,RepoSnapshot,Result,Role,Target,Ticket} from '../src/domain/model.ts';
import {applyOperation,availableRoles,confirmEffect,createAgenda,effectPrecondition,reconcile,satisfiedResult} from '../src/domain/engine.ts';

// Regression coverage for the Ticket delivery lifecycle through the domain
// engine's exported API. Effects are confirmed the way RoundtableController
// does it: reconcile the observed Facts (settle), ask satisfiedResult for a
// source-confirmed result, then confirmEffect (drive). No GitHub port is faked;
// confirmation is earned from typed Facts instead.

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
  return {repo:REPO,defaultBranch:'main',defaultHead:head,bases:[{name:'main',state:{kind:'present',head,isDefault:true,rules:{required:[],strict:true,upToDate:true,constraints:[]}}}]};
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
