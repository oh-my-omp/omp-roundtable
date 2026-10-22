# 本地链接启动器

负责校验浏览器点击导航请求与本地工作目录，探活终端前端 Tern 的可见窗口与活动命令块，并在确保终端窗口可见的前提下聚焦目标议题已有的协调器块或启动新协调器标签页；不负责维护协调器持久状态。

## 依据

任何网页都能通过图片、脚本或预取向 `127.0.0.1` 发起请求，且 GitHub 的 `no-referrer-when-downgrade` 策略在 `https` 跳转到本地 `http` 链接时剥离 `Referer` 头；同时已写入 GitHub 议题正文的徽章链接固定指向本地端口 ``Launcher`LauncherPort``（来源：浏览器安全策略与已发布链接契约，证据见附录 `evidence/browser-navigation-and-tern.md`）。所以 ``Launcher`AuthorizedNavigation`` 强制要求 `GET`、`Sec-Fetch-Mode: navigate` 与 `Sec-Fetch-User: ?1`，以操作员的主动点击作为启动授权。

Tern 守护进程在无图形窗口连接时仍保留后台会话并接受新标签页请求，且已退出的命令块仍保留 `live: true` 并附带退出码（来源：Tern 守护进程行为，证据见附录 `evidence/browser-navigation-and-tern.md`）。所以 ``Launcher`RequiresWindowOpen`` 在无窗口连接时要求先打开窗口，``Launcher`LiveCoordinatorBlocks`` 仅匹配 `live` 且未 `exited` 的块，``Launcher`DecideLaunch`` 在窗口仍未连接时拒绝静默启动并返回 ``<FrontendFailed>``。

## 为什么

本地链接启动器只同父模块共享被协调议题的身份 ``Ticket`IssueRef``，协调器本身不需要知道浏览器导航头或终端块如何探活，所以单独成为子模块。

不在启动器进程内维护“已启动议题到协调器进程”的去重表：协调器进程随时可能由操作员在终端内关闭，启动器自建状态表会在协调器退出后留下陈旧记录阻止再次启动；直接以 Tern 当前列出的未退出命令块作为唯一事实源（``Launcher`LiveCoordinatorBlocks``），协调器退出后下一次点击即可自然拉起新进程。

## 语义

`Launcher` 作为独立的本地无状态驻留进程（macOS `LaunchAgent`）监听 `127.0.0.1:47591`，不与协调器共享进程内存或持久状态文件。每次 HTTP 请求在当次调用内完成校验、窗口探活、聚焦或新建标签页，并返回一个 HTML 结果页。
