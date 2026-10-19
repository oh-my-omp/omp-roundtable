// State-flow simulation of omp-roundtable. Each scenario runs the real `omp`
// binary in RPC mode with the real extension (index.ts), the real controller,
// host, git worktrees, native sessions and forks. Only two things are
// simulated: the model (tests/sim/extension.ts plays Main and every seat) and
// GitHub (tests/sim/github-sim.ts behind a `gh` shim on PATH, backed by real
// bare repositories). Run: `bun run sim [scenario...]`.

import {closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import type {Subprocess} from 'bun';
import {z} from '@oh-my-pi/omptype/zod';
import type {Agenda} from '../../src/domain/model.ts';
import {createAgendaFiles} from '../../src/ports/state.ts';
import {git, remotePath, seedGitHub, withState, type SimState} from './github-sim.ts';
import type {Expect, Scenario, TicketSpec} from './scenario.ts';

const ROOT = resolve(import.meta.dir, '../..');
const REPO = {owner: 'sim', name: 'arena'};
const KEY = `${REPO.owner}/${REPO.name}`;
const DEADLINE_MS = 240_000;

type Run = {
  name: string; dir: string; github: string; bin: string; work: string; data: string; mainSessions: string;
  scenarioFile: string; scenario: Scenario; rootIssue: number; proc: Subprocess<'pipe', number, number> | null; starts: number;
};
type Case = {
  name: string;
  files: Record<string, string>;
  /** Issue titles in creation order; issue N is the Nth entry. The first may list children. */
  issues: {title: string; children?: number[]}[];
  requiredChecks: string[];
  ci: {default: SimState['ciDefault']; failMarker: string | null};
  scenario: (markers: string) => Omit<Scenario, 'log' | 'repo' | 'name'>;
  rootIssue: number;
  drive?: (run: Run) => Promise<void>;
  check: (run: Run) => Promise<string[]>;
};

/* ------------------------------------------------------------ process */

function setup(spec: Case): Run {
  const dir = mkdtempSync(`/tmp/rt-sim-${spec.name}-`);
  const github = join(dir, 'github'), work = join(dir, 'work'), markers = join(dir, 'markers');
  for (const path of [github, join(work, '.omp', 'agents'), markers, join(dir, 'data'), join(dir, 'main-sessions')]) mkdirSync(path, {recursive: true});
  const bin = seedGitHub(github, {viewer: 'sim', ciDefault: spec.ci.default, ciFailMarker: spec.ci.failMarker,
    repos: [{...REPO, defaultBranch: 'main', requiredChecks: spec.requiredChecks, files: spec.files}],
    issues: spec.issues.map(issue => ({repo: KEY, title: issue.title, body: `Simulated ${issue.title}.`, ...(issue.children ? {children: issue.children} : {})}))});
  writeFileSync(join(work, '.omp', 'agents', 'sim-seat.md'), '---\nname: sim-seat\ndescription: Scripted roundtable seat for the state-flow simulation\nmodel: sim/seat\n---\n\nFollow the roundtable brief.\n');
  const scenario: Scenario = {name: spec.name, repo: REPO, log: join(dir, 'model.jsonl'), ...spec.scenario(markers)};
  const scenarioFile = join(dir, 'scenario.json');
  writeFileSync(scenarioFile, JSON.stringify(scenario, null, 1));
  writeFileSync(scenario.log, '');
  return {name: spec.name, dir, github, bin, work, data: join(dir, 'data'), mainSessions: join(dir, 'main-sessions'), scenarioFile, scenario, rootIssue: spec.rootIssue, proc: null, starts: 0};
}

function start(run: Run): void {
  run.starts++;
  const stdout = openSync(join(run.dir, `omp-${run.starts}.stdout.jsonl`), 'a'), stderr = openSync(join(run.dir, `omp-${run.starts}.stderr.log`), 'a');
  run.proc = Bun.spawn(['omp', '--mode', 'rpc', '--no-ui', '--no-extensions', '-e', join(ROOT, 'index.ts'), '-e', join(ROOT, 'tests/sim/extension.ts'),
    '--model', 'sim/main', '--session-dir', run.mainSessions, '--roundtable', `${KEY}#${run.rootIssue}`], {
    cwd: run.work, stdin: 'pipe', stdout, stderr,
    env: {...process.env, PATH: `${run.bin}:${process.env.PATH}`, OMP_ROUNDTABLE_DIR: run.data, OMP_ROUNDTABLE_OWNER_AGENT: 'sim-seat',
      OMP_ROUNDTABLE_GATE_AGENT: 'sim-seat', OMP_ROUNDTABLE_RECOMPUTE_SECONDS: '1', SIM_SCENARIO: run.scenarioFile},
  });
  closeSync(stdout); closeSync(stderr);
}

/** Closes stdin, which is RPC mode's clean shutdown: session_shutdown runs and the process exits. */
async function stop(run: Run): Promise<void> {
  const proc = run.proc;
  if (!proc) return;
  proc.stdin.end();
  const exited = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => null)]);
  if (exited === null) proc.kill('SIGKILL');
  await proc.exited;
  run.proc = null;
}

