# 议程账本连接

```vdm
module Agenda
imports from Roundtable types IssueRef renamed IssueRef
exports
  types
    TicketId; Observation; Workflow; Contract; Fingerprint; IntentId; RunId;
    struct Revision; struct StepKind; struct Stage; struct Ticket;
    struct Handoff; struct CallResult; struct Settled; struct Disposal; struct Takeover
  functions
    DepsDone: map TicketId to Ticket * TicketId -> bool
  operations
    Convene: [IssueRef] * map TicketId to Ticket * RunId * Observation ==> ();
    Release: TicketId ==> ();
    Produce: TicketId * Revision ==> Handoff;
    Judge: TicketId * Revision * Fingerprint * bool * Observation ==> Handoff;
    Begin: TicketId * Observation ==> IntentId;
    Settle: IntentId * CallResult * Observation ==> Settled;
    Complete: TicketId * Observation ==> ();
    Recheck: TicketId * Observation ==> ();
    Except: TicketId * Revision ==> Handoff;
    Resolve: TicketId * Revision * nat1 * Contract * set of TicketId ==> ();
    Dispose: IntentId * Disposal * Observation ==> Handoff;
    Resume: RunId * Takeover ==> ();
    Snapshot: () ==> map TicketId to Ticket;
    Pending: () ==> set of TicketId;
    Finish: () ==> ()
definitions
types
  -- 议程内一张票据的身份；使用方原样传递
  TicketId = token;

  -- 票据的工作期编号，从 1 开始；每次作废在途工作时加一
  Revision = nat1;

  -- 一次完整的源头观察，只代表读取那一刻；读取中途对象身份或版本变化的读取不会成为观察
  Observation = token;

  -- 一类票据的工作流定义；来自工作流配置，内容待定，账本只用到它的步骤序列、重做位置与完成条件
  Workflow = token;

  -- 工作流里一步的种类：席位做工作、席位对一个指纹下结论、对源头写一次
  StepKind = <Produce> | <Judge> | <Write>;

  -- 被采纳的需求版本；只有 Main 的裁定能换掉它
  Contract = token;

  -- 被评判对象的版本标识；指纹相同即同一个被评判对象
  Fingerprint = token;

  -- 一条写入意图的身份；每次决定对源头写一次就有一条新意图
  IntentId = token;

  -- 一次协调器运行的身份；一次运行对应一个进程
  RunId = token;

  -- 票据的状况：推进中、例外待 Main 裁定、已完成
  Stage = <Running> | <Excepted> | <Done>;

  -- 写入意图的状况：执行中、已知失败、结果不明、源头已确认、已放弃
  IntentState = <Executing> | <Failed> | <Uncertain> | <Confirmed> | <Dropped>;

  -- 一条写入意图：属于哪张票据的哪一个写入步骤
  Intent ::
    ticket : TicketId  -- 所属票据
    step : nat1  -- 它执行的写入步骤
    status : IntentState;  -- 当前状况

  -- 一张票据；推进只沿它的工作流定义走
  Ticket ::
    issue : IssueRef  -- 交付的议题
    flow : Workflow  -- 它这一类的工作流定义
    deps : set of TicketId  -- 必须先完成的票据
    contract : Contract  -- 被采纳的需求版本
    revision : Revision  -- 当前工作期；只接受这个工作期的交接
    released : bool  -- Main 是否已放行；只放行一次
    pos : nat1  -- 当前所在的步骤；超过步骤数表示等待完成判定
    approvals : map nat1 to Fingerprint  -- 本工作期内已通过的评判步骤及其指纹
    stage : Stage;  -- 推进中、例外或已完成

  -- 一次交接或请求的结局：被接受，或因工作期已被取代、前提不再成立而拒收
  Handoff = <Accepted> | <Stale>;

  -- 外部写入调用的返回；返回本身不证明源头结果
  CallResult = <Returned> | <KnownFailure> | <Unknown>;

  -- 写入核对后的结局：源头已确认、已知失败、结果不明
  Settled = <Confirmed> | <Failed> | <Uncertain>;

  -- Main 对一条失败或不明写入的处置：按源头确认采纳，或放弃（需要重做时由裁定回到写入步骤重新登记）
  Disposal = <Adopt> | <Drop>;

  -- 接管议程的前提：操作员确认原协调器进程已结束
  Takeover = <OriginalEnded>;

  -- 议程账本：依赖不出议程且无环；每张票据至多一条执行中的写入；带着失败或不明写入的票据只能处于例外
state Ledger of
  tickets : map TicketId to Ticket  -- 议程中的票据
  intents : map IntentId to Intent  -- 全部写入意图
  spent : set of Observation  -- 已经支撑过转换的观察
  writer : [RunId]  -- 当前写入议程的协调器运行
  inv mk_Ledger(ts, ins, -, -) ==
    (forall id in set dom ts & ts(id).deps subset (dom ts \ {id}))
    and Acyclic(ts)
    and (forall e in set dom ins & ins(e).ticket in set dom ts)
    and (forall id in set dom ts &
           card {e | e in set dom ins & ins(e).ticket = id and ins(e).status = <Executing>} <= 1)
    and (forall e in set dom ins &
           ins(e).status in set {<Failed>, <Uncertain>} => ts(ins(e).ticket).stage = <Excepted>)
  init l == l = mk_Ledger({|->}, {|->}, {}, nil)
end

functions
  -- 工作流的步骤序列；内容来自工作流配置，待定
  Steps: Workflow -> seq1 of StepKind
  Steps(w) == is not yet specified;

  -- 评判否决后回到哪一步重做：此前的一个产出步骤；具体位置来自工作流配置
  ReworkAt(w: Workflow, failed: nat1) r: nat1
  pre failed <= len Steps(w) and exists j in set inds Steps(w) & j <= failed and Steps(w)(j) = <Produce>
  post r <= failed and Steps(w)(r) = <Produce>;

  -- 观察显示工作流的完成条件已满足；条件来自工作流配置，待定
  Finished: Workflow * Observation -> bool
  Finished(w, o) == is not yet specified;

  -- 观察显示某个写入步骤的预期结果已在源头出现；结果的判定来自工作流配置，待定
  Effected: Workflow * nat1 * Observation -> bool
  Effected(w, s, o) == is not yet specified;

  -- 观察中这张票据被评判对象的当前指纹；指纹覆盖被评判对象、目标、需求与裁定，待定
  Current: Ticket * Observation -> Fingerprint
  Current(t, o) == is not yet specified;

  -- 观察中议题的需求是否与票据采纳的契约不一致，待定
  Drifted: Ticket * Observation -> bool
  Drifted(t, o) == is not yet specified;

  -- 观察中父议题当前的子议题，待定
  Children: IssueRef * Observation -> set of IssueRef
  Children(p, o) == is not yet specified;

  -- 依赖无环：任何一组票据里都至少有一张不依赖同组其它票据；两个实现必须得出同一结论
  Acyclic: map TicketId to Ticket -> bool
  Acyclic(ts) ==
    forall s in set power dom ts &
      s <> {} => exists id in set s & ts(id).deps inter s = {};

  -- 票据的依赖都已完成；两个实现必须得出同一结论
  DepsDone: map TicketId to Ticket * TicketId -> bool
  DepsDone(ts, id) ==
    id in set dom ts
    and forall d in set ts(id).deps & d in set dom ts and ts(d).stage = <Done>;

  -- 票据此刻接受某一种步骤在工作期 rev 的交接：已放行、推进中、工作期一致、依赖都已完成、当前步骤正是这一种
  Accepts: map TicketId to Ticket * TicketId * Revision * StepKind -> bool
  Accepts(ts, id, rev, k) ==
    DepsDone(ts, id)
    and let t = ts(id) in
      t.released and t.stage = <Running> and t.revision = rev
      and t.pos <= len Steps(t.flow) and Steps(t.flow)(t.pos) = k;

  -- 把票据交给 Main：转入例外并开启新的工作期
  Excepted: Ticket -> Ticket
  Excepted(t) == mu(t, stage |-> <Excepted>, revision |-> t.revision + 1);

  -- 一组步骤里最早的一个
  Earliest: set of nat1 -> nat1
  Earliest(s) == let m in set s be st forall x in set s & m <= x in m
  pre s <> {};

operations
  -- 召集议程：写入初始票据，全部推进中、未放行、停在第一步；每个议题至多一张票据；有父议题时它当前的每个子议题都有票据
  Convene(parent: [IssueRef], initial: map TicketId to Ticket, run: RunId, obs: Observation)
  ext wr tickets wr spent wr writer
  pre tickets = {|->} and obs not in set spent
      and (forall id in set dom initial &
             initial(id).deps subset (dom initial \ {id})
             and not initial(id).released and initial(id).stage = <Running>
             and initial(id).pos = 1 and initial(id).approvals = {|->})
      and Acyclic(initial)
      and (forall a, b in set dom initial & a <> b => initial(a).issue <> initial(b).issue)
      and (parent <> nil => forall c in set Children(parent, obs) & exists t in set rng initial & t.issue = c)
  post tickets = initial and spent = spent~ union {obs} and writer = run;

  -- Main 放行一张票据；每张票据只放行一次，且只在依赖都已完成时
  Release(id: TicketId)
  ext wr tickets
  pre id in set dom tickets and not tickets(id).released
      and tickets(id).stage = <Running> and DepsDone(tickets, id)
  post tickets = tickets~ ++ {id |-> mu(tickets~(id), released |-> true)};

  -- 产出席位交接当前产出步骤的结果；只接受当前工作期的交接，被接受后进入下一步，此前的评判全部作废
  Produce(id: TicketId, rev: Revision) r: Handoff
  ext wr tickets
  pre id in set dom tickets
  post (Accepts(tickets~, id, rev, <Produce>) and r = <Accepted>
          and tickets = tickets~ ++ {id |-> mu(tickets~(id), pos |-> tickets~(id).pos + 1, approvals |-> {|->})})
       or (not Accepts(tickets~, id, rev, <Produce>) and r = <Stale> and tickets = tickets~);

  -- 评判席位在指纹 fp 上交接结论；只接受当前工作期、且 fp 正是观察中当前指纹的结论；通过则记下指纹进入下一步，否决则开启新工作期回到产出步骤重做
  Judge(id: TicketId, rev: Revision, fp: Fingerprint, pass: bool, obs: Observation) r: Handoff
  ext wr tickets wr spent
  pre id in set dom tickets and obs not in set spent
  post spent = spent~ union {obs}
       and let t = tickets~(id) in
         ((Accepts(tickets~, id, rev, <Judge>) and fp = Current(t, obs) and r = <Accepted>
            and tickets = tickets~ ++ {id |->
              if pass then mu(t, pos |-> t.pos + 1, approvals |-> t.approvals ++ {t.pos |-> fp})
              else mu(t, pos |-> ReworkAt(t.flow, t.pos), revision |-> t.revision + 1, approvals |-> {|->})})
          or ((not Accepts(tickets~, id, rev, <Judge>) or fp <> Current(t, obs))
            and r = <Stale> and tickets = tickets~));

  -- 为当前写入步骤登记一条执行中的意图，在调用源头之前；只在本工作期的全部评判都通过于观察中的当前指纹时
  Begin(id: TicketId, obs: Observation) e: IntentId
  ext wr intents wr spent rd tickets
  pre id in set dom tickets and obs not in set spent
      and Accepts(tickets, id, tickets(id).revision, <Write>)
      and (forall s in set rng tickets(id).approvals & s = Current(tickets(id), obs))
      and not exists i in set rng intents & i.ticket = id and i.status = <Executing>
  post e not in set dom intents~
       and intents = intents~ ++ {e |-> mk_Intent(id, tickets(id).pos, <Executing>)}
       and spent = spent~ union {obs};

  -- 调用之后核对写入：只有观察显示预期结果已在源头出现才确认，票据进入下一步；否则已知失败记为失败、其余记为不明，票据交给 Main
  Settle(e: IntentId, call: CallResult, obs: Observation) r: Settled
  ext wr intents wr tickets wr spent
  pre e in set dom intents and intents(e).status = <Executing> and obs not in set spent
  post spent = spent~ union {obs}
       and let i = intents~(e), t = tickets~(i.ticket) in
         ((Effected(t.flow, i.step, obs) and r = <Confirmed>
            and intents = intents~ ++ {e |-> mu(i, status |-> <Confirmed>)}
            and tickets = tickets~ ++ {i.ticket |->
              if t.stage = <Running> and t.pos = i.step then mu(t, pos |-> t.pos + 1) else t})
          or (not Effected(t.flow, i.step, obs) and call = <KnownFailure> and r = <Failed>
            and intents = intents~ ++ {e |-> mu(i, status |-> <Failed>)}
            and tickets = tickets~ ++ {i.ticket |-> if t.stage = <Excepted> then t else Excepted(t)})
          or (not Effected(t.flow, i.step, obs) and call <> <KnownFailure> and r = <Uncertain>
            and intents = intents~ ++ {e |-> mu(i, status |-> <Uncertain>)}
            and tickets = tickets~ ++ {i.ticket |-> if t.stage = <Excepted> then t else Excepted(t)}));

  -- 走完全部步骤的票据，只在观察显示完成条件满足时完成
  Complete(id: TicketId, obs: Observation)
  ext wr tickets wr spent
  pre id in set dom tickets and obs not in set spent
      and tickets(id).stage = <Running> and tickets(id).pos > len Steps(tickets(id).flow)
  post spent = spent~ union {obs}
       and tickets = tickets~ ++ {id |->
         if Finished(tickets~(id).flow, obs) then mu(tickets~(id), stage |-> <Done>) else tickets~(id)};

  -- 用新观察复核票据：需求与契约不一致、或已完成的票据不再满足完成条件时交给 Main；评判过的指纹不再是当前指纹时，开启新工作期，作废最早失效的评判及其后的评判并回到那一步
  Recheck(id: TicketId, obs: Observation)
  ext wr tickets wr spent
  pre id in set dom tickets and obs not in set spent
  post spent = spent~ union {obs}
       and let t = tickets~(id),
               stale = {j | j in set dom t.approvals & t.approvals(j) <> Current(t, obs)} in
         if t.stage <> <Excepted> and (Drifted(t, obs) or (t.stage = <Done> and not Finished(t.flow, obs)))
         then tickets = tickets~ ++ {id |-> Excepted(t)}
         elseif t.stage = <Running> and stale <> {}
         then tickets = tickets~ ++ {id |-> mu(t,
                pos |-> Earliest(stale),
                revision |-> t.revision + 1,
                approvals |-> {j |-> t.approvals(j) | j in set dom t.approvals & j < Earliest(stale)})}
         else tickets = tickets~;

  -- 把推进中的票据交给 Main（席位未交接就结束或起不来时）；只接受当前工作期的请求
  Except(id: TicketId, rev: Revision) r: Handoff
  ext wr tickets
  pre id in set dom tickets
  post (tickets~(id).stage = <Running> and tickets~(id).revision = rev and r = <Accepted>
          and tickets = tickets~ ++ {id |-> Excepted(tickets~(id))})
       or ((tickets~(id).stage <> <Running> or tickets~(id).revision <> rev)
          and r = <Stale> and tickets = tickets~);

  -- Main 裁定一张例外票据：采纳给定的契约与依赖，开启新工作期，从给定步骤续接；票据还有执行中、失败或不明的写入时不能续接
  Resolve(id: TicketId, rev: Revision, resume: nat1, contract: Contract, deps: set of TicketId)
  ext wr tickets rd intents
  pre id in set dom tickets and tickets(id).stage = <Excepted> and tickets(id).revision = rev
      and resume <= len Steps(tickets(id).flow) + 1
      and deps subset (dom tickets \ {id})
      and Acyclic(tickets ++ {id |-> mu(tickets(id), deps |-> deps)})
      and not exists i in set rng intents &
            i.ticket = id and i.status in set {<Executing>, <Failed>, <Uncertain>}
  post tickets = tickets~ ++ {id |-> mu(tickets~(id),
         stage |-> <Running>, pos |-> resume, contract |-> contract, deps |-> deps,
         revision |-> rev + 1, approvals |-> {|->})};

  -- Main 处置一条失败或不明的写入：采纳只在观察显示预期结果已在源头出现时成立；放弃结束这条意图
  Dispose(e: IntentId, d: Disposal, obs: Observation) r: Handoff
  ext wr intents rd tickets wr spent
  pre e in set dom intents and intents(e).status in set {<Failed>, <Uncertain>} and obs not in set spent
  post spent = spent~ union {obs}
       and let i = intents~(e) in
         ((d = <Adopt> and Effected(tickets(i.ticket).flow, i.step, obs) and r = <Accepted>
            and intents = intents~ ++ {e |-> mu(i, status |-> <Confirmed>)})
          or (d = <Adopt> and not Effected(tickets(i.ticket).flow, i.step, obs) and r = <Stale>
            and intents = intents~)
          or (d = <Drop> and r = <Accepted>
            and intents = intents~ ++ {e |-> mu(i, status |-> <Dropped>)}));

  -- 新的协调器运行接管议程：须操作员确认原进程已结束；中断时执行中的写入记为不明，不重放，其票据交给 Main
  Resume(run: RunId, confirmed: Takeover)
  ext wr writer wr intents wr tickets
  pre confirmed = <OriginalEnded> and writer <> nil and run <> writer
  post writer = run
       and intents = {e |-> (if intents~(e).status = <Executing> then mu(intents~(e), status |-> <Uncertain>) else intents~(e))
                      | e in set dom intents~}
       and tickets = tickets~ ++ {intents~(e).ticket |-> Excepted(tickets~(intents~(e).ticket))
                      | e in set dom intents~ & intents~(e).status = <Executing>};

  -- 读取票据表；只读
  Snapshot() r: map TicketId to Ticket
  ext rd tickets
  post r = tickets;

  -- 读取还有未结写入的票据；只读
  Pending() r: set of TicketId
  ext rd intents
  post r = {i.ticket | i in set rng intents & i.status not in set {<Confirmed>, <Dropped>}};

  -- 结束议程：全部票据已完成且没有未结的写入；之后可以召集新的议程
  Finish()
  ext wr tickets wr intents
  pre tickets <> {|->} and (forall t in set rng tickets & t.stage = <Done>)
      and (forall i in set rng intents & i.status in set {<Confirmed>, <Dropped>})
  post tickets = {|->} and intents = {|->};
end Agenda
```
