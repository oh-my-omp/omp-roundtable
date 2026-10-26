# 席位连接

```vdm
module Seat
imports
  from Agenda
    types
      TicketId renamed TicketId; Revision renamed Revision;
      StepKind renamed StepKind; RunId renamed RunId
    operations
      Except renamed Except; Resume renamed Resume
exports
  types
    SeatId;
    struct Slot; struct Continue; struct Workspace; struct Seated; struct AcquireOutcome;
    struct Ending; struct Ended
  operations
    Acquire: Slot * StepKind ==> AcquireOutcome;
    End: SeatId ==> Ended;
    Live: () ==> set of [TicketId];
    Dispatch: Slot * StepKind ==> AcquireOutcome;
    Close: SeatId ==> Ended;
    Recover: RunId * Slot * StepKind ==> AcquireOutcome
definitions
types
  -- 一次席位运行的身份；宿主造出，结束时交回
  SeatId = token;

  -- 一个派发槽位：哪张票据（为空即收口）、哪一步、哪个工作期；一个进程内每个槽位至多派发一次
  Slot ::
    ticket : [TicketId]  -- 席位绑定的票据；为空即收口的评判席位
    step : nat1  -- 席位执行的步骤
    revision : Revision;  -- 派发时的工作期

  -- 接续一个已交接的产出席位：沿用它的会话与工作空间
  Continue ::
    seat : SeatId;  -- 被接续的产出席位

  -- 席位的工作空间：空白（不继承任何产出历史），或接续最近一次被接受交接的产出席位
  Workspace = Continue | <Blank>;

  -- 席位已开始；之后必须用 End 结束它
  Seated ::
    seat : SeatId  -- 结束时交回的身份
    workspace : Workspace;  -- 它得到的工作空间

  -- Acquire 的结局：已开始；本票据还有在跑的席位要先等它们退出；槽位在本进程已派发过、不再派发；宿主起不来
  AcquireOutcome = Seated | <Busy> | <Used> | <Failed>;

  -- 席位结束的方式：交接已被接受，或未交接就结束
  Ending = <HandedOff> | <Abandoned>;

  -- 一次席位结束：它的槽位与结束方式
  Ended ::
    slot : Slot  -- 结束的槽位
    ending : Ending;  -- 是否完成交接

  -- 本进程的席位：每个槽位至多一个席位；在跑的席位都已登记；产出席位都绑定票据；交接点只指向本票据已结束的产出席位
state Seats of
  slots : map SeatId to Slot  -- 本进程派发过的席位及其槽位
  kinds : map SeatId to StepKind  -- 每个席位执行的步骤种类
  live : set of SeatId  -- 在跑的席位
  last : map TicketId to SeatId  -- 每张票据最近一次被接受交接的产出席位
  inv mk_Seats(s, k, l, p) ==
    dom k = dom s and l subset dom s
    and (forall a, b in set dom s & a <> b => s(a) <> s(b))
    and (forall x in set dom s & k(x) = <Produce> => s(x).ticket <> nil)
    and (forall t in set dom p &
           p(t) in set dom s and s(p(t)).ticket = t and k(p(t)) = <Produce> and p(t) not in set l)
  init q == q = mk_Seats({|->}, {|->}, {}, {|->})
end

operations
  -- 为一个槽位开始席位：槽位在本进程派发过则不再派发；产出席位要等本票据其它席位都退出，其它席位要等同一步的席位退出；产出席位接续本票据的交接点，其它席位一律空白
  Acquire(slot: Slot, kind: StepKind) r: AcquireOutcome
  ext wr slots wr kinds wr live rd last
  post (slot in set rng slots~ and r = <Used>
          and slots = slots~ and kinds = kinds~ and live = live~)
       or (slot not in set rng slots~
          and (exists s in set live~ & slots~(s).ticket = slot.ticket
                 and (kind = <Produce> or slots~(s).step = slot.step))
          and r = <Busy> and slots = slots~ and kinds = kinds~ and live = live~)
       or (slot not in set rng slots~
          and not (exists s in set live~ & slots~(s).ticket = slot.ticket
                     and (kind = <Produce> or slots~(s).step = slot.step))
          and r = <Failed>
          and (exists s : SeatId & s not in set dom slots~
                 and slots = slots~ ++ {s |-> slot} and kinds = kinds~ ++ {s |-> kind})
          and live = live~)
       or (slot not in set rng slots~
          and not (exists s in set live~ & slots~(s).ticket = slot.ticket
                     and (kind = <Produce> or slots~(s).step = slot.step))
          and is_Seated(r) and r.seat not in set dom slots~
          and r.workspace = (if kind = <Produce> and slot.ticket in set dom last
                             then mk_Continue(last(slot.ticket)) else <Blank>)
          and slots = slots~ ++ {r.seat |-> slot}
          and kinds = kinds~ ++ {r.seat |-> kind}
          and live = live~ union {r.seat});

  -- 结束一个在跑的席位，报告它是否完成交接；产出席位的交接被接受时成为本票据的交接点
  End(seat: SeatId) r: Ended
  ext rd slots rd kinds wr live wr last
  pre seat in set live
  post live = live~ \ {seat} and r.slot = slots(seat)
       and let t = slots(seat).ticket in
         ((r.ending = <HandedOff> and kinds(seat) = <Produce> and t <> nil
             and last = last~ ++ {t |-> seat})
          or ((r.ending = <Abandoned> or kinds(seat) <> <Produce>) and last = last~));

  -- 读取有在跑席位的票据（空表示收口）；只读
  Live() r: set of [TicketId]
  ext rd slots rd live
  post r = {slots(s).ticket | s in set live};

  -- 场景：派发一个槽位；宿主起不来时票据或收口交给 Main，不重新派发
  Dispatch: Slot * StepKind ==> AcquireOutcome
  Dispatch(slot, kind) ==
    let r = Acquire(slot, kind) in
      (if r = <Failed> then let - = Except(slot.ticket, slot.revision) in skip;
       return r);

  -- 场景：席位结束；未交接就结束时票据或收口交给 Main，不重新派发（工作期已被取代时 Except 拒收）
  Close: SeatId ==> Ended
  Close(seat) ==
    let r = End(seat) in
      (if r.ending = <Abandoned> then let - = Except(r.slot.ticket, r.slot.revision) in skip;
       return r)
  pre seat in set live;

  -- 场景：进程中断后恢复：新运行接管议程，中断时执行中的写入交给 Main；已放行票据当前步骤的席位在当前工作期重新派发一次，产出席位接续交接点
  Recover: RunId * Slot * StepKind ==> AcquireOutcome
  Recover(run, slot, kind) ==
    (Resume(run, <OriginalEnded>);
     return Acquire(slot, kind));
end Seat
```
