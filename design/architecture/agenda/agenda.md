# 议程账本连接

```vdm
module Agenda
imports from Roundtable types IssueRef renamed IssueRef
exports
  types
    ReadId; Contract; Fingerprint; IntentId; RunId;
    struct TicketId; struct Revision; struct StepKind; struct Workflow; struct Observation; struct Stage; struct Ticket;
    struct Verdict; struct Closure; struct Handoff; struct CallResult; struct Settled; struct Disposal;
    struct Takeover
  functions
    DepsDone: map TicketId to Ticket * TicketId -> bool
  operations
    Convene: [IssueRef] * map TicketId to Ticket * RunId * Observation ==> ();
    Release: TicketId ==> ();
    Produce: TicketId * Revision * Observation ==> Handoff;
    Judge: TicketId * Revision * Fingerprint * bool * Observation ==> Handoff;
    Begin: TicketId * Observation ==> IntentId;
    Settle: IntentId * CallResult * Observation ==> Settled;
    Complete: TicketId * Observation ==> ();
    Recheck: TicketId * Observation ==> ();
    Except: [TicketId] * Revision ==> Handoff;
    Resolve: TicketId * Revision * nat1 * Contract * set of TicketId * map IntentId to Disposal * Observation ==> ();
    ReviewClosure: Observation ==> ();
    JudgeClosure: Revision * Fingerprint * bool * Observation ==> Handoff;
    CloseParent: Observation ==> IntentId;
    ResolveClosure: Revision * map IntentId to Disposal * Observation ==> ();
    Resume: RunId * Takeover ==> ();
    Snapshot: () ==> map TicketId to Ticket;
    Closing: () ==> bool * [Closure];
    Pending: () ==> set of [TicketId];
    Finish: () ==> ()
definitions
types
  -- 议程内一张票据的身份；由 Main 在召集与裁定时给出，其余使用方原样传递
  TicketId = token;

  -- 票据或收口的工作期编号，从 1 开始；每次作废在途工作时加一
  Revision = nat1;

  -- 一次源头读取的身份；内容相同的两次读取仍是两次
  ReadId = token;

  -- 工作流里一步的种类：席位做工作、席位对一个指纹下结论、对源头写一次
  StepKind = <Produce> | <Judge> | <Write>;

  -- 一类票据的工作流定义，来自工作流配置；账本只看到它的形状，每一步具体做什么由配置决定
  Workflow ::
    steps : seq1 of StepKind  -- 步骤序列
    rework : map nat1 to nat1  -- 每个评判步骤被否决后回到的产出步骤
  inv mk_Workflow(s, rw) ==
    dom rw = {j | j in set inds s & s(j) = <Judge>}
    and (forall j in set dom rw & rw(j) < j and s(rw(j)) = <Produce>);

  -- 被采纳的需求版本；只有 Main 的裁定能换掉它
  Contract = token;

  -- 被评判对象的版本标识；指纹相同即同一个被评判对象
  Fingerprint = token;

  -- 一次完整的源头读取按工作流配置得出的判定，只代表读取那一刻；读取中途对象身份或版本变化的读取不会成为观察
  Observation ::
    read : ReadId  -- 这次读取
    current : map TicketId to Fingerprint  -- 各票据被评判对象此刻的指纹（覆盖被评判对象、目标、需求与裁定）
    effected : map TicketId to set of nat1  -- 各票据哪些写入步骤的预期结果已在源头出现
    finished : set of TicketId  -- 源头已满足完成条件的票据
    drifted : set of TicketId  -- 源头需求与采纳的契约不一致的票据
    children : set of IssueRef  -- 父议题此刻的子议题
    stamp : [Fingerprint]  -- 收口核实成立时的收口指纹（每个子议题都有票据、已关闭且与契约一致、每个合入仍在目标分支中；覆盖父议题、各子项与终局、目标与收口裁定），否则为空
    parentClosed : bool;  -- 父议题已关闭

  -- 一条写入意图的身份；每次决定对源头写一次就有一条新意图
  IntentId = token;

  -- 一次协调器运行的身份；一次运行对应一个进程
  RunId = token;

  -- 票据或收口的状况：推进中、例外待 Main 裁定、已完成
  Stage = <Running> | <Excepted> | <Done>;

  -- 写入意图的状况：排队待执行、执行中、已知失败、结果不明、源头已确认、已取消
  IntentState = <Ready> | <Executing> | <Failed> | <Uncertain> | <Confirmed> | <Cancelled>;

  -- 一条写入意图：属于哪张票据的哪一个写入步骤；票据为空表示收口关闭父议题的写入
  Intent ::
    ticket : [TicketId]  -- 所属票据；为空即属于收口
    step : nat1  -- 它执行的写入步骤；收口的写入只有一步
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

  -- 收口评判的结论：待评判、已通过、已否决
  Verdict = <Pending> | <Passed> | <Failed>;

  -- 父议题收口：全部票据完成后自动开始，一个评判在收口指纹上通过后关闭父议题
  Closure ::
    revision : Revision  -- 收口的工作期
    stamp : Fingerprint  -- 本工作期评判的收口指纹
    verdict : Verdict  -- 收口评判的结论
    stage : Stage;  -- 推进中、例外或已完成

  -- 一次交接或请求的结局：被接受，或因工作期已被取代、前提不再成立而拒收
  Handoff = <Accepted> | <Stale>;

  -- 外部写入调用的返回；返回本身不证明源头结果
  CallResult = <Returned> | <KnownFailure> | <Unknown>;

  -- 写入核对后的结局：源头已确认、已知失败、结果不明
  Settled = <Confirmed> | <Failed> | <Uncertain>;

  -- Main 对一条失败或不明写入的处置：重试、按源头确认采纳、取消
  Disposal = <Retry> | <Adopt> | <Cancel>;

  -- 接管议程的前提：操作员确认原协调器进程已结束
  Takeover = <OriginalEnded>;

  -- 议程账本：依赖不出议程且无环；收口只在有父议题时存在；每张票据与收口各至多一条执行中的写入；带着失败或不明写入的票据或收口只能处于例外
state Ledger of
  tickets : map TicketId to Ticket  -- 议程中的票据
  parent : [IssueRef]  -- 父议题；为空表示议程没有收口
  closure : [Closure]  -- 父议题收口；全部票据完成之前为空
  intents : map IntentId to Intent  -- 全部写入意图
  spent : set of ReadId  -- 已经支撑过转换的读取
  writer : [RunId]  -- 当前写入议程的协调器运行
  inv mk_Ledger(ts, p, c, ins, -, -) ==
    (forall id in set dom ts & ts(id).deps subset (dom ts \ {id}))
    and Acyclic(ts)
    and (c <> nil => p <> nil)
    and (forall e in set dom ins &
           (ins(e).ticket = nil and c <> nil) or ins(e).ticket in set dom ts)
    and (forall h in set {ins(e).ticket | e in set dom ins} &
           card {e | e in set dom ins & ins(e).ticket = h and ins(e).status = <Executing>} <= 1)
    and (forall e in set dom ins & ins(e).status in set {<Failed>, <Uncertain>} =>
           (ins(e).ticket = nil and c <> nil and c.stage = <Excepted>)
           or (ins(e).ticket in set dom ts and ts(ins(e).ticket).stage = <Excepted>))
  init l == l = mk_Ledger({|->}, nil, nil, {|->}, {}, nil)
end

functions
  -- 观察中这张票据被评判对象的指纹；没读到为空
  CurrentOf: Observation * TicketId -> [Fingerprint]
  CurrentOf(o, id) == if id in set dom o.current then o.current(id) else nil;

  -- 收口指纹：只在议程有票据且全部完成时，取观察给出的收口指纹；两个实现必须得出同一结论
  ClosureStamp: map TicketId to Ticket * Observation -> [Fingerprint]
  ClosureStamp(ts, o) ==
    if ts <> {|->} and forall t in set rng ts & t.stage = <Done> then o.stamp else nil;

  -- 观察显示一条写入的预期结果已在源头出现：票据的写入看这一步，收口的写入看父议题是否已关闭
  Shows: Intent * Observation -> bool
  Shows(i, o) ==
    if i.ticket = nil then o.parentClosed
    else i.ticket in set dom o.effected and i.step in set o.effected(i.ticket);

  -- 一个写入步骤所依赖的评判：它之前、且与它之间没有产出步骤的评判步骤；两个实现必须得出同一结论
  Gating: Workflow * nat1 -> set of nat1
  Gating(w, s) ==
    {j | j in set inds w.steps & j < s and w.steps(j) = <Judge>
         and not (exists k in set inds w.steps & j < k and k < s and w.steps(k) = <Produce>)};

  -- Main 重试一条未经源头确认的写入后从哪一步续接：它依赖的评判最早的一步，重新取得评判；没有依赖的评判就是这个写入步骤
  RetryAt: Workflow * nat1 -> nat1
  RetryAt(w, s) == if Gating(w, s) = {} then s else Earliest(Gating(w, s));

  -- Main 处置后一条写入的状况：取消即取消；源头已确认则确认；否则重新排队；两个实现必须得出同一结论
  Disposed: Disposal * bool -> IntentState
  Disposed(d, shown) ==
    if d = <Cancel> then <Cancelled>
    elseif shown then <Confirmed>
    else <Ready>;

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
      and t.pos <= len t.flow.steps and t.flow.steps(t.pos) = k;

  -- 把票据交给 Main：转入例外并开启新的工作期
  Excepted: Ticket -> Ticket
  Excepted(t) == mu(t, stage |-> <Excepted>, revision |-> t.revision + 1);

  -- 把收口交给 Main：转入例外并开启新的工作期
  ClosureExcepted: Closure -> Closure
  ClosureExcepted(c) == mu(c, stage |-> <Excepted>, revision |-> c.revision + 1);

  -- 一组步骤里最早的一个
  Earliest: set of nat1 -> nat1
  Earliest(s) == let m in set s be st forall x in set s & m <= x in m
  pre s <> {};

operations
  -- 召集议程：写入初始票据，全部推进中、未放行、停在第一步；每个议题至多一张票据；有父议题时它此刻的每个子议题都有票据
  Convene(par: [IssueRef], initial: map TicketId to Ticket, run: RunId, obs: Observation)
  ext wr tickets wr parent wr closure wr spent wr writer
  pre tickets = {|->} and obs.read not in set spent
      and (forall id in set dom initial &
             initial(id).deps subset (dom initial \ {id})
             and not initial(id).released and initial(id).stage = <Running>
             and initial(id).pos = 1 and initial(id).approvals = {|->})
      and Acyclic(initial)
      and (forall a, b in set dom initial & a <> b => initial(a).issue <> initial(b).issue)
      and (par <> nil => forall c in set obs.children & exists t in set rng initial & t.issue = c)
  post tickets = initial and parent = par and closure = nil
       and spent = spent~ union {obs.read} and writer = run;

  -- Main 放行一张票据；每张票据只放行一次，且只在依赖都已完成时
  Release(id: TicketId)
  ext wr tickets
  pre id in set dom tickets and not tickets(id).released
      and tickets(id).stage = <Running> and DepsDone(tickets, id)
  post tickets = tickets~ ++ {id |-> mu(tickets~(id), released |-> true)};

  -- 产出席位交接当前产出步骤的结果；只接受当前工作期、需求未漂移时的交接，被接受后进入下一步，此前的评判全部作废
  Produce(id: TicketId, rev: Revision, obs: Observation) r: Handoff
  ext wr tickets wr spent
  pre id in set dom tickets and obs.read not in set spent
  post spent = spent~ union {obs.read}
       and ((Accepts(tickets~, id, rev, <Produce>) and id not in set obs.drifted and r = <Accepted>
               and tickets = tickets~ ++ {id |-> mu(tickets~(id), pos |-> tickets~(id).pos + 1, approvals |-> {|->})})
            or ((not Accepts(tickets~, id, rev, <Produce>) or id in set obs.drifted)
               and r = <Stale> and tickets = tickets~));

  -- 评判席位在指纹 fp 上交接结论；只接受当前工作期、需求未漂移、且 fp 正是观察中当前指纹的结论；通过则记下指纹进入下一步，否决则开启新工作期回到工作流给出的产出步骤重做
  Judge(id: TicketId, rev: Revision, fp: Fingerprint, pass: bool, obs: Observation) r: Handoff
  ext wr tickets wr spent
  pre id in set dom tickets and obs.read not in set spent
  post spent = spent~ union {obs.read}
       and let t = tickets~(id) in
         ((Accepts(tickets~, id, rev, <Judge>) and id not in set obs.drifted and fp = CurrentOf(obs, id) and r = <Accepted>
            and tickets = tickets~ ++ {id |->
              if pass then mu(t, pos |-> t.pos + 1, approvals |-> t.approvals ++ {t.pos |-> fp})
              else mu(t, pos |-> t.flow.rework(t.pos), revision |-> t.revision + 1, approvals |-> {|->})})
          or ((not Accepts(tickets~, id, rev, <Judge>) or id in set obs.drifted or fp <> CurrentOf(obs, id))
            and r = <Stale> and tickets = tickets~));

  -- 为当前写入步骤开始执行一条意图，在调用源头之前：有排队的意图就执行它，否则登记一条新意图；只在需求未漂移、这一步依赖的评判都已在本工作期通过、且全部评判都通过于观察中的当前指纹时
  Begin(id: TicketId, obs: Observation) e: IntentId
  ext wr intents wr spent rd tickets
  pre id in set dom tickets and obs.read not in set spent
      and Accepts(tickets, id, tickets(id).revision, <Write>)
      and id not in set obs.drifted
      and Gating(tickets(id).flow, tickets(id).pos) subset dom tickets(id).approvals
      and (forall s in set rng tickets(id).approvals & s = CurrentOf(obs, id))
      and not (exists i in set rng intents & i.ticket = id and i.status = <Executing>)
  post spent = spent~ union {obs.read}
       and let queued = {x | x in set dom intents~ &
                          intents~(x).ticket = id and intents~(x).step = tickets(id).pos
                          and intents~(x).status = <Ready>} in
         ((queued <> {} and e in set queued
            and intents = intents~ ++ {e |-> mu(intents~(e), status |-> <Executing>)})
          or (queued = {} and e not in set dom intents~
            and intents = intents~ ++ {e |-> mk_Intent(id, tickets(id).pos, <Executing>)}));

  -- 调用之后核对写入：只有观察显示预期结果已在源头出现才确认，票据进入下一步、收口完成；否则已知失败记为失败、其余记为不明，所属的票据或收口交给 Main
  Settle(e: IntentId, call: CallResult, obs: Observation) r: Settled
  ext wr intents wr tickets wr closure wr spent
  pre e in set dom intents and intents(e).status = <Executing> and obs.read not in set spent
  post spent = spent~ union {obs.read}
       and let i = intents~(e), h = i.ticket in
         ((Shows(i, obs) and r = <Confirmed>
            and intents = intents~ ++ {e |-> mu(i, status |-> <Confirmed>)}
            and (h = nil => closure = mu(closure~, stage |-> <Done>) and tickets = tickets~)
            and (h <> nil => closure = closure~
                 and tickets = tickets~ ++ {h |->
                   if tickets~(h).stage = <Running> and tickets~(h).pos = i.step
                   then mu(tickets~(h), pos |-> tickets~(h).pos + 1) else tickets~(h)}))
          or (not Shows(i, obs)
            and ((call = <KnownFailure> and r = <Failed>) or (call <> <KnownFailure> and r = <Uncertain>))
            and intents = intents~ ++ {e |-> mu(i, status |-> r)}
            and (h = nil => tickets = tickets~
                 and closure = (if closure~.stage = <Excepted> then closure~ else ClosureExcepted(closure~)))
            and (h <> nil => closure = closure~
                 and tickets = tickets~ ++ {h |->
                   if tickets~(h).stage = <Excepted> then tickets~(h) else Excepted(tickets~(h))})));

  -- 走完全部步骤的票据，只在依赖都已完成、观察显示完成条件满足时完成
  Complete(id: TicketId, obs: Observation)
  ext wr tickets wr spent
  pre id in set dom tickets and obs.read not in set spent
      and tickets(id).stage = <Running> and tickets(id).pos > len tickets(id).flow.steps
  post spent = spent~ union {obs.read}
       and tickets = tickets~ ++ {id |->
         if id in set obs.finished and DepsDone(tickets~, id)
         then mu(tickets~(id), stage |-> <Done>) else tickets~(id)};

  -- 用新观察复核票据：需求与契约不一致、或已完成的票据不再满足完成条件时交给 Main；评判过的指纹不再是当前指纹时，开启新工作期，作废最早失效的评判及其后的评判并回到那一步
  Recheck(id: TicketId, obs: Observation)
  ext wr tickets wr spent
  pre id in set dom tickets and obs.read not in set spent
  post spent = spent~ union {obs.read}
       and let t = tickets~(id),
               stale = {j | j in set dom t.approvals & t.approvals(j) <> CurrentOf(obs, id)} in
         if t.stage <> <Excepted> and (id in set obs.drifted or (t.stage = <Done> and id not in set obs.finished))
         then tickets = tickets~ ++ {id |-> Excepted(t)}
         elseif t.stage = <Running> and stale <> {}
         then tickets = tickets~ ++ {id |-> mu(t,
                pos |-> Earliest(stale),
                revision |-> t.revision + 1,
                approvals |-> {j |-> t.approvals(j) | j in set dom t.approvals & j < Earliest(stale)})}
         else tickets = tickets~;

  -- 把推进中的票据或收口（h 为空）交给 Main（席位未交接就结束或起不来时）；只接受当前工作期的请求
  Except(h: [TicketId], rev: Revision) r: Handoff
  ext wr tickets wr closure
  pre h = nil or h in set dom tickets
  post (h <> nil and tickets~(h).stage = <Running> and tickets~(h).revision = rev and r = <Accepted>
          and tickets = tickets~ ++ {h |-> Excepted(tickets~(h))} and closure = closure~)
       or (h = nil and closure~ <> nil and closure~.stage = <Running> and closure~.revision = rev
          and r = <Accepted> and closure = ClosureExcepted(closure~) and tickets = tickets~)
       or (not ((h <> nil and tickets~(h).stage = <Running> and tickets~(h).revision = rev)
                or (h = nil and closure~ <> nil and closure~.stage = <Running> and closure~.revision = rev))
          and r = <Stale> and tickets = tickets~ and closure = closure~);

  -- Main 裁定一张例外票据：对它每条失败或不明的写入重试、采纳或取消，采纳要求源头已确认；采纳给定的契约与依赖，开启新工作期，从给定步骤续接——不能直接续接到依赖评判的写入步骤；重试的写入重新排队，并改从它依赖的评判（没有则从它自己）续接；此前排队而这次没有重试的写入取消
  Resolve(id: TicketId, rev: Revision, resume: nat1, contract: Contract, deps: set of TicketId,
          ds: map IntentId to Disposal, obs: Observation)
  ext wr tickets rd parent wr intents wr spent
  pre id in set dom tickets and tickets(id).stage = <Excepted> and tickets(id).revision = rev
      and obs.read not in set spent
      and resume <= len tickets(id).flow.steps + 1
      and (resume <= len tickets(id).flow.steps and tickets(id).flow.steps(resume) = <Write>
           => Gating(tickets(id).flow, resume) = {})
      and deps subset (dom tickets \ {id})
      and Acyclic(tickets ++ {id |-> mu(tickets(id), deps |-> deps)})
      and (parent <> nil => forall c in set obs.children & exists t in set rng tickets & t.issue = c)
      and dom ds = {x | x in set dom intents & intents(x).ticket = id
                        and intents(x).status in set {<Failed>, <Uncertain>}}
      and not (exists i in set rng intents & i.ticket = id and i.status = <Executing>)
      and (forall x in set dom ds & ds(x) = <Adopt> => Shows(intents(x), obs))
  post spent = spent~ union {obs.read}
       and let t = tickets~(id),
               shown = {x | x in set dom ds & Shows(intents~(x), obs)},
               retried = {x | x in set dom ds & ds(x) = <Retry> and x not in set shown},
               stale = {x | x in set dom intents~ & intents~(x).ticket = id and intents~(x).status = <Ready>} in
         intents = intents~ ++ {x |-> mu(intents~(x), status |-> <Cancelled>) | x in set stale}
                            ++ {x |-> mu(intents~(x), status |-> Disposed(ds(x), x in set shown)) | x in set dom ds}
         and tickets = tickets~ ++ {id |-> mu(t,
               stage |-> <Running>, contract |-> contract, deps |-> deps,
               revision |-> rev + 1, approvals |-> {|->},
               pos |-> if retried <> {} then Earliest({RetryAt(t.flow, intents~(x).step) | x in set retried})
                       else resume)};

  -- 用新观察推进收口：全部票据完成且源头核实成立时开始收口；收口指纹变化且收口没有未结写入时开启新工作期重新评判；评判通过且父议题已关闭时完成；核实不再成立时交给 Main
  ReviewClosure(obs: Observation)
  ext rd tickets rd parent wr closure rd intents wr spent
  pre parent <> nil and obs.read not in set spent
  post spent = spent~ union {obs.read}
       and let s = ClosureStamp(tickets, obs),
               unsettled = exists i in set rng intents & i.ticket = nil and i.status in set {<Failed>, <Uncertain>} in
         if s <> nil then
           (if closure~ = nil then closure = mk_Closure(1, s, <Pending>, <Running>)
            elseif closure~.stamp <> s and not unsettled
            then closure = mk_Closure(closure~.revision + 1, s, <Pending>, <Running>)
            elseif closure~.stage = <Running> and closure~.verdict = <Passed> and obs.parentClosed
            then closure = mu(closure~, stage |-> <Done>)
            else closure = closure~)
         elseif closure~ <> nil and closure~.stage <> <Excepted>
         then closure = mu(ClosureExcepted(closure~), verdict |-> <Failed>)
         else closure = closure~;

  -- 收口评判席位在收口指纹上交接结论；只接受当前工作期、待评判、且 fp 正是观察中收口指纹的结论；否决交给 Main
  JudgeClosure(rev: Revision, fp: Fingerprint, pass: bool, obs: Observation) r: Handoff
  ext rd tickets rd parent wr closure wr spent
  pre parent <> nil and obs.read not in set spent
  post spent = spent~ union {obs.read}
       and ((closure~ <> nil and closure~.stage = <Running> and closure~.verdict = <Pending>
               and closure~.revision = rev and fp = closure~.stamp and fp = ClosureStamp(tickets, obs)
               and r = <Accepted>
               and closure = (if pass then mu(closure~, verdict |-> <Passed>)
                              else mu(ClosureExcepted(closure~), verdict |-> <Failed>)))
            or (not (closure~ <> nil and closure~.stage = <Running> and closure~.verdict = <Pending>
                     and closure~.revision = rev and fp = closure~.stamp and fp = ClosureStamp(tickets, obs))
               and r = <Stale> and closure = closure~));

  -- 为关闭父议题开始执行一条意图，在调用源头之前：有排队的意图就执行它，否则登记一条新意图；只在收口评判通过于观察中的收口指纹、父议题尚未关闭时
  CloseParent(obs: Observation) e: IntentId
  ext rd tickets rd parent rd closure wr intents wr spent
  pre parent <> nil and closure <> nil and obs.read not in set spent
      and closure.stage = <Running> and closure.verdict = <Passed>
      and closure.stamp = ClosureStamp(tickets, obs) and not obs.parentClosed
      and not (exists i in set rng intents & i.ticket = nil and i.status in set {<Executing>, <Failed>, <Uncertain>})
  post spent = spent~ union {obs.read}
       and let queued = {x | x in set dom intents~ & intents~(x).ticket = nil and intents~(x).status = <Ready>} in
         ((queued <> {} and e in set queued
            and intents = intents~ ++ {e |-> mu(intents~(e), status |-> <Executing>)})
          or (queued = {} and e not in set dom intents~
            and intents = intents~ ++ {e |-> mk_Intent(nil, 1, <Executing>)}));

  -- Main 裁定例外的收口：只能回到评判，且源头核实必须成立；对收口每条失败或不明的写入重试、采纳或取消，采纳要求父议题已关闭，重试重新排队；不能改动票据
  ResolveClosure(rev: Revision, ds: map IntentId to Disposal, obs: Observation)
  ext rd tickets rd parent wr closure wr intents wr spent
  pre parent <> nil and closure <> nil and obs.read not in set spent
      and closure.stage = <Excepted> and closure.revision = rev
      and ClosureStamp(tickets, obs) <> nil
      and dom ds = {x | x in set dom intents & intents(x).ticket = nil
                        and intents(x).status in set {<Failed>, <Uncertain>}}
      and not (exists i in set rng intents & i.ticket = nil and i.status = <Executing>)
      and (forall x in set dom ds & ds(x) = <Adopt> => obs.parentClosed)
  post spent = spent~ union {obs.read}
       and intents = intents~ ++ {x |-> mu(intents~(x),
                       status |-> Disposed(ds(x), obs.parentClosed)) | x in set dom ds}
       and closure = mk_Closure(rev + 1, ClosureStamp(tickets, obs), <Pending>, <Running>);

  -- 新的协调器运行接管议程：须操作员确认原进程已结束；中断时执行中的写入记为不明，不重放，所属的票据或收口交给 Main
  Resume(run: RunId, confirmed: Takeover)
  ext wr writer wr intents wr tickets wr closure
  pre confirmed = <OriginalEnded> and writer <> nil and run <> writer
  post writer = run
       and let cut = {e | e in set dom intents~ & intents~(e).status = <Executing>},
               hit = {intents~(e).ticket | e in set cut} in
         intents = intents~ ++ {e |-> mu(intents~(e), status |-> <Uncertain>) | e in set cut}
         and tickets = tickets~ ++ {h |-> Excepted(tickets~(h)) | h in set hit & h <> nil and h in set dom tickets~}
         and closure = (if nil in set hit and closure~ <> nil then ClosureExcepted(closure~) else closure~);

  -- 读取票据表；只读
  Snapshot() r: map TicketId to Ticket
  ext rd tickets
  post r = tickets;

  -- 读取议程是否有父议题以及收口；只读
  Closing() r: bool * [Closure]
  ext rd parent rd closure
  post r = mk_(parent <> nil, closure);

  -- 读取还有未结写入的票据（空表示收口）；只读
  Pending() r: set of [TicketId]
  ext rd intents
  post r = {i.ticket | i in set rng intents & i.status not in set {<Confirmed>, <Cancelled>}};

  -- 结束议程：全部票据已完成、有父议题时收口已完成、没有未结的写入；之后可以召集新的议程
  Finish()
  ext wr tickets wr parent wr closure wr intents
  pre tickets <> {|->} and (forall t in set rng tickets & t.stage = <Done>)
      and (parent <> nil => closure <> nil and closure.stage = <Done>)
      and (forall i in set rng intents & i.status in set {<Confirmed>, <Cancelled>})
  post tickets = {|->} and parent = nil and closure = nil and intents = {|->};
end Agenda
```
