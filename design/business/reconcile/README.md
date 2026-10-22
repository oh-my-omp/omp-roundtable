# 远端对账与升级裁定

负责将远端 GitHub 观测事实与本地票据及外部写入意图对账，处理执行中写入的两阶段确认、进程重启后的未决意图接管、主协调器对升级票据的裁定，以及回合结束时的主协调器唤醒通知；不负责席位内部的编写或门禁评判。

## 依据

远端源码状态与外部写入结果只能通过读取 GitHub 最新事实确认，超时或重启遗留的执行中意图无法在本地推断远端是否已生效（来源：GitHub CLI 与 HTTP 接口行为，证据见附录 `evidence/github-write-uncertainty.md`）。所以 ``Reconcile`DriveEffect`` 在未获源码确认时将意图标为结果未知并升级票据，``Reconcile`RecoverInterruptedIntent`` 在重启接管时将遗留执行中意图转为结果未知并升级票据。

## 需求

外部写入在调用前先持久化为执行中，调用后凭远端源码确认完成，未获确认时标为结果未知并将所属票据升级（来源：外部写入安全需求），由 ``Reconcile`DriveEffect`` 走通。

协调器进程重启接管时，将遗留的执行中写入意图转为结果未知并升级所属票据；主协调器显式处置未决意图并指定新源码指纹与必需门禁后，票据重新打开（来源：崩溃恢复与裁定需求），由 ``Reconcile`RecoverInterruptedIntent`` 与 ``Reconcile`ResolveEscalatedTicket`` 走通。

远端源码指纹变更时刷新指纹并清空旧门禁记录，契约冲突时升级票据，并在主协调器回合结束时仅就新增待决事项发送唤醒通知（来源：源码对账与通知需求），由 ``Reconcile`ReconcileSource`` 与 ``Reconcile`NotifyOpenDecisions`` 走通。
