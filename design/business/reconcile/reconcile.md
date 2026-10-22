# 远端对账与裁定接入

```vdm
module Reconcile
imports
  from Ticket
    types
      TicketId renamed TicketId;
      TicketRecord renamed TicketRecord;
      Escalated renamed Escalated
    functions
      Launchable renamed Launchable
    operations
      Escalate renamed Escalate;
      Resolve renamed Resolve,
  from Effect
    types
      EffectId renamed EffectId
    functions
      BlockedTickets renamed BlockedTickets
    operations
      Reconcile renamed ReconcileEffect;
      Cancel renamed CancelEffect,
  from Attention
    types
      Decision renamed Decision
    operations
      Observe renamed Observe
exports
  functions
    OpenDecisions: map TicketId to TicketRecord * map EffectId to TicketId * set of EffectId -> set of Decision
  operations
    SettleUncertainWrite: TicketId * EffectId ==> ();
    ResolveEscalated: TicketId * EffectId ==> ();
    NotifyMain: map TicketId to TicketRecord * map EffectId to TicketId * set of EffectId ==> set of Decision
definitions
functions
  -- 从票据表与未决写入意图表投影出当前需要主协调器介入的待决决策集合；两个实现必须得出同一集合
  OpenDecisions: map TicketId to TicketRecord * map EffectId to TicketId * set of EffectId -> set of Decision
  OpenDecisions(ts, byTicket, unresolved) ==
    let blocked = BlockedTickets(byTicket, unresolved) in
    {mk_Decision(id, nil) | id in set dom ts & Launchable(ts, id) and id not in set blocked}
    union
    {mk_Decision(id, ts(id).revision) | id in set dom ts & ts(id).status = <Escalated>}
    union
    (if ts <> {|->}
        and unresolved = {}
        and (forall t in set rng ts & t.status = <Done>)
     then {mk_Decision(nil, nil)}
     else {});

operations
  -- 场景：对结果未知的写入意图执行远端对账；已生效则完成票据，未生效则升级票据并按新修订号唤醒主协调器
  SettleUncertainWrite: TicketId * EffectId ==> ()
  SettleUncertainWrite(ticket, effect) ==
    cases ReconcileEffect(effect):
      <Confirmed> -> skip,
      <Absent> ->
        cases Escalate(ticket):
          mk_Escalated(nextRev) ->
            let - = Observe({mk_Decision(ticket, nextRev)}) in skip,
          <Rejected> -> skip
        end
    end;

  -- 场景：主协调器取消未决写入意图并裁定恢复升级票据
  ResolveEscalated: TicketId * EffectId ==> ()
  ResolveEscalated(ticket, effect) ==
    (CancelEffect(effect);
     let - = Resolve(ticket) in skip);

  -- 场景：在主协调器回合结束时投影当前待决决策并过滤已通知事项
  NotifyMain: map TicketId to TicketRecord * map EffectId to TicketId * set of EffectId ==> set of Decision
  NotifyMain(ts, byTicket, unresolved) ==
    return Observe(OpenDecisions(ts, byTicket, unresolved));
end Reconcile
```
