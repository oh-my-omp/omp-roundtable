# 远端对账与裁定接入

```vdm
module Reconcile
imports
  from Ticket
    types
      TicketId renamed TicketId;
      Revision renamed Revision;
      TicketRecord renamed TicketRecord;
      Escalated renamed Escalated
    functions
      Launchable renamed Launchable
    operations
      Snapshot renamed Snapshot;
      Escalate renamed Escalate;
      Resolve renamed Resolve;
      Complete renamed Complete,
  from Effect
    types
      EffectId renamed EffectId
    functions
      BlockedTickets renamed BlockedTickets
    operations
      Reconcile renamed ReconcileEffect;
      Cancel renamed CancelEffect;
      PendingEffects renamed PendingEffects,
  from Attention
    types
      Decision renamed Decision
    operations
      Observe renamed Observe
exports
  functions
    OpenDecisions: map TicketId to TicketRecord * map EffectId to TicketId -> set of Decision
  operations
    SettleUncertainWrite: TicketId * Revision * EffectId ==> ();
    ResolveEscalated: TicketId * EffectId ==> set of Decision;
    NotifyMain: () ==> set of Decision
definitions
functions
  -- 从票据表快照与未决写入意图映射投影出当前需要主协调器介入的待决决策集合；两个实现必须得出同一集合
  OpenDecisions: map TicketId to TicketRecord * map EffectId to TicketId -> set of Decision
  OpenDecisions(ts, pending) ==
    let blocked = BlockedTickets(pending, dom pending) in
    {mk_Decision(<Launch>, id, nil) | id in set dom ts & Launchable(ts, id) and id not in set blocked}
    union
    {mk_Decision(<Escalated>, id, ts(id).revision) | id in set dom ts & ts(id).status = <Escalated>}
    union
    (if ts <> {|->}
        and pending = {|->}
        and (forall t in set rng ts & t.status = <Done>)
     then {mk_Decision(<Finish>, nil, nil)}
     else {});

operations
  -- 场景：对结果未知的写入意图执行远端对账；已生效则完成票据，未生效则升级票据并按新修订号唤醒主协调器
  SettleUncertainWrite: TicketId * Revision * EffectId ==> ()
  SettleUncertainWrite(ticket, rev, effect) ==
    cases ReconcileEffect(effect):
      <Confirmed> ->
        let - = Complete(ticket, rev) in skip,
      <Absent> ->
        cases Escalate(ticket):
          mk_Escalated(nextRev) ->
            let - = Observe({mk_Decision(<Escalated>, ticket, nextRev)}) in skip,
          <Rejected> -> skip
        end
    end;

  -- 场景：主协调器取消未决写入意图、裁定恢复升级票据，并同步回合末通知状态
  ResolveEscalated: TicketId * EffectId ==> set of Decision
  ResolveEscalated(ticket, effect) ==
    (CancelEffect(effect);
     let - = Resolve(ticket) in
       return NotifyMain());

  -- 场景：在主协调器回合结束时读取当前票据与未决意图快照，投影待决决策并过滤已通知事项
  NotifyMain: () ==> set of Decision
  NotifyMain() ==
    let ts = Snapshot(),
        pending = PendingEffects() in
      return Observe(OpenDecisions(ts, pending));
end Reconcile
```
