import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {promisify} from 'node:util';
import {createAgentSession,z,type AgentSession,type ExtensionContext} from '@oh-my-pi/pi-coding-agent';
import type {ToolDefinition} from '@oh-my-pi/pi-coding-agent/extensibility/extensions/types';
import {AgentRegistry,MAIN_AGENT_ID} from '@oh-my-pi/pi-coding-agent/registry/agent-registry';
import {SessionManager} from '@oh-my-pi/pi-coding-agent/session/session-manager';
import {discoverAgents,getAgent} from '@oh-my-pi/pi-coding-agent/task/discovery';
import {cfgTaskAgentModelOverrides,cfgTaskDisabledAgents} from '@oh-my-pi/pi-coding-agent/task/settings';
import {resolveAgentModelSelection} from '@oh-my-pi/pi-coding-agent/config/model-resolver';
import {initializeExtensions} from '@oh-my-pi/pi-coding-agent/modes/runtime-init';
import {buildPublicGrammar} from '../domain/public-grammar.ts';
import {parseToolParameters} from '../domain/parse.ts';
import type {Caller,PortError,PortInput,Result} from '../domain/model.ts';
import type {HostPort,SeatLaunch} from './contracts.ts';
import type {ControllerOutput,RuntimeError} from '../runtime/controller.ts';

const runFile=promisify(execFile);
const contractSchema=z.object({systemPrompt:z.array(z.string()),tools:z.array(z.string())}).strict();
const handoffSchema=z.object({ticketId:z.string(),notes:z.number().int().nonnegative(),rulings:z.number().int().nonnegative()}).strict();
type LiveSeat={input:SeatLaunch;session:AgentSession|null;done:Promise<void>};
export type HostOptions={sessionDir:string;execute:(caller:Caller,input:PortInput,cwd:string)=>Promise<Result<ControllerOutput,RuntimeError>>;onExit:(ticketId:string,handedOff:boolean,error:string|null)=>void};

