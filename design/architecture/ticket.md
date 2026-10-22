# 票据与议程连接

```vdm
module Ticket
exports
  types
    TicketId; IssueRef; Target; Stamp;
    struct Revision; struct Stage; struct GateRole; struct Role;
    struct GateStatus; struct GateRecord; struct Terminal;
    struct TicketEntry; struct ClosureGate; struct ResolveStage
  values
    RecomputeSeconds : nat1;
    StateFormat : nat1
  functions
    DependenciesDone: map TicketId to TicketEntry * TicketEntry -> bool;
    Launchable: map TicketId to TicketEntry * TicketId -> bool;
    AvailableRoles: map TicketId to TicketEntry * TicketId -> set of Role
  operations
    Convene: map TicketId to TicketEntry * [ClosureGate] ==> ();
    Launch: TicketId ==> ();
    Submit: TicketId ==> ();
    OpenReviewGates: TicketId * Stamp ==> ();
    Verdict: TicketId * GateRole * bool * Stamp ==> ();
    ConfirmMerge: TicketId * Stamp ==> ();
    ConfirmDone: TicketId ==> ();
    Escalate: TicketId ==> ();
    Resolve: TicketId * ResolveStage * bool ==> ();
    JudgeClosure: bool * Stamp ==> ();
    ConfirmClosure: () ==> ();
    Finish: () ==> ()
definitions
values
  -- 协调器主动拉取 GitHub 事实并执行对账的默认间隔秒数
  RecomputeSeconds : nat1 = 120;

  -- 本地持久议程状态信封的格式版本号
  StateFormat : nat1 = 5;

types
  -- 议程内票据的唯一身份；使用方原样传递，不读内部结构
  TicketId = token;

  -- 被交付或统领的 GitHub 议题身份；使用方不读内部结构
  IssueRef = token;

  -- 交付的目标仓库与基线分支身份；使用方不读内部结构
  Target = token;

  -- 绑定议题契约、提交或拉取请求、目标分支与裁定的源码指纹
  Stamp = token;

  -- 票据或收尾门禁的单调递增修订号，从 1 开始
  Revision = nat
  inv r == r > 0;

  -- 票据在交付生命周期中的阶段
  Stage = <Coding> | <Publishing> | <Reviewing> | <Merging> | <Verifying> | <Escalated> | <Done>;

  -- 附着在单张票据上的三个独立核验门禁角色
  GateRole = <Review> | <Accept> | <PostMerge>;

  -- 协调器可派发的全部席位角色
  Role = <Owner> | GateRole | <Closure>;

  -- 门禁在当前指纹下的核验状态
  GateStatus = <Pending> | <Passed> | <Failed>;

  -- 单道门禁绑定的源码指纹与结论
  GateRecord ::
    stamp : Stamp  -- 该结论所评判的源码指纹
    status : GateStatus;  -- 当前门禁结论

  -- 票据经源码确认的终端完成形态
  Terminal = <Merged> | <NoCode>;

  -- 单张交付票据的核心记录
  TicketEntry ::
    issue : IssueRef  -- 交付对应的 GitHub 议题身份
    target : Target  -- 交付的目标仓库与基线分支
    dependsOn : set of TicketId  -- 必须先到达已完成阶段的前置票据集合
    stage : Stage  -- 票据当前所处的交付阶段
    revision : Revision  -- 票据递增修订号，每次门禁失效或升级时递增
    started : bool  -- 主协调器是否已将该票据放上桌面启动流转
    review : [GateRecord]  -- 审查门禁当前印记与结论
    accept : [GateRecord]  -- 验收门禁当前印记与结论
    postMerge : [GateRecord]  -- 合并后门禁当前印记与结论
    terminal : [Terminal];  -- 票据的终端完成形态

  -- 全部子票据完成后核验父议题收尾条件的门禁
  ClosureGate ::
    parent : IssueRef  -- 统领全部子票据的父议题身份
    revision : Revision  -- 父议题收尾门禁的修订号
    stage : <Reviewing> | <Escalated> | <Done>  -- 父议题收尾阶段
    gate : GateRecord;  -- 父议题收尾门禁当前印记与结论

  -- 主协调器裁定升级票据后可转入的目标阶段
  ResolveStage = <Coding> | <Reviewing> | <Verifying> | <Done>;

  -- 议程状态：依赖边不出本议程票据集且不含自依赖，已完成的议程中全部票据与父议题收尾门禁均已完成
state Agenda of
  tickets : map TicketId to TicketEntry  -- 议程中的票据表
  closure : [ClosureGate]  -- 可选的父议题收尾门禁
  completed : bool  -- 议程是否已全部完成并收尾
  inv mk_Agenda(ts, c, done) ==
    (forall id in set dom ts & ts(id).dependsOn subset (dom ts \ {id}))
    and (done =>
      (forall t in set rng ts & t.stage = <Done>)
      and (c <> nil => c.stage = <Done>))
  init a == a = mk_Agenda({|->}, nil, false)
end

functions
  -- 判定票据的全部前置依赖是否都已到达完成阶段；所有实现必须得出同一结论
  DependenciesDone: map TicketId to TicketEntry * TicketEntry -> bool
  DependenciesDone(ts, t) ==
    forall dep in set t.dependsOn &
      dep in set dom ts and ts(dep).stage = <Done>;

  -- 判定票据是否可由主协调器放上桌面：处于编写阶段、尚未启动且前置依赖全部完成
  Launchable: map TicketId to TicketEntry * TicketId -> bool
  Launchable(ts, id) ==
    id in set dom ts
    and let entry = ts(id) in
        entry.stage = <Coding>
        and not entry.started
        and DependenciesDone(ts, entry);

  -- 计算票据在当前阶段向接力器提供的可执行席位角色集合
  AvailableRoles: map TicketId to TicketEntry * TicketId -> set of Role
  AvailableRoles(ts, id) ==
    if id in set dom ts
    then
      let entry = ts(id) in
      if not DependenciesDone(ts, entry)
      then {}
      else
        cases entry.stage:
          <Coding> -> {<Owner>},
          <Reviewing> ->
            (if entry.review <> nil and entry.review.status = <Pending> then {<Review>} else {})
            union
            (if entry.accept <> nil and entry.accept.status = <Pending> then {<Accept>} else {}),
          <Verifying> ->
            if entry.postMerge <> nil and entry.postMerge.status = <Pending>
            then {<PostMerge>}
            else {},
          others -> {}
        end
    else {};

operations
  -- 召集新议程并写入初始票据图与可选父议题门禁
  Convene(initial: map TicketId to TicketEntry, parentClosure: [ClosureGate])
  ext wr tickets wr closure rd completed
  pre not completed
      and tickets = {|->}
      and (forall id in set dom initial & initial(id).dependsOn subset (dom initial \ {id}))
  post tickets = initial and closure = parentClosure;

  -- 主协调器将一张可派发票据放上桌面；每张票据至多放上桌面一次
  Launch(id: TicketId)
  ext wr tickets rd completed
  pre not completed and Launchable(tickets, id)
  post tickets = tickets~ ++ {id |-> mu(tickets~(id), started |-> true)};

  -- 编写者席位提交分支与拉取请求说明后，票据进入发布阶段等待源码确认
  Submit(id: TicketId)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).stage = <Coding>
      and DependenciesDone(tickets, tickets(id))
  post tickets = tickets~ ++ {id |-> mu(tickets~(id), stage |-> <Publishing>)};

  -- 拉取请求发布经源码确认且可合并、必需检查通过时，在当前指纹上开启审查与验收门禁
  OpenReviewGates(id: TicketId, stamp: Stamp)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).stage in set {<Publishing>, <Reviewing>}
  post tickets = tickets~ ++ {id |-> mu(tickets~(id),
         stage |-> <Reviewing>,
         review |-> mk_GateRecord(stamp, <Pending>),
         accept |-> mk_GateRecord(stamp, <Pending>))};

  -- 审查、验收或合并后门禁交回裁决；拒绝时递增修订号并回退编写或升级，双门禁同时通过且依赖完成时进入合并阶段
  Verdict(id: TicketId, role: GateRole, passed: bool, stamp: Stamp)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and role in set AvailableRoles(tickets, id)
      and ((role = <Review> and tickets(id).review = mk_GateRecord(stamp, <Pending>))
           or (role = <Accept> and tickets(id).accept = mk_GateRecord(stamp, <Pending>))
           or (role = <PostMerge> and tickets(id).postMerge = mk_GateRecord(stamp, <Pending>)))
  post let prev = tickets~(id) in
       if not passed
       then tickets = tickets~ ++ {id |-> mu(prev,
              revision |-> prev.revision + 1,
              stage |-> if role = <PostMerge> then <Escalated> else <Coding>,
              review |-> nil,
              accept |-> nil,
              postMerge |-> nil)}
       elseif role = <Review>
       then let nextStage =
              if prev.accept <> nil and prev.accept.status = <Passed> and DependenciesDone(tickets~, prev)
              then <Merging>
              else <Reviewing> in
            tickets = tickets~ ++ {id |-> mu(prev,
              stage |-> nextStage,
              review |-> mk_GateRecord(stamp, <Passed>))}
       elseif role = <Accept>
       then let nextStage =
              if prev.review <> nil and prev.review.status = <Passed> and DependenciesDone(tickets~, prev)
              then <Merging>
              else <Reviewing> in
            tickets = tickets~ ++ {id |-> mu(prev,
              stage |-> nextStage,
              accept |-> mk_GateRecord(stamp, <Passed>))}
       else tickets = tickets~ ++ {id |-> mu(prev,
              postMerge |-> mk_GateRecord(stamp, <Passed>))};

  -- 拉取请求合并经源码确认后记录合并终端状态，并在合并提交指纹上开启合并后核验门禁
  ConfirmMerge(id: TicketId, stamp: Stamp)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).stage = <Merging>
  post tickets = tickets~ ++ {id |-> mu(tickets~(id),
         stage |-> <Verifying>,
         terminal |-> <Merged>,
         postMerge |-> mk_GateRecord(stamp, <Pending>))};

  -- 合并后门禁通过且议题关闭，或无需代码裁定且议题关闭经源码确认后，票据到达完成阶段
  ConfirmDone(id: TicketId)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and ((tickets(id).stage = <Verifying>
            and tickets(id).postMerge <> nil
            and tickets(id).postMerge.status = <Passed>)
           or (tickets(id).stage = <Escalated>
               and tickets(id).terminal = <NoCode>))
  post tickets = tickets~ ++ {id |-> mu(tickets~(id), stage |-> <Done>)};

  -- 席位主动升级、席位无交接退出、外部写入失败或源码契约漂移时，递增修订号、清空门禁并转入升级阶段
  Escalate(id: TicketId)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).stage <> <Done>
  post let prev = tickets~(id) in
       tickets = tickets~ ++ {id |-> mu(prev,
         revision |-> prev.revision + 1,
         stage |-> <Escalated>,
         review |-> nil,
         accept |-> nil,
         postMerge |-> nil)};

  -- 主协调器裁定升级票据：递增修订号、清空旧门禁，按裁定转入目标阶段或标记无需代码等待议题关闭确认
  Resolve(id: TicketId, targetStage: ResolveStage, noCode: bool)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).stage = <Escalated>
      and (noCode => targetStage = <Done>)
  post let prev = tickets~(id) in
       tickets = tickets~ ++ {id |-> mu(prev,
         revision |-> prev.revision + 1,
         stage |-> if noCode then <Escalated> else targetStage,
         review |-> nil,
         accept |-> nil,
         postMerge |-> nil,
         terminal |-> if noCode then <NoCode> elseif targetStage <> <Done> and prev.terminal = <NoCode> then nil else prev.terminal)};

  -- 父议题收尾门禁提交裁决；拒绝时递增修订号并转入升级阶段
  JudgeClosure(passed: bool, stamp: Stamp)
  ext wr closure rd tickets rd completed
  pre not completed
      and closure <> nil
      and (forall t in set rng tickets & t.stage = <Done>)
      and closure.stage = <Reviewing>
      and closure.gate = mk_GateRecord(stamp, <Pending>)
  post if passed
       then closure = mu(closure~, gate |-> mk_GateRecord(stamp, <Passed>))
       else closure = mu(closure~,
              revision |-> closure~.revision + 1,
              stage |-> <Escalated>,
              gate |-> mk_GateRecord(stamp, <Failed>));

  -- 父议题收尾门禁通过且父议题关闭经源码确认后，父议题收尾完成
  ConfirmClosure()
  ext wr closure rd completed
  pre not completed
      and closure <> nil
      and closure.stage = <Reviewing>
      and closure.gate.status = <Passed>
  post closure = mu(closure~, stage |-> <Done>);

  -- 全部票据与父议题收尾门禁均完成后，主协调器结束议程
  Finish()
  ext rd tickets rd closure wr completed
  pre not completed
      and (forall t in set rng tickets & t.stage = <Done>)
      and (closure <> nil => closure.stage = <Done>)
  post completed = true;
end Ticket
```
