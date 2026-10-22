# 远端对账与裁定接入

```vdm
module Reconcile
imports
  from Ticket
    types
      TicketId renamed TicketId;
      Stamp renamed Stamp;
      Gate renamed Gate;
      TicketRecord renamed TicketRecord
    functions
      Launchable renamed Launchable
    operations
      RefreshStamp renamed RefreshStamp;
      Escalate renamed Escalate;
      Resolve renamed Resolve;
      Complete renamed Complete,
  from Effect
    types
      EffectId renamed EffectId;
      Action renamed Action;
      Disposition renamed Disposition;
      Intent renamed Intent
    functions
      AllSettled renamed AllSettled
    operations
      Enqueue renamed Enqueue;
      BeginExecute renamed BeginExecute;
      Confirm renamed Confirm;
      Fail renamed Fail;
      RecoverExecuting renamed RecoverExecuting;
      Dispose renamed Dispose,
  from Attention
    types
      Decision renamed Decision
    operations
      Observe renamed Observe
exports
  functions
    OpenDecisions: map TicketId to TicketRecord * map EffectId to Intent -> set of Decision
  operations
    DriveEffect: EffectId * TicketId * Action * bool ==> ();
    RecoverInterruptedIntent: EffectId * TicketId ==> ();
    ResolveEscalatedTicket: TicketId * EffectId * Disposition * Stamp * set of Gate ==> ();
    ReconcileSource: TicketId * Stamp * bool ==> ();
    NotifyOpenDecisions: map TicketId to TicketRecord * map EffectId to Intent ==> set of Decision
definitions
functions
  -- 从票据表与外部写入意图表投影出当前需要主协调器介入的待决决策集合
  OpenDecisions: map TicketId to TicketRecord * map EffectId to Intent -> set of Decision
  OpenDecisions(ts, effects) ==
    {mk_Decision(id, nil) | id in set dom ts & Launchable(ts, id)}
    union
    {mk_Decision(id, ts(id).revision) | id in set dom ts & ts(id).status = <Escalated>}
    union
    (if ts <> {|->}
        and (forall t in set rng ts & t.status = <Done>)
        and AllSettled(effects)
     then {mk_Decision(nil, nil)}
     else {});

operations
  -- 场景：登记并持久化执行中外部写入意图；凭最新源码确认完成，未获确认时记为结果未知并升级票据
  DriveEffect: EffectId * TicketId * Action * bool ==> ()
  DriveEffect(effectId, ticketId, action, confirmedBySource) ==
    (Enqueue(effectId, ticketId, action);
     BeginExecute(effectId);
     if confirmedBySource
     then Confirm(effectId)
     else (Fail(effectId, true);
           Escalate(ticketId)));

  -- 场景：进程重启接管时将遗留的执行中写入意图转为结果未知，并将所属票据升级交主协调器裁定
  RecoverInterruptedIntent: EffectId * TicketId ==> ()
  RecoverInterruptedIntent(effectId, ticketId) ==
    (RecoverExecuting(effectId);
     Escalate(ticketId));

  -- 场景：主协调器显式处置失败或结果未知的写入意图，并在新源码指纹与必需门禁下重新打开升级票据
  ResolveEscalatedTicket: TicketId * EffectId * Disposition * Stamp * set of Gate ==> ()
  ResolveEscalatedTicket(ticketId, effectId, disposition, stamp, required) ==
    (Dispose(effectId, disposition);
     Resolve(ticketId, stamp, required));

  -- 场景：按最新远端观测对账票据；契约有效时刷新源码指纹并尝试完成票据，契约冲突时升级票据
  ReconcileSource: TicketId * Stamp * bool ==> ()
  ReconcileSource(ticketId, stamp, contractValid) ==
    if contractValid
    then (RefreshStamp(ticketId, stamp);
          Complete(ticketId))
    else Escalate(ticketId);

  -- 场景：在回合结束时计算当前待决决策集合并过滤已通知事项，返回需唤醒主协调器的新增决策
  NotifyOpenDecisions: map TicketId to TicketRecord * map EffectId to Intent ==> set of Decision
  NotifyOpenDecisions(ts, effects) ==
    return Observe(OpenDecisions(ts, effects));
end Reconcile
```
