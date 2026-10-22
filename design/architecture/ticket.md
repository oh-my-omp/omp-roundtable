# 票据与议程连接

```vdm
module Ticket
exports
  types
    TicketId; IssueRef; Target; Stamp;
    struct Revision; struct GateRole; struct Role;
    struct GateStatus; struct Terminal;
    struct ReviewGates; struct VerifyGate; struct DoneStage; struct TicketStage;
    struct TicketEntry; struct ClosureStage; struct ClosureGate;
    struct MergeReadyPr; struct MergedPr; struct SourceObservation;
    struct ReopenReview; struct ReopenVerify; struct ResolveDecision
  functions
    DependenciesDone: map TicketId to TicketEntry * TicketEntry -> bool;
    Launchable: map TicketId to TicketEntry * TicketId -> bool;
    ReadyToMerge: map TicketId to TicketEntry * TicketId -> bool;
    AvailableRoles: map TicketId to TicketEntry * [ClosureGate] * TicketId -> set of Role
  operations
    Convene: map TicketId to TicketEntry * [ClosureGate] ==> ();
    Launch: TicketId ==> ();
    Submit: TicketId ==> ();
    OpenReviewGates: TicketId * Stamp ==> ();
    Verdict: TicketId * GateRole * bool * Stamp ==> ();
    ConfirmMerge: TicketId * Stamp ==> ();
    ConfirmDone: TicketId ==> ();
    ReconcileTicket: TicketId * SourceObservation ==> ();
    Escalate: TicketId ==> ();
    Resolve: TicketId * ResolveDecision ==> ();
    JudgeClosure: bool * Stamp ==> ();
    ResolveClosure: Stamp ==> ();
    ConfirmClosure: () ==> ();
    Finish: () ==> ()
definitions
types
  -- 票据或父议题收尾门禁的唯一身份；使用方原样传递，不读内部结构
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

  -- 附着在单张票据上的三个独立核验门禁角色
  GateRole = <Review> | <Accept> | <PostMerge>;

  -- 协调器可派发的全部席位角色
  Role = <Owner> | GateRole | <Closure>;

  -- 门禁在当前源码指纹下的核验状态
  GateStatus = <Pending> | <Passed> | <Failed>;

  -- 票据经源码确认的终端完成形态
  Terminal = <Merged> | <NoCode>;

  -- 审查阶段的双门禁记录：审查与验收始终评判同一个拉取请求源码指纹
  ReviewGates ::
    stamp : Stamp  -- 审查与验收共同绑定的拉取请求源码指纹
    review : GateStatus  -- 审查门禁结论
    accept : GateStatus;  -- 验收门禁结论

  -- 合并后核验或父议题收尾门禁记录：绑定单个待核验的源码指纹
  VerifyGate ::
    stamp : Stamp  -- 待核验的合并提交或父议题收尾指纹
    status : GateStatus;  -- 核验门禁结论

  -- 已完成阶段：携带经源码确认的终端完成形态
  DoneStage ::
    terminal : Terminal;  -- 经源码确认的合并完成或无需代码完成

  -- 票据在交付生命周期中的阶段和类型：门禁与终端载荷仅在对应阶段存在
  TicketStage =
    <Coding>
    | <Publishing>
    | ReviewGates
    | <Merging>
    | VerifyGate
    | <ClosingNoCode>
    | <Escalated>
    | DoneStage;

  -- 单张交付票据的核心记录
  TicketEntry ::
    issue : IssueRef  -- 交付对应的 GitHub 议题身份
    target : Target  -- 交付的目标仓库与基线分支
    dependsOn : set of TicketId  -- 必须先到达已完成阶段的前置票据集合
    started : bool  -- 主协调器是否已将该票据放上桌面准入流转
    revision : Revision  -- 票据递增修订号，每次门禁失效或升级时递增
    stage : TicketStage  -- 票据当前所处的交付阶段及阶段专属载荷
  inv entry ==
    not entry.started => entry.stage in set {<Coding>, <Escalated>};

  -- 父议题收尾门禁的阶段和类型
  ClosureStage = VerifyGate | <Escalated> | <Done>;

  -- 全部子票据完成后核验父议题收尾条件的门禁
  ClosureGate ::
    id : TicketId  -- 父议题收尾门禁的身份，供席位、写入意图与通知统一寻址
    parent : IssueRef  -- 统领全部子票据的父议题身份
    revision : Revision  -- 父议题收尾门禁的修订号
    stage : ClosureStage;  -- 父议题收尾阶段及其门禁载荷

  -- 远端拉取请求处于打开、可合并且必需检查通过的观测事实
  MergeReadyPr ::
    stamp : Stamp;  -- 当前可合并拉取请求的源码指纹

  -- 远端拉取请求已合并且合并提交包含在目标分支中的观测事实
  MergedPr ::
    stamp : Stamp  -- 合并后核验指纹
    issueClosed : bool;  -- 对应议题在 GitHub 上是否已关闭

  -- 针对单张票据的远端源码对账观测分类
  SourceObservation =
    <ContractOrPrDrifted>
    | <ChecksOrMergeConflict>
    | MergeReadyPr
    | MergedPr
    | <IssueClosed>;

  -- 主协调器裁定升级票据进入审查阶段并绑定当前拉取请求指纹
  ReopenReview ::
    stamp : Stamp;  -- 当前打开拉取请求的源码指纹

  -- 主协调器裁定升级票据进入合并后核验阶段并绑定合并提交指纹
  ReopenVerify ::
    stamp : Stamp;  -- 已合并提交的源码指纹

  -- 主协调器对升级票据的裁定目标
  ResolveDecision = <ToCoding> | ReopenReview | ReopenVerify | <ToNoCode>;

  -- 议程状态：依赖边不出本议程票据集且无自环，收尾门禁身份与子票据不重叠，议程完成时全部票据与收尾门禁均已完成
state Agenda of
  tickets : map TicketId to TicketEntry  -- 议程中的子票据表
  closure : [ClosureGate]  -- 可选的父议题收尾门禁
  completed : bool  -- 议程是否已全部完成并收尾
  inv mk_Agenda(ts, c, done) ==
    (forall id in set dom ts & ts(id).dependsOn subset (dom ts \ {id}))
    and (c <> nil => c.id not in set dom ts)
    and (done =>
      (forall t in set rng ts & is_DoneStage(t.stage))
      and (c <> nil => c.stage = <Done>))
  init a == a = mk_Agenda({|->}, nil, false)
end

functions
  -- 判定票据的全部前置依赖是否都已到达完成阶段
  DependenciesDone: map TicketId to TicketEntry * TicketEntry -> bool
  DependenciesDone(ts, t) ==
    forall dep in set t.dependsOn &
      dep in set dom ts and is_DoneStage(ts(dep).stage);

  -- 判定票据是否可由主协调器放上桌面：处于编写阶段、尚未启动且前置依赖全部完成
  Launchable: map TicketId to TicketEntry * TicketId -> bool
  Launchable(ts, id) ==
    id in set dom ts
    and let entry = ts(id) in
        entry.stage = <Coding>
        and not entry.started
        and DependenciesDone(ts, entry);

  -- 判定票据是否已满足合并准入：已启动、前置依赖全部完成，且审查与验收双门禁在同一指纹下均已通过
  ReadyToMerge: map TicketId to TicketEntry * TicketId -> bool
  ReadyToMerge(ts, id) ==
    id in set dom ts
    and let entry = ts(id) in
        entry.started
        and DependenciesDone(ts, entry)
        and cases entry.stage:
              mk_ReviewGates(-, r, a) -> r = <Passed> and a = <Passed>,
              others -> false
            end;

  -- 计算子票据或父议题收尾门禁在当前阶段向接力器提供的可执行席位角色集合
  AvailableRoles: map TicketId to TicketEntry * [ClosureGate] * TicketId -> set of Role
  AvailableRoles(ts, c, id) ==
    if id in set dom ts
    then
      let entry = ts(id) in
      if not entry.started or not DependenciesDone(ts, entry)
      then {}
      else
        cases entry.stage:
          <Coding> -> {<Owner>},
          mk_ReviewGates(-, r, a) ->
            (if r = <Pending> then {<Review>} else {})
            union
            (if a = <Pending> then {<Accept>} else {}),
          mk_VerifyGate(-, s) ->
            if s = <Pending> then {<PostMerge>} else {},
          others -> {}
        end
    elseif c <> nil
           and id = c.id
           and (forall t in set rng ts & is_DoneStage(t.stage))
           and is_VerifyGate(c.stage)
           and c.stage.status = <Pending>
    then {<Closure>}
    else {};

operations
  -- 召集新议程并写入初始票据图与可选父议题门禁
  Convene(initial: map TicketId to TicketEntry, parentClosure: [ClosureGate])
  ext wr tickets wr closure rd completed
  pre not completed
      and tickets = {|->}
      and (forall id in set dom initial & initial(id).dependsOn subset (dom initial \ {id}))
      and (parentClosure <> nil => parentClosure.id not in set dom initial)
  post tickets = initial and closure = parentClosure;

  -- 主协调器将一张可派发票据放上桌面；每张票据至多放上桌面一次
  Launch(id: TicketId)
  ext wr tickets rd completed
  pre not completed and Launchable(tickets, id)
  post tickets = tickets~ ++ {id |-> mu(tickets~(id), started |-> true)};

  -- 已启动的编写者席位提交分支与拉取请求说明后，票据进入发布阶段等待源码确认
  Submit(id: TicketId)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).started
      and tickets(id).stage = <Coding>
      and DependenciesDone(tickets, tickets(id))
  post tickets = tickets~ ++ {id |-> mu(tickets~(id), stage |-> <Publishing>)};

  -- 拉取请求发布经源码确认且可合并、必需检查通过时，在当前指纹上开启审查与验收双门禁
  OpenReviewGates(id: TicketId, stamp: Stamp)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).started
      and (tickets(id).stage = <Publishing> or is_ReviewGates(tickets(id).stage))
  post let prev = tickets~(id) in
       let bumped = if is_ReviewGates(prev.stage) and prev.stage.stamp <> stamp
                    then prev.revision + 1
                    else prev.revision in
       tickets = tickets~ ++ {id |-> mu(prev,
         revision |-> bumped,
         stage |-> mk_ReviewGates(stamp, <Pending>, <Pending>))};

  -- 审查、验收或合并后门禁交回裁决；拒绝时递增修订号并回退编写或升级，双门禁同时通过且依赖完成时进入合并阶段
  Verdict(id: TicketId, role: GateRole, passed: bool, stamp: Stamp)
  ext wr tickets rd closure rd completed
  pre not completed
      and id in set dom tickets
      and role in set AvailableRoles(tickets, closure, id)
      and ((role = <Review>
            and is_ReviewGates(tickets(id).stage)
            and tickets(id).stage.stamp = stamp
            and tickets(id).stage.review = <Pending>)
           or (role = <Accept>
               and is_ReviewGates(tickets(id).stage)
               and tickets(id).stage.stamp = stamp
               and tickets(id).stage.accept = <Pending>)
           or (role = <PostMerge>
               and is_VerifyGate(tickets(id).stage)
               and tickets(id).stage.stamp = stamp
               and tickets(id).stage.status = <Pending>))
  post let prev = tickets~(id) in
       if not passed
       then tickets = tickets~ ++ {id |-> mu(prev,
              revision |-> prev.revision + 1,
              stage |-> if role = <PostMerge> then <Escalated> else <Coding>)}
       elseif role = <Review> and is_ReviewGates(prev.stage)
       then let nextStage =
              if prev.stage.accept = <Passed> and DependenciesDone(tickets~, prev)
              then <Merging>
              else mk_ReviewGates(stamp, <Passed>, prev.stage.accept) in
            tickets = tickets~ ++ {id |-> mu(prev, stage |-> nextStage)}
       elseif role = <Accept> and is_ReviewGates(prev.stage)
       then let nextStage =
              if prev.stage.review = <Passed> and DependenciesDone(tickets~, prev)
              then <Merging>
              else mk_ReviewGates(stamp, prev.stage.review, <Passed>) in
            tickets = tickets~ ++ {id |-> mu(prev, stage |-> nextStage)}
       else tickets = tickets~ ++ {id |-> mu(prev,
              stage |-> mk_VerifyGate(stamp, <Passed>))};

  -- 拉取请求合并经源码确认后，在合并提交指纹上开启合并后核验门禁
  ConfirmMerge(id: TicketId, stamp: Stamp)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).started
      and tickets(id).stage = <Merging>
  post tickets = tickets~ ++ {id |-> mu(tickets~(id),
         stage |-> mk_VerifyGate(stamp, <Pending>))};

  -- 合并后门禁通过且议题关闭，或无需代码裁定且议题关闭经源码确认后，票据到达完成阶段
  ConfirmDone(id: TicketId)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and ((is_VerifyGate(tickets(id).stage)
            and tickets(id).stage.status = <Passed>)
           or tickets(id).stage = <ClosingNoCode>)
  post let prev = tickets~(id) in
       let term = if prev.stage = <ClosingNoCode> then <NoCode> else <Merged> in
       tickets = tickets~ ++ {id |-> mu(prev, stage |-> mk_DoneStage(term))};

  -- 按最新 GitHub 源码观测事实对账单张票据：推进依赖已就绪的双过门禁进入合并、重开漂移的审查门禁、回退冲突或失败检查、或升级契约漂移
  ReconcileTicket(id: TicketId, obs: SourceObservation)
  ext wr tickets rd completed
  pre not completed and id in set dom tickets and tickets(id).started
  post let prev = tickets~(id) in
       cases obs:
         <ContractOrPrDrifted> ->
           tickets = tickets~ ++ {id |-> mu(prev,
             revision |-> prev.revision + 1,
             stage |-> <Escalated>)},
         <ChecksOrMergeConflict> ->
           if is_ReviewGates(prev.stage) or prev.stage = <Merging>
           then tickets = tickets~ ++ {id |-> mu(prev,
                  revision |-> prev.revision + 1,
                  stage |-> <Coding>)}
           else tickets = tickets~,
         mk_MergeReadyPr(stamp) ->
           if prev.stage = <Publishing>
           then tickets = tickets~ ++ {id |-> mu(prev,
                  stage |-> mk_ReviewGates(stamp, <Pending>, <Pending>))}
           elseif is_ReviewGates(prev.stage) and prev.stage.stamp <> stamp
           then tickets = tickets~ ++ {id |-> mu(prev,
                  revision |-> prev.revision + 1,
                  stage |-> mk_ReviewGates(stamp, <Pending>, <Pending>))}
           elseif ReadyToMerge(tickets~, id) and prev.stage = mk_ReviewGates(stamp, <Passed>, <Passed>)
           then tickets = tickets~ ++ {id |-> mu(prev, stage |-> <Merging>)}
           else tickets = tickets~,
         mk_MergedPr(stamp, closed) ->
           if prev.stage = <Merging>
           then tickets = tickets~ ++ {id |-> mu(prev,
                  stage |-> mk_VerifyGate(stamp, <Pending>))}
           elseif prev.stage = mk_VerifyGate(stamp, <Passed>) and closed
           then tickets = tickets~ ++ {id |-> mu(prev,
                  stage |-> mk_DoneStage(<Merged>))}
           else tickets = tickets~,
         <IssueClosed> ->
           if prev.stage = <ClosingNoCode>
           then tickets = tickets~ ++ {id |-> mu(prev,
                  stage |-> mk_DoneStage(<NoCode>))}
           else tickets = tickets~
       end;

  -- 席位主动升级、席位无交接退出或外部写入失败时，递增修订号并转入升级阶段
  Escalate(id: TicketId)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and not is_DoneStage(tickets(id).stage)
  post let prev = tickets~(id) in
       tickets = tickets~ ++ {id |-> mu(prev,
         revision |-> prev.revision + 1,
         stage |-> <Escalated>)};

  -- 主协调器裁定升级票据：递增修订号，按裁定目标回到编写、在给定指纹上重开审查或合并后核验、或转入等待无需代码关单确认
  Resolve(id: TicketId, decision: ResolveDecision)
  ext wr tickets rd completed
  pre not completed
      and id in set dom tickets
      and tickets(id).stage = <Escalated>
      and (not (decision = <ToCoding>) => tickets(id).started)
  post let prev = tickets~(id) in
       let nextStage =
         cases decision:
           <ToCoding> -> <Coding>,
           mk_ReopenReview(stamp) -> mk_ReviewGates(stamp, <Pending>, <Pending>),
           mk_ReopenVerify(stamp) -> mk_VerifyGate(stamp, <Pending>),
           <ToNoCode> -> <ClosingNoCode>
         end in
       tickets = tickets~ ++ {id |-> mu(prev,
         revision |-> prev.revision + 1,
         stage |-> nextStage)};

  -- 父议题收尾门禁提交裁决；拒绝时递增修订号并转入升级阶段
  JudgeClosure(passed: bool, stamp: Stamp)
  ext wr closure rd tickets rd completed
  pre not completed
      and closure <> nil
      and (forall t in set rng tickets & is_DoneStage(t.stage))
      and closure.stage = mk_VerifyGate(stamp, <Pending>)
  post if passed
       then closure = mu(closure~, stage |-> mk_VerifyGate(stamp, <Passed>))
       else closure = mu(closure~,
              revision |-> closure~.revision + 1,
              stage |-> <Escalated>);

  -- 主协调器裁定处于升级状态的父议题收尾门禁，在新指纹上重新开启收尾核验
  ResolveClosure(stamp: Stamp)
  ext wr closure rd tickets rd completed
  pre not completed
      and closure <> nil
      and (forall t in set rng tickets & is_DoneStage(t.stage))
      and closure.stage = <Escalated>
  post closure = mu(closure~,
         revision |-> closure~.revision + 1,
         stage |-> mk_VerifyGate(stamp, <Pending>));

  -- 父议题收尾门禁通过且父议题关闭经源码确认后，父议题收尾完成
  ConfirmClosure()
  ext wr closure rd completed
  pre not completed
      and closure <> nil
      and is_VerifyGate(closure.stage)
      and closure.stage.status = <Passed>
  post closure = mu(closure~, stage |-> <Done>);

  -- 全部票据与父议题收尾门禁均完成后，主协调器结束议程
  Finish()
  ext rd tickets rd closure wr completed
  pre not completed
      and (forall t in set rng tickets & is_DoneStage(t.stage))
      and (closure <> nil => closure.stage = <Done>)
  post completed = true;
end Ticket
```
