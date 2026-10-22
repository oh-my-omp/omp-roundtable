# 席位宿主连接

```vdm
module Seat
imports from Ticket
  types
    TicketId renamed TicketId;
    Gate renamed Gate;
    Revision renamed Revision
exports
  types
    SessionFile;
    struct GateSeat; struct Role; struct SeatKey; struct SeatSlot;
    struct Workspace; struct StartOutcome; struct ExitOutcome
  functions
    CanSeat: set of SeatSlot * map SeatKey to Revision * SeatSlot -> bool;
    SelectWorkspace: map TicketId to SessionFile * TicketId * Role -> Workspace
  operations
    Start: SeatSlot ==> StartOutcome;
    RecordOwnerHandoff: TicketId * SessionFile ==> ();
    Exit: SeatSlot * bool * Revision ==> ExitOutcome
definitions
types
  -- 持久化的编写者原生会话记录文件身份；使用方不读内部结构
  SessionFile = token;

  -- 执行单道核验门禁的席位角色
  GateSeat ::
    gate : Gate;  -- 所核验的门禁身份

  -- 席位角色：编写者或独立核验门禁
  Role = <Owner> | GateSeat;

  -- 票据与席位角色的运行槽位键
  SeatKey ::
    ticket : TicketId  -- 席位绑定的票据身份
    role : Role;  -- 席位担任的角色

  -- 绑定特定修订号的单次席位派发记录
  SeatSlot ::
    ticket : TicketId  -- 席位绑定的票据身份
    role : Role  -- 席位担任的角色
    revision : Revision;  -- 派发时的修订号

  -- 席位工作空间方式：分叉既有编写者会话与工作树，或建立全新检出与空白会话
  Workspace = <Fork> | <Fresh>;

  -- 启动席位的结局：分配工作空间，或因已派发过该修订号或存在互斥活动席位而拒绝
  StartOutcome = Workspace | <Refused>;

  -- 席位退出时的宿主可观察结局：已完成交接、已被新修订号取代、或未交接且修订号仍为当前修订号
  ExitOutcome = <HandedOff> | <Superseded> | <Abandon>;

  -- 席位宿主状态：所有活动席位都已记入单次派发历史，同一票据下编写者与门禁互不并发，已记录会话文件的票据必曾派发过编写者
state Seats of
  seated : set of SeatSlot  -- 已派发过的（票据、角色、修订号）集合，只增不减
  live : map SeatKey to Revision  -- 当前正在运行的席位及其绑定的修订号
  ownerSessions : map TicketId to SessionFile  -- 已交接的编写者席位留下的会话文件
  inv mk_Seats(s, l, o) ==
    (forall k in set dom l & mk_SeatSlot(k.ticket, k.role, l(k)) in set s)
    and (forall k1, k2 in set dom l &
           k1 <> k2 and k1.ticket = k2.ticket =>
             k1.role <> <Owner> and k2.role <> <Owner>)
    and (forall t in set dom o & exists slot in set s & slot.ticket = t and slot.role = <Owner>)
  init s == s = mk_Seats({}, {|->}, {|->})
end

functions
  -- 判定一个席位槽位当前是否允许启动：该修订号未曾派发过，且编写者与同票据任何角色互斥、门禁与同角色及编写者互斥
  CanSeat: set of SeatSlot * map SeatKey to Revision * SeatSlot -> bool
  CanSeat(history, active, slot) ==
    slot not in set history
    and (if slot.role = <Owner>
         then not exists k in set dom active & k.ticket = slot.ticket
         else mk_SeatKey(slot.ticket, slot.role) not in set dom active
              and mk_SeatKey(slot.ticket, <Owner>) not in set dom active);

  -- 计算席位应使用的工作空间：已有会话记录的返工编写者分叉原会话，首次编写者与所有门禁席位均使用全新检出
  SelectWorkspace: map TicketId to SessionFile * TicketId * Role -> Workspace
  SelectWorkspace(sessions, ticket, role) ==
    if role = <Owner> and ticket in set dom sessions
    then <Fork>
    else <Fresh>;

operations
  -- 启动一个到期的单次席位：符合准入时登记派发历史与活动表并返回工作空间方式，否则保持状态不变并返回拒绝
  Start(slot: SeatSlot) r: StartOutcome
  ext wr seated wr live rd ownerSessions
  post if CanSeat(seated~, live~, slot)
       then seated = seated~ union {slot}
            and live = live~ ++ {mk_SeatKey(slot.ticket, slot.role) |-> slot.revision}
            and r = SelectWorkspace(ownerSessions, slot.ticket, slot.role)
       else seated = seated~
            and live = live~
            and r = <Refused>;

  -- 编写者席位完成交接时，保存其原生会话文件供后续返工分叉
  RecordOwnerHandoff(ticket: TicketId, session: SessionFile)
  ext rd seated rd live wr ownerSessions
  post if mk_SeatKey(ticket, <Owner>) in set dom live
       then ownerSessions = ownerSessions~ ++ {ticket |-> session}
       else ownerSessions = ownerSessions~;

  -- 席位退出时移出活动表并保留派发历史，返回是否已完成交接、已被新修订号取代或未交接退出
  Exit(slot: SeatSlot, handedOff: bool, currentRevision: Revision) outcome: ExitOutcome
  ext rd seated wr live
  post live = {mk_SeatKey(slot.ticket, slot.role)} <-: live~
       and (handedOff => outcome = <HandedOff>)
       and (not handedOff and slot.revision <> currentRevision => outcome = <Superseded>)
       and (not handedOff and slot.revision = currentRevision => outcome = <Abandon>);
end Seat
```