/** Owns only the sessions it creates; the native registry owns their identities. */
export function createHostPort(options:HostOptions):HostPort {
  const registry=AgentRegistry.global();
  const seats=new Map<string,LiveSeat>();
  let disposed=false;
  function main():AgentSession {
    const root=registry.get(MAIN_AGENT_ID);
    if(!root?.session||root.kind!=='main'||root.status==='aborted')throw new Error('The native Main session is unavailable');
    return root.session;
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
      let manager:SessionManager|undefined,workspace:string|undefined,ephemeralWorkspace=false;
      try {
        const parent=main();
        if(!parent.asyncJobManager)throw new Error('Roundtable requires the native async job manager');
        if(parent.getPlanModeState()?.enabled)throw new Error('Roundtable seats require an executing Main');
        const discovery=await discoverAgents(input.cwd,undefined,parent.effectiveExtensionRoots);
        const agent=getAgent([...discovery.agents,...parent.getSessionAgents()],input.agent);
        if(!agent||cfgTaskDisabledAgents.get(parent.settings).includes(input.agent))throw new Error(`Configured seat agent is unavailable: ${input.agent}`);
        if(agent.blocking)throw new Error('Roundtable requires a nonblocking seat agent');
        await mkdir(options.sessionDir,{recursive:true,mode:0o700});
        if(input.sourceSessionFile){
          if(input.role!=='owner')throw new Error('Gate sessions must never inherit history');
          const prior=await SessionManager.peekSessionInit(input.sourceSessionFile);
          if(!prior)throw new Error('Owner fork source has no native session contract');
          workspace=prior.cwd;
          manager=await SessionManager.forkFrom(input.sourceSessionFile,workspace,options.sessionDir,undefined,{copyArtifacts:false,suppressBreadcrumb:true});
        }else{
          const root=await mkdtemp(join(tmpdir(),'roundtable-seat-'));
          workspace=join(root,'repo');ephemeralWorkspace=input.role!=='owner';
          await runFile('gh',['repo','clone',`${input.workspace.repo.owner}/${input.workspace.repo.name}`,workspace,'--','--quiet'],{cwd:input.cwd});
          await runFile('git',['checkout','--detach',`origin/${input.workspace.base}`],{cwd:workspace});
          manager=SessionManager.create(workspace,options.sessionDir);
          await manager.ensureOnDisk();
        }
        const sessionFile=manager.getSessionFile();if(!sessionFile)throw new Error('Native seat session must be persistent');
        let inheritedContract:unknown,previousHandoff:unknown;
        for(const entry of manager.getEntries())if(entry.type==='custom'){
          if(entry.customType==='roundtable-session-contract')inheritedContract=entry.data;
          if(entry.customType==='roundtable-handoff')previousHandoff=entry.data;
        }
        const savedContract=contractSchema.safeParse(inheritedContract);
        if(input.sourceSessionFile&&!savedContract.success)throw new Error('Owner session is missing its original prompt/tool contract');
        const handoff=handoffSchema.safeParse(previousHandoff);
        if(input.sourceSessionFile&&(!handoff?.success||handoff.data.ticketId!==input.ticketId))throw new Error('Owner fork source does not contain this ticket’s accepted handoff');
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
              const response=await options.execute(caller,parsed.value.input,workspace!);
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
          credentialSourceSessionId:parent.sessionManager.getSessionId(),settings:parent.settings,
          ...(!input.sourceSessionFile&&modelSelection.patterns?{modelPattern:modelSelection.patterns}:{}),
          ...(input.sourceSessionFile&&cacheKey?{providerPromptCacheKey:cacheKey,providerPromptCacheKeySource:'fork' as const}:{}),
          ...(savedContract.success?{systemPrompt:savedContract.data.systemPrompt}:{appendSystemPrompt:agent.systemPrompt}),
          customTools:[tool],disableExtensionDiscovery:true,toolNames:tools,restrictToolNames:true,allowRestrictedCustomTools:true,
          hasUI:false,bindProcessState:false,cacheWarming:false,enableIrc:false,enableMCP:false,
          agentId:id,agentName:agent.name,agentDisplayName:`${input.role}: ${input.ticketId}`,parentAgentId:MAIN_AGENT_ID,parentTaskPrefix:id,taskDepth:1,expectedAgentRef:null,
          spawns:'',inheritedSessionAgents:parent.getSessionAgents(),
        });
        seat.session=created.session;
        if(!input.sourceSessionFile){
          manager.appendCustomEntry('roundtable-session-contract',{systemPrompt:created.session.systemPrompt,tools});
          manager.appendSessionInit({systemPrompt:created.session.systemPrompt.join('\n\n'),task:input.prompt,tools,agent:agent.name,readOnly:input.role!=='owner',spawns:''});
        }
        await initializeExtensions(created.session,{reportSendError:(_action,error)=>options.onExit(input.ticketId,false,error.message),reportRuntimeError:error=>options.onExit(input.ticketId,false,error.error)});
        const prompt=input.sourceSessionFile&&handoff?.success
          ? `Continue ticket ${input.ticketId} at revision ${input.revision}. Only the incremental handoff follows. Call roundtable read if the current contract or PR is needed.\n${JSON.stringify({notes:input.ticket.notes.slice(handoff.data.notes),rulings:input.ticket.rulings.slice(handoff.data.rulings)})}`
          : input.prompt;
        const session=created.session,ownedWorkspace=workspace,cleanupWorkspace=ephemeralWorkspace;
        const completion=Promise.withResolvers<void>();
        seat.done=completion.promise;
        const jobId=parent.asyncJobManager.register('task',`${input.role}: ${input.ticketId}`,async({signal})=>{
          const abort=()=>{void session.abort();};
          signal.addEventListener('abort',abort,{once:true});
          let error:string|null=null;
          try {
            if(signal.aborted)throw new Error('Seat was cancelled before dispatch');
            await session.prompt(prompt);
            return handedOff?`Ticket ${input.ticketId} handed off.`:`Ticket ${input.ticketId} exited without handoff.`;
          }catch(cause){
            error=cause instanceof Error?cause.message:String(cause);
            throw cause;
          }finally {
            signal.removeEventListener('abort',abort);
            try {await session.dispose();}catch(cause){error??=cause instanceof Error?cause.message:String(cause);}
            seats.delete(id);
            try {
              if(cleanupWorkspace)await rm(join(ownedWorkspace,'..'),{recursive:true,force:true});
            }catch(cause){error??=cause instanceof Error?cause.message:String(cause);}
            finally {options.onExit(input.ticketId,handedOff,error);completion.resolve();}
          }
        },{ownerId:MAIN_AGENT_ID,agentId:id});
        return {ok:true,value:{agentId:id,sessionFile,jobId}};
      }catch(error){
        seats.delete(id);
        if(seat.session)await seat.session.dispose();else if(manager)await manager.close();
        if(workspace&&ephemeralWorkspace)await rm(join(workspace,'..'),{recursive:true,force:true});
        const detail:PortError={kind:'unavailable',message:error instanceof Error?error.message:String(error)};
        return {ok:false,error:detail};
      }
    },
    async finish(files){
      try {
        for(const file of files){
          if(!resolve(file).startsWith(`${resolve(options.sessionDir)}${sep}`))throw new Error('Owner session is outside the owned session directory');
          const prior=await SessionManager.peekSessionInit(file);
          if(!prior)throw new Error(`Cannot inspect Owner workspace for ${file}`);
          const root=dirname(prior.cwd);
          if(basename(prior.cwd)!=='repo'||!basename(root).startsWith('roundtable-seat-')||root!==join(tmpdir(),basename(root)))throw new Error('Refusing to remove a workspace not created by this seat host');
          await rm(root,{recursive:true,force:true});
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
