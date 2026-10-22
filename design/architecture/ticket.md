# 票据与议程连接

```vdm
module Ticket
exports
  types
    TicketId; IssueRef; Stamp; Gate;
    struct Revision; struct Status; struct TicketRecord
  functions
    DependenciesDone: map TicketId to TicketRecord * TicketRecord -> bool;
    Launchable: map TicketId to TicketRecord * TicketId -> bool
  operations
    Convene: map TicketId to TicketRecord ==> ();
    Launch: TicketId ==> ();
    PassGate: TicketId * Gate * Stamp ==> ();
    RefreshStamp: TicketId * Stamp ==> ();
    Escalate: TicketId ==> ();
    Resolve: TicketId * Stamp * set of Gate ==> ();
    Complete: TicketId ==> ()
definitions
types
  -- 议程内票据的唯一身份；使用方原样传递，不读内部结构
  TicketId = token;

  -- 关联的远端议题身份；使用方不读内部结构
  IssueRef = token;

  -- 绑定远端契约与提交状态的源码指纹；使用方不读内部结构
  Stamp = token;

  -- 单道核验门禁的身份；使用方不读内部结构
  Gate = token;

  -- 票据的单调递增修订号，从 1 开始
  Revision = nat
  inv r == r > 0;

  -- 票据的协调状态
  Status = <Open> | <Escalated> | <Done>;

  -- 单张票据的核心约束记录：已通过门禁必属必需门禁，未启动票据无通过门禁且未完成，已完成票据必已通过全部必需门禁
  TicketRecord ::
    issue : IssueRef  -- 关联的远端议题身份
    dependsOn : set of TicketId  -- 必须先到达完成状态的前置票据集合
    started : bool  -- 主协调器是否已将该票据放上桌面准入流转
    revision : Revision  -- 票据递增修订号，每次指纹变更或升级时递增
    stamp : Stamp  -- 当前门禁结论所绑定的源码指纹
    required : set of Gate  -- 当前指纹下完成交付所需的核验门禁集合
    passed : set of Gate  -- 在当前指纹下已通过的核验门禁集合
    status : Status  -- 票据当前所处的协调状态
  inv t ==
    t.passed subset t.required
    and (not t.started => t.passed = {} and t.status <> <Done>)
    and (t.status = <Done> => t.passed = t.required);

  -- 议程状态：所有票据的前置依赖均属于本议程且不含自依赖
state Agenda of
  tickets : map TicketId to TicketRecord  -- 议程中的票据表
  inv mk_Agenda(ts) ==
    forall id in set dom ts & ts(id).dependsOn subset (dom ts \ {id})
  init a == a = mk_Agenda({|->})
end

functions
  -- 判定票据的全部前置依赖是否均已完成
  DependenciesDone: map TicketId to TicketRecord * TicketRecord -> bool
  DependenciesDone(ts, t) ==
    forall dep in set t.dependsOn &
      dep in set dom ts and ts(dep).status = <Done>;

  -- 判定票据是否可由主协调器放上桌面：处于打开状态、尚未启动且前置依赖全部完成
  Launchable: map TicketId to TicketRecord * TicketId -> bool
  Launchable(ts, id) ==
    id in set dom ts
    and let t = ts(id) in
        t.status = <Open>
        and not t.started
        and DependenciesDone(ts, t);

operations
  -- 召集新议程并写入初始票据图
  Convene(initial: map TicketId to TicketRecord)
  ext wr tickets
  pre forall id in set dom initial & initial(id).dependsOn subset (dom initial \ {id})
  post if tickets~ = {|->}
       then tickets = initial
       else tickets = tickets~;

  -- 主协调器将一张可派发票据放上桌面；每张票据至多放上桌面一次
  Launch(id: TicketId)
  ext wr tickets
  post if Launchable(tickets~, id)
       then tickets = tickets~ ++ {id |-> mu(tickets~(id), started |-> true)}
       else tickets = tickets~;

  -- 记下票据在当前源码指纹下通过的一道必需门禁
  PassGate(id: TicketId, gate: Gate, stamp: Stamp)
  ext wr tickets
  post if id in set dom tickets~
          and tickets~(id).started
          and tickets~(id).status = <Open>
          and tickets~(id).stamp = stamp
          and gate in set tickets~(id).required
       then let prev = tickets~(id) in
            tickets = tickets~ ++ {id |-> mu(prev, passed |-> prev.passed union {gate})}
       else tickets = tickets~;

  -- 远端源码指纹变更时更新指纹、递增修订号并清空旧指纹下的门禁通过记录
  RefreshStamp(id: TicketId, stamp: Stamp)
  ext wr tickets
  post if id in set dom tickets~
          and tickets~(id).status = <Open>
          and tickets~(id).stamp <> stamp
       then let prev = tickets~(id) in
            tickets = tickets~ ++ {id |-> mu(prev,
              revision |-> prev.revision + 1,
              stamp |-> stamp,
              passed |-> {})}
       else tickets = tickets~;

  -- 门禁拒绝、席位无交接退出、外部写入失败或契约冲突时，递增修订号、清空门禁并转入升级状态
  Escalate(id: TicketId)
  ext wr tickets
  post if id in set dom tickets~ and tickets~(id).status <> <Done>
       then let prev = tickets~(id) in
            tickets = tickets~ ++ {id |-> mu(prev,
              revision |-> prev.revision + 1,
              passed |-> {},
              status |-> <Escalated>)}
       else tickets = tickets~;

  -- 主协调器裁定升级票据：递增修订号、绑定新源码指纹与必需门禁集合并重新打开票据
  Resolve(id: TicketId, stamp: Stamp, required: set of Gate)
  ext wr tickets
  post if id in set dom tickets~ and tickets~(id).status = <Escalated>
       then let prev = tickets~(id) in
            tickets = tickets~ ++ {id |-> mu(prev,
              revision |-> prev.revision + 1,
              stamp |-> stamp,
              required |-> required,
              passed |-> {},
              status |-> <Open>)}
       else tickets = tickets~;

  -- 前置依赖全部完成且当前指纹下的必需门禁全部通过后，确认票据完成
  Complete(id: TicketId)
  ext wr tickets
  post if id in set dom tickets~
          and tickets~(id).started
          and tickets~(id).status = <Open>
          and DependenciesDone(tickets~, tickets~(id))
          and tickets~(id).passed = tickets~(id).required
       then tickets = tickets~ ++ {id |-> mu(tickets~(id), status |-> <Done>)}
       else tickets = tickets~;
end Ticket
```
