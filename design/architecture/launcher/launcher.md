# 启动链接连接

```vdm
module Launcher
imports from Roundtable types IssueRef renamed IssueRef
exports
  types struct Navigation; struct Block; struct Listing; struct Probe; struct Act; struct Plan; struct Outcome
  values LauncherPort : nat1
  functions
    Decide: Navigation * Probe -> Plan;
    Report: Plan * bool -> Outcome
definitions
values
  -- 已发布启动链接固定的本地回环端口；写进议题的链接依赖它，不可配置
  LauncherPort : nat1 = 47591;

types
  -- 一次浏览器请求中决定能否启动的事实
  Navigation ::
    clicked : bool  -- 请求是用户点击产生的顶层导航，而不是网页发出的子资源请求或预取
    issue : [IssueRef]  -- 链接路径解析出的议题；前端不受支持、路径或议题编号不合法时为空
    cwdUsable : bool;  -- 链接给出的 cwd 是已存在的绝对目录

  -- 终端列出的一个命令块
  Block ::
    issue : IssueRef  -- 它运行的协调器所协调的议题
    exited : bool;  -- 命令块的进程是否已经退出

  -- 终端此刻的窗口连接与列出的全部命令块
  Listing ::
    windowed : bool  -- 是否有可见窗口连接着终端
    blocks : set of Block;  -- 全部命令块，包括已退出的

  -- 探测终端的结果：列出的状态，或终端不可用
  Probe = Listing | <Unreachable>;

  -- 要对终端做的事：没有可见窗口时先打开窗口；议题已有协调器在跑就聚焦它，否则新开一个
  Act ::
    openWindow : bool  -- 先在 cwd 打开窗口
    focus : bool;  -- 聚焦已有协调器；否则新开

  -- 一次请求的处理：拒绝、报终端失败，或对终端做的事
  Plan = Act | <Rejected> | <FrontendFailed>;

  -- 一次请求的结局：已新开协调器、已聚焦现有协调器、拒绝、终端失败
  Outcome = <Launched> | <Focused> | <Rejected> | <FrontendFailed>;

functions
  -- 一次请求的处理：只有用户点击、链接合法、cwd 可用的请求才动终端；终端不可用报终端失败；议题已有未退出的协调器块就聚焦，否则新开；没有可见窗口时先打开窗口；两个实现必须得出同一结论
  Decide: Navigation * Probe -> Plan
  Decide(n, p) ==
    if not (n.clicked and n.issue <> nil and n.cwdUsable) then <Rejected>
    else cases p:
           mk_Listing(w, bs) ->
             mk_Act(not w, exists b in set bs & b.issue = n.issue and not b.exited),
           others -> <FrontendFailed>
         end;

  -- 执行之后的结局：对终端做的事全部成功才报已聚焦或已新开，任何一步失败都报终端失败；两个实现必须得出同一结论
  Report: Plan * bool -> Outcome
  Report(p, ok) ==
    cases p:
      mk_Act(-, f) -> if not ok then <FrontendFailed> elseif f then <Focused> else <Launched>,
      <Rejected> -> <Rejected>,
      others -> <FrontendFailed>
    end;
end Launcher
```
