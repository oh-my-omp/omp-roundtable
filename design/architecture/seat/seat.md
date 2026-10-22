# 席位宿主连接

```vdm
module Seat
imports from Ticket
  types
    TicketId renamed TicketId;
    Revision renamed Revision
exports
  types
    SeatId;
    struct Role; struct SeatSlot; struct Workspace;
    struct Seated; struct AcquireOutcome; struct ReleaseOutcome
  functions
    SelectWorkspace: set of TicketId * TicketId * Role -> Workspace
  operations
    Acquire: SeatSlot ==> AcquireOutcome;
    Release: SeatId * bool ==> ReleaseOutcome
definitions
types
  -- 一次席位会话的唯一身份；由宿主造出，调用方在 Release 时交回
  SeatId = token;

  -- 席位角色：保留会话与工作树的编写者，或使用全新空白检出的独立门禁
  Role = <Owner> | <Gate>;

  -- 绑定特定票据、角色与修订号的单次席位派发槽位
  SeatSlot ::
    ticket : TicketId  -- 席位绑定的票据身份
    role : Role  -- 席位担任的角色
    revision : Revision;  -- 派发时的票据修订号

  -- 席位工作空间方式：分叉既有编写者会话与工作树，或建立全新检出与空白会话
  Workspace = <Fork> | <Fresh>;

  -- 席位已成功启动；调用方之后必须用 Release 结束它
  Seated ::
    seat : SeatId  -- 结束席位时交回的身份
    workspace : Workspace;  -- 本次席位所使用的工作空间方式

  -- Acquire 的结局：已启动并交出席位身份与工作空间，或因该槽位已派发过/存在活动冲突而被拒绝
  AcquireOutcome = Seated | <Refused>;

  -- Release 的结局：已完成交接正常结束，或未交接中途退出（恢复需调用 Ticket`Escalate 升级票据）
  ReleaseOutcome = <HandedOff> | <Abandoned>;

  -- 席位宿主状态：活动席位均属已登记席位，同一槽位至多派发一次，可分叉票据必曾派发过编写者席位
state Seats of
  bySeat : map SeatId to SeatSlot  -- 席位身份到其派发槽位的映射
  live : set of SeatId  -- 已启动、尚未结束的席位集合
  forkable : set of TicketId  -- 已完成过编写者交接、后续返工可分叉会话的票据集合
  inv mk_Seats(b, l, f) ==
    l subset dom b
    and (forall s1, s2 in set dom b & s1 <> s2 => b(s1) <> b(s2))
    and (forall t in set f & exists slot in set rng b & slot.ticket = t and slot.role = <Owner>)
  init s == s = mk_Seats({|->}, {}, {})
end

functions
  -- 计算席位应使用的工作空间：已有编写者交接记录的返工编写者分叉原会话，其余情形均使用全新检出
  SelectWorkspace: set of TicketId * TicketId * Role -> Workspace
  SelectWorkspace(forkedTickets, ticket, role) ==
    if role = <Owner> and ticket in set forkedTickets
    then <Fork>
    else <Fresh>;

operations
  -- 为未曾派发过的槽位启动单次席位；每个（票据、角色、修订号）槽位至多成功启动一次
  Acquire(slot: SeatSlot) r: AcquireOutcome
  ext wr bySeat wr live rd forkable
  post (slot not in set rng bySeat~
          and is_Seated(r)
          and r.seat not in set dom bySeat~
          and r.workspace = SelectWorkspace(forkable, slot.ticket, slot.role)
          and bySeat = bySeat~ ++ {r.seat |-> slot}
          and live = live~ union {r.seat})
       or (r = <Refused>
             and bySeat = bySeat~
             and live = live~);

  -- 结束一次席位运行；编写者完成交接时记录该票据可分叉，未交接退出时返回 Abandoned
  Release(seat: SeatId, handedOff: bool) r: ReleaseOutcome
  ext rd bySeat wr live wr forkable
  post live = live~ \ {seat}
       and (if handedOff
            then r = <HandedOff>
                 and forkable =
                   (if seat in set dom bySeat and bySeat(seat).role = <Owner>
                    then forkable~ union {bySeat(seat).ticket}
                    else forkable~)
            else r = <Abandoned>
                 and forkable = forkable~);
end Seat
```
