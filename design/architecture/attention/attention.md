# 主协调器通知连接

```vdm
module Attention
imports from Ticket
  types
    TicketId renamed TicketId;
    Revision renamed Revision
exports
  types
    struct DecisionKind; struct Decision
  functions
    FreshDecisions: set of Decision * set of Decision -> set of Decision
  operations
    Observe: set of Decision ==> set of Decision
definitions
types
  -- 需主协调器介入的三类决策类别：票据可放上桌面、票据处于升级待裁定、议程全部完成可收尾
  DecisionKind = <Launch> | <Escalated> | <Finish>;

  -- 一条需主协调器介入的待决决策键：绑定决策类别、可选票据身份与修订号
  Decision ::
    kind : DecisionKind  -- 待决决策类别
    ticket : [TicketId]  -- 关联的票据身份；议程级收尾决策为空
    revision : [Revision];  -- 关联的票据修订号

  -- 通知面板状态：记录上一次回合结束时已向主协调器发过通知的未决决策集合
state NoticeBoard of
  notified : set of Decision  -- 已通知且上次观察时仍打开的决策集合
  init n == n = mk_NoticeBoard({})
end

functions
  -- 计算本次观察相较于已通知集合新增的决策集合；已通知过的未决事项不再重复唤醒
  FreshDecisions: set of Decision * set of Decision -> set of Decision
  FreshDecisions(current, prior) ==
    current \ prior;

operations
  -- 在主协调器空闲或回合结束时观察当前未决决策，返回新增决策并更新已通知集合
  Observe(current: set of Decision) fresh: set of Decision
  ext wr notified
  post fresh = FreshDecisions(current, notified~)
       and notified = current;
end Attention
```
