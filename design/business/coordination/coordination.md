# 协调接入

```vdm
module Coordination
imports
  from Agenda
    types
      TicketId renamed TicketId; Ticket renamed Ticket; Closure renamed Closure;
      IntentId renamed IntentId; Intent renamed Intent
    functions Launchable renamed Launchable
    operations
      Snapshot renamed Snapshot; Closing renamed Closing; Pending renamed Pending; Finish renamed Finish,
  from Seat
    operations Live renamed Live,
  from Attention
    types Decision renamed Decision
    operations Observe renamed Observe
exports
  types struct CloseOutcome
  operations
    Notify: () ==> set of Decision;
    Close: () ==> CloseOutcome
definitions
types
  -- Close 的结局：议程已结束，或交付还没全部完成、还有未结的写入或在跑的席位
  CloseOutcome = <Finished> | <Open>;

functions
  -- 需要 Main 的决策：可放行的票据、待裁定的票据或收口例外（按工作期区分；收口的决策不带票据）、可结束的议程；收口自动开始，不需要放行；在跑的席位与写入不是决策；两个实现必须得出同一集合
  OpenDecisions: map TicketId to Ticket * (bool * [Closure]) * map IntentId to Intent * bool -> set of Decision
  OpenDecisions(ts, closing, pending, seatsLive) ==
    let mk_(-, c) = closing in
    {mk_Decision(<Release>, id, nil) | id in set dom ts & Launchable(ts, id)}
    union
    {mk_Decision(<Rule>, id, ts(id).revision) | id in set dom ts & ts(id).stage = <Excepted>}
    union
    (if c <> nil and c.stage = <Excepted> then {mk_Decision(<Rule>, nil, c.revision)} else {})
    union
    (if Closable(ts, closing, pending, seatsLive)
     then {mk_Decision(<Finish>, nil, nil)}
     else {});

  -- 议程可以结束：全部票据完成、有父议题时收口完成、没有未结的写入、没有在跑的席位；两个实现必须得出同一结论
  Closable: map TicketId to Ticket * (bool * [Closure]) * map IntentId to Intent * bool -> bool
  Closable(ts, closing, pending, seatsLive) ==
    let mk_(hasParent, c) = closing in
      ts <> {|->} and (forall t in set rng ts & t.stage = <Done>)
      and (hasParent => c <> nil and c.stage = <Done>)
      and pending = {|->} and not seatsLive;

operations
  -- 场景：Main 回合结束时，按当前账本与在跑席位算出决策，只为新决策唤醒 Main
  Notify: () ==> set of Decision
  Notify() ==
    let ts = Snapshot(), closing = Closing(), pending = Pending(), live = Live() in
      return Observe(OpenDecisions(ts, closing, pending, live <> {}));

  -- 场景：议程可以结束时 Main 结束它
  Close: () ==> CloseOutcome
  Close() ==
    let ts = Snapshot(), closing = Closing(), pending = Pending(), live = Live() in
      if Closable(ts, closing, pending, live <> {}) then (Finish(); return <Finished>)
      else return <Open>;
end Coordination
```
