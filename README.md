# omp-roundtable

Roundtable delivers GitHub issue graphs through durable tickets, source-confirmed effects, one-shot Owner sessions, and fresh independent gates. Main chooses which independent tickets run concurrently and which dependency edges enforce serial delivery.

## Starting a coordinator

A roundtable starts from the issue it delivers, never from a switch inside a session. The issue carries one link:

```
http://127.0.0.1:47591/tern/<owner>/<repo>/issues/<number>?cwd=<absolute local checkout>
```

Install the extension as an omp plugin (`omp plugin install omp-roundtable`), then install the link launcher once — from any omp session with `/roundtable-launcher install`, or from the package CLI with `omp-roundtable-launcher install`. `install` writes `~/Library/LaunchAgents/com.ohmyomp.roundtable-launcher.plist` and leaves `127.0.0.1:47591` answering; `uninstall` removes it and `status` reports it.

The launcher holds no state of its own. It reads the link, calls Tern, and returns one page naming exactly one outcome: `launched` (a coordinator tab now runs `omp --roundtable <owner>/<repo>#<number>` in the link's `cwd`), `focused` (a live block already runs that exact reference and was focused instead), `rejected` (unsupported frontend, malformed path or number, a `cwd` that is not an existing absolute directory, or a request that is not a user's click navigation), or `frontendFailed` (Tern's own output). Tern's daemon outlives its window, so the launcher opens a window in the link's `cwd` first whenever no window client is connected: a block started without one would run invisibly. Only `Sec-Fetch-Mode: navigate` with `Sec-Fetch-User: ?1` is served, because any page can GET `127.0.0.1` and GitHub drops Referer on the https→http hop; the click is the operator's authorization. The port and the `tern` frontend are part of the published link contract.

## The coordinator

`--roundtable` is the whole identity. From `session_start`, the process's Main coordinates that issue and keeps the same native session throughout delivery. One visible startup message identifies the issue and any saved active agenda. Main reads the issue and its sub-issues, then calls the `roundtable` tool with a strict `{"input": ...}` object. Ending a coordinator means ending its omp process.

Without the flag the extension registers nothing else: no active `roundtable` tool, no timers, no roundtable state.

Main starts a new agenda with `convene`, supplying `parent` (or `null`) and `tickets`. Every ticket entry has an `id`, `issue`, `target`, `dependsOn` array, and `adoptPr` reference or `null`. All current parent sub-issues must be represented. Dependencies refer to ticket IDs; independent tickets have no edge. Main can change the topology and record exceptional rulings with `resolve`. A saved active agenda requires explicit `resume` and confirmation that the original coordinator process ended.

## Ticket handoff

Main uses `status` or `tickets` to inspect available roles, then explicitly calls `launch` with `ticketId` and `role`. Each launch returns immediately with a native async job ID, so Main can launch multiple independent tickets before waiting. Native `task` is not used for these seats because its session allocator cannot accept an Owner fork manager.

Each seat reads only its bound ticket through `read`. An Owner pushes its code branch and calls `submit` with the ticket revision, branch, head, title, and a PR body closing exactly that issue. Review and accept seats call `verdict`; both must pass on the same fresh source fingerprint before merging. A failed review, acceptance, required CI check, or branch conflict returns the ticket to `Coding` with the finding on its notes. A seat calls `escalate` for a question, blocker, proposed split, or no-code finding. A successful handoff ends the seat; it does not wait for another assignment.

The state machine publishes or updates the PR, checks GitHub again, and advances `Publishing → Reviewing → Merging → Verifying → Done`. Post-merge acceptance also requires the target branch to contain the merge commit and the source issue to be closed. Main handles `Escalated` tickets using `resolve`, which records a persistent ruling, synchronizes the issue contract, adjusts topology, adopts source results, or explicitly retries/adopts/cancels a failed or uncertain effect. Main confirms no-code work with `to:"Done"` and `noCode`; the ticket reaches `Done` only after GitHub confirms closure. If a parent exists, all tickets must finish before a fresh `closure` seat can approve its closure. `finish` records the final summary only after the full graph and parent closure are complete.

## Sessions and recovery

An Owner's first seat receives a new persistent native session and an independent checkout. Rework passes the previous accepted `ownerSessionFile` directly to `SessionManager.forkFrom`, then gives that manager to `createAgentSession`. The original system prompt and tool contract remain fixed, the provider prompt-cache key is explicitly inherited, and only incremental notes and rulings are appended to the new turn. Actual provider cache hits still depend on the provider; preserving a key is not a measured hit-rate guarantee.

Review, accept, post-merge, and closure seats always receive new blank sessions and independent checkouts. Their histories are never reused or forked. Seat sessions are disposed when their native async jobs finish. Owner checkouts survive process restarts and rework until `finish`; gate checkouts are removed when their jobs end. Session files remain under `<roundtable.dataDir>/sessions`.

Accepted transitions and effect intents are durably saved under `<roundtable.dataDir>/state` before returning. Every external write first persists `executing`, performs the operation, then confirms its result through a fresh GitHub read. An unknown outcome becomes `uncertain` and is never automatically resent. Resume reconciles interrupted executing intents against GitHub rather than replaying them. PR head, target, issue contract, PR body, or ruling changes invalidate approvals before any merge.

State envelopes use `format: 4`. Older formats are rejected without migration or deletion. State saves sync the owned state directory, not its ancestors. The extension never rewrites conversation history or injects per-turn hidden ticket context; ticket reads and visible notifications are ordinary messages.
