# 议程账本连接

```vdm
module Agenda
imports from Roundtable types IssueRef renamed IssueRef
exports
  types
    Workflow; Observation; Contract; Fingerprint; IntentId; RunId; Role; Reason; SeatId;
    struct TicketId; struct Revision; struct StepKind; struct Stage; struct Ticket; struct Verdict;
    struct Closure; struct Handoff; struct CallResult; struct Settled; struct Disposal;
    struct IntentState; struct Intent
  functions
    StepAt: Workflow * nat1 -> [StepKind];
    Judges: Workflow * nat1 -> set of Role;
    DepsDone: map TicketId to Ticket * TicketId -> bool;
    Launchable: map TicketId to Ticket * TicketId -> bool
  operations
    Convene: [IssueRef] * map TicketId to Ticket * RunId * Observation ==> ();
    Release: TicketId ==> ();
    Produce: TicketId * Revision * nat1 * SeatId * Observation ==> Handoff;
    Judge: TicketId * Revision * nat1 * Role * Fingerprint * bool * [Reason] * Observation ==> Handoff;
    Begin: TicketId * Observation ==> [IntentId];
    Settle: IntentId * CallResult * Observation ==> Settled;
    Complete: TicketId * Observation ==> ();
    Recheck: TicketId * Observation ==> ();
    Except: [TicketId] * Revision * [Reason] ==> Handoff;
    Resolve: TicketId * Revision * nat1 * Contract * set of TicketId * map IntentId to Disposal * Observation ==> ();
    ReviewClosure: Observation ==> ();
    JudgeClosure: Revision * Fingerprint * bool * [Reason] * Observation ==> Handoff;
    CloseParent: Observation ==> [IntentId];
    ResolveClosure: Revision * map IntentId to Disposal * Observation ==> ();
    Resume: RunId ==> ();
    Snapshot: () ==> map TicketId to Ticket;
    Closing: () ==> bool * [Closure];
    Pending: () ==> map IntentId to Intent;
    Finish: () ==> ()
definitions
types
  -- 议程内一张票据的身份；由 Main 在召集与裁定时给出，其余使用方原样传递
  TicketId = token;

  -- 票据或收口的工作期编号，从 1 开始；每次作废在途工作时加一
  Revision = nat1;

  -- 一类票据的工作流定义；来自工作流配置，实现待定，设计里是占位符，账本只经 StepAt、Judges、ReworkTo 与 Gates 向它提问
  Workflow = token;

  -- 工作流里一步的种类：席位做工作、席位对它所看的对象下结论、对源头写一次
  StepKind = <Produce> | <Judge> | <Write>;

  -- 一个评判步骤里一个相互独立的评判；同一步的几个评判可以并行
  Role = token;

  -- 一次完整的源头读取，只代表读取那一刻；读取中途对象身份或版本变化的读取不会成为观察
  Observation = token;

  -- 被采纳的需求版本；只有 Main 的裁定能换掉它
  Contract = token;

  -- 一步所看对象的版本标识；指纹相同即同一个对象
  Fingerprint = token;

  -- 一次退回或例外的原因：评判的发现、源头的否决理由，或席位提出的问题、阻塞、拆分建议与无需代码的结论
  Reason = token;

  -- 一次席位会话的身份；产出席位的交接被接受后，它就是这张票据的交接点，返工的产出席位接续它
  SeatId = token;

  -- 一条写入意图的身份；每次决定对源头写一次就有一条新意图
  IntentId = token;

  -- 一次协调器运行的身份；一次运行对应一个进程
  RunId = token;

  -- 源头否决当前步骤后的去向：退回产出步骤重做，或交给 Main
  Route = <Rework> | <Except>;

  -- 源头否决当前步骤：去向与源头给出的理由
  Refusal ::
    route : Route  -- 退回重做还是交给 Main
    reason : Reason;  -- 源头给出的理由

  -- 票据或收口的状况：推进中、例外待 Main 裁定、已完成
  Stage = <Running> | <Excepted> | <Done>;

  -- 写入意图的状况：排队待执行、执行中、已知失败、结果不明、源头已确认、已取消
  IntentState = <Ready> | <Executing> | <Failed> | <Uncertain> | <Confirmed> | <Cancelled>;

  -- 一条写入意图：属于哪张票据的哪一个写入步骤，依据哪一次读取发起；票据为空表示收口关闭父议题的写入
  Intent ::
    ticket : [TicketId]  -- 所属票据；为空即属于收口
    step : nat1  -- 它执行的写入步骤；收口的写入只有一步
    since : Observation  -- 决定执行这次写入时依据的读取；确认它要用之后的读取
    status : IntentState;  -- 当前状况

  -- 一张票据；推进只沿它的工作流定义走
  Ticket ::
    issue : IssueRef  -- 交付的议题
    flow : Workflow  -- 它这一类的工作流定义
    deps : set of TicketId  -- 必须先完成的票据
    contract : Contract  -- 被采纳的需求版本
    revision : Revision  -- 当前工作期；只接受这个工作期的交接
    released : bool  -- Main 是否已放行；只放行一次
    pos : nat1  -- 当前所在的步骤
    passes : map nat1 to map Role to Fingerprint  -- 本工作期内尚未用完的评判：评判步骤到各评判通过时的指纹
    point : [SeatId]  -- 交接点：最近一次被接受交接的产出席位；随议程保存到议程结束
    reason : [Reason]  -- 最近一次退回或例外的原因；席位未交接、写入失败或不明、源头回退时为空
    stage : Stage;  -- 推进中、例外或已完成

  -- 收口评判的结论：待评判、已通过、已否决
  Verdict = <Pending> | <Passed> | <Failed>;

  -- 父议题收口：全部票据完成后自动开始，一个评判在收口指纹上通过后关闭父议题
  Closure ::
    revision : Revision  -- 收口的工作期
    stamp : Fingerprint  -- 本工作期评判的收口指纹
    verdict : Verdict  -- 收口评判的结论
    reason : [Reason]  -- 最近一次交给 Main 的原因
    stage : Stage;  -- 推进中、例外或已完成

  -- 一次交接或请求的结局：被接受，或因工作期已被取代、前提不再成立而拒收
  Handoff = <Accepted> | <Stale>;

  -- 外部写入调用的返回；返回本身不证明源头结果
  CallResult = <Returned> | <KnownFailure> | <Unknown>;

  -- 写入核对后的结局：源头已确认、已知失败、结果不明；后两支所属的票据或收口交给 Main，由 Resolve 或 ResolveClosure 处置
  Settled = <Confirmed> | <Failed> | <Uncertain>;

  -- Main 对一条失败或不明写入的处置：重试、按源头确认采纳、取消
  Disposal = <Retry> | <Adopt> | <Cancel>;

  -- 议程账本：依赖不出议程且无环；收口只在有父议题时存在；每张票据与收口各至多一条执行中的写入；带着失败或不明写入的票据或收口只能处于例外
state Ledger of
  tickets : map TicketId to Ticket  -- 议程中的票据
  parent : [IssueRef]  -- 父议题；为空表示议程没有收口
  closure : [Closure]  -- 父议题收口；全部票据完成之前为空
  intents : map IntentId to Intent  -- 全部写入意图
  writer : [RunId]  -- 最近一次召集或接管议程的协调器运行
  inv mk_Ledger(ts, p, c, ins, -) ==
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
  init l == l = mk_Ledger({|->}, nil, nil, {|->}, nil)
end

functions
  -- 工作流第 s 步的种类；走完全部步骤时为空；由工作流配置给出
  StepAt: Workflow * nat1 -> [StepKind]
  StepAt(w, s) == is not yet specified;

  -- 评判步骤里的几个评判；由工作流配置给出
  Judges: Workflow * nat1 -> set of Role
  Judges(w, s) == is not yet specified;

  -- 第 s 步被否决后回到的产出步骤；由工作流配置给出
  ReworkTo: Workflow * nat1 -> nat1
  ReworkTo(w, s) == is not yet specified;

  -- 写入步骤 s 依赖的评判步骤；由工作流配置给出
  Gates: Workflow * nat1 -> set of nat1
  Gates(w, s) == is not yet specified;

  -- 观察中这张票据第 s 步所看对象此刻的指纹；每一步看哪个对象由工作流配置决定；没读到为空
  Seen: Observation * Ticket * nat1 -> [Fingerprint]
  Seen(o, t, s) == is not yet specified;

  -- 观察显示这张票据第 s 步写入的预期结果已在源头出现
  Effected: Observation * Ticket * nat1 -> bool
  Effected(o, t, s) == is not yet specified;

  -- 观察显示这张票据的完成条件已满足；条件由工作流配置给出
  Finished: Observation * Ticket -> bool
  Finished(o, t) == is not yet specified;

  -- 观察中议题的需求与票据采纳的契约不一致
  Drifted: Observation * Ticket -> bool
  Drifted(o, t) == is not yet specified;

  -- 源头否决这张票据的当前步骤（例如检查失败、分支冲突）；去向由工作流配置决定；没有否决为空
  Refused: Observation * Ticket -> [Refusal]
  Refused(o, t) == is not yet specified;

  -- 观察中父议题此刻的子议题
  Children: Observation * IssueRef -> set of IssueRef
  Children(o, p) == is not yet specified;

  -- 观察中收口核实成立时的收口指纹（父议题当前每个子议题都有票据、已关闭且与契约一致、每个合入仍在目标分支中），否则为空
  Verified: Observation * IssueRef * map TicketId to Ticket -> [Fingerprint]
  Verified(o, p, ts) == is not yet specified;

  -- 观察显示父议题已关闭
  Closed: Observation * IssueRef -> bool
  Closed(o, p) == is not yet specified;

  -- 前一次读取在后一次开始之后才开始
  Later: Observation * Observation -> bool
  Later(a, b) == is not yet specified;

  -- 收口指纹：只在议程有票据且全部完成时取观察核实的收口指纹；两个实现必须得出同一结论
  ClosureStamp: map TicketId to Ticket * IssueRef * Observation -> [Fingerprint]
  ClosureStamp(ts, p, o) ==
    if ts <> {|->} and forall t in set rng ts & t.stage = <Done> then Verified(o, p, ts) else nil;

  -- 观察显示一条写入的预期结果已在源头出现：票据的写入看那一步，收口的写入看父议题是否已关闭；两个实现必须得出同一结论
  Shows: map TicketId to Ticket * [IssueRef] * Intent * Observation -> bool
  Shows(ts, p, i, o) ==
    if i.ticket = nil then p <> nil and Closed(o, p)
    else i.ticket in set dom ts and Effected(o, ts(i.ticket), i.step);

  -- Main 重试一条未经源头确认的写入后从哪一步续接：它依赖的评判最早的一步，没有依赖的评判就是这个写入步骤
  RetryAt: Workflow * nat1 -> nat1
  RetryAt(w, s) == if Gates(w, s) = {} then s else Earliest(Gates(w, s));

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

  -- 票据可放行：推进中、从未放行、依赖全部完成；放行准入与需要 Main 的放行决策共用这个判定
  Launchable: map TicketId to Ticket * TicketId -> bool
  Launchable(ts, id) ==
    DepsDone(ts, id) and not ts(id).released and ts(id).stage = <Running>;

  -- 票据此刻接受第 s 步在工作期 rev 的一种交接：已放行、推进中、依赖都已完成、工作期一致、正处于这一步且这一步是这一种
  Accepts: map TicketId to Ticket * TicketId * Revision * nat1 * StepKind -> bool
  Accepts(ts, id, rev, s, k) ==
    DepsDone(ts, id)
    and let t = ts(id) in
      t.released and t.stage = <Running> and t.revision = rev and t.pos = s
      and StepAt(t.flow, s) = k;

  -- 写入步骤此刻可以执行：这一步依赖的评判都已在本工作期通过，且尚未用完的评判都通过于观察中各自所看对象的当前指纹
  Cleared: Ticket * Observation -> bool
  Cleared(t, o) ==
    Gates(t.flow, t.pos) subset dom t.passes
    and forall s in set dom t.passes &
          forall r in set dom t.passes(s) & t.passes(s)(r) = Seen(o, t, s);

  -- 第 s 步一个评判在指纹 fp 上通过后这一步的通过记录：只留下同一指纹上的通过
  Votes: Ticket * nat1 * Role * Fingerprint -> map Role to Fingerprint
  Votes(t, s, r, fp) ==
    (if s in set dom t.passes
     then {k |-> t.passes(s)(k) | k in set dom t.passes(s) & t.passes(s)(k) = fp}
     else {|->})
    ++ {r |-> fp};

  -- 把票据交给 Main：转入例外，开启新的工作期，记下原因
  Excepted: Ticket * [Reason] -> Ticket
  Excepted(t, why) == mu(t, stage |-> <Excepted>, revision |-> t.revision + 1, reason |-> why);

  -- 把收口交给 Main：转入例外，开启新的工作期，记下原因
  ClosureExcepted: Closure * [Reason] -> Closure
  ClosureExcepted(c, why) == mu(c, stage |-> <Excepted>, revision |-> c.revision + 1, reason |-> why);

  -- 一组步骤里最早的一个
  Earliest: set of nat1 -> nat1
  Earliest(s) == let m in set s be st forall x in set s & m <= x in m
  pre s <> {};

operations
  -- 召集议程：写入初始票据，全部推进中、未放行、停在 Main 指定的起始步骤；每个议题至多一张票据；有父议题时它此刻的每个子议题都有票据；一次协调器运行至多召集一次
  Convene(par: [IssueRef], initial: map TicketId to Ticket, run: RunId, obs: Observation)
  ext wr tickets wr parent wr writer rd closure rd intents
  pre tickets = {|->} and closure = nil and intents = {|->} and writer <> run
      and (forall id in set dom initial &
             initial(id).deps subset (dom initial \ {id})
             and not initial(id).released and initial(id).stage = <Running>
             and initial(id).passes = {|->} and initial(id).point = nil and initial(id).reason = nil)
      and Acyclic(initial)
      and (forall a, b in set dom initial & a <> b => initial(a).issue <> initial(b).issue)
      and (par <> nil => forall c in set Children(obs, par) & exists t in set rng initial & t.issue = c)
  post tickets = initial and parent = par and writer = run;

  -- Main 放行一张可放行的票据；每张票据只放行一次
  Release(id: TicketId)
  ext wr tickets
  pre id in set dom tickets and Launchable(tickets, id)
  post tickets = tickets~ ++ {id |-> mu(tickets~(id), released |-> true)};

  -- 产出席位交接第 step 步的结果；只接受当前工作期、需求未漂移时的交接；被接受后进入下一步，这个席位成为交接点，此前的评判全部作废
  Produce(id: TicketId, rev: Revision, step: nat1, seat: SeatId, obs: Observation) r: Handoff
  ext wr tickets
  pre id in set dom tickets
  post let t = tickets~(id) in
         ((Accepts(tickets~, id, rev, step, <Produce>) and not Drifted(obs, t) and r = <Accepted>
             and tickets = tickets~ ++ {id |-> mu(t, pos |-> t.pos + 1, passes |-> {|->}, point |-> seat)})
          or ((not Accepts(tickets~, id, rev, step, <Produce>) or Drifted(obs, t))
             and r = <Stale> and tickets = tickets~));

  -- 一个评判在第 step 步、指纹 fp 上交接结论；只接受当前工作期、需求未漂移、这一步的评判、且 fp 正是观察中这一步所看对象当前指纹的结论；通过时这一步的全部评判都在同一指纹上通过才进入下一步；否决时开启新工作期，带着发现回到工作流给出的产出步骤
  Judge(id: TicketId, rev: Revision, step: nat1, role: Role, fp: Fingerprint, pass: bool, why: [Reason], obs: Observation) r: Handoff
  ext wr tickets
  pre id in set dom tickets
  post let t = tickets~(id) in
         ((Accepts(tickets~, id, rev, step, <Judge>) and role in set Judges(t.flow, step)
             and not Drifted(obs, t) and fp = Seen(obs, t, step) and r = <Accepted>
             and tickets = tickets~ ++ {id |->
               if not pass
               then mu(t, pos |-> ReworkTo(t.flow, step), revision |-> t.revision + 1, passes |-> {|->}, reason |-> why)
               elseif dom Votes(t, step, role, fp) = Judges(t.flow, step)
               then mu(t, pos |-> t.pos + 1, passes |-> t.passes ++ {step |-> Votes(t, step, role, fp)})
               else mu(t, passes |-> t.passes ++ {step |-> Votes(t, step, role, fp)})})
          or ((not Accepts(tickets~, id, rev, step, <Judge>) or role not in set Judges(t.flow, step)
               or Drifted(obs, t) or fp <> Seen(obs, t, step))
             and r = <Stale> and tickets = tickets~));

  -- 为当前写入步骤开始执行一条意图，在调用源头之前：有排队的意图就执行它，否则登记一条新意图，记下依据的读取；只在需求未漂移、这一步依赖的评判都已通过于当前指纹、没有执行中的写入时；否则不开始
  Begin(id: TicketId, obs: Observation) r: [IntentId]
  ext rd tickets wr intents
  pre id in set dom tickets
  post let t = tickets(id),
           ok = Accepts(tickets, id, t.revision, t.pos, <Write>)
                and not (exists i in set rng intents~ & i.ticket = id and i.status = <Executing>)
                and not Drifted(obs, t) and Cleared(t, obs),
           queued = {x | x in set dom intents~ &
                       intents~(x).ticket = id and intents~(x).step = t.pos and intents~(x).status = <Ready>} in
         ((ok and queued <> {} and r in set queued
             and intents = intents~ ++ {r |-> mu(intents~(r), since |-> obs, status |-> <Executing>)})
          or (ok and queued = {} and r <> nil and r not in set dom intents~
             and intents = intents~ ++ {r |-> mk_Intent(id, t.pos, obs, <Executing>)})
          or (not ok and r = nil and intents = intents~));

  -- 调用之后用之后的读取核对写入：只有观察显示预期结果已在源头出现才确认，票据进入下一步并用完它之前的评判、收口完成；否则已知失败记为失败、其余记为不明，所属的票据或收口交给 Main
  Settle(e: IntentId, call: CallResult, obs: Observation) r: Settled
  ext wr intents wr tickets wr closure rd parent
  pre e in set dom intents and intents(e).status = <Executing> and Later(obs, intents(e).since)
  post let i = intents~(e), h = i.ticket in
         ((Shows(tickets~, parent, i, obs) and r = <Confirmed>
             and intents = intents~ ++ {e |-> mu(i, status |-> <Confirmed>)}
             and (h = nil => closure = mu(closure~, stage |-> <Done>) and tickets = tickets~)
             and (h <> nil => closure = closure~
                  and tickets = tickets~ ++ {h |->
                    if tickets~(h).stage = <Running> and tickets~(h).pos = i.step
                    then mu(tickets~(h), pos |-> tickets~(h).pos + 1, passes |-> {|->}) else tickets~(h)}))
          or (not Shows(tickets~, parent, i, obs)
             and ((call = <KnownFailure> and r = <Failed>) or (call <> <KnownFailure> and r = <Uncertain>))
             and intents = intents~ ++ {e |-> mu(i, status |-> r)}
             and (h = nil => tickets = tickets~
                  and closure = (if closure~.stage = <Excepted> then closure~ else ClosureExcepted(closure~, nil)))
             and (h <> nil => closure = closure~
                  and tickets = tickets~ ++ {h |->
                    if tickets~(h).stage = <Excepted> then tickets~(h) else Excepted(tickets~(h), nil)})));

  -- 走完全部步骤、已放行、依赖都已完成的票据，只在观察显示完成条件满足时完成；否则不变
  Complete(id: TicketId, obs: Observation)
  ext wr tickets
  pre id in set dom tickets
  post let t = tickets~(id) in
         if t.released and t.stage = <Running> and DepsDone(tickets~, id)
            and StepAt(t.flow, t.pos) = nil and Finished(obs, t)
         then tickets = tickets~ ++ {id |-> mu(t, stage |-> <Done>)}
         else tickets = tickets~;

  -- 用新观察复核票据：需求与契约不一致、或已完成的票据不再满足完成条件时交给 Main；源头否决当前步骤时按去向退回产出步骤或交给 Main；尚未用完的评判所看对象的指纹变了时，停在写入步骤的票据交给 Main，其余开启新工作期回到最早失效的评判
  Recheck(id: TicketId, obs: Observation)
  ext wr tickets
  pre id in set dom tickets
  post let t = tickets~(id),
           stale = {s | s in set dom t.passes &
                      exists k in set dom t.passes(s) & t.passes(s)(k) <> Seen(obs, t, s)} in
         if t.stage <> <Excepted> and (Drifted(obs, t) or (t.stage = <Done> and not Finished(obs, t)))
         then tickets = tickets~ ++ {id |-> Excepted(t, nil)}
         elseif t.stage = <Running> and t.released and Refused(obs, t) <> nil
         then tickets = tickets~ ++ {id |->
                let f = Refused(obs, t) in
                  if f.route = <Except> then Excepted(t, f.reason)
                  else mu(t, pos |-> ReworkTo(t.flow, t.pos), revision |-> t.revision + 1,
                          passes |-> {|->}, reason |-> f.reason)}
         elseif t.stage = <Running> and stale <> {} and StepAt(t.flow, t.pos) = <Write>
         then tickets = tickets~ ++ {id |-> Excepted(t, nil)}
         elseif t.stage = <Running> and stale <> {}
         then tickets = tickets~ ++ {id |-> mu(t,
                pos |-> Earliest(stale),
                revision |-> t.revision + 1,
                passes |-> {s |-> t.passes(s) | s in set dom t.passes & s < Earliest(stale)})}
         else tickets = tickets~;

  -- 把推进中的票据或收口（h 为空）交给 Main 并记下原因（席位提出问题时带原因；席位未交接就结束或起不来时为空）；只接受当前工作期的请求
  Except(h: [TicketId], rev: Revision, why: [Reason]) r: Handoff
  ext wr tickets wr closure
  pre h = nil or h in set dom tickets
  post (h <> nil and tickets~(h).stage = <Running> and tickets~(h).revision = rev and r = <Accepted>
          and tickets = tickets~ ++ {h |-> Excepted(tickets~(h), why)} and closure = closure~)
       or (h = nil and closure~ <> nil and closure~.stage = <Running> and closure~.revision = rev
          and r = <Accepted> and closure = ClosureExcepted(closure~, why) and tickets = tickets~)
       or (not ((h <> nil and tickets~(h).stage = <Running> and tickets~(h).revision = rev)
                or (h = nil and closure~ <> nil and closure~.stage = <Running> and closure~.revision = rev))
          and r = <Stale> and tickets = tickets~ and closure = closure~);

  -- Main 裁定一张例外票据：对它每条失败或不明的写入重试、采纳或取消，采纳要求之后的读取显示源头已确认；采纳给定的契约与依赖并重新核对子议题，开启新工作期，从给定步骤续接，但不能直接续接到依赖评判的写入；重试的写入重新排队，改从它依赖的评判续接；此前排队而这次没有重试的写入取消；放行与否不变
  Resolve(id: TicketId, rev: Revision, resume: nat1, contract: Contract, deps: set of TicketId,
          ds: map IntentId to Disposal, obs: Observation)
  ext wr tickets rd parent wr intents
  pre id in set dom tickets and tickets(id).stage = <Excepted> and tickets(id).revision = rev
      and deps subset (dom tickets \ {id})
      and dom ds = {x | x in set dom intents & intents(x).ticket = id
                        and intents(x).status in set {<Failed>, <Uncertain>}}
      and not (exists i in set rng intents & i.ticket = id and i.status = <Executing>)
      and Acyclic(tickets ++ {id |-> mu(tickets(id), deps |-> deps)})
      and (forall x in set dom ds & ds(x) = <Adopt> =>
             Later(obs, intents(x).since) and Shows(tickets, parent, intents(x), obs))
      and (StepAt(tickets(id).flow, resume) = <Write> => Gates(tickets(id).flow, resume) = {})
      and (parent <> nil => forall c in set Children(obs, parent) & exists t in set rng tickets & t.issue = c)
  post let t = tickets~(id),
           shown = {x | x in set dom ds & Later(obs, intents~(x).since) and Shows(tickets~, parent, intents~(x), obs)},
           retried = {x | x in set dom ds & ds(x) = <Retry> and x not in set shown},
           stale = {x | x in set dom intents~ & intents~(x).ticket = id and intents~(x).status = <Ready>} in
         intents = intents~ ++ {x |-> mu(intents~(x), status |-> <Cancelled>) | x in set stale}
                            ++ {x |-> mu(intents~(x), status |-> Disposed(ds(x), x in set shown)) | x in set dom ds}
         and tickets = tickets~ ++ {id |-> mu(t,
               stage |-> <Running>, contract |-> contract, deps |-> deps,
               revision |-> rev + 1, passes |-> {|->},
               pos |-> if retried <> {} then Earliest({RetryAt(t.flow, intents~(x).step) | x in set retried})
                       else resume)};

  -- 用新观察推进收口：全部票据完成且源头核实成立时开始收口；收口指纹变化且收口没有未结写入时开启新工作期重新评判；评判通过且父议题已关闭时完成并取消排队的关闭写入；核实不再成立时交给 Main
  ReviewClosure(obs: Observation)
  ext rd tickets rd parent wr closure wr intents
  pre parent <> nil
  post let s = ClosureStamp(tickets, parent, obs),
           unsettled = exists i in set rng intents~ & i.ticket = nil and i.status in set {<Failed>, <Uncertain>},
           queued = {x | x in set dom intents~ & intents~(x).ticket = nil and intents~(x).status = <Ready>} in
         if s <> nil and closure~ = nil
         then closure = mk_Closure(1, s, <Pending>, nil, <Running>) and intents = intents~
         elseif s <> nil and closure~.stamp <> s and not unsettled
         then closure = mk_Closure(closure~.revision + 1, s, <Pending>, nil, <Running>) and intents = intents~
         elseif s <> nil and closure~.stage = <Running> and closure~.verdict = <Passed> and Closed(obs, parent)
         then closure = mu(closure~, stage |-> <Done>)
              and intents = intents~ ++ {x |-> mu(intents~(x), status |-> <Cancelled>) | x in set queued}
         elseif s = nil and closure~ <> nil and closure~.stage <> <Excepted>
         then closure = mu(ClosureExcepted(closure~, nil), verdict |-> <Failed>) and intents = intents~
         else closure = closure~ and intents = intents~;

  -- 收口评判席位在收口指纹上交接结论；只接受当前工作期、待评判、且 fp 正是观察中收口指纹的结论；否决时带着发现交给 Main
  JudgeClosure(rev: Revision, fp: Fingerprint, pass: bool, why: [Reason], obs: Observation) r: Handoff
  ext rd tickets rd parent wr closure
  pre parent <> nil
  post ((closure~ <> nil and closure~.stage = <Running> and closure~.verdict = <Pending>
           and closure~.revision = rev and fp = closure~.stamp and fp = ClosureStamp(tickets, parent, obs)
           and r = <Accepted>
           and closure = (if pass then mu(closure~, verdict |-> <Passed>)
                          else mu(ClosureExcepted(closure~, why), verdict |-> <Failed>)))
        or (not (closure~ <> nil and closure~.stage = <Running> and closure~.verdict = <Pending>
                 and closure~.revision = rev and fp = closure~.stamp and fp = ClosureStamp(tickets, parent, obs))
           and r = <Stale> and closure = closure~));

  -- 为关闭父议题开始执行一条意图，在调用源头之前：有排队的意图就执行它，否则登记一条新意图；只在收口评判通过于观察中的收口指纹、父议题尚未关闭、收口没有执行中或未结的写入时；否则不开始
  CloseParent(obs: Observation) r: [IntentId]
  ext rd tickets rd parent rd closure wr intents
  pre parent <> nil
  post let ok = closure <> nil and closure.stage = <Running> and closure.verdict = <Passed>
                and not (exists i in set rng intents~ & i.ticket = nil
                           and i.status in set {<Executing>, <Failed>, <Uncertain>})
                and closure.stamp = ClosureStamp(tickets, parent, obs) and not Closed(obs, parent),
           queued = {x | x in set dom intents~ & intents~(x).ticket = nil and intents~(x).status = <Ready>} in
         ((ok and queued <> {} and r in set queued
             and intents = intents~ ++ {r |-> mu(intents~(r), since |-> obs, status |-> <Executing>)})
          or (ok and queued = {} and r <> nil and r not in set dom intents~
             and intents = intents~ ++ {r |-> mk_Intent(nil, 1, obs, <Executing>)})
          or (not ok and r = nil and intents = intents~));

  -- Main 裁定例外的收口：源头核实必须成立，不能改动票据；对收口每条失败或不明的写入重试、采纳或取消，采纳要求之后的读取显示父议题已关闭；有写入经采纳或重试被确认时收口完成，否则开启新工作期回到评判；此前排队而这次没有处置的关闭写入取消
  ResolveClosure(rev: Revision, ds: map IntentId to Disposal, obs: Observation)
  ext rd tickets rd parent wr closure wr intents
  pre parent <> nil and closure <> nil
      and closure.stage = <Excepted> and closure.revision = rev
      and dom ds = {x | x in set dom intents & intents(x).ticket = nil
                        and intents(x).status in set {<Failed>, <Uncertain>}}
      and not (exists i in set rng intents & i.ticket = nil and i.status = <Executing>)
      and (forall x in set dom ds & ds(x) = <Adopt> => Later(obs, intents(x).since) and Closed(obs, parent))
      and ClosureStamp(tickets, parent, obs) <> nil
  post let shown = {x | x in set dom ds & Later(obs, intents~(x).since) and Closed(obs, parent)},
           stale = {x | x in set dom intents~ & intents~(x).ticket = nil and intents~(x).status = <Ready>} in
         intents = intents~ ++ {x |-> mu(intents~(x), status |-> <Cancelled>) | x in set stale}
                            ++ {x |-> mu(intents~(x), status |-> Disposed(ds(x), x in set shown)) | x in set dom ds}
         and closure = (if exists x in set shown & ds(x) <> <Cancel>
                        then mu(closure~, stage |-> <Done>)
                        else mk_Closure(rev + 1, ClosureStamp(tickets, parent, obs), <Pending>, nil, <Running>));

  -- 新的协调器运行接管议程：中断时执行中的写入记为不明，不重放，所属的票据或收口交给 Main
  Resume(run: RunId)
  ext wr writer wr intents wr tickets wr closure
  pre tickets <> {|->} and writer <> nil and run <> writer
  post writer = run
       and let cut = {e | e in set dom intents~ & intents~(e).status = <Executing>},
               hit = {intents~(e).ticket | e in set cut} in
         intents = intents~ ++ {e |-> mu(intents~(e), status |-> <Uncertain>) | e in set cut}
         and tickets = tickets~ ++ {h |-> Excepted(tickets~(h), nil) | h in set hit & h <> nil and h in set dom tickets~}
         and closure = (if nil in set hit and closure~ <> nil then ClosureExcepted(closure~, nil) else closure~);

  -- 读取票据表，含各票据的交接点与最近一次退回或例外的原因；只读
  Snapshot() r: map TicketId to Ticket
  ext rd tickets
  post r = tickets;

  -- 读取议程是否有父议题以及收口；只读
  Closing() r: bool * [Closure]
  ext rd parent rd closure
  post r = mk_(parent <> nil, closure);

  -- 读取尚未结清的写入意图，Main 据此处置失败或不明的写入；只读
  Pending() r: map IntentId to Intent
  ext rd intents
  post r = {e |-> intents(e) | e in set dom intents & intents(e).status not in set {<Confirmed>, <Cancelled>}};

  -- 结束议程：全部票据已完成、有父议题时收口已完成、没有未结的写入；召集它的运行不能再召集
  Finish()
  ext wr tickets wr parent wr closure wr intents
  pre tickets <> {|->} and (forall t in set rng tickets & t.stage = <Done>)
      and (parent <> nil => closure <> nil and closure.stage = <Done>)
      and (forall i in set rng intents & i.status in set {<Confirmed>, <Cancelled>})
  post tickets = {|->} and parent = nil and closure = nil and intents = {|->};
end Agenda
```
