# 圆桌协调

负责把一个 GitHub 议题图按议程交付：``Agenda`Ticket`` 沿 ``Agenda`Workflow`` 接力推进，对 GitHub 的写入经观察确认，``Seat`` 隔离每次席位运行，``Attention`` 只为新决策唤醒 Main，``Launcher`` 从议题里的链接启动协调器；不负责工作流的具体内容，也不负责席位内部怎样做工作。

## 依据

GitHub 上的议题正文、子议题、PR 头提交、合入状态与检查结果由远端独立维护，运行期间可能被外部修改，分页读取中途对象也可能变化（来源：GitHub 平台行为，证据见附录 `evidence/github-source-drift.md`）。所以 ``Agenda`Observation`` 只代表一次完整读取那一刻，每份观察只支撑一次转换（``Agenda`Ledger.spent``），``Agenda`Ticket`` 只在观察确认后前进。

对 GitHub 的写入在超时、断连或进程中断之后仍可能已经生效（来源：GitHub CLI 与 HTTP 接口行为，证据见附录 `evidence/github-write-uncertainty.md`）。所以每次写入先登记一条 ``Agenda`Intent``（``Agenda`Begin``），只按观察确认（``Agenda`Settle``）；结果不明的写入不重发，票据交给 Main。

席位会话可能没有交接就结束；Main 在回合进行中不空闲，只在回合结束或空闲时接收唤醒（来源：宿主行为，证据见附录 `evidence/host-session-and-turn.md`）。所以每个 ``Seat`Slot`` 只派发一次，没有交接就结束时票据交给 Main（``Seat`Close``），唤醒只在回合结束时观察（``Attention`Observe``）。

任何网页都能向本地回环端口发请求；终端守护进程在没有窗口时仍在后台运行，已退出的命令块仍会列出（来源：浏览器安全策略与 Tern 行为，证据见附录 `evidence/browser-navigation-and-tern.md`）。所以 ``Launcher`Authorized`` 只认用户点击，``Launcher`Running`` 只认未退出的 ``Launcher`Block``。

工作流（步骤序列、重做位置、完成条件）要做成配置文件，实现待定（来源：用户需求）。所以 ``Agenda`Workflow`` 是占位符，账本只用到它的 ``Agenda`StepKind`` 与完成判定 ``Agenda`Finished``。

## 为什么

根模块 ``Roundtable`` 只放启动器与协调器共用的 ``Roundtable`IssueRef``。``Launcher`` 运行在另一个进程、不读写 ``Agenda`Ledger``，所以与 ``Agenda`` 并列，不挂在它之下。

``Agenda`Ticket``、``Agenda`Intent`` 与 ``Agenda`Observation`` 放在同一个模块，因为它们共守 ``Agenda`Ledger`` 的不变量：带着失败或不明写入的票据只能处于例外，每张票据至多一条执行中的写入。分成两个模块，``Agenda`Resolve`` 拒绝带未结写入的票据就只能靠调用方自觉。

接力只认三种 ``Agenda`StepKind``。具体有哪些步骤、评判否决回到哪一步（``Agenda`ReworkAt``）、完成看哪些源头事实（``Agenda`Finished``），都来自 ``Agenda`Workflow`` 的配置；换配置不改账本。不把某一种交付流程写进设计：流程与它的失败分支随需求变动，接力的次序、确认、评判绑定、例外出路与完成判定不变。

## 语义

``Agenda``、``Seat`` 与 ``Attention`` 运行在同一个协调器进程内；``Launcher`` 是另一个本地驻留进程，与协调器不共享内存或状态文件。只有以协调引用启动的进程是协调器，它在整个交付中绑定同一个 Main 会话。

只有 Main 调用 ``Agenda`Release``、``Agenda`Resolve``、``Agenda`Dispose``、``Agenda`Resume`` 与 ``Agenda`Finish``；席位只为自己绑定的票据调用 ``Agenda`Produce`` 与 ``Agenda`Judge``。

一份 ``Agenda`Observation`` 只由同一次操作里新读、且读完整的读取产生。

``Agenda`Ledger`` 的每次改变在操作返回前已持久化；``Seat`Seats`` 与 ``Attention`Board`` 只在进程内存，新进程从空开始。

对 GitHub 的调用发生在 ``Agenda`Begin`` 之后、``Agenda`Settle`` 之前。

议程级的收口（例如关闭父议题）用一张依赖其余全部票据的 ``Agenda`Ticket`` 表达，它的 ``Agenda`Workflow`` 同样来自配置。
