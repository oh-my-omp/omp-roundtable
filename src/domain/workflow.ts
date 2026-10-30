import {JUDGE_STAGES,type Judge,type JudgeStage,type Role,type Verdict,type Workflow} from './model.ts';

/** The Owner seat's fixed name; every other seat name comes from the workflow. */
export const OWNER:Role='owner';
/** A configured seat: the Owner, or one judge of one judged stage. */
export type Seat={stage:'owner';role:Role;agent:string;brief:string}|{stage:JudgeStage;role:Role;agent:string;brief:string};

/** Seat names key verdicts, notes and seat lifetimes across the agenda, so each name denotes exactly one seat. */
export function validateWorkflow(workflow:Workflow):string|null {
  const seen=new Set<Role>([OWNER]);
  for(const stage of JUDGE_STAGES)for(const judge of workflow.judges[stage]){
    if(judge.role===OWNER)return `Judge role ${OWNER} is reserved for the Owner seat`;
    if(seen.has(judge.role))return `Role ${judge.role} is configured more than once`;
    seen.add(judge.role);
  }
  return null;
}
export function seatOf(workflow:Workflow,role:Role):Seat|null {
  if(role===OWNER)return {stage:'owner',role,...workflow.owner};
  for(const stage of JUDGE_STAGES){
    const judge=workflow.judges[stage].find(item=>item.role===role);
    if(judge)return {stage,...judge};
  }
  return null;
}
/** Every seat a delivery ticket can hold, in configured order. */
export function ticketSeatRoles(workflow:Workflow):Role[] {
  return [OWNER,...workflow.judges.pullRequest.map(judge=>judge.role),...workflow.judges.mergeCommit.map(judge=>judge.role)];
}
export function parentSeatRoles(workflow:Workflow):Role[] {return workflow.judges.parent.map(judge=>judge.role);}
export function openVerdicts(roster:readonly Judge[]):Verdict[] {return roster.map(judge=>({role:judge.role,status:'pending',note:''}));}
/** The frozen roster, not the recorded verdicts, decides which judges a stage requires; an empty roster passes. */
export function stagePassed(roster:readonly Judge[],verdicts:readonly Verdict[]):boolean {
  return roster.every(judge=>verdicts.some(verdict=>verdict.role===judge.role&&verdict.status==='passed'));
}
export function pendingRoles(roster:readonly Judge[],verdicts:readonly Verdict[]):Role[] {
  return roster.filter(judge=>verdicts.some(verdict=>verdict.role===judge.role&&verdict.status==='pending')).map(judge=>judge.role);
}
/** Recorded verdicts must name exactly the stage's configured judges, in order. */
export function verdictsMatch(roster:readonly Judge[],verdicts:readonly Verdict[]):boolean {
  return roster.length===verdicts.length&&roster.every((judge,index)=>verdicts[index]!.role===judge.role);
}
