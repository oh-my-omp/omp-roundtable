# 外部写入意图连接

```vdm
module Effect
imports from Ticket types TicketId renamed TicketId
exports
  types
    EffectId;
    struct Applied; struct Uncertain; struct ApplyOutcome; struct ReconcileOutcome
  functions
    BlockedTickets: map EffectId to TicketId * set of EffectId -> set of TicketId
  operations
    Apply: TicketId ==> ApplyOutcome;
    Reconcile: EffectId ==> ReconcileOutcome;
    Cancel: EffectId ==> ();
    PendingEffects: () ==> map EffectId to TicketId
definitions
types
  -- 一次外部写入意图的唯一身份；由提供方造出，使用方不读内部结构
  EffectId = token;

  -- 外部写入已获远端源码确认生效
  Applied ::
    effect : EffectId;  -- 本次写入意图的身份

  -- 外部写入结果未知；调用方必须经 Reconcile 对账确认或由主协调器经 Cancel 取消后才能继续推进该票据
  Uncertain ::
    effect : EffectId;  -- 待对账或取消的写入意图身份

  -- Apply 的结局：已确认生效、已知未生效被拒绝、或结果未知需对账
  ApplyOutcome = Applied | <Rejected> | Uncertain;

  -- Reconcile 的结局：远端源码确认该意图已生效，或远端尚未观测到生效结果
  ReconcileOutcome = <Confirmed> | <Absent>;

  -- 外部写入意图表：结果未知的未决意图都属于已登记的某张票据
state Effects of
  byTicket : map EffectId to TicketId  -- 意图身份到所属票据身份的映射
  unresolved : set of EffectId  -- 结果未知、尚未经源码对账确认或取消的意图集合
  inv mk_Effects(b, u) == u subset dom b
  init e == e = mk_Effects({|->}, {})
end

functions
  -- 计算当前因存在结果未知写入意图而不得继续推进的票据集合；两个实现必须得出同一集合
  BlockedTickets: map EffectId to TicketId * set of EffectId -> set of TicketId
  BlockedTickets(b, u) ==
    {b(e) | e in set u & e in set dom b};

operations
  -- 为指定票据执行一次外部写入；已确认时记入意图表，被拒绝时状态不变，结果未知时同时记入未决集合等待对账
  Apply(ticket: TicketId) r: ApplyOutcome
  ext wr byTicket wr unresolved
  post (is_Applied(r)
          and r.effect not in set dom byTicket~
          and byTicket = byTicket~ ++ {r.effect |-> ticket}
          and unresolved = unresolved~)
       or (r = <Rejected>
             and byTicket = byTicket~
             and unresolved = unresolved~)
       or (is_Uncertain(r)
             and r.effect not in set dom byTicket~
             and byTicket = byTicket~ ++ {r.effect |-> ticket}
             and unresolved = unresolved~ union {r.effect});

  -- 对结果未知的意图核对远端源码事实；若远端已生效则移出未决集合
  Reconcile(effect: EffectId) r: ReconcileOutcome
  ext rd byTicket wr unresolved
  post (effect in set dom byTicket
          and r = <Confirmed>
          and unresolved = unresolved~ \ {effect})
       or (r = <Absent>
             and unresolved = unresolved~);

  -- 主协调器显式取消一条未决意图，将其移出未决集合；取消两次与一次效果相同
  Cancel(effect: EffectId)
  ext wr unresolved
  post unresolved = unresolved~ \ {effect};

  -- 读取当前尚未结清的未决写入意图到所属票据的映射；只读，不改变意图表
  PendingEffects() m: map EffectId to TicketId
  ext rd byTicket rd unresolved
  post m = unresolved <: byTicket;
end Effect
```
