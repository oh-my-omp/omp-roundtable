# 主协调器通知连接

```vdm
module Attention
imports from Ticket
  types
    TicketId renamed TicketId;
    Revision renamed Revision
exports
  types
    struct LaunchDecision; struct EscalatedDecision; struct Decision
  functions
    FreshDecisions: set of Decision * set of Decision -> set of Decision
  operations
    Observe: set of Decision ==> set of Decision;
    SettleInTurn: set of Decision * set of Decision ==> set of Decision
definitions
types
  -- 票据前置依赖全部完成、等待主协调器放上桌面的决策键
  LaunchDecision ::
    ticket : TicketId;  -- 可放上桌面的票据身份

  -- 票据或父议题门禁处于升级状态、等待主协调器按修订号裁定的决策键
  EscalatedDecision ::
    ticket : TicketId  -- 处于升级状态的票据或收尾门禁身份
    revision : Revision;  -- 触发本次升级的修订号

  -- 仅主协调器可做出的三类决策
  Decision = LaunchDecision | EscalatedDecision | <Finish>;

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

  -- 场景：首次观察唤醒新增决策后，再次观察同一未决集合或已消解的子集时不再重复唤醒
  SettleInTurn: set of Decision * set of Decision ==> set of Decision
  SettleInTurn(initial, remaining) ==
    (let - = Observe(initial) in
       return Observe(remaining));
end Attention
```
