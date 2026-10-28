# 圆桌协调

负责把一个 GitHub 议题图按议程交付：``Agenda`Ticket`` 沿 ``Agenda`Workflow`` 接力推进，全部完成后由 ``Agenda`Closure`` 关闭父议题，对 GitHub 的写入经观察确认，``Seat`` 隔离每次席位运行，``Attention`` 只为新决策唤醒 Main，``Launcher`` 从议题里的链接启动协调器；不负责工作流的具体内容，也不负责席位内部怎样做工作。

## 依据

GitHub 上的议题正文、子议题、PR 头提交、合入状态与检查结果由远端独立维护，运行期间可能被外部修改，分页读取中途对象也可能变化（来源：GitHub 平台行为，证据见附录 `evidence/github-source-drift.md`）。所以 ``Agenda`Observation`` 只代表一次完整读取那一刻，``Agenda`Ticket`` 只按观察上的判定前进，写入只用发起之后的读取确认（``Agenda`Later``）。

对 GitHub 的写入在超时、断连或进程中断之后仍可能已经生效（来源：GitHub CLI 与 HTTP 接口行为，证据见附录 `evidence/github-write-uncertainty.md`）。所以每次写入先登记一条 ``Agenda`Intent``（``Agenda`Begin``、``Agenda`CloseParent``），只按观察确认（``Agenda`Settle``）；结果不明的写入不重发，所属的票据或收口交给 Main，由 Main 逐条选 ``Agenda`Disposal``。

席位会话可能没有交接就结束，也可能派生助手会话；Main 在回合进行中不空闲，只在回合结束或空闲时接收唤醒（来源：宿主行为，证据见附录 `evidence/host-session-and-turn.md` 与 README「Sessions and recovery」）。所以每个 ``Seat`Slot`` 只派发一次，交接只经在跑席位自己的连接（``Seat`Submit``、``Seat`Verdict``、``Seat`Escalate``）进入账本，没有交接就结束时票据交给 Main（``Seat`Close``），唤醒只在回合结束时观察（``Attention`Observe``）。

任何网页都能向本地回环端口发请求；终端守护进程在没有窗口时仍在后台运行，已退出的命令块仍会列出（来源：浏览器安全策略与 Tern 行为，证据见附录 `evidence/browser-navigation-and-tern.md`）。所以 ``Launcher`Decide`` 只为用户点击的合法链接动终端，并以未退出的 ``Launcher`Block`` 判断协调器是否在跑。

工作流要只写抽象、做成配置文件，实现待定（来源：用户需求）。所以 ``Agenda`Workflow`` 是占位符，账本只经 ``Agenda`StepAt``、``Agenda`Judges``、``Agenda`ReworkTo`` 与 ``Agenda`Gates`` 向它提问；源头事实对一张票据意味着什么，也只经 ``Agenda`Seen``、``Agenda`Effected``、``Agenda`Finished``、``Agenda`Drifted`` 与 ``Agenda`Refused`` 这些不展开的判定得出。

## 为什么

根模块 ``Roundtable`` 只放启动器与协调器共用的 ``Roundtable`IssueRef``。``Launcher`` 运行在另一个进程、不读写 ``Agenda`Ledger``，所以与 ``Agenda`` 并列，不挂在它之下。

``Agenda`Ticket``、``Agenda`Closure`` 与 ``Agenda`Intent`` 放在同一个模块，因为它们共守 ``Agenda`Ledger`` 的不变量：带着失败或不明写入的票据或收口只能处于例外，每张票据与收口各至多一条执行中的写入。分成两个模块，``Agenda`Resolve`` 与 ``Agenda`ResolveClosure`` 拒绝带未结写入的续接就只能靠调用方自觉。

源头判定写成以 ``Agenda`Observation`` 与 ``Agenda`Ticket`` 为参数的不展开函数，归 ``Agenda`` 持有，不让调用方构造判定结果交进来：判定结果由调用方给出，账本就守不住“只凭源头确认”；判定的内容随工作流配置变化，所以不展开。

收口不是一张票据：它不经 Main 放行，在全部票据完成后自动开始（``Agenda`ReviewClosure``）；它只有一个评判和一次关闭父议题的写入，没有产出步骤；Main 裁定它时只能回到评判，不能改动票据（``Agenda`ResolveClosure``）。把它当成票据，这三条就得在每张票据上另加例外。

Main 对失败或不明的写入有三种处置（``Agenda`Disposal``）：重试、采纳、取消。采纳只在发起之后的读取显示源头已确认时成立。重试时源头已确认就直接记为确认；否则重新排队，票据回到这次写入依赖的评判重新取得评判（``Agenda`RetryAt``）：写入凭的是裁定之前的评判，裁定开启了新工作期，旧评判不能再用。

写入的新鲜度按读取的先后表达（``Agenda`Later``），不要求每个操作单独读一次：同一次完整读取可以复核多张票据，结论建立在足够新的读取上就够了。

## 语义

``Agenda``、``Seat`` 与 ``Attention`` 运行在同一个协调器进程内；``Launcher`` 是另一个本地驻留进程，与协调器不共享内存或状态文件。只有以协调引用启动的进程是协调器，它在整个交付中绑定同一个 Main 会话，只为它启动时的议题调用 ``Agenda`Convene``；议程结束后协调器进程只能结束。

只有 Main 调用 ``Agenda`Convene``、``Agenda`Release``、``Agenda`Resolve`` 与 ``Agenda`ResolveClosure``；Main 结束议程只经 ``Coordination`Close``，因为在跑的席位记在 ``Seat`Seats``，``Agenda`Finish`` 看不到。

只有操作员确认原协调器进程已结束之后，新进程才可以调用 ``Relay`Recover``；系统不能替操作员确认，一次恢复只调用一次。

一份 ``Agenda`Observation`` 只由一次读完整的读取产生。协调器在 ``Agenda`Begin`` 或 ``Agenda`CloseParent`` 返回之后才调用源头，调用返回之后才开始用来调用 ``Agenda`Settle`` 的读取。

``Agenda`Ledger`` 的每次改变在操作返回前已持久化；``Seat`Seats`` 与 ``Attention`Board`` 只在进程内存，新进程从空开始。

唤醒与票据读取都是 Main 会话里的普通可见消息；协调器不得改写会话历史，不得按回合向会话注入隐藏的票据上下文。
