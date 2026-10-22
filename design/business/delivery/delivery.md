# 票据交付接入

```vdm
module Delivery
imports
  from Ticket
    types
      TicketId renamed TicketId;
      Stamp renamed Stamp;
      Gate renamed Gate;
      Revision renamed Revision;
      TicketRecord renamed TicketRecord
    operations
      Launch renamed Launch;
      PassGate renamed PassGate;
      RefreshStamp renamed RefreshStamp;
      Escalate renamed Escalate;
      Complete renamed Complete,
  from Effect
    types
      EffectId renamed EffectId;
      Action renamed Action
    operations
      Enqueue renamed Enqueue;
      BeginExecute renamed BeginExecute;
      Confirm renamed Confirm,
  from Seat
    types
      SessionFile renamed SessionFile;
      GateSeat renamed GateSeat;
      SeatSlot renamed SeatSlot
    operations
      Start renamed Start;
      RecordOwnerHandoff renamed RecordOwnerHandoff;
      Exit renamed Exit
exports
  types
    struct FailureRoute
  functions
    PendingGates: TicketRecord -> set of Gate;
    GateFailureAction: bool -> FailureRoute
  operations
    DeliverTicket: TicketId * Revision * SessionFile * EffectId * Action * Gate * Stamp ==> ();
    ApplyGateVerdict: TicketId * Gate * Stamp * Stamp * bool * bool ==> ();
    SettleSeatExit: SeatSlot * bool * Revision ==> ()
definitions
types
  -- 门禁拒绝后的分流方向：回退返工或升级交主协调器裁定
  FailureRoute = <Rework> | <Escalate>;

functions
  -- 计算已启动且打开的票据在当前源码指纹下尚未通过的必需门禁集合
  PendingGates: TicketRecord -> set of Gate
  PendingGates(ticket) ==
    if ticket.started and ticket.status = <Open>
    then ticket.required \ ticket.passed
    else {};

  -- 判定门禁拒绝后的分流方向：合并后或收尾门禁拒绝必须升级，合并前门禁拒绝回退返工
  GateFailureAction: bool -> FailureRoute
  GateFailureAction(postMergeOrClosure) ==
    if postMergeOrClosure
    then <Escalate>
    else <Rework>;

operations
  -- 场景：将可派发票据放上桌面，依次完成编写者席位交接、外部发布写入确认、门禁席位核验通过并完成交付
  DeliverTicket: TicketId * Revision * SessionFile * EffectId * Action * Gate * Stamp ==> ()
  DeliverTicket(id, rev, session, effectId, action, gate, stamp) ==
    let ownerSlot = mk_SeatSlot(id, <Owner>, rev),
        gateSlot = mk_SeatSlot(id, mk_GateSeat(gate), rev) in
      (Launch(id);
       cases Start(ownerSlot):
         <Refused> -> Escalate(id),
         others ->
           (RecordOwnerHandoff(id, session);
            let - = Exit(ownerSlot, true, rev) in
              (Enqueue(effectId, id, action);
               BeginExecute(effectId);
               Confirm(effectId);
               cases Start(gateSlot):
                 <Refused> -> Escalate(id),
                 others ->
                   (PassGate(id, gate, stamp);
                    let - = Exit(gateSlot, true, rev) in
                      Complete(id))
               end))
       end);

  -- 场景：处理单道门禁裁决；通过时记录门禁通过，拒绝时按合并前后性质刷新指纹回退返工或升级
  ApplyGateVerdict: TicketId * Gate * Stamp * Stamp * bool * bool ==> ()
  ApplyGateVerdict(id, gate, stamp, nextStamp, passed, postMergeOrClosure) ==
    if passed
    then PassGate(id, gate, stamp)
    else
      cases GateFailureAction(postMergeOrClosure):
        <Rework> -> RefreshStamp(id, nextStamp),
        <Escalate> -> Escalate(id)
      end;

  -- 场景：席位退出时结算宿主状态；未完成交接且修订号仍为当前修订号时将票据升级
  SettleSeatExit: SeatSlot * bool * Revision ==> ()
  SettleSeatExit(slot, handedOff, currentRevision) ==
    cases Exit(slot, handedOff, currentRevision):
      <Abandon> -> Escalate(slot.ticket),
      others -> skip
    end;
end Delivery
```
