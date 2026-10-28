# 席位连接

```vdm
module Seat
imports
  from Agenda
    types
      TicketId renamed TicketId; Revision renamed Revision; StepKind renamed StepKind;
      Role renamed Role; Reason renamed Reason; SeatId renamed SeatId; Fingerprint renamed Fingerprint;
      Observation renamed Observation; Ticket renamed Ticket; Closure renamed Closure; Handoff renamed Handoff
    functions
      StepAt renamed StepAt; Judges renamed Judges; DepsDone renamed DepsDone
    operations
      Snapshot renamed Snapshot; Closing renamed Closing;
      Produce renamed Produce; Judge renamed Judge; JudgeClosure renamed JudgeClosure;
      Except renamed Except
exports
  types
    struct Slot; struct Continue; struct Workspace; struct Seated; struct Dispatched;
    struct Ending; struct Ended
  operations
    Dispatch: Slot ==> Dispatched;
    Submit: SeatId * Observation ==> Handoff;
    Verdict: SeatId * Fingerprint * bool * [Reason] * Observation ==> Handoff;
    Escalate: SeatId * Reason ==> Handoff;
    Close: SeatId ==> Ended;
    Live: () ==> set of [TicketId]
definitions
types
  -- 一个派发槽位：哪张票据（为空即收口）、哪一步、哪个评判（产出步骤为空）、哪个工作期；一个进程内每个槽位至多派发一次
  Slot ::
    ticket : [TicketId]  -- 席位绑定的票据；为空即收口的评判席位
    step : nat1  -- 席位执行的步骤
    role : [Role]  -- 席位担任的评判；产出席位与收口评判为空
    revision : Revision;  -- 派发时的工作期

  -- 接续一个交接已被接受的产出席位：沿用它的会话与工作空间
  Continue ::
    seat : SeatId;  -- 被接续的产出席位

  -- 席位的工作空间：空白（不继承任何产出历史），或接续票据的交接点
  Workspace = Continue | <Blank>;

  -- 席位已开始；之后用 Close 结束它
  Seated ::
    seat : SeatId  -- 席位的身份；交接与结束时交回
    workspace : Workspace;  -- 它得到的工作空间

  -- Dispatch 的结局：已开始；槽位此刻不该派发；本票据前任席位还没退出，稍后再派；槽位在本进程已派发过；宿主起不来，票据或收口已交给 Main
  Dispatched = Seated | <Idle> | <Busy> | <Used> | <Failed>;

  -- 席位结束的方式：交接已被账本接受，或没有交接就结束
  Ending = <HandedOff> | <Abandoned>;

  -- 一次席位结束：它的槽位与结束方式
  Ended ::
    slot : Slot  -- 结束的槽位
    ending : Ending;  -- 是否完成交接

  -- 本进程的席位：每个槽位至多一个席位；在跑与已交接的席位都已登记；产出席位都绑定票据
state Seats of
  slots : map SeatId to Slot  -- 本进程派发过的席位及其槽位
  kinds : map SeatId to StepKind  -- 每个席位执行的步骤种类
  live : set of SeatId  -- 在跑的席位
  handed : set of SeatId  -- 交接已被账本接受的席位
  inv mk_Seats(s, k, l, h) ==
    dom k = dom s and l subset dom s and h subset dom s
    and (forall a, b in set dom s & a <> b => s(a) <> s(b))
    and (forall x in set dom s & k(x) = <Produce> => s(x).ticket <> nil)
  init q == q = mk_Seats({|->}, {|->}, {}, {})
end

functions
  -- 槽位此刻该派发的席位种类与产出席位要接续的交接点：票据已放行、推进中、依赖都已完成、工作期为当前、正处于这一步，这一步是产出，或是评判且角色属于这一步的评判；收口的槽位要收口推进中、待评判、工作期为当前；不该派发为空
  Due: map TicketId to Ticket * [Closure] * Slot -> [StepKind * [SeatId]]
  Due(ts, c, s) ==
    if s.ticket = nil
    then (if c <> nil and c.stage = <Running> and c.verdict = <Pending>
             and c.revision = s.revision and s.role = nil
          then mk_(<Judge>, nil) else nil)
    elseif DepsDone(ts, s.ticket)
           and ts(s.ticket).released and ts(s.ticket).stage = <Running>
           and ts(s.ticket).revision = s.revision and ts(s.ticket).pos = s.step
    then let t = ts(s.ticket) in
           cases StepAt(t.flow, s.step):
             <Produce> -> if s.role = nil then mk_(<Produce>, t.point) else nil,
             <Judge> -> if s.role <> nil and s.role in set Judges(t.flow, s.step) then mk_(<Judge>, nil) else nil,
             others -> nil
           end
    else nil;

operations
  -- 为一个该派发的槽位开始席位：槽位在本进程派发过则不再派发；产出席位要等本票据其它席位都退出，评判席位要等本票据的产出席位退出；产出席位接续交接点，评判席位一律空白
  Acquire(slot: Slot, kind: StepKind, point: [SeatId]) r: Dispatched
  ext wr slots wr kinds wr live
  pre kind = <Produce> => slot.ticket <> nil
  post (slot in set rng slots~ and r = <Used>
          and slots = slots~ and kinds = kinds~ and live = live~)
       or (slot not in set rng slots~
          and (exists x in set live~ & slots~(x).ticket = slot.ticket
                 and (kind = <Produce> or kinds~(x) = <Produce>))
          and r = <Busy> and slots = slots~ and kinds = kinds~ and live = live~)
       or (slot not in set rng slots~
          and not (exists x in set live~ & slots~(x).ticket = slot.ticket
                     and (kind = <Produce> or kinds~(x) = <Produce>))
          and r = <Failed>
          and (exists x : SeatId & x not in set dom slots~
                 and slots = slots~ ++ {x |-> slot} and kinds = kinds~ ++ {x |-> kind})
          and live = live~)
       or (slot not in set rng slots~
          and not (exists x in set live~ & slots~(x).ticket = slot.ticket
                     and (kind = <Produce> or kinds~(x) = <Produce>))
          and is_Seated(r) and r.seat not in set dom slots~
          and r.workspace = (if kind = <Produce> and point <> nil then mk_Continue(point) else <Blank>)
          and slots = slots~ ++ {r.seat |-> slot}
          and kinds = kinds~ ++ {r.seat |-> kind}
          and live = live~ union {r.seat});

  -- 记下一个在跑席位的交接已被账本接受
  Mark(seat: SeatId)
  ext rd live wr handed
  pre seat in set live
  post handed = handed~ union {seat};

  -- 结束一个在跑的席位：交接已被账本接受时以已交接结束，否则以未交接结束
  End(seat: SeatId) r: Ended
  ext rd slots rd handed wr live
  pre seat in set live
  post live = live~ \ {seat}
       and r = mk_Ended(slots(seat), if seat in set handed then <HandedOff> else <Abandoned>);

  -- 读取有在跑席位的票据（空表示收口）；只读
  Live() r: set of [TicketId]
  ext rd slots rd live
  post r = {slots(s).ticket | s in set live};

  -- 场景：按账本判定槽位该不该派发，该派发就开始席位；宿主起不来时票据或收口交给 Main，不重新派发
  Dispatch: Slot ==> Dispatched
  Dispatch(slot) ==
    let ts = Snapshot(), mk_(-, c) = Closing() in
      let due = Due(ts, c, slot) in
        if due = nil then return <Idle>
        else let mk_(kind, point) = due in
          let r = Acquire(slot, kind, point) in
            (if r = <Failed> then let - = Except(slot.ticket, slot.revision, nil) in skip;
             return r);

  -- 场景：在跑的产出席位交接它绑定的那一步；账本接受时记下已交接
  Submit: SeatId * Observation ==> Handoff
  Submit(seat, obs) ==
    let s = slots(seat) in
      let r = Produce(s.ticket, s.revision, s.step, seat, obs) in
        (if r = <Accepted> then Mark(seat);
         return r)
  pre seat in set live;

  -- 场景：在跑的评判席位在指纹 fp 上交接它绑定的那一步的结论；账本接受时记下已交接
  Verdict: SeatId * Fingerprint * bool * [Reason] * Observation ==> Handoff
  Verdict(seat, fp, pass, why, obs) ==
    let s = slots(seat) in
      let r = if s.ticket = nil then JudgeClosure(s.revision, fp, pass, why, obs)
              else Judge(s.ticket, s.revision, s.step, s.role, fp, pass, why, obs) in
        (if r = <Accepted> then Mark(seat);
         return r)
  pre seat in set live and kinds(seat) = <Judge>;

  -- 场景：在跑的席位带着原因把它绑定的票据或收口交给 Main；账本接受时记下已交接
  Escalate: SeatId * Reason ==> Handoff
  Escalate(seat, why) ==
    let s = slots(seat) in
      let r = Except(s.ticket, s.revision, why) in
        (if r = <Accepted> then Mark(seat);
         return r)
  pre seat in set live;

  -- 场景：席位结束；未交接就结束时票据或收口交给 Main，不重新派发（工作期已被取代时 Except 拒收）
  Close: SeatId ==> Ended
  Close(seat) ==
    let r = End(seat) in
      (if r.ending = <Abandoned> then let - = Except(r.slot.ticket, r.slot.revision, nil) in skip;
       return r)
  pre seat in set live;
end Seat
```
