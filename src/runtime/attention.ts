import {SEAT_ROLES,type Agenda,type Role} from '../domain/model.ts';
import {awaitsLaunch} from '../domain/engine.ts';

/**
 * The decisions only Main can make, one key each: a ticket it may put on the table, an Escalated ticket or
 * closure awaiting its ruling (keyed by revision, so a re-escalation is new), and a finished agenda awaiting
 * `finish`. Seats running, effects in flight, and a confirmed noCode closure on its way are not decisions.
 */
export function attentionKeys(agenda:Agenda,active:(ticketId:string,role:Role)=>boolean):string[] {
  if(agenda.lifecycle!=='active')return [];
  const keys:string[]=[];
  for(const ticket of agenda.tickets){
    if(awaitsLaunch(agenda,ticket))keys.push(`launch:${ticket.id}`);
    const closing=ticket.terminal?.kind==='noCode'&&agenda.effects.some(effect=>effect.ticketId===ticket.id&&effect.action.kind==='setIssueState'&&!effect.action.open&&(effect.state.kind==='ready'||effect.state.kind==='executing'));
    if(ticket.state==='Escalated'&&!closing)keys.push(`escalated:${ticket.id}:${ticket.revision}`);
  }
  if(agenda.closure?.state==='Escalated')keys.push(`escalated:${agenda.closure.id}:${agenda.closure.revision}`);
  const settled=agenda.tickets.every(ticket=>ticket.state==='Done')&&(!agenda.parent||agenda.closure?.state==='Done')
    &&agenda.effects.every(effect=>effect.state.kind==='confirmed'||effect.state.kind==='cancelled')
    &&![...agenda.tickets.map(ticket=>ticket.id),...(agenda.closure?[agenda.closure.id]:[])].some(id=>SEAT_ROLES.some(role=>active(id,role)));
  if(settled)keys.push('finish');
  return keys;
}

/** Wakes Main only for a decision it has not been told about; resolved decisions leave silently. */
export class Attention {
  private notified=new Set<string>();
  /** The decisions that are new since the previous observation, or an empty list when Main need not wake. */
  observe(agenda:Agenda,active:(ticketId:string,role:Role)=>boolean):string[] {
    const keys=attentionKeys(agenda,active);
    const fresh=keys.filter(key=>!this.notified.has(key));
    this.notified=new Set(keys);
    return fresh;
  }
}
