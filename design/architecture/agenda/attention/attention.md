# 唤醒连接

```vdm
module Attention
imports
  from Agenda
    types TicketId renamed TicketId; Revision renamed Revision
exports
  types struct Kind; struct Decision
  operations Observe: set of Decision ==> set of Decision
definitions
types
  -- 需要 Main 的决策种类：放行一张票据、裁定一次例外、结束议程
  Kind = <Release> | <Rule> | <Finish>;

  -- 一项需要 Main 的决策；同一张票据再次例外时工作期不同，即为新的决策
  Decision ::
    kind : Kind  -- 决策种类
    ticket : [TicketId]  -- 关联的票据；结束议程时为空
    revision : [Revision];  -- 例外所在的工作期；其余种类为空

  -- 已通知集合：上一次观察时已告诉 Main、且当时仍未解决的决策
state Board of
  notified : set of Decision  -- 已通知且仍未解决的决策
  init b == b = mk_Board({})
end

operations
  -- 在 Main 回合结束或空闲时观察当前决策：只返回尚未通知过的决策，并把已通知集合换成本次的决策
  Observe(current: set of Decision) fresh: set of Decision
  ext wr notified
  post fresh = current \ notified~ and notified = current;
end Attention
```
