import type {Agenda,Role} from './model.ts';

/** Seat scope is one ticket. Ordinary user/tool messages carry it once at entry. */
export function seatBrief(state:Agenda,ticketId:string,role:Role):string {
  const ticket=state.tickets.find(ticket=>ticket.id===ticketId)??(state.closure?.id===ticketId?state.closure:null);
  if(!ticket)throw new Error('Cannot brief an unknown ticket');
  return [
    `You are the ${role} seat for roundtable ticket ${ticketId}. You own only this ticket.`,
    'Use roundtable read with this ticketId for the current ticket. Do not query other tickets or write GitHub PRs/issues/merges directly; the state machine owns those effects.',
    role==='owner'
      ? 'Implement the issue contract and current Main rulings. Push your code branch. Submit ticketId, revision, branch, head, title, and a complete PR body closing exactly this issue through roundtable submit. If blocked, ambiguous, split, or already satisfied, use escalate with kind question/blocked/split/noCode and evidence. The state machine publishes the PR. Do not merge your branch into the target yourself.'
      : 'Your working directory is a detached checkout of exactly the commit under judgment: the PR head for review/accept, the merge commit for postMerge, the target branch for closure. Independently verify the complete current contract and exact gate stamp against it, not just prior findings. Submit roundtable verdict with ticketId, revision, your role, ok, and a concrete evidence note. Review/accept fail returns to Coding; postMerge/closure fail escalates to Main. Do not modify code. Use escalate for a non-programmatic question or blocker.',
    'A successful submit, verdict, or escalate is your handoff. Return immediately afterward; do not wait for another assignment.',
    JSON.stringify(ticket),
  ].join('\n\n');
}
