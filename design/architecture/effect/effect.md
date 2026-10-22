# 外部写入意图连接

```vdm
module Effect
imports from Ticket types TicketId renamed TicketId
exports
  types
    EffectId; Action;
    struct EffectStatus; struct Disposition; struct Intent
  functions
    ActiveForTicket: map EffectId to Intent * TicketId -> set of EffectId;
    Unsettled: map EffectId to Intent * TicketId -> set of EffectId;
    AllSettled: map EffectId to Intent -> bool
  operations
    Enqueue: EffectId * TicketId * Action ==> ();
    BeginExecute: EffectId ==> ();
    Confirm: EffectId ==> ();
    Fail: EffectId * bool ==> ();
    RecoverExecuting: EffectId ==> ();
    Dispose: EffectId * Disposition ==> ()
definitions
types
  -- 一次外部写入意图的唯一身份；使用方不读内部结构
  EffectId = token;

  -- 待执行的外部写入动作；具体业务载荷对本模块隐藏
  Action = token;

  -- 外部写入意图的持久生命周期状态
  EffectStatus = <Ready> | <Executing> | <Confirmed> | <Failed> | <Uncertain> | <Cancelled>;

  -- 主协调器对失败或结果未知意图的显式处置方式
  Disposition = <Retry> | <Adopt> | <Cancel>;

  -- 一条外部写入意图的记录
  Intent ::
    ticket : TicketId  -- 该写入意图归属的票据身份
    action : Action  -- 待执行的外部写入动作
    status : EffectStatus;  -- 当前持久化的意图状态

  -- 外部写入意图表：同一票据在同一时刻至多有一条就绪或执行中的活动写入意图
state Effects of
  byId : map EffectId to Intent  -- 意图身份到意图记录的映射
  inv mk_Effects(b) ==
    forall id1 in set dom b &
      let i1 = b(id1) in
      forall id2 in set dom b &
        let i2 = b(id2) in
        id1 <> id2 and i1.ticket = i2.ticket =>
          not (i1.status in set {<Ready>, <Executing>}
               and i2.status in set {<Ready>, <Executing>})
  init s == s = mk_Effects({|->})
end

functions
  -- 计算指定票据当前处于就绪或执行中的活动写入意图集合
  ActiveForTicket: map EffectId to Intent * TicketId -> set of EffectId
  ActiveForTicket(table, ticket) ==
    {id | id in set dom table &
       let intent = table(id) in
       intent.ticket = ticket
       and intent.status in set {<Ready>, <Executing>}};

  -- 计算指定票据下尚未结清（非已确认且非已取消）的意图集合
  Unsettled: map EffectId to Intent * TicketId -> set of EffectId
  Unsettled(table, ticket) ==
    {id | id in set dom table &
       let intent = table(id) in
       intent.ticket = ticket
       and intent.status not in set {<Confirmed>, <Cancelled>}};

  -- 判定全部外部写入意图是否均已确认或已取消
  AllSettled: map EffectId to Intent -> bool
  AllSettled(table) ==
    forall intent in set rng table &
      intent.status in set {<Confirmed>, <Cancelled>};

operations
  -- 为没有在途活动意图的票据登记一条就绪的外部写入意图
  Enqueue(id: EffectId, ticket: TicketId, action: Action)
  ext wr byId
  pre id not in set dom byId
      and ActiveForTicket(byId, ticket) = {}
  post byId = byId~ ++ {id |-> mk_Intent(ticket, action, <Ready>)};

  -- 调用外部接口前先将就绪意图持久化为执行中
  BeginExecute(id: EffectId)
  ext wr byId
  pre id in set dom byId and byId(id).status = <Ready>
  post byId = byId~ ++ {id |-> mu(byId~(id), status |-> <Executing>)};

  -- 源码读取确认目标事实已成立后，将意图标记为已确认
  Confirm(id: EffectId)
  ext wr byId
  pre id in set dom byId
      and byId(id).status in set {<Ready>, <Executing>, <Uncertain>}
  post byId = byId~ ++ {id |-> mu(byId~(id), status |-> <Confirmed>)};

  -- 外部调用未获源码确认时，按失败性质标记为结果未知或已知失败
  Fail(id: EffectId, uncertain: bool)
  ext wr byId
  pre id in set dom byId
      and byId(id).status in set {<Ready>, <Executing>}
  post byId = byId~ ++ {id |-> mu(byId~(id),
         status |-> if uncertain then <Uncertain> else <Failed>)};

  -- 协调器重启接管议程时，将遗留的执行中意图转为结果未知
  RecoverExecuting(id: EffectId)
  ext wr byId
  pre id in set dom byId and byId(id).status = <Executing>
  post byId = byId~ ++ {id |-> mu(byId~(id), status |-> <Uncertain>)};

  -- 主协调器显式处置失败或结果未知的意图：取消、采纳已确认事实，或在无其他活动意图时重新排入就绪
  Dispose(id: EffectId, disposition: Disposition)
  ext wr byId
  pre id in set dom byId
      and byId(id).status in set {<Failed>, <Uncertain>}
      and (disposition = <Retry> => ActiveForTicket(byId, byId(id).ticket) = {})
  post let prev = byId~(id) in
       let nextStatus =
         cases disposition:
           <Cancel> -> <Cancelled>,
           <Adopt> -> <Confirmed>,
           <Retry> -> <Ready>
         end in
       byId = byId~ ++ {id |-> mu(prev, status |-> nextStatus)};
end Effect
```
