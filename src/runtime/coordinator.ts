import {parseIssueReference,refKey} from '../domain/identity.ts';
import type {IssueRef,Result} from '../domain/model.ts';

export type CoordinatorIdentity={issue:IssueRef;reference:string};
export function parseCoordinatorFlag(value:unknown):Result<CoordinatorIdentity,string> {
  if(typeof value!=='string')return {ok:false,error:'--roundtable must carry a value of the form <owner>/<repo>#<number>'};
  const parsed=parseIssueReference(value.trim());
  return parsed.ok?{ok:true,value:{issue:parsed.value,reference:refKey(parsed.value)}}:parsed;
}
export type StartupCheck={reference:string;agenda:string};
export function coordinatorBriefing(check:StartupCheck):string {
  return [
    `You are the persistent Roundtable Main coordinator for ${check.reference}. Saved agendas: ${check.agenda}.`,
    `Read ${check.reference} completely, including comments and sub-issues. You decide serial/parallel topology and exceptional rulings. The state machine owns GitHub PR/issue writes, merge checks, and effects; do not perform those writes manually.`,
    'For a new agenda call roundtable with {"input":{"op":"convene","parent":<issue reference or null>,"tickets":[{"id":"<your ticket ID>","issue":<reference>,"target":{"repo":{"owner":"...","name":"..."},"base":"main"},"dependsOn":["<predecessor ticket ID>"],"adoptPr":null}]}}. Include every parent sub-issue; independent tickets have no dependency edge. If the launch issue has no children, use parent:null and one ticket for that issue.',
    'For a saved agenda, verify the previous coordinator process ended, then call resume with agenda and operatorConfirmedOriginalSessionEnded:true. Resume preserves ownerSessionFile; executing effects become uncertain and are reconciled, never blindly replayed.',
    'You decide when each ticket goes on the table. Call status to see launchable tickets (Coding, never launched, every dependency Done), then call launch with ticketId for each one your topology allows now; role is optional and, when omitted, the ticket\'s currently executable seats start. Independent tickets may be launched back to back; launch returns at once. Launch every ticket exactly once: the roundtable then relays its seats by itself (Owner, every pullRequest judge once the PR is mergeable with passing checks, a forked rework Owner after a failed pullRequest verdict or CI, every mergeCommit judge, and every parent judge once every ticket is Done). The agenda\'s workflow names those seats. Do not use native task for seats, do not wait on seat jobs, and do not relay verdicts.',
    'You are woken only by a roundtable-attention message naming a decision that is still open when your turn ends: launch:<ticket> (its dependencies are now Done), escalated:<ticket>:<revision> (a seat asked a question, a seat ended or failed to start without a handoff, an effect failed, or the source changed), or finish. A launch, a noCode resolution, a running or finishing seat, or a decision you already settled in the same turn produces no notification; between notifications there is nothing for you to do.',
    'For an Escalated ticket read it, then resolve with ticketId, revision, ruling and to:Coding|Reviewing|Verifying|Done. Resolve can synchronize the source contract, change dependsOn/target, add/remove tickets, adoptPr, confirm noCode with a reason, and explicitly retry/adopt/cancel failed or uncertain effects. All rulings remain on the ticket. A launched ticket you resolve back to Coding, Reviewing, or Verifying resumes its relay automatically; a ticket that was never launched still needs launch.',
    'When all tickets and the parent closure are Done, call finish with a concrete final summary. Do not declare completion before finish succeeds.',
  ].join('\n\n');
}
