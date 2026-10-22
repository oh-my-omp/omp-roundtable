# 票据与议程连接

```vdm
module Ticket
exports
  types
    TicketId; IssueRef;
    struct Revision; struct Status; struct TicketRecord;
    struct Launched; struct ActivateOutcome;
    struct Escalated; struct EscalateOutcome; struct CompleteOutcome
  functions
    DependenciesDone: map TicketId to TicketRecord * TicketRecord -> bool;
    Launchable: map TicketId to TicketRecord * TicketId -> bool
  operations
    Convene: map TicketId to TicketRecord ==> ();
    Launch: TicketId ==> ActivateOutcome;
    Escalate: TicketId ==> EscalateOutcome;
    Resolve: TicketId ==> ActivateOutcome;
    Complete: TicketId * Revision ==> CompleteOutcome
definitions
types
  -- 议程内票据的唯一身份；使用方原样传递，不读内部结构
  TicketId = token;

  -- 关联的远端议题身份；使用方不读内部结构
  IssueRef = token;

  -- 票据的单调递增修订号，从 1 开始；同一票据每次升级或裁定时递增
  Revision = nat
  inv r == r > 0;

  -- 票据在议程中的生命周期状态
  Status = <Pending> | <Active> | <Escalated> | <Done>;

  -- 单张票据的记录
  TicketRecord ::
    issue : IssueRef  -- 关联的远端议题身份
    dependsOn : set of TicketId  -- 必须先到达完成状态的前置票据集合
    revision : Revision  -- 当前生效的票据修订号
    status : Status;  -- 票据当前所处的生命周期状态

  -- 票据已获准进入活动状态；调用方按交出的修订号派发席位并在完成时交回核对
  Launched ::
    revision : Revision;  -- 本轮生效的票据修订号

  -- Launch 与 Resolve 的结局：已进入活动状态并交出修订号，或因前置条件未满足而被拒绝
  ActivateOutcome = Launched | <Blocked>;

  -- 票据已转入升级状态；调用方按交出的新修订号通知主协调器裁定
  Escalated ::
    revision : Revision;  -- 触发本次升级的新修订号

  -- Escalate 的结局：已转入升级状态并交出新修订号，或因票据已完成/不存在而被拒绝
  EscalateOutcome = Escalated | <Rejected>;

  -- Complete 的结局：当前修订号确认完成，或因修订号过期/状态不符而被拒绝
  CompleteOutcome = <Completed> | <Rejected>;

  -- 议程状态：依赖边不出本议程票据集且不含自依赖，任何处于活动或完成状态的票据其前置依赖均已完成
state Agenda of
  tickets : map TicketId to TicketRecord  -- 议程中的票据表
  inv mk_Agenda(ts) ==
    forall id in set dom ts &
      let t = ts(id) in
      t.dependsOn subset (dom ts \ {id})
      and (t.status in set {<Active>, <Done>} => DependenciesDone(ts, t))
  init a == a = mk_Agenda({|->})
end

functions
  -- 判定票据的全部前置依赖是否均已到达完成状态；两个实现必须得出同一结论
  DependenciesDone: map TicketId to TicketRecord * TicketRecord -> bool
  DependenciesDone(ts, t) ==
    forall dep in set t.dependsOn &
      dep in set dom ts and ts(dep).status = <Done>;

  -- 判定票据是否可由主协调器放上桌面：处于待启动状态且前置依赖全部完成
  Launchable: map TicketId to TicketRecord * TicketId -> bool
  Launchable(ts, id) ==
    id in set dom ts
    and let t = ts(id) in
        t.status = <Pending>
        and DependenciesDone(ts, t);

operations
  -- 召集新议程并写入初始待启动票据图
  Convene(initial: map TicketId to TicketRecord)
  ext wr tickets
  pre forall id in set dom initial &
        initial(id).dependsOn subset (dom initial \ {id})
        and initial(id).status = <Pending>
  post if tickets~ = {|->}
       then tickets = initial
       else tickets = tickets~;

  -- 主协调器将一张可派发票据放上桌面；准入成功时转为活动状态并交出当前修订号
  Launch(id: TicketId) r: ActivateOutcome
  ext wr tickets
  post (Launchable(tickets~, id)
          and r = mk_Launched(tickets~(id).revision)
          and tickets = tickets~ ++ {id |-> mu(tickets~(id), status |-> <Active>)})
       or (not Launchable(tickets~, id)
             and r = <Blocked>
             and tickets = tickets~);

  -- 席位请求升级、无交接退出或外部对账冲突时，递增修订号并转入升级状态，交出新修订号供通知与裁定
  Escalate(id: TicketId) r: EscalateOutcome
  ext wr tickets
  post (id in set dom tickets~
          and tickets~(id).status in set {<Pending>, <Active>}
          and let prev = tickets~(id),
                  nextRev = prev.revision + 1 in
              r = mk_Escalated(nextRev)
              and tickets = tickets~ ++ {id |-> mu(prev,
                    revision |-> nextRev,
                    status |-> <Escalated>)})
       or ((id not in set dom tickets~
            or tickets~(id).status not in set {<Pending>, <Active>})
           and r = <Rejected>
           and tickets = tickets~);

  -- 主协调器裁定处于升级状态的票据；前置依赖全部完成时递增修订号、恢复活动状态并交出新修订号
  Resolve(id: TicketId) r: ActivateOutcome
  ext wr tickets
  post (id in set dom tickets~
          and tickets~(id).status = <Escalated>
          and DependenciesDone(tickets~, tickets~(id))
          and let prev = tickets~(id),
                  nextRev = prev.revision + 1 in
              r = mk_Launched(nextRev)
              and tickets = tickets~ ++ {id |-> mu(prev,
                    revision |-> nextRev,
                    status |-> <Active>)})
       or ((id not in set dom tickets~
            or tickets~(id).status <> <Escalated>
            or not DependenciesDone(tickets~, tickets~(id)))
           and r = <Blocked>
           and tickets = tickets~);

  -- 核对本轮修订号未过期且前置依赖全部完成后，将活动票据标记为完成
  Complete(id: TicketId, rev: Revision) r: CompleteOutcome
  ext wr tickets
  post (id in set dom tickets~
          and tickets~(id).status = <Active>
          and tickets~(id).revision = rev
          and DependenciesDone(tickets~, tickets~(id))
          and r = <Completed>
          and tickets = tickets~ ++ {id |-> mu(tickets~(id), status |-> <Done>)})
       or ((id not in set dom tickets~
            or tickets~(id).status <> <Active>
            or tickets~(id).revision <> rev
            or not DependenciesDone(tickets~, tickets~(id)))
           and r = <Rejected>
           and tickets = tickets~);
end Ticket
```