async function kill(run: Run): Promise<void> {
  run.proc?.kill('SIGKILL');
  await run.proc?.exited;
  run.proc = null;
}

/* ------------------------------------------------------------ observations */

async function agenda(run: Run): Promise<Agenda | null> {
  const list = await createAgendaFiles(run.data).list();
  if (!list.ok) throw new Error(`Cannot read agendas: ${list.error.message}`);
  return list.value[0] ?? null;
}

const ticketOf = (state: Agenda | null, id: string) => state?.tickets.find(ticket => ticket.id === id);

async function waitUntil(run: Run, label: string, ready: (state: Agenda | null) => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    const state = await agenda(run);
    if (await ready(state)) return;
    if (run.proc && run.proc.exitCode !== null) throw new Error(`omp exited (${run.proc.exitCode}) while waiting for ${label}`);
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}; agenda: ${JSON.stringify(state?.tickets.map(ticket => ({id: ticket.id, state: ticket.state, revision: ticket.revision, notes: ticket.notes.map(note => note.text)})))}`);
    await Bun.sleep(300);
  }
}

const completed = (state: Agenda | null) => state?.lifecycle === 'completed';

const logSchema = z.object({at: z.number(), session: z.string().nullable(), kind: z.enum(['main', 'seat']), role: z.string().optional(), ticket: z.string().optional(), note: z.string(),
  step: z.object({name: z.string().optional(), args: z.record(z.string(), z.unknown()).optional(), text: z.string().optional()})});
type LogEntry = z.infer<typeof logSchema>;
const inputSchema = z.object({input: z.object({op: z.string(), ticketId: z.string().optional(), role: z.string().optional(), ok: z.boolean().optional(), note: z.string().optional(), revision: z.number().optional()}).passthrough()}).passthrough();

function modelLog(run: Run): LogEntry[] {
  return readFileSync(run.scenario.log, 'utf8').split('\n').filter(Boolean).map(line => logSchema.parse(JSON.parse(line)));
}

/** The roundtable input of a logged tool call, or null for text and other tools. */
function roundtableInput(entry: LogEntry): z.infer<typeof inputSchema>['input'] | null {
  if (entry.step.name !== 'roundtable') return null;
  const parsed = inputSchema.safeParse(entry.step.args);
  return parsed.success ? parsed.data.input : null;
}

const sessionLineSchema = z.object({type: z.string()}).passthrough();
type SeatSession = {file: string; id: string; parent: string | null; role: string; ticket: string; lines: z.infer<typeof sessionLineSchema>[]};

function seatSessions(run: Run, agendaId: string): SeatSession[] {
  const dir = join(run.data, 'sessions', agendaId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort().map(name => {
    const raw = readFileSync(join(dir, name), 'utf8');
    const lines = raw.split('\n').filter(Boolean).map(line => sessionLineSchema.parse(JSON.parse(line)));
    const header = lines.find(line => line.type === 'session');
    const seat = /You are the (\w+) seat for roundtable ticket (\S+?)\. /.exec(raw);
    return {file: join(dir, name), id: typeof header?.id === 'string' ? header.id : '', parent: typeof header?.parentSession === 'string' ? header.parentSession : null,
      role: seat?.[1] ?? '?', ticket: seat?.[2] ?? '?', lines};
  });
}

const callSchema = z.object({type: z.literal('toolCall'), id: z.string(), name: z.string(), arguments: z.object({input: z.object({op: z.string(), note: z.string().optional()}).passthrough()}).passthrough()}).passthrough();
const messageLineSchema = z.object({message: z.object({role: z.string(), content: z.unknown(), toolCallId: z.string().optional()}).passthrough()}).passthrough();

/** Verdicts a gate seat actually submitted and the roundtable accepted, read from the seat transcripts. */
function acceptedVerdicts(sessions: SeatSession[]): {ticket: string; role: string; note: string}[] {
  const out: {ticket: string; role: string; note: string}[] = [];
  for (const session of sessions) {
    const messages = session.lines.flatMap(line => { const parsed = messageLineSchema.safeParse(line); return parsed.success ? [parsed.data.message] : []; });
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
      for (const block of message.content) {
        const call = callSchema.safeParse(block);
        if (!call.success || call.data.name !== 'roundtable' || call.data.arguments.input.op !== 'verdict') continue;
        const result = messages.find(item => item.role === 'toolResult' && item.toolCallId === call.data.id);
        if (result && JSON.stringify(result.content).includes('\\"ok\\":true')) out.push({ticket: session.ticket, role: session.role, note: call.data.arguments.input.note ?? ''});
      }
    }
  }
  return out;
}

const simState = (run: Run): SimState => withState(run.github, state => structuredClone(state));
const gitIn = (run: Run, args: string[]) => git(remotePath(run.github, KEY), args, true);

/* ------------------------------------------------------------ shared checks */

async function commonChecks(run: Run, expectOnMain: Expect): Promise<string[]> {
  const failures: string[] = [];
  const state = await agenda(run);
  if (!completed(state)) failures.push(`agenda is ${state?.lifecycle ?? 'missing'}, not completed`);
  const unhandled = readFileSync(join(run.github, 'requests.jsonl'), 'utf8').split('\n').filter(line => line.includes('"unhandled":true'));
  if (unhandled.length) failures.push(`simulated GitHub got ${unhandled.length} unmodelled requests, first: ${unhandled[0]!.slice(0, 400)}`);
  const log = modelLog(run);
  // Main puts every ticket on the table exactly once and never names a later stage.
  const launches = log.filter(entry => entry.kind === 'main').map(roundtableInput).filter(input => input?.op === 'launch');
  for (const ticket of run.scenario.tickets) {
    const count = launches.filter(input => input?.ticketId === ticket.id).length;
    if (count !== 1) failures.push(`Main launched ${ticket.id} ${count} times`);
  }
  if (launches.some(input => input?.role !== undefined)) failures.push('Main named a role in launch');
  // Main is woken only for decisions it has not already taken.
  const launched = new Set<string>(), resolved = new Set<string>();
  const groups = new Map<string, LogEntry[]>();
  for (const entry of log.filter(item => item.kind === 'main')) groups.set(`${entry.session}:${entry.note}`, [...(groups.get(`${entry.session}:${entry.note}`) ?? []), entry]);
  for (const [, entries] of groups) {
    const keys = entries[0]!.note.slice(entries[0]!.note.indexOf(':') + 1);
    if (keys !== 'start') for (const key of keys.split(', ')) {
      if (key.startsWith('launch:') && launched.has(key.slice(7))) failures.push(`Main was woken for ${key} after launching it`);
      if (key.startsWith('escalated:') && resolved.has(key.slice(10))) failures.push(`Main was woken for ${key} after resolving it`);
    }
    for (const input of entries.map(roundtableInput)) {
      if (input?.op === 'launch' && input.ticketId) launched.add(input.ticketId);
      if (input?.op === 'resolve' && input.ticketId) resolved.add(`${input.ticketId}:${input.revision}`);
    }
  }
  // Gates judged the exact commit: review/accept sat on PR commits, postMerge on the merge commit.
  const sim = simState(run);
  const verdicts = acceptedVerdicts(seatSessions(run, state?.id ?? ''));
  for (const ticket of run.scenario.tickets.filter(item => Object.keys(item.gate).length > 0))
    for (const role of ['review', 'accept', 'postMerge']) if (!verdicts.some(verdict => verdict.ticket === ticket.id && verdict.role === role)) failures.push(`${ticket.id} has no accepted ${role} verdict in its transcripts`);
  if (run.scenario.parent !== null && !verdicts.some(verdict => verdict.role === 'closure')) failures.push('no accepted closure verdict in the transcripts');
  for (const verdict of verdicts) {
    const head = /HEAD ([0-9a-f]{40})/.exec(verdict.note)?.[1];
    if (!head) { failures.push(`${verdict.ticket} ${verdict.role} verdict has no observed HEAD`); continue; }
    if (verdict.role === 'closure') {
      if (gitIn(run, ['merge-base', '--is-ancestor', head, 'main']).code !== 0) failures.push(`closure sat on ${head}, which is not on main`);
      continue;
    }
    const spec = run.scenario.tickets.find(ticket => ticket.id === verdict.ticket);
    const pr = sim.prs.find(item => item.state === 'MERGED' && spec && item.body.includes(`#${spec.issue}`));
    if (!pr?.mergeCommit) { failures.push(`${verdict.ticket} has no merged PR`); continue; }
    if (verdict.role === 'postMerge') {
      if (head !== pr.mergeCommit) failures.push(`${verdict.ticket} postMerge sat on ${head}, not merge ${pr.mergeCommit}`);
    } else if (gitIn(run, ['merge-base', '--is-ancestor', head, pr.lastHead]).code !== 0 || gitIn(run, ['merge-base', '--is-ancestor', head, `${pr.mergeCommit}^1`]).code === 0) {
      failures.push(`${verdict.ticket} ${verdict.role} sat on ${head}, which is not a commit of its PR`);
    }
  }
  for (const issue of sim.issues) if (issue.state !== 'CLOSED') failures.push(`issue #${issue.number} is still open`);
  for (const [path, content] of Object.entries(expectOnMain)) {
    const actual = gitIn(run, ['show', `main:${path}`]);
    if (actual.code !== 0 || `${actual.stdout}\n` !== content && actual.stdout !== content.trimEnd()) failures.push(`main:${path} is ${JSON.stringify(actual.stdout)}, expected ${JSON.stringify(content)}`);
  }
  return failures;
}

