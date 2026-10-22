# 外部写入意图连接

```vdm
module Effect
imports from Ticket types TicketId renamed TicketId
exports
  types
    EffectId;
    struct ActionKind; struct EffectStatus; struct Disposition; struct Intent
  functions
    Unsettled: map EffectId to Intent * TicketId -> set of EffectId;
    AllSettled: map EffectId to Intent -> bool
  operations
    Enqueue: EffectId * TicketId * ActionKind ==> ();
    BeginExecute: EffectId ==> ();
    Confirm: EffectId ==> ();
    Fail: EffectId * bool ==> ();
    RecoverExecuting: EffectId ==> ();
    Dispose: EffectId * Disposition * bool ==> ()
definitions
types
  -- 一次外部写入意图的唯一身份；使用方不读内部结构
  EffectId = token;

  -- 状态机向 GitHub 发起的受控外部写入动作类别
  ActionKind = <PublishPr> | <MergePr> | <SetIssueState> | <ReplaceBody> | <CreateIssue> | <AttachChild> | <RerunChecks>;

  -- 外部写入意图的持久生命周期状态
  EffectStatus = <Ready> | <Executing> | <Confirmed> | <Failed> | <Uncertain> | <Cancelled>;

  -- 主协调器对失败或结果未知意图的显式处置方式
  Disposition = <Retry> | <Adopt> | <Cancel>;

  -- 一条外部写入意图的记录
  Intent ::
    ticket : TicketId  -- 该写入意图归属的票据或收尾门禁身份
    action : ActionKind  -- 待执行的外部写入动作
    status : EffectStatus;  -- 当前持久化的意图状态

  -- 外部写入意图表：正在执行的意图集合恰好是状态为执行中的记录
state Effects of
  byId : map EffectId to Intent  -- 意图身份到意图记录的映射
  executing : set of EffectId  -- 已持久化为执行中、尚未确认结局的意图集合
  inv mk_Effects(b, e) ==
    e subset dom b
    and forall id in set dom b & (id in set e <=> b(id).status = <Executing>)
  init s == s = mk_Effects({|->}, {})
end

functions
  -- 计算指定票据下尚未结清（失败、结果未知或执行中）的意图集合；重新放开票据工作前该集合必须为空
  Unsettled: map EffectId to Intent * TicketId -> set of EffectId
  Unsettled(table, ticket) ==
    {id | id in set dom table &
       let intent = table(id) in
       intent.ticket = ticket
       and intent.status in set {<Failed>, <Uncertain>, <Executing>}};

  -- 判定全部外部写入意图是否均已确认或已取消；议程收尾前必须满足
  AllSettled: map EffectId to Intent -> bool
  AllSettled(table) ==
    forall intent in set rng table &
      intent.status in set {<Confirmed>, <Cancelled>};

operations
  -- 登记一条就绪的外部写入意图
  Enqueue(id: EffectId, ticket: TicketId, action: ActionKind)
  ext wr byId rd executing
  pre id not in set dom byId
  post byId = byId~ ++ {id |-> mk_Intent(ticket, action, <Ready>)};

  -- 调用外部接口前先将意图持久化为执行中
  BeginExecute(id: EffectId)
  ext wr byId wr executing
  pre id in set dom byId and byId(id).status = <Ready>
  post byId = byId~ ++ {id |-> mu(byId~(id), status |-> <Executing>)}
       and executing = executing~ union {id};

  -- 源码读取确认目标事实已成立后，将意图标记为已确认
  Confirm(id: EffectId)
  ext wr byId wr executing
  pre id in set dom byId
      and byId(id).status in set {<Ready>, <Executing>, <Uncertain>}
  post byId = byId~ ++ {id |-> mu(byId~(id), status |-> <Confirmed>)}
       and executing = executing~ \ {id};

  -- 外部调用未获源码确认时，按失败性质标记为结果未知或已知失败，并移出执行中集合
  Fail(id: EffectId, uncertain: bool)
  ext wr byId wr executing
  pre id in set dom byId
      and byId(id).status in set {<Ready>, <Executing>}
  post byId = byId~ ++ {id |-> mu(byId~(id),
         status |-> if uncertain then <Uncertain> else <Failed>)}
       and executing = executing~ \ {id};

  -- 协调器重启接管议程时，将遗留的执行中意图转为结果未知，绝不自动重放外部写入
  RecoverExecuting(id: EffectId)
  ext wr byId wr executing
  pre id in set executing
  post byId = byId~ ++ {id |-> mu(byId~(id), status |-> <Uncertain>)}
       and executing = executing~ \ {id};

  -- 主协调器显式处置失败或结果未知的意图：取消、采纳已生效事实，或重排非合并写入（合并重试须取消原意图并重走门禁）
  Dispose(id: EffectId, disposition: Disposition, satisfied: bool)
  ext wr byId rd executing
  pre id in set dom byId
      and byId(id).status in set {<Failed>, <Uncertain>}
      and (disposition = <Adopt> => satisfied)
  post let prev = byId~(id) in
       let nextStatus =
         cases disposition:
           <Cancel> -> <Cancelled>,
           <Adopt> -> <Confirmed>,
           <Retry> ->
             if satisfied
             then <Confirmed>
             elseif prev.action = <MergePr>
             then <Cancelled>
             else <Ready>
         end in
       byId = byId~ ++ {id |-> mu(prev, status |-> nextStatus)};
end Effect
```
