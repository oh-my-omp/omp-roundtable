import type {Agenda} from './model.ts';
import type {Seat} from './workflow.ts';

/** The handoff contract of a seat's stage; the workflow supplies only the seat's duty. */
function protocol(seat:Seat):string {
  const judge=(checkout:string,failure:string)=>`Your working directory is ${checkout}. Judge it against the complete current contract and the exact gate stamp. Submit roundtable verdict with ticketId, revision, role ${seat.role}, ok, and a concrete evidence note. ${failure} Do not modify code. Use escalate for a non-programmatic question or blocker.`;
  switch(seat.stage){
    case 'owner':return 'Push your code branch. Submit ticketId, revision, branch, head, title, and a complete PR body closing exactly this issue through roundtable submit. If blocked, ambiguous, split, or already satisfied, use escalate with kind question/blocked/split/noCode and evidence. The state machine publishes the PR. Do not merge your branch into the target yourself.';
    case 'pullRequest':return judge('a detached checkout of exactly the pull request head under judgment','A failing verdict returns the ticket to Coding.');
    case 'mergeCommit':return judge('a detached checkout of exactly the merge commit under judgment','A failing verdict escalates the ticket to Main.');
    case 'parent':return judge('a checkout of the target branch after every child ticket was delivered','A failing verdict escalates the parent closure to Main.');
  }
}

/** Seat scope is one ticket. Ordinary user/tool messages carry it once at entry. */
export function seatBrief(state:Agenda,ticketId:string,seat:Seat):string {
  const ticket=state.tickets.find(ticket=>ticket.id===ticketId)??(state.closure?.id===ticketId?state.closure:null);
  if(!ticket)throw new Error('Cannot brief an unknown ticket');
  return [
    `You are the ${seat.role} seat for roundtable ticket ${ticketId}. You own only this ticket.`,
    'Use roundtable read with this ticketId for the current ticket. Do not query other tickets or write GitHub PRs/issues/merges directly; the state machine owns those effects.',
    seat.brief,
    protocol(seat),
    'A successful submit, verdict, or escalate is your handoff. Return immediately afterward; do not wait for another assignment.',
    JSON.stringify(ticket),
  ].join('\n\n');
}