function owners(sessions: SeatSession[], ticket: string): SeatSession[] {
  return sessions.filter(session => session.role === 'owner' && session.ticket === ticket);
}

/* ------------------------------------------------------------ scenarios */

const commit = (write: Record<string, string>) => ({kind: 'commit' as const, write});
const ticket = (id: string, issue: number, owner: TicketSpec['owner'], gate: Expect, extra: Partial<TicketSpec> = {}): TicketSpec => ({id, issue, dependsOn: [], owner, gate, ...extra});

const TREE_FILES = {'a1.txt': '0\n', 'a2.txt': '0\n', 'shared.txt': 'L1=0\nL2=0\n', 'c.txt': '0\n', 'd.txt': '0\n', 'e.txt': '1\n'};
const TREE_DONE = {'a1.txt': '1\n', 'a2.txt': '1\n', 'shared.txt': 'L1=1\nL2=1\n', 'c.txt': '1\n', 'c.verify': '1\n', 'd.txt': '1\n', 'e.txt': '1\n'};

const cases: Case[] = [
  {
    name: 'tree',
    files: TREE_FILES,
    issues: [{title: 'Parent', children: [2, 3, 4, 5, 6, 7, 8]}, {title: 'A1'}, {title: 'A2'}, {title: 'B1'}, {title: 'B2'}, {title: 'C'}, {title: 'D'}, {title: 'E'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: () => ({parent: 1, closure: TREE_DONE, tickets: [
      ticket('A1', 2, [commit({'a1.txt': '1\n'})], {'a1.txt': '1\n'}),
      ticket('A2', 3, [commit({'a2.txt': '1\n'})], {'a2.txt': '1\n'}),
      ticket('B1', 4, [commit({'shared.txt': 'L1=1\nL2=0\n'})], {'shared.txt': 'L1=1\nL2=0\n'}),
      ticket('B2', 5, [commit({'shared.txt': 'L1=1\nL2=1\n'})], {'shared.txt': 'L1=1\nL2=1\n'}, {dependsOn: ['B1']}),
      // The first round omits c.verify, so both gates reject it and a forked Owner adds it.
      ticket('C', 6, [commit({'c.txt': '1\n'}), commit({'c.verify': '1\n'})], {'c.txt': '1\n', 'c.verify': '1\n'}),
      ticket('D', 7, [{kind: 'escalate', escalation: 'blocked', reason: 'Clauses demand d.txt=1 and d.txt=2.'}, commit({'d.txt': '1\n'})], {'d.txt': '1\n'},
        {rulings: [{to: 'Coding', ruling: 'Clause 1 governs: d.txt must be 1.'}]}),
      ticket('E', 8, [{kind: 'escalate', escalation: 'noCode', reason: 'e.txt is already 1.'}], {},
        {rulings: [{to: 'Done', ruling: 'e.txt already satisfies the contract.', noCode: 'e.txt is already 1 on main.'}]}),
    ]}),
    async check(run) {
      const failures = await commonChecks(run, TREE_DONE);
      const state = await agenda(run);
      const sessions = seatSessions(run, state!.id);
      for (const id of ['C', 'D']) {
        const [first, second] = owners(sessions, id);
        if (!first || !second || second.parent !== first.id) failures.push(`${id} rework Owner is not a fork of its first Owner (${owners(sessions, id).map(item => `${item.id}<-${item.parent}`).join(', ')})`);
      }
      for (const gate of sessions.filter(session => session.role !== 'owner')) if (gate.parent) failures.push(`${gate.ticket} ${gate.role} session inherited history`);
      if (ticketOf(state, 'E')?.terminal?.kind !== 'noCode') failures.push('E did not finish as noCode');
      if (state?.closure?.state !== 'Done') failures.push('closure is not Done');
      return failures;
    },
  },
  {
    name: 'ci',
    files: {'p.txt': '0\n', 'f.txt': '0\n'},
    issues: [{title: 'P'}, {title: 'F'}],
    requiredChecks: ['ci/sim'], ci: {default: 'PENDING', failMarker: 'BROKEN'}, rootIssue: 1,
    scenario: () => ({parent: null, closure: {}, tickets: [
      ticket('P', 1, [commit({'p.txt': '1\n'})], {'p.txt': '1\n'}),
      // The first round ships a file CI rejects; the forked Owner removes it.
      ticket('F', 2, [commit({'f.txt': '1\n', BROKEN: 'x\n'}), {kind: 'commit', write: {'f.txt': '1\n'}, remove: ['BROKEN']}], {'f.txt': '1\n'}),
    ]}),
    async drive(run) {
      // CI stays pending for three seconds after a PR head first appears, then passes, unless the commit is broken.
      const seen = new Map<string, number>(), flips: {sha: string; at: number}[] = [];
      await waitUntil(run, 'completion with CI', async state => {
        withState(run.github, sim => {
          for (const pr of sim.prs.filter(item => item.state === 'OPEN')) {
            if (sim.ci[pr.lastHead] || gitIn(run, ['cat-file', '-e', `${pr.lastHead}:BROKEN`]).code === 0) continue;
            const first = seen.get(pr.lastHead) ?? Date.now();
            seen.set(pr.lastHead, first);
            if (Date.now() - first >= 3000) { sim.ci[pr.lastHead] = 'SUCCESS'; flips.push({sha: pr.lastHead, at: Date.now()}); }
          }
        });
        return completed(state);
      });
      writeFileSync(join(run.dir, 'ci-flips.json'), JSON.stringify(flips));
    },
    async check(run) {
      const failures = await commonChecks(run, {'p.txt': '1\n', 'f.txt': '1\n'});
      const flips = z.array(z.object({sha: z.string(), at: z.number()})).parse(JSON.parse(readFileSync(join(run.dir, 'ci-flips.json'), 'utf8')));
      for (const entry of modelLog(run).filter(item => item.kind === 'seat' && (item.role === 'review' || item.role === 'accept') && item.note === 'inspect')) {
        const flipped = flips.filter(flip => flip.at <= entry.at);
        if (!flipped.length) failures.push(`${entry.ticket} ${entry.role} started before any required check passed`);
      }
      const state = await agenda(run);
      if (!ticketOf(state, 'F')?.notes.some(note => note.kind === 'checks')) failures.push('F was never returned to Coding by failing CI');
      const [first, second] = owners(seatSessions(run, state!.id), 'F');
      if (!first || second?.parent !== first.id) failures.push('F rework Owner is not a fork');
      return failures;
    },
  },
  {
    name: 'head',
    files: {'h.txt': '0\n'},
    issues: [{title: 'H'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: markers => ({parent: null, closure: {}, tickets: [
      // After submitting h.txt=1 the Owner pushes h.txt=2 to the same PR while both gates are seated on the first head.
      ticket('H', 1, [{kind: 'commit', write: {'h.txt': '1\n'}, after: {kind: 'push', waitFor: join(markers, 'move-head'), write: {'h.txt': '2\n'}}}], {'h.txt': '2\n'},
        {hold: {roles: ['review', 'accept'], marker: join(markers, 'release-gates')}}),
    ]}),
    async drive(run) {
      const markers = join(run.dir, 'markers');
      await waitUntil(run, 'both gates seated on the first head', () => {
        const inspecting = modelLog(run).filter(entry => entry.ticket === 'H' && entry.note === 'inspect').map(entry => entry.role);
        return inspecting.includes('review') && inspecting.includes('accept');
      });
      writeFileSync(join(markers, 'move-head'), '');
      await waitUntil(run, 'the new head to restart the gates', state => ticketOf(state, 'H')?.notes.some(note => note.text.startsWith('Open PR changed to head')) ?? false);
      writeFileSync(join(markers, 'release-gates'), '');
      await waitUntil(run, 'completion', completed);
    },
    async check(run) {
      const failures = await commonChecks(run, {'h.txt': '2\n'});
      const state = await agenda(run);
      const notes = ticketOf(state, 'H')?.notes ?? [];
      if (notes.some(note => note.kind === 'escalation' || note.text.includes('changed after approval'))) failures.push(`H escalated on a legitimate PR update: ${JSON.stringify(notes)}`);
      const sessions = seatSessions(run, state!.id);
      // The superseded gates are aborted at their next tool boundary, so no verdict on the first head may be accepted.
      if (acceptedVerdicts(sessions).some(verdict => verdict.ticket === 'H' && verdict.note.includes('h.txt="1\\n"'))) failures.push('a gate on the superseded head had its verdict accepted');
      const reviews = sessions.filter(session => session.ticket === 'H' && session.role === 'review');
      if (reviews.length < 2) failures.push(`expected a fresh review seat for the new head, found ${reviews.length}`);
      return failures;
    },
  },
  {
    name: 'abandon',
    files: {'q.txt': '0\n'},
    issues: [{title: 'Q'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: () => ({parent: null, closure: {}, tickets: [
      ticket('Q', 1, [{kind: 'quit'}, commit({'q.txt': '1\n'})], {'q.txt': '1\n'}, {rulings: [{to: 'Coding', ruling: 'Try again.'}]}),
    ]}),
    async check(run) {
      const failures = await commonChecks(run, {'q.txt': '1\n'});
      const state = await agenda(run);
      if (!ticketOf(state, 'Q')?.notes.some(note => note.text.includes('ended without a handoff'))) failures.push('the abandoned Owner did not escalate Q');
      if (!modelLog(run).some(entry => entry.kind === 'main' && entry.note.includes('escalated:Q:'))) failures.push('Main was not woken for the abandoned seat');
      const seats = owners(seatSessions(run, state!.id), 'Q');
      if (seats.length !== 2 || seats.some(seat => seat.parent)) failures.push(`expected two fresh Owner sessions, found ${seats.map(seat => `${seat.id}<-${seat.parent}`).join(', ')}`);
      return failures;
    },
  },
  {
    name: 'restart',
    files: {'k.txt': '0\n'},
    issues: [{title: 'K'}],
    requiredChecks: [], ci: {default: 'SUCCESS', failMarker: null}, rootIssue: 1,
    scenario: markers => ({parent: null, closure: {}, tickets: [
      // The Owner stays busy after its handoff; the gates reject, and the process dies while the Owner is mid-tool.
      ticket('K', 1, [{kind: 'commit', write: {'k.txt': '1\n'}, after: {kind: 'block', marker: join(markers, 'never')}}, commit({'k.verify': '1\n'})], {'k.txt': '1\n', 'k.verify': '1\n'}),
    ]}),
    async drive(run) {
      await waitUntil(run, 'K back in Coding with its Owner mid-tool', state => {
        const ticket = ticketOf(state, 'K');
        return ticket?.state === 'Coding' && ticket.revision >= 2 && modelLog(run).some(entry => entry.ticket === 'K' && entry.role === 'owner' && entry.note.startsWith('round 0 step 2'));
      });
      await kill(run);
      start(run);
      await waitUntil(run, 'completion after resume', completed);
    },
    async check(run) {
      const failures = await commonChecks(run, {'k.txt': '1\n', 'k.verify': '1\n'});
      if (!modelLog(run).some(entry => entry.kind === 'main' && roundtableInput(entry)?.op === 'resume')) failures.push('Main did not resume the saved agenda');
      const state = await agenda(run);
      const [source, fork] = owners(seatSessions(run, state!.id), 'K');
      if (!source || !fork || fork.parent !== source.id) return [...failures, 'K rework Owner is not a fork of the interrupted Owner'];
      const message = (line: SeatSession['lines'][number]) => z.object({message: z.object({role: z.string(), content: z.unknown(), toolCallId: z.string().optional(), usage: z.object({cost: z.object({total: z.number()})}).optional()}).passthrough()}).safeParse(line);
      const sourceMessages = source.lines.filter(line => line.type === 'message').map(message).flatMap(item => item.success ? [item.data.message] : []);
      const forkMessages = fork.lines.filter(line => line.type === 'message').map(message).flatMap(item => item.success ? [item.data.message] : []);
      const callIds = (messages: typeof sourceMessages) => messages.flatMap(item => item.role === 'assistant' && Array.isArray(item.content) ? item.content.flatMap(block => typeof block === 'object' && block !== null && 'type' in block && block.type === 'toolCall' && 'id' in block && typeof block.id === 'string' ? [block.id] : []) : []);
      const answered = (messages: typeof sourceMessages) => new Set(messages.flatMap(item => item.role === 'toolResult' && item.toolCallId ? [item.toolCallId] : []));
      const dangling = callIds(sourceMessages).filter(id => !answered(sourceMessages).has(id));
      if (!dangling.length) failures.push('the killed Owner session has no interrupted tool call, so tail repair was not exercised');
      for (const id of dangling) if (!answered(forkMessages).has(id)) failures.push(`fork left tool call ${id} unanswered`);
      const continueAt = forkMessages.findIndex(item => item.role === 'user' && JSON.stringify(item.content).includes('Continue ticket K'));
      const inherited = forkMessages.slice(0, continueAt).filter(item => item.role === 'assistant');
      if (!inherited.length || inherited.some(item => item.usage?.cost.total !== 0)) failures.push(`inherited assistant cost not reset: ${inherited.map(item => item.usage?.cost.total).join(',')}`);
      if (!sourceMessages.some(item => item.role === 'assistant' && (item.usage?.cost.total ?? 0) > 0)) failures.push('source Owner had no cost to reset');
      return failures;
    },
  },
];

/* ------------------------------------------------------------ main */

const selected = process.argv.slice(2);
let failed = false;
for (const spec of cases.filter(item => !selected.length || selected.includes(item.name))) {
  const run = setup(spec);
  const began = Date.now();
  let failures: string[];
  try {
    start(run);
    await (spec.drive ?? (async () => waitUntil(run, 'completion', completed)))(run);
    await stop(run);
    failures = await spec.check(run);
  } catch (error) {
    await kill(run);
    failures = [error instanceof Error ? error.message : String(error)];
  }
  failed ||= failures.length > 0;
  console.log(`${failures.length ? 'FAIL' : 'PASS'} ${spec.name} (${((Date.now() - began) / 1000).toFixed(1)}s) ${run.dir}`);
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failed ? 1 : 0);
