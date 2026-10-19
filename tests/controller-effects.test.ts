import {expect,test} from 'bun:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {Caller,Facts,PortError,Result} from '../src/domain/model.ts';
import type {GitHubPort,HostPort} from '../src/ports/contracts.ts';
import {createAgendaFiles} from '../src/ports/state.ts';
import {RoundtableController} from '../src/runtime/controller.ts';
import {bodyHash} from '../src/domain/identity.ts';

const repository={owner:'test',name:'roundtable'};
const issue={repo:repository,number:1};
const head='1'.repeat(40),base='2'.repeat(40);
const facts:Facts={viewer:'test',issues:[{ref:issue,body:'Deliver the ticket.',bodyHash:bodyHash('Deliver the ticket.'),updatedAt:1,state:'open',lastClose:null,lastReopen:null,children:[]}],prs:[],links:[],repos:[{repo:repository,defaultBranch:'main',defaultHead:base,bases:[{name:'main',state:{kind:'present',head:base,isDefault:true,rules:{required:[],strict:false,constraints:[]}}}]}],branches:[{repo:repository,name:'feature',state:{kind:'present',head}}],maintenance:[],commits:[],checkAttempts:[],createdIssues:[]};
function unexpected():never {throw new Error('Unexpected port call');}
const host:HostPort={bind:unexpected,launch:unexpected,active:()=>false,finish:async()=>({ok:true,value:null}),dispose:async()=>{}};
function success<T>(value:T):Result<T,PortError>{return {ok:true,value};}

for(const operation of ['publishPr','merge'] as const)test(`an unknown ${operation} is durable before dispatch and is not resent on refresh or resume`,async()=>{
  const root=await mkdtemp(join(tmpdir(),'roundtable-effect-'));
  const files=createAgendaFiles(root),source=structuredClone(facts);
  const prRef={repo:repository,number:2};
  if(operation==='merge')source.prs.push({ref:prRef,headRepo:repository,headBranch:'feature',head,target:{repo:repository,base:'main'},title:'Deliver one',body:'Closes test/roundtable#1',bodyHash:bodyHash('Closes test/roundtable#1'),updatedAt:1,state:{kind:'open'},closes:[issue],mergeable:'yes',checks:{kind:'passing',required:[]}});
  let calls=0,executingOnDisk=false;
  let controller:RoundtableController;
  async function unknownWrite():Promise<Result<never,PortError>> {
    calls++;
    const snapshot=controller.snapshot();if(!snapshot)throw new Error('Agenda disappeared before dispatch');
    const durable=await files.load(snapshot.id);if(!durable.ok)throw new Error(durable.error.message);
    executingOnDisk=durable.value.effects.some(effect=>effect.action.kind===operation&&effect.state.kind==='executing');
    return {ok:false,error:{kind:'uncertainOutcome',message:'Connection ended without an outcome'}};
  }
  const github:GitHubPort={
    facts:async()=>success(structuredClone(source)),openPrsByHead:async()=>success([]),
    contains:unexpected,branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,
    createIssue:unexpected,addSubIssue:unexpected,editIssueBody:unexpected,setIssueOpen:unexpected,editPr:unexpected,rerunCheck:unexpected,
    createPr:operation==='publishPr'?unknownWrite:unexpected,mergePr:operation==='merge'?unknownWrite:unexpected,
  };
  const errors:unknown[]=[];
  controller=new RoundtableController({files,github,host,ownerAgent:'task:free',gateAgent:'task:free',intervalSeconds:3600,onChange:()=>{},onError:error=>errors.push(error)});
  const main:Caller={kind:'main',agentId:'Main',sessionId:'first-main',sessionFile:null};controller.setMain(main);
  try {
    const convened=await controller.execute(main,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:operation==='merge'?prRef:null}]},root);
    expect(convened.ok).toBe(true);
    const owner:Caller={kind:'seat',agentId:'Owner',sessionId:'first-owner',sessionFile:join(root,'owner.jsonl'),ticketId:'one',revision:1,role:'owner'};
    if(operation==='publishPr')expect((await controller.execute(owner,{op:'submit',ticketId:'one',revision:1,branch:'feature',head,title:'Deliver one',body:'Closes test/roundtable#1'},root)).ok).toBe(true);
    else for(const role of ['review','accept'] as const){
      const gate:Caller={kind:'seat',agentId:role,sessionId:role,sessionFile:join(root,`${role}.jsonl`),ticketId:'one',revision:1,role};
      expect((await controller.execute(gate,{op:'verdict',ticketId:'one',revision:1,role,ok:true,note:'Verified the exact contract and head.'},root)).ok).toBe(true);
    }
    if(operation==='merge'){
      source.prs[0]!.mergeable='unknown';
      await controller.run();
      expect(calls).toBe(0);
      expect(controller.snapshot()?.effects[0]?.state.kind).toBe('ready');
      expect(controller.snapshot()?.tickets[0]?.state).toBe('Merging');
      source.prs[0]!.mergeable='yes';
    }
    await controller.run();await controller.run();
    const failed=controller.snapshot();if(!failed)throw new Error('Missing agenda');
    expect(executingOnDisk).toBe(true);
    expect(calls).toBe(1);
    expect(failed.effects[0]?.state.kind).toBe('uncertain');
    expect(failed.tickets[0]?.state).toBe('Escalated');
    if(operation==='publishPr')expect(failed.tickets[0]?.ownerSessionFile).toBe(owner.sessionFile);
    await controller.shutdown();
    controller=new RoundtableController({files,github,host,ownerAgent:'task:free',gateAgent:'task:free',intervalSeconds:3600,onChange:()=>{},onError:error=>errors.push(error)});
    const successor:Caller={kind:'main',agentId:'Main',sessionId:'second-main',sessionFile:null};controller.setMain(successor);
    expect((await controller.execute(successor,{op:'resume',agenda:failed.id,operatorConfirmedOriginalSessionEnded:true},root)).ok).toBe(true);
    await controller.run();await controller.run();
    expect(calls).toBe(1);
    expect(controller.snapshot()?.effects[0]?.state.kind).toBe('uncertain');
    if(operation==='publishPr')expect(controller.snapshot()?.tickets[0]?.ownerSessionFile).toBe(owner.sessionFile);
    expect(errors).toEqual([]);
  }finally {await controller.shutdown();await rm(root,{recursive:true,force:true});}
});

