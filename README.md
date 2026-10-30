# omp-roundtable

Roundtable delivers GitHub issue graphs through durable tickets, source-confirmed effects, one-shot Owner sessions, and fresh independent gates. Main chooses which independent tickets run concurrently and which dependency edges enforce serial delivery.

## Demo

[![Watch the omp-roundtable walkthrough](https://raw.githubusercontent.com/oh-my-omp/omp-roundtable/a04c58e7c63d3ddfb7ab0bc455026b1bad07b742/docs/demo/roundtable-demo-poster.png)](https://cdn.jsdelivr.net/gh/oh-my-omp/omp-roundtable@a04c58e7c63d3ddfb7ab0bc455026b1bad07b742/docs/demo/roundtable-demo.mp4)

A 4½-minute walkthrough of one real take, every model on `openai-codex/gpt-6.1-sol`. It starts with an omp session filing a feature as an issue tree: parent [#190](https://github.com/RiriAgent/rt-e2e-20260930-0931/issues/190) with native sub-issues [#186](https://github.com/RiriAgent/rt-e2e-20260930-0931/issues/186) and [#187](https://github.com/RiriAgent/rt-e2e-20260930-0931/issues/187), which are independent, [#188](https://github.com/RiriAgent/rt-e2e-20260930-0931/issues/188) with `Depends on #186`, and [#189](https://github.com/RiriAgent/rt-e2e-20260930-0931/issues/189) with `Depends on #187` and `Depends on #188`; the parent ends with the coordinator link. A click on that link on GitHub reaches the local launcher, which opens a Tern tab running `omp --roundtable RiriAgent/rt-e2e-20260930-0931#190`. Main's terminal then plays beside a ticket graph and a seat timeline drawn from the run's agenda state file and seat session logs. Every ticket passes between separate sessions: an Owner, review and accept side by side, Roundtable's own merge, then a post-merge check; the video stops on #186's relay with each seat's agent, session and duration. #186 and #187 start together, #188 starts the moment #186 is Done while #187 is still in review, and #189 waits for the later of its two dependencies; PRs #191–#194 merge and #190 closes. The video pauses and zooms at each of those moments; idle time is cut, the issue authoring plays at 6×, Main's activity at 2× and seat-only stretches at 12×.

## Starting a coordinator

A roundtable starts from the issue it delivers, never from a switch inside a session. The issue carries one link:

```
http://127.0.0.1:47591/tern/<owner>/<repo>/issues/<number>?cwd=<absolute local checkout>
```

GitHub strips inline `<svg>` from issue bodies, so the link is written as this repository's badge image wrapped in the link, not as a bare URL. `cwd` is percent-encoded as a query value; an unencoded space would end the Markdown link:

```markdown
[![Coordinate with Roundtable](https://raw.githubusercontent.com/oh-my-omp/omp-roundtable/main/docs/badge/coordinate-with-roundtable.svg)](http://127.0.0.1:47591/tern/<owner>/<repo>/issues/<number>?cwd=<absolute local checkout>)
```

Install the extension as an omp plugin (`omp plugin install omp-roundtable`), then install the link launcher once — from any omp session with `/roundtable-launcher install`, or from the package CLI with `omp-roundtable-launcher install`. `install` writes `~/Library/LaunchAgents/com.ohmyomp.roundtable-launcher.plist` and leaves `127.0.0.1:47591` answering; `uninstall` removes it and `status` reports it.

The launcher holds no state of its own. It reads the link, calls Tern, and returns one page naming exactly one outcome: `launched` (a coordinator tab now runs `omp --roundtable <owner>/<repo>#<number>` in the link's `cwd`), `focused` (a live block already runs that exact reference and was focused instead), `rejected` (unsupported frontend, malformed path or number, a `cwd` that is not an existing absolute directory, or a request that is not a user's click navigation), or `frontendFailed` (Tern's own output). Tern's daemon outlives its window, so the launcher opens a window in the link's `cwd` first whenever no window client is connected: a block started without one would run invisibly. Only `Sec-Fetch-Mode: navigate` with `Sec-Fetch-User: ?1` is served, because any page can GET `127.0.0.1` and GitHub drops Referer on the https→http hop; the click is the operator's authorization. The port and the `tern` frontend are part of the published link contract.

## The coordinator

`--roundtable` is the whole identity. From `session_start`, the process's Main coordinates that issue and keeps the same native session throughout delivery. One visible startup message identifies the issue and any saved active agenda. Main reads the issue and its sub-issues, then calls the `roundtable` tool with a strict `{"input": ...}` object. Ending a coordinator means ending its omp process.

Without the flag the extension registers nothing else: no active `roundtable` tool, no timers, no roundtable state.

Main starts a new agenda with `convene`, supplying `parent` (or `null`) and `tickets`. Every ticket entry has an `id`, `issue`, `target`, `dependsOn` array, and `adoptPr` reference or `null`. All current parent sub-issues must be represented. Dependencies refer to ticket IDs; independent tickets have no edge. Main can change the topology and record exceptional rulings with `resolve`. A saved active agenda requires explicit `resume` and confirmation that the original coordinator process ended.

## Workflow

The ticket states and every GitHub effect are fixed; the workflow names the seats. It has one `owner` seat and three judged stages, each a list of judges with a `role`, an `agent`, and a `brief`. The built-in workflow is [`src/default-workflow.yml`](src/default-workflow.yml): an Owner on `task:high`, `review` and `accept` on the PR, `postMerge` on the merge commit, and `closure` on the parent, all on `task:mid`.

```yaml
owner: {agent: task:high, brief: Implement the issue contract and current Main rulings.}
judges:
  pullRequest: [{role: quality, agent: task:mid, brief: Check correctness and tests.}, {role: security, agent: reviewer, brief: Check for injection and secrets.}]
  mergeCommit: []
  parent: [{role: closure, agent: task:mid, brief: Verify the parent issue is fully delivered.}]
```

| Stage | Judges check out | Opens when | Every judge passes | Any judge fails |
|---|---|---|---|---|
| `pullRequest` | the exact PR head | the ticket is `Reviewing` and its PR is mergeable with passing required checks | the PR is merged | the ticket returns to `Coding` |
| `mergeCommit` | the exact merge commit | the merge is confirmed and the ticket is `Verifying` | the issue is closed and the ticket is `Done` | the ticket is `Escalated` |
| `parent` | the target branch | every ticket is `Done` | the parent issue is closed and the closure is `Done` | the closure is `Escalated` |

An empty list removes that stage's seats, not its checks: the stage still opens on its source-confirmed fingerprint and passes at once. Role names start with a letter, use letters, digits, `_`, or `-`, and are unique across all stages; `owner` is reserved. A `brief` is the seat's duty. The roundtable adds the seat's protocol to it: ticket scope, what its checkout is, the exact `submit` or `verdict` call, and what a failure leads to. An `agent` is a native agent name, resolved like `task` resolves it in the coordinator's `cwd`. It must be non-blocking.

`convene` reads the workflow from `roundtable.workflowFile` (env `OMP_ROUNDTABLE_WORKFLOW`, relative to the coordinator's `cwd`), which must exist. When that setting is unset, it reads `<roundtable.dataDir>/workflow.yml`, falling back to the built-in workflow when the file does not exist. An unreadable or invalid file, or an agent that cannot host a seat, refuses `convene`. The agenda freezes the workflow it was convened with: relays, rework, and `resume` never read the file again, so edits apply to the next `convene`.

## Ticket handoff

Main decides only when each ticket goes on the table. `status` lists `launchable` tickets (`Coding`, never launched, every dependency `Done`) and the seats currently `seated`. Main calls `launch` with `ticketId` and an optional `role`, once per ticket; an omitted `role` means the ticket's currently executable seats, and a given `role` must be one of them. The call marks the ticket started, seats its current stage at once, and returns their native async job IDs, so independent tickets can be launched back to back. From then on the roundtable relays the ticket's seats by itself: the Owner, a fresh seat for every `pullRequest` judge once the PR is mergeable with passing required checks, a forked rework Owner after a failed `pullRequest` verdict, CI failure, or conflict, every `mergeCommit` judge, and, once every ticket is `Done`, every `parent` judge. A seat is one-shot per revision: a role seated at a revision is never seated at that revision again within the process, so a seat that ends without a handoff is followed by its escalation, not by a replacement. A rework Owner starts only after every seat of its ticket has exited. Native `task` is not used for these seats because its session allocator cannot accept an Owner fork manager.

Main is woken by a `roundtable-attention` message only for a decision it has not yet been told about and that is still open when its current turn ends: a ticket that became launchable, an `Escalated` ticket or closure (keyed by revision), or a finished agenda awaiting `finish`. A decision Main settles within the turn that produced it, such as launching what `convene` unlocked, never wakes it again. Launching, running seats, seat job completions, effects in flight, and a confirmed no-code closure on its way do not notify.

Each seat reads only its bound ticket through `read`. An Owner pushes its code branch and calls `submit` with the ticket revision, branch, head, title, and a PR body closing exactly that issue. A judge calls `verdict` with its own `role`; every `pullRequest` judge must pass on the same fresh source fingerprint before merging. A failed `pullRequest` verdict, required CI check, or branch conflict returns the ticket to `Coding` with the finding on its notes. A seat calls `escalate` for a question, blocker, proposed split, or no-code finding. A successful handoff ends the seat; it does not wait for another assignment.

The state machine publishes or updates the PR, checks GitHub again, and advances `Publishing → Reviewing → Merging → Verifying → Done`. In `Reviewing`, a new head or description of the same open PR restarts the `pullRequest` stage on the new fingerprint; only an approved `Merging` ticket escalates when its PR drifts. `Verifying` also requires the target branch to contain the merge commit and the source issue to be closed. A seat that ends at its current revision without a handoff, or cannot be started, escalates its ticket instead of being relaunched. Main handles `Escalated` tickets using `resolve`, which records a persistent ruling, synchronizes the issue contract, adjusts topology, adopts source results, or explicitly retries/adopts/cancels a failed or uncertain effect; a started ticket resolved back to `Coding`, `Reviewing`, or `Verifying` resumes its relay. Main confirms no-code work with `to:"Done"` and `noCode`; the ticket reaches `Done` only after GitHub confirms closure. If a parent exists, all tickets must finish before the `parent` stage can approve its closure. `finish` records the final summary only after the full graph and parent closure are complete.

## Sessions and recovery

Every seat checkout is a detached `git worktree` of a per-repository bare cache under `<roundtable.dataDir>/repos`, which is cloned once and fetched before each checkout; seats never clone from the network. Worktrees live under `<roundtable.dataDir>/worktrees/<agendaId>`. An Owner's first seat receives a new persistent native session and a checkout of the target branch. Rework forks the previous accepted `ownerSessionFile` with `SessionManager.forkFrom` in the same checkout, repairing an interrupted transcript tail and resetting inherited cost, then gives that manager to `createAgentSession`. The first Owner records its base system prompt and its tool presentation (enabled tools and the subset mounted as `xd://` devices) in a `roundtable-session-contract` entry; the fork restores both, the provider prompt-cache key is explicitly inherited, the inherited todo list is cleared, and only incremental notes and rulings are appended to the new turn. A fork source whose contract lacks the tool presentation cannot be forked, so its ticket escalates. Actual provider cache hits still depend on the provider; preserving a key is not a measured hit-rate guarantee.

Every seat is a full native omp session in its checkout, not a restricted one. It binds the extensions Main loaded (user plugins, configured extensions, and their extension roots), reads the workspace's settings, discovers the workspace's custom tools, shares Main's MCP servers, and keeps every tool those provide, including `todo`, `task`, and replacements such as `exec_command` for `bash`. Its seat agent may delegate to helper agents (`spawns` follows the agent definition, `*` when unspecified). Only the seat's own session is bound to its ticket: the `roundtable` tool it receives reads and hands off that ticket, while helpers it spawns have their own native identities and are refused as seats. Seats run headless, so tool approvals are not prompted, and they never join IRC: a seat reaches Main only through its ticket. Extensions bind from Main's process rather than being rediscovered, so project-local extensions or MCP servers of a different target repository are not loaded into its seats.

Judge seats always receive new blank sessions; their histories are never reused or forked. `pullRequest` judges check out exactly the PR head their stage stamp names (fetched through the PR's pull ref, so fork heads work), `mergeCommit` judges check out exactly the merge commit, and `parent` judges check out the target branch; the host verifies the checkout's `HEAD` before the seat starts. A superseded seat ends at its next native tool-completion boundary instead of retrying another revision's work; accepted handoffs finish normally so their checkpoints remain intact. `mergeCommit` fingerprints pin the ticket's merge commit and freshly verify target containment, so unrelated forward merges do not invalidate a running verification. Seat sessions are disposed when their native async jobs finish. Owner checkouts survive process restarts and rework until `finish`; judge worktrees are removed when their jobs end. Session files remain under `<roundtable.dataDir>/sessions/<agendaId>`.

Accepted transitions and effect intents are durably saved under `<roundtable.dataDir>/state` before returning. Every external write first persists `executing`, performs the operation, then confirms its result through a fresh GitHub read. An unknown outcome becomes `uncertain` and is never automatically resent. Resume reconciles interrupted executing intents against GitHub rather than replaying them. PR head, target, issue contract, PR body, or ruling changes invalidate approvals before any merge.

State envelopes use `format: 6`, which carries the agenda's frozen workflow. Older formats are rejected without migration or deletion. State saves sync the owned state directory, not its ancestors. The extension never rewrites conversation history or injects per-turn hidden ticket context; ticket reads and visible notifications are ordinary messages.

## State-flow simulation

`bun run sim [scenario...]` runs the real `omp` binary in RPC mode with this extension, its controller, seat host, git worktrees, native sessions and forks. Only the model and GitHub are simulated: `tests/sim/extension.ts` registers a scripted `sim` provider that plays Main and every seat from what omp actually sends it, and `tests/sim/github-sim.ts` answers the real `src/ports/github.ts` through a `gh` shim placed first on `PATH`, backed by local bare repositories for every git fact and failing loudly on any request it does not model. Each scenario supplies its workflow as `<roundtable.dataDir>/workflow.yml`, with every seat agent defined as a scripted agent; all but `roster` use the built-in roster. Scenarios run in scratch directories under `/tmp/rt-sim-*` and need no network:

- `tree`: seven tickets with parallel, serial, gate rejection with forked rework, escalation with a ruling, noCode, and the parent closure. Every seat must record `task` and `roundtable` with `spawns` `*`, and each rework fork must keep its first Owner's prompt-cache key and clear the inherited todo list.
- `ci`: required checks that stay pending delay the gates; a failing check returns the ticket to Coding for a forked rework.
- `head`: a new head pushed to an open PR while both gates are seated restarts the gates without escalating.
- `abandon`: an Owner that ends without a handoff escalates once and is seated again only after Main's ruling.
- `restart`: the process is killed while a handed-off Owner is mid-tool, and the workflow file is rewritten to a different roster; after `resume`, the agenda keeps its frozen roster, and the rework fork repairs the interrupted tail and resets inherited cost.
- `roster`: a custom workflow with two `pullRequest` judges, no `mergeCommit` judge, and two `parent` judges, each seat on its own agent with its own duty. One PR judge passing alone does not merge, every seat runs its configured agent and carries only its own duty, and both tickets still pass `Verifying` with no judge seated.

Each scenario also checks that Main launched every ticket exactly once, was never woken for a decision it had already taken, that every configured judge's accepted verdict sat on the exact commit its stage names, and that the simulated repository ends in the expected state.
