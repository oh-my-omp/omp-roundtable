import type {ZodLikeSchema} from '@oh-my-pi/omptype/zod';
import {agendaSchema,toolParametersSchema,type Agenda,type ParseError,type Result,type ToolParameters} from './model.ts';

function parse<T>(schema:ZodLikeSchema<T>,value:unknown):Result<T,ParseError> {
  const parsed=schema.safeParse(value);
  if(parsed.success)return {ok:true,value:parsed.data};
  const first=parsed.error.issues[0];
  return {ok:false,error:{path:first?.path.join('.')??'',reason:first?.message??'Invalid input'}};
}
export function parseToolParameters(value:unknown):Result<ToolParameters,ParseError>{return parse(toolParametersSchema,value);}

/** Validate graph integrity at the file/input boundary, not at each internal read. */
export function validateTopology(state:Pick<Agenda,'tickets'>):string|null {
  const byId=new Map(state.tickets.map(ticket=>[ticket.id,ticket]));
  if(byId.size!==state.tickets.length)return 'Ticket IDs must be unique';
  const issues=new Set<string>();
  for(const ticket of state.tickets){
    const key=`${ticket.issue.repo.owner}/${ticket.issue.repo.name}#${ticket.issue.number}`.toLowerCase();
    if(issues.has(key))return 'Each issue must have exactly one ticket';
    issues.add(key);
    if(new Set(ticket.dependsOn).size!==ticket.dependsOn.length)return `Duplicate dependency on ${ticket.id}`;
    for(const dependency of ticket.dependsOn)if(!byId.has(dependency))return `Unknown dependency ${dependency}`;
  }
  const visited=new Set<string>(),visiting=new Set<string>();
  function visit(id:string):boolean {
    if(visiting.has(id))return false;
    if(visited.has(id))return true;
    visiting.add(id);
    for(const dependency of byId.get(id)?.dependsOn??[])if(!visit(dependency))return false;
    visiting.delete(id);visited.add(id);return true;
  }
  for(const ticket of state.tickets)if(!visit(ticket.id))return 'Ticket dependencies must be acyclic';
  return null;
}
export function parseAgenda(value:unknown):Result<Agenda,ParseError> {
  const parsed=parse(agendaSchema,value);if(!parsed.ok)return parsed;
  const topology=validateTopology(parsed.value);
  if(topology)return {ok:false,error:{path:'tickets',reason:topology}};
  const ids=new Set(parsed.value.effects.map(effect=>effect.id));
  if(ids.size!==parsed.value.effects.length)return {ok:false,error:{path:'effects',reason:'Effect IDs must be unique'}};
  for(const effect of parsed.value.effects)if(!parsed.value.tickets.some(ticket=>ticket.id===effect.ticketId)&&effect.ticketId!==parsed.value.closure?.id)return {ok:false,error:{path:'effects',reason:'Effect must belong to a ticket or closure'}};
  return parsed;
}
