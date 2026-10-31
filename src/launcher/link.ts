import {stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {parseIssueReference,refKey} from '../domain/identity.ts';
import type {IssueRef,Result} from '../domain/model.ts';
import {diagnosticText} from './diagnostics.ts';

/**
 * Fixed by the published link contract. A configurable port would invalidate
 * every link already written into an issue, so it is a constant, not a setting.
 */
export const LAUNCHER_PORT=47591;
export const LAUNCHER_ORIGIN=`http://127.0.0.1:${LAUNCHER_PORT}`;

export type LaunchTarget={frontend:'tern';issue:IssueRef;reference:string;cwd:string};
export type Rejection={kind:'rejected';reason:string};

export function refuse(reason:string):{ok:false;error:Rejection} {return {ok:false,error:{kind:'rejected',reason}};}

/**
 * Only a user's top-level click may start an agent. Any page can GET
 * `127.0.0.1` through an image, a fetch or a prefetch, and GitHub's
 * `no-referrer-when-downgrade` policy drops Referer on the https→http hop, so
 * the click itself is the authorization the operator gives.
 */
export function isUserNavigation(navigation:{mode:string|undefined;user:string|undefined}):boolean {
  return navigation.mode==='navigate'&&navigation.user==='?1';
}

/** The link's path: `/<frontend>/<owner>/<repo>/issues/<number>`. */
export function parseLinkPath(pathname:string):Result<IssueRef,Rejection> {
  const segments=pathname.split('/').filter(segment=>segment.length>0);
  if(segments.length!==5)return refuse(diagnosticText({kind:'linkPath'}));
  const [frontend,owner,repo,kind,number]=segments as [string,string,string,string,string];
  if(frontend!=='tern')return refuse(diagnosticText({kind:'frontend',frontend}));
  if(kind!=='issues')return refuse(diagnosticText({kind:'issuePath'}));
  const reference=`${owner}/${repo}#${number}`,issue=parseIssueReference(reference);
  return issue.ok?{ok:true,value:issue.value}:refuse(diagnosticText({kind:'issueReference',value:reference}));
}

/**
 * `cwd` is the coordinator's local checkout and travels in the link. The
 * launcher neither reconciles it with the linked repository nor clones or maps
 * anything: a writer of the link is responsible for its truth, and only its
 * being an existing absolute directory is a precondition for starting a process
 * in it.
 */
export async function resolveTarget(input:{pathname:string;search:string}):Promise<Result<LaunchTarget,Rejection>> {
  const path=parseLinkPath(input.pathname);
  if(!path.ok)return path;
  const cwd=new URLSearchParams(input.search).get('cwd');
  if(cwd===null||cwd.length===0)return refuse(diagnosticText({kind:'missingCwd'}));
  if(!isAbsolute(cwd))return refuse(diagnosticText({kind:'relativeCwd',cwd}));
  const directory=await stat(cwd).catch(()=>null);
  if(!directory?.isDirectory())return refuse(diagnosticText({kind:'missingDirectory',cwd}));
  return {ok:true,value:{frontend:'tern',issue:path.value,reference:refKey(path.value),cwd}};
}