test('Main can adopt a source-confirmed external merge below the target head in one resolution',async()=>{
  const root=await mkdtemp(join(tmpdir(),'roundtable-adopt-'));
  const source=structuredClone(facts),merge='3'.repeat(40),prRef={repo:repository,number:7};
  source.issues[0]!.state='closed';source.issues[0]!.lastClose={id:'closed',at:3};
  source.prs.push({ref:prRef,headRepo:repository,headBranch:'feature',head,target:{repo:repository,base:'main'},title:'Externally merged',body:'Closes test/roundtable#1',bodyHash:bodyHash('Closes test/roundtable#1'),updatedAt:3,state:{kind:'merged',sha:merge,at:3},closes:[issue],mergeable:'unknown',checks:{kind:'passing',required:[]}});
  const comparisons:string[]=[];
  const github:GitHubPort={
    facts:async scope=>success({...structuredClone(source),prs:source.prs.filter(pr=>scope.prs.some(wanted=>wanted.number===pr.ref.number))}),
    contains:async(_repo,ancestor,descendant)=>{comparisons.push(`${ancestor}:${descendant}`);return success('contains');},
    openPrsByHead:async()=>success([]),branchHead:unexpected,issue:unexpected,pr:unexpected,issuesCreatedSince:unexpected,checkAttempt:unexpected,createIssue:unexpected,addSubIssue:unexpected,editIssueBody:unexpected,setIssueOpen:unexpected,editPr:unexpected,rerunCheck:unexpected,createPr:unexpected,mergePr:unexpected,
  };
  const controller=new RoundtableController({files:createAgendaFiles(root),github,host,ownerAgent:'task:free',gateAgent:'task:free',intervalSeconds:3600,onChange:()=>{},onError:unexpected});
  const main:Caller={kind:'main',agentId:'Main',sessionId:'external-main',sessionFile:null};controller.setMain(main);
  try {
    expect((await controller.execute(main,{op:'convene',parent:null,tickets:[{id:'one',issue,target:{repo:repository,base:'main'},dependsOn:[],adoptPr:null}]},root)).ok).toBe(true);
    const adopted=await controller.execute(main,{op:'resolve',ticketId:'one',revision:1,ruling:'The author merged this change externally; the current target contains its merge.',to:'Done',adoptPr:prRef},root);
    expect(adopted.ok).toBe(true);
    expect(comparisons).toContain(`${merge}:${base}`);
    expect(controller.snapshot()?.tickets[0]).toMatchObject({state:'Done',terminal:{kind:'merged',mergeSha:merge}});
  }finally {await controller.shutdown();await rm(root,{recursive:true,force:true});}
});
