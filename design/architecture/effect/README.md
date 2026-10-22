# 外部写入意图

负责执行对远端系统的受控写入并记下结果未知的写入意图，供调用方按意图身份向源码对账找回或显式取消；不负责决定何时发起写入。

## 依据

通过 CLI 或 HTTP 接口向远端发起创建拉取请求、合并拉取请求或修改议题状态等写操作时，超时、断连或进程中断均不证明远端未生效（来源：GitHub CLI 与 HTTP 接口行为，证据见附录 `evidence/github-write-uncertainty.md`）。所以 ``Effect`ApplyOutcome`` 包含结果未知分支 ``Effect`Uncertain``，调用方经 ``Effect`Reconcile`` 核对远端事实确认生效，或经主协调器裁定调用 ``Effect`Cancel`` 结清。

## 为什么

外部写入意图的登记与结果未知找回只用到父模块的 ``Ticket`TicketId``，父模块不需要知道每次外部调用如何持久记录，所以单独成为子模块。不让调用方在得到结果未知时直接重调 ``Effect`Apply``：远端可能已经完成了写入，盲目重发会造成重复创建或非幂等副作用，必须先按 ``Effect`EffectId`` 对账或取消。

## 语义

`Effect` 与 `Ticket` 运行在同一协调器进程内，意图表随议程状态在同一原子文件写入中持久化。进程崩溃重启后，崩溃前已开始但未确认的写入均归入 ``Effect`Effects.unresolved``，绝不自动重发。
