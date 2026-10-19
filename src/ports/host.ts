import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {access,mkdir,readdir,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {createAgentSession,z,type AgentSession,type ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {SessionManager} from '@oh-my-pi/pi-coding-agent/session/session-manager';
import {discoverAgents,getAgent} from '@oh-my-pi/pi-coding-agent/task/discovery';
import {cfgTaskAgentModelOverrides,cfgTaskDisabledAgents} from '@oh-my-pi/pi-coding-agent/task/settings';
import {createSubagentSettings} from '@oh-my-pi/pi-coding-agent/task/executor';
import {resolveAgentModelSelection} from '@oh-my-pi/pi-coding-agent/config/model-resolver';
import {initializeExtensions} from '@oh-my-pi/pi-coding-agent/modes/runtime-init';
import {buildPublicGrammar} from '../domain/public-grammar.ts';
import {parseToolParameters} from '../domain/parse.ts';
import type {Caller,PortInput,Repo,Result,Role} from '../domain/model.ts';
import type {HostPort,SeatExit,SeatLaunch,SeatWorkspace} from './contracts.ts';
import type {ControllerOutput,RuntimeError} from '../runtime/controller.ts';

const runFile=promisify(execFile);
const contractSchema=z.object({systemPrompt:z.array(z.string()),tools:z.array(z.string())}).strict();
const handoffSchema=z.object({ticketId:z.string(),notes:z.number().int().nonnegative(),rulings:z.number().int().nonnegative()}).strict();
type LiveSeat={input:SeatLaunch;session:AgentSession|null;done:Promise<void>};
type Worktree={bare:string;path:string};
export type HostOptions={dataDir:string;ticketRevision:(ticketId:string)=>number|null;execute:(caller:Caller,input:PortInput)=>Promise<Result<ControllerOutput,RuntimeError>>;onExit:(seat:SeatExit,handedOff:boolean,error:string|null)=>void;onSeatError:(ticketId:string,message:string)=>void};
async function git(args:readonly string[]):Promise<string>{const {stdout}=await runFile('git',[...args]);return stdout.trim();}

/** Owns only the sessions and worktrees it creates; the native registry owns their identities. */
export function createHostPort(options:HostOptions):HostPort {
  const registry=AgentRegistry.global();
  const seats=new Map<string,LiveSeat>();
  const reposDir=join(options.dataDir,'repos'),worktreesDir=join(options.dataDir,'worktrees'),sessionsDir=join(options.dataDir,'sessions');
  // git holds ref and worktree-admin locks per repository, so every operation on one bare cache runs in order.
  const locks=new Map<string,Promise<unknown>>();
  function locked<T>(bare:string,work:()=>Promise<T>):Promise<T> {
    const result=(locks.get(bare)??Promise.resolve()).then(work);
    locks.set(bare,result.catch(()=>{}));
    return result;
  }
  let disposed=false;
  function main():AgentSession {
    const root=registry.get(MAIN_AGENT_ID);
    if(!root?.session||root.kind!=='main'||root.status==='aborted')throw new Error('The native Main session is unavailable');
    return root.session;
  }
  /**
   * A detached worktree of the repository's bare cache at exactly the commit the seat must build on or judge.
   * The cache is cloned once and fetched before every checkout; seats never clone from the network.
   */
  async function checkout(agendaId:string,seatId:string,cwd:string,spec:Exclude<SeatWorkspace,{kind:'fork'}>):Promise<Worktree> {
    const repo=spec.kind==='base'?spec.target.repo:spec.repo;
    const bare=join(reposDir,`${repo.owner}__${repo.name}.git`.toLowerCase());
    return locked(bare,async()=>{
      if(!await access(join(bare,'HEAD')).then(()=>true,()=>false)){
        await rm(bare,{recursive:true,force:true});await mkdir(reposDir,{recursive:true,mode:0o700});
        await runFile('gh',['repo','clone',`${repo.owner}/${repo.name}`,bare,'--','--bare','--quiet'],{cwd});
        // A bare clone has no remote-tracking refspec; worktrees then fetch and track origin like an ordinary clone.
        await git(['-C',bare,'config','remote.origin.fetch','+refs/heads/*:refs/remotes/origin/*']);
      }
      await git(['-C',bare,'fetch','--prune','--quiet','origin']);
      let commit:string;
      if(spec.kind==='base')commit=await git(['-C',bare,'rev-parse','--verify',`refs/remotes/origin/${spec.target.base}^{commit}`]);
      else {
        // A fork PR head lives only under the base repository's pull ref, not its branches.
        if(spec.pull!==null)await git(['-C',bare,'fetch','--quiet','origin',`+refs/pull/${spec.pull}/head:refs/roundtable/pull/${spec.pull}`]);
        commit=spec.sha;
      }
      const tree={bare,path:join(worktreesDir,agendaId,seatId)};
      await mkdir(dirname(tree.path),{recursive:true,mode:0o700});
      await git(['-C',bare,'worktree','add','--detach','--quiet',tree.path,`${commit}^{commit}`]);
      const head=await git(['-C',tree.path,'rev-parse','HEAD']);
      if(head!==commit){await git(['-C',bare,'worktree','remove','--force',tree.path]);throw new Error(`Seat worktree is at ${head}, not the required ${commit}`);}
      return tree;
    });
  }
  return {
    bind(ctx){
      const ref=registry.get(ctx.agent.id);
      if(!ref?.session||ref.session.sessionManager!==ctx.sessionManager)return {ok:false,error:{kind:'precondition',message:'Caller is not the current native session'}};
      if(ref.id===MAIN_AGENT_ID&&ref.kind==='main')return {ok:true,value:{kind:'main',agentId:ref.id,sessionId:ctx.sessionManager.getSessionId(),sessionFile:ctx.sessionManager.getSessionFile()??null}};
      const seat=seats.get(ref.id),file=ctx.sessionManager.getSessionFile();
      if(!seat||seat.session!==ref.session||!file)return {ok:false,error:{kind:'precondition',message:'Caller is not a one-shot ticket seat'}};
      return {ok:true,value:{kind:'seat',agentId:ref.id,sessionId:ctx.sessionManager.getSessionId(),sessionFile:file,ticketId:seat.input.ticketId,revision:seat.input.revision,role:seat.input.role}};
    },
    active(ticketId,role){return [...seats.values()].some(seat=>seat.input.ticketId===ticketId&&seat.input.role===role);},
    async launch(input){
      if(disposed)return {ok:false,error:{kind:'precondition',message:'Seat host has shut down'}};
      if([...seats.values()].some(seat=>seat.input.ticketId===input.ticketId&&seat.input.role===input.role))return {ok:false,error:{kind:'precondition',message:'Ticket role already has a live session'}};
      const id=`Rt${randomUUID().replaceAll('-','')}`;
      // This is a lifecycle reservation, not an observation of a native session.
      const seat:LiveSeat={input,session:null,done:Promise.resolve()};seats.set(id,seat);
      let manager:SessionManager|undefined,tree:Worktree|null=null;
      const fork=input.workspace.kind==='fork'?input.workspace.sessionFile:null;
      try {
        const parent=main();
        if(!parent.asyncJobManager)throw new Error('Roundtable requires the native async job manager');
        if(parent.getPlanModeState()?.enabled)throw new Error('Roundtable seats require an executing Main');
        const discovery=await discoverAgents(input.cwd,undefined,parent.effectiveExtensionRoots);
        const agent=getAgent([...discovery.agents,...parent.getSessionAgents()],input.agent);
        if(!agent||cfgTaskDisabledAgents.get(parent.settings).includes(input.agent))throw new Error(`Configured seat agent is unavailable: ${input.agent}`);
        if(agent.blocking)throw new Error('Roundtable requires a nonblocking seat agent');
        const sessionDir=join(sessionsDir,input.agendaId);
        await mkdir(sessionDir,{recursive:true,mode:0o700});
        let workspace:string;
        if(input.workspace.kind==='fork'){
          if(input.role!=='owner')throw new Error('Gate sessions must never inherit history');
          const prior=await SessionManager.peekSessionInit(input.workspace.sessionFile);
          if(!prior)throw new Error('Owner fork source has no native session contract');
          workspace=prior.cwd;
          // The controller forks only after the predecessor seat exited and flushed. A tail cut by
          // that exit is repaired into a valid transcript, and the fork does not re-bill inherited spend.
          manager=await SessionManager.forkFrom(input.workspace.sessionFile,workspace,sessionDir,undefined,{copyArtifacts:false,suppressBreadcrumb:true,resetInheritedCost:true,repairInterruptedTail:true});
        }else{
          tree=await checkout(input.agendaId,id,input.cwd,input.workspace);workspace=tree.path;
          manager=SessionManager.create(workspace,sessionDir);
          await manager.ensureOnDisk();
        }
        const sessionFile=manager.getSessionFile();if(!sessionFile)throw new Error('Native seat session must be persistent');
        let inheritedContract:unknown,previousHandoff:unknown;
        for(const entry of manager.getEntries())if(entry.type==='custom'){
          if(entry.customType==='roundtable-session-contract')inheritedContract=entry.data;
          if(entry.customType==='roundtable-handoff')previousHandoff=entry.data;
        }
        const savedContract=contractSchema.safeParse(inheritedContract);
        if(fork&&!savedContract.success)throw new Error('Owner session is missing its original prompt/tool contract');
        const handoff=handoffSchema.safeParse(previousHandoff);
        if(fork&&(!handoff?.success||handoff.data.ticketId!==input.ticketId))throw new Error('Owner fork source does not contain this ticket’s accepted handoff');
        let handedOff=false;
        const caller:Caller={kind:'seat',agentId:id,sessionId:manager.getSessionId(),sessionFile,ticketId:input.ticketId,revision:input.revision,role:input.role};
        const nativeManager=manager;
        const tool:ToolDefinition={name:'roundtable',label:'Roundtable',description:'Read or hand off only your bound ticket. A successful submit/verdict/escalate ends this seat.',parameters:buildPublicGrammar(z).toolParametersSchema,
            async execute(_id,params){
              if(handedOff)return {content:[{type:'text',text:'This seat has already handed off.'}],details:null,isError:true};
              const current=registry.get(id);
              if(!current?.session||current.session!==seat.session)return {content:[{type:'text',text:'Native seat identity changed.'}],details:null,isError:true};
              const parsed=parseToolParameters(params);
              if(!parsed.ok)return {content:[{type:'text',text:JSON.stringify(parsed.error)}],details:null,isError:true};
              const response=await options.execute(caller,parsed.value.input);
              if(response.ok&&['submit','verdict','escalate'].includes(parsed.value.input.op)){
                handedOff=true;
                if(input.role==='owner'&&'ticket' in response.value&&'ownerSessionFile' in response.value.ticket){
                  nativeManager.appendCustomEntry('roundtable-handoff',{ticketId:input.ticketId,notes:response.value.ticket.notes.length,rulings:response.value.ticket.rulings.length});
                }
              }
              return {content:[{type:'text',text:JSON.stringify(response)}],details:response,isError:!response.ok};
            },
        };
        const tools=savedContract?.success?savedContract.data.tools:[...new Set([...(agent.tools??parent.getEnabledToolNames()).filter(name=>!['roundtable','task','fork_task','todo','ask','schedule'].includes(name)),'roundtable'])];
        const override=cfgTaskAgentModelOverrides.get(parent.settings)[input.agent];
        const modelPattern=parent.model?`${parent.model.provider}/${parent.model.id}`:undefined;
        const modelSelection=resolveAgentModelSelection({settings:parent.settings,
          ...(override!==undefined?{settingsOverride:override}:{}),
          ...(agent.model!==undefined?{agentModel:agent.model}:{}),
          ...(modelPattern!==undefined?{activeModelPattern:modelPattern,fallbackModelPattern:modelPattern}:{}),
        });
        const cacheKey=manager.getHeader()?.providerPromptCacheKey??manager.getHeader()?.id;
        const created=await createAgentSession({cwd:workspace,sessionManager:manager,authStorage:parent.modelRegistry.authStorage,modelRegistry:parent.modelRegistry,
          credentialSourceSessionId:parent.sessionManager.getSessionId(),settings:createSubagentSettings(parent.settings),
          ...(!fork&&modelSelection.patterns?{modelPattern:modelSelection.patterns}:{}),
          ...(fork&&cacheKey?{providerPromptCacheKey:cacheKey,providerPromptCacheKeySource:'fork' as const}:{}),
          ...(savedContract.success?{systemPrompt:savedContract.data.systemPrompt}:{appendSystemPrompt:agent.systemPrompt}),
          customTools:[tool],disableExtensionDiscovery:true,toolNames:tools,restrictToolNames:true,allowRestrictedCustomTools:true,
          hasUI:false,bindProcessState:false,cacheWarming:false,enableIrc:false,enableMCP:false,
          agentId:id,agentName:agent.name,agentDisplayName:`${input.role}: ${input.ticketId}`,parentAgentId:MAIN_AGENT_ID,parentTaskPrefix:id,taskDepth:1,expectedAgentRef:null,
          spawns:'',inheritedSessionAgents:parent.getSessionAgents(),
        });
        seat.session=created.session;
        if(!fork){
          manager.appendCustomEntry('roundtable-session-contract',{systemPrompt:created.session.systemPrompt,tools});
          manager.appendSessionInit({systemPrompt:created.session.systemPrompt.join('\n\n'),task:input.prompt,tools,agent:agent.name,readOnly:input.role!=='owner',spawns:''});
        }
        await initializeExtensions(created.session,{reportSendError:(_action,error)=>options.onSeatError(input.ticketId,error.message),reportRuntimeError:error=>options.onSeatError(input.ticketId,error.error)});
        const prompt=fork&&handoff?.success
          ? `Continue ticket ${input.ticketId} at revision ${input.revision}. Only the incremental handoff follows. Call roundtable read if the current contract or PR is needed.\n${JSON.stringify({notes:input.ticket.notes.slice(handoff.data.notes),rulings:input.ticket.rulings.slice(handoff.data.rulings)})}`
          : input.prompt;
        // The Owner's checkout outlives the seat for rework forks until finish; a gate checkout ends with its seat.
        const session=created.session,disposable=input.role==='owner'?null:tree;
        // Like native terminal-yield handling, abort the obsolete tool loop at a
        // tool-completion boundary. Accepted handoffs have already saved their
        // checkpoint and must finish normally, even if their transition bumped revision.
        const unsubscribe=session.subscribe(event=>{
          if(event.type!=='tool_execution_end'||handedOff)return;
          const revision=options.ticketRevision(input.ticketId);
          if(revision!==null&&revision!==input.revision)session.agent.abort('Roundtable seat revision was superseded');
        });
        const completion=Promise.withResolvers<void>();
        seat.done=completion.promise;
        const jobId=parent.asyncJobManager.register('task',`${input.role}: ${input.ticketId}`,async({signal})=>{
          const abort=()=>{void session.abort();};
          signal.addEventListener('abort',abort,{once:true});
          let error:string|null=null;
          try {
            if(signal.aborted)throw new Error('Seat was cancelled before dispatch');
            await session.prompt(prompt);
            await session.waitForIdle();
            while(session.hasPendingAsyncWork()){
              if(signal.aborted)throw new Error('Seat was cancelled while descendant work settled');
              await session.settleAsyncWork();
            }
            return handedOff?`Ticket ${input.ticketId} handed off.`:`Ticket ${input.ticketId} exited without handoff.`;
          }catch(cause){
            error=cause instanceof Error?cause.message:String(cause);
            throw cause;
          }finally {
            signal.removeEventListener('abort',abort);
            unsubscribe();
            try {await session.dispose();}catch(cause){error??=cause instanceof Error?cause.message:String(cause);}
            seats.delete(id);
            try {
              if(disposable)await locked(disposable.bare,()=>git(['-C',disposable.bare,'worktree','remove','--force',disposable.path]));
            }catch(cause){error??=cause instanceof Error?cause.message:String(cause);}
            finally {options.onExit({ticketId:input.ticketId,role:input.role,revision:input.revision},handedOff,error);completion.resolve();}
          }
        },{ownerId:MAIN_AGENT_ID,agentId:id});
        return {ok:true,value:{agentId:id,sessionFile,jobId}};
      }catch(error){
        seats.delete(id);
        if(seat.session)await seat.session.dispose();else if(manager)await manager.close();
        let detail=error instanceof Error?error.message:String(error);
        if(tree){const created=tree;try {await locked(created.bare,()=>git(['-C',created.bare,'worktree','remove','--force',created.path]));}catch(cause){detail+=`; worktree cleanup failed: ${cause instanceof Error?cause.message:String(cause)}`;}}
        return {ok:false,error:{kind:'unavailable',message:detail}};
      }
    },
    async finish(agendaId){
      try {
        const root=join(worktreesDir,agendaId);
        if(dirname(resolve(root))!==resolve(worktreesDir))throw new Error('Invalid agenda worktree directory');
        if(!await access(root).then(()=>true,()=>false))return {ok:true,value:null};
        // Every Owner checkout of this agenda lives under its root; pruning drops their admin entries from each cache.
        await rm(root,{recursive:true,force:true});
        for(const name of await readdir(reposDir))if(name.endsWith('.git')){
          const bare=join(reposDir,name);
          await locked(bare,()=>git(['-C',bare,'worktree','prune']));
        }
        return {ok:true,value:null};
      }catch(error){return {ok:false,error:{kind:'unavailable',message:error instanceof Error?error.message:String(error)}};}
    },
    async dispose(){
      disposed=true;
      const live=[...seats.values()];
      for(const seat of live)if(seat.session)await seat.session.abort();
      await Promise.all(live.map(seat=>seat.done));
      seats.clear();
    },
  };
}
