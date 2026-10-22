# 本地链接启动连接

```vdm
module Launcher
imports from Ticket types IssueRef renamed IssueRef
exports
  types
    BlockId;
    struct Frontend; struct Navigation; struct Block;
    struct TernSnapshot; struct TernProbe; struct LaunchOutcome
  values
    LauncherPort : nat1
  functions
    AuthorizedNavigation: Navigation -> bool;
    RequiresWindowOpen: Navigation * TernProbe -> bool;
    LiveCoordinatorBlocks: set of Block * IssueRef -> set of BlockId;
    DecideLaunch: Navigation * TernProbe -> LaunchOutcome
definitions
values
  -- 已发布议题徽章链接固定的本地回环监听端口
  LauncherPort : nat1 = 47591;

types
  -- 终端前端中单个运行块的身份；使用方不读内部结构
  BlockId = token;

  -- 链接路径请求的目标终端前端类别
  Frontend = <Tern> | <Unsupported>;

  -- 一次浏览器启动请求携带的导航与校验属性
  Navigation ::
    isGet : bool  -- 请求方法是否为 GET
    isNavigate : bool  -- Sec-Fetch-Mode 是否为 navigate
    isUserActivated : bool  -- Sec-Fetch-User 是否为 ?1（用户点击激活）
    frontend : Frontend  -- 路径请求的终端前端
    cwdExists : bool  -- 查询参数 cwd 是否为本地已存在的绝对目录
    issue : IssueRef;  -- 路径解析出的目标 GitHub 议题身份

  -- 终端前端列出的单个命令块快照
  Block ::
    id : BlockId  -- 命令块身份
    issue : IssueRef  -- 该命令块启动参数绑定的协调议题身份
    live : bool  -- 命令块是否处于活动列出状态
    exited : bool;  -- 命令块进程是否已退出

  -- 终端前端在探测成功时的窗口连接与命令块快照
  TernSnapshot ::
    windowConnected : bool  -- 是否有可见的窗口客户端连接到守护进程
    blocks : set of Block;  -- 当前列出的全部命令块

  -- 终端前端探测结果：成功返回快照或前端命令执行失败
  TernProbe = TernSnapshot | <FrontendUnreachable>;

  -- 单次启动请求的四种可观察结局
  LaunchOutcome = <Launched> | <Focused> | <Rejected> | <FrontendFailed>;

functions
  -- 判定请求是否为合法的用户点击导航且本地检出目录存在
  AuthorizedNavigation: Navigation -> bool
  AuthorizedNavigation(nav) ==
    nav.isGet
    and nav.isNavigate
    and nav.isUserActivated
    and nav.frontend = <Tern>
    and nav.cwdExists;

  -- 判定在聚焦或启动协调器标签页前是否必须先在目标目录拉起可见的终端窗口
  RequiresWindowOpen: Navigation * TernProbe -> bool
  RequiresWindowOpen(nav, probe) ==
    AuthorizedNavigation(nav)
    and cases probe:
          mk_TernSnapshot(w, -) -> not w,
          others -> true
        end;

  -- 筛选终端中已绑定同一议题且进程尚未退出的活动协调器块
  LiveCoordinatorBlocks: set of Block * IssueRef -> set of BlockId
  LiveCoordinatorBlocks(blocks, issue) ==
    {b.id | b in set blocks & b.issue = issue and b.live and not b.exited};

  -- 判定一次链接请求在窗口就绪检查后的最终结局：拒绝非法请求、无可见窗口或前端不可达时报告前端失败、聚焦已有活动块或启动新标签页
  DecideLaunch: Navigation * TernProbe -> LaunchOutcome
  DecideLaunch(nav, probe) ==
    if not AuthorizedNavigation(nav)
    then <Rejected>
    else
      cases probe:
        mk_TernSnapshot(w, blocks) ->
          if not w
          then <FrontendFailed>
          elseif LiveCoordinatorBlocks(blocks, nav.issue) <> {}
          then <Focused>
          else <Launched>,
        others -> <FrontendFailed>
      end;
end Launcher
```
