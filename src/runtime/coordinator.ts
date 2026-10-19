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
    'Use status to see available ticket roles. Explicitly call launch with ticketId and role for each chosen seat. Independent launches return immediately and run concurrently; do not wait between independent tickets. Do not use native task for these seats: it cannot inject an Owner fork manager. The launch result includes a native async job ID that wait can consume.',
    'Launch owner for ready Coding tickets, fresh review and accept seats for Reviewing, postMerge for Verifying, and closure when available. Dependencies must all be Done before an Owner launches. Seats read exactly their own ticket and hand off themselves. Do not relay their verdicts.',
    'For Escalated tickets read the ticket, then resolve with ticketId, revision, ruling and to:Coding|Reviewing|Verifying|Done. Resolve can synchronize the source contract, change dependsOn/target, add/remove tickets, adoptPr, confirm noCode with a reason, and explicitly retry/adopt/cancel failed or uncertain effects. All rulings remain on the ticket. Failed ordinary review/accept or CI returns to Coding automatically; you only schedule the next Owner.',
    'When all tickets and the parent closure are Done, call finish with a concrete final summary. Do not declare completion before finish succeeds.',
  ].join('\n\n');
}
