# 接力接入

```vdm
module Relay
imports
  from Agenda
    types
      TicketId renamed TicketId; Role renamed Role; Observation renamed Observation;
      IntentId renamed IntentId; RunId renamed RunId
    functions StepAt renamed StepAt
    operations
      Recheck renamed Recheck; Snapshot renamed Snapshot; Begin renamed Begin;
      Complete renamed Complete; Resume renamed Resume,
  from Seat
    types Slot renamed Slot
    operations Dispatch renamed Dispatch
exports
  operations
    Advance: TicketId * [Role] * Observation ==> [IntentId];
    Recover: RunId * TicketId * [Role] * Observation ==> [IntentId]
definitions
operations
  -- 场景：用一次新读取推进一张票据一步：先复核，再按当前步骤的种类派发产出或评判席位、开始写入（交回要调用源头的写入意图）或核对完成；前任席位还没退出时这次不派发，下一次推进再派
  Advance: TicketId * [Role] * Observation ==> [IntentId]
  Advance(id, role, obs) ==
    (Recheck(id, obs);
     let ts = Snapshot(), t = ts(id) in
       cases StepAt(t.flow, t.pos):
         nil -> (Complete(id, obs); return nil),
         <Write> -> return Begin(id, obs),
         others -> (let - = Dispatch(mk_Slot(id, t.pos, role, t.revision)) in skip;
                    return nil)
       end);

  -- 场景：进程中断后的恢复：新运行先接管议程一次，中断时执行中的写入交给 Main；之后票据从当前步骤续接，产出席位接续交接点
  Recover: RunId * TicketId * [Role] * Observation ==> [IntentId]
  Recover(run, id, role, obs) ==
    (Resume(run);
     return Advance(id, role, obs));
end Relay
```
