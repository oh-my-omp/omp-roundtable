# 远端对账与升级裁定

负责核对结果未知的外部写入意图，在升级票据上执行主协调器的裁定恢复，并在回合结束时读取议程与未决意图状态唤醒主协调器；不负责席位内部的编写或门禁评判。

## 依据

外部写入返回结果未知时远端可能已经生效，只有向远端读取对账或由主协调器显式取消后才能解除对该票据的阻塞（来源：GitHub CLI 与 HTTP 接口行为，证据见附录 `evidence/github-write-uncertainty.md`）。所以 ``Reconcile`OpenDecisions`` 仅对无未决意图阻塞的可派发票据生成启动决策，``Reconcile`ResolveEscalated`` 在取消未决意图后再调用 ``Ticket`Resolve`` 恢复票据并调用 ``Reconcile`NotifyMain`` 同步通知状态。

## 需求

外部写入出现结果未知时，若远端对账确认已生效则继续完成票据，若远端未生效则升级票据并在回合结束唤醒主协调器（来源：不确定写入恢复需求），由 ``Reconcile`SettleUncertainWrite`` 走通。

主协调器裁定升级票据时，先结清其未决写入意图再恢复票据活动状态，并在回合结束时读取当前票据与未决意图过滤已通知事项（来源：升级裁定与边沿唤醒需求），由 ``Reconcile`ResolveEscalated`` 与 ``Reconcile`NotifyMain`` 走通。
