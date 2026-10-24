# 启动链接连接

```vdm
module Launcher
imports from Roundtable types IssueRef renamed IssueRef
exports
  types BlockId; struct Navigation; struct Block; struct Listing; struct Probe; struct Outcome
  values LauncherPort : nat1
  functions
    Authorized: Navigation -> bool;
    Running: set of Block * IssueRef -> set of BlockId;
    Decide: Navigation * Probe -> Outcome
definitions
values
  -- 已发布启动链接固定的本地回环端口；写进议题的链接依赖它，不可配置
  LauncherPort : nat1 = 47591;

types
  -- 终端里一个命令块的身份
  BlockId = token;

  -- 一次浏览器请求中决定能否启动的事实
  Navigation ::
    clicked : bool  -- 请求是用户点击产生的顶层导航，而不是网页发出的子资源请求或预取
    cwdUsable : bool  -- 链接给出的 cwd 是已存在的绝对目录
    issue : IssueRef;  -- 链接指向的议题

  -- 终端列出的一个命令块
  Block ::
    id : BlockId  -- 命令块身份
    issue : IssueRef  -- 它运行的协调器所协调的议题
    exited : bool;  -- 命令块的进程是否已经退出

  -- 终端此刻列出的全部命令块
  Listing ::
    blocks : set of Block;  -- 全部命令块，包括已退出的

  -- 探测终端的结果：列出的命令块，或终端不可用
  Probe = Listing | <Unreachable>;

  -- 一次请求的结局：已新开协调器、已聚焦现有协调器、拒绝、终端失败
  Outcome = <Launched> | <Focused> | <Rejected> | <FrontendFailed>;

functions
  -- 请求能否启动或聚焦协调器：只有用户点击且 cwd 可用；两个实现必须得出同一结论
  Authorized: Navigation -> bool
  Authorized(n) == n.clicked and n.cwdUsable;

  -- 某议题正在运行的协调器：协调这个议题、进程尚未退出的命令块；终端是唯一依据
  Running: set of Block * IssueRef -> set of BlockId
  Running(bs, i) == {b.id | b in set bs & b.issue = i and not b.exited};

  -- 一次请求的结局：未授权拒绝；终端不可用报终端失败；已有协调器则聚焦，否则新开
  Decide: Navigation * Probe -> Outcome
  Decide(n, p) ==
    if not Authorized(n) then <Rejected>
    else cases p:
           mk_Listing(bs) -> if Running(bs, n.issue) <> {} then <Focused> else <Launched>,
           others -> <FrontendFailed>
         end;
end Launcher
```
