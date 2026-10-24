# 协调接入

```vdm
module Coordination
imports
  from Roundtable
    types IssueRef renamed IssueRef,
  from Agenda
    types
      TicketId renamed TicketId; Ticket renamed Ticket; RunId renamed RunId;
      Observation renamed Observation
    functions DepsDone renamed DepsDone
    operations
      Convene renamed Convene; Release renamed Release; Snapshot renamed Snapshot;
      Pending renamed Pending; Finish renamed Finish,
  from Seat
    operations Live renamed Live,
  from Attention
    types Decision renamed Decision
    operations Observe renamed Observe
exports
  types struct CloseOutcome
  functions
    OpenDecisions: map TicketId to Ticket * set of TicketId * bool -> set of Decision
  operations
    Open: [IssueRef] * map TicketId to Ticket * RunId * Observation * TicketId ==> ();
    Notify: () ==> set of Decision;
    Close: () ==> CloseOutcome
definitions
types
  -- Close 的结局：议程已结束，或还有在跑的席位要先等它们退出
  CloseOutcome = <Finished> | <SeatsLive>;

functions
  -- 需要 Main 的决策：可放行的票据、待裁定的例外（按工作期区分）、可结束的议程；在跑的席位与写入不是决策；两个实现必须得出同一集合
  OpenDecisions: map TicketId to Ticket * set of TicketId * bool -> set of Decision
  OpenDecisions(ts, pending, seatsLive) ==
    {mk_Decision(<Release>, id, nil) | id in set dom ts &
       not ts(id).released and ts(id).stage = <Running> and DepsDone(ts, id)}
    union
    {mk_Decision(<Rule>, id, ts(id).revision) | id in set dom ts & ts(id).stage = <Excepted>}
    union
    (if ts <> {|->} and (forall t in set rng ts & t.stage = <Done>) and pending = {} and not seatsLive
     then {mk_Decision(<Finish>, nil, nil)}
     else {});

operations
  -- 场景：召集议程，Main 放行一张依赖已完成的票据；之后它的步骤自动接力
  Open: [IssueRef] * map TicketId to Ticket * RunId * Observation * TicketId ==> ()
  Open(parent, initial, run, obs, first) ==
    (Convene(parent, initial, run, obs);
     Release(first));

  -- 场景：Main 回合结束时，按当前账本与在跑席位算出决策，只为新决策唤醒 Main
  Notify: () ==> set of Decision
  Notify() ==
    let ts = Snapshot(), pending = Pending(), live = Live() in
      return Observe(OpenDecisions(ts, pending, live <> {}));

  -- 场景：没有在跑的席位时 Main 结束议程
  Close: () ==> CloseOutcome
  Close() ==
    if Live() = {} then (Finish(); return <Finished>)
    else return <SeatsLive>;
end Coordination
```
