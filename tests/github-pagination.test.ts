import {describe, expect, test} from 'bun:test';
import {createHash} from 'node:crypto';

import type {Facts, IssueRef, PortError, PrSnapshot, Result} from '../src/domain/model.ts';
import {createGitHubPort} from '../src/ports/github.ts';
import {
  CLOSED_AT, HEAD_OID, ISSUE_NUMBER, LINKED, MAIN_OID, PR_NUMBER, REOPENED_AT, REPO, SERVED, UPDATED_AT, VIEWER,
  constraintsOf, issueRoutes, issueScope, prRoutes, prScope, startFakeGh, type FakeGhSource, type LinkedPr,
} from './github-fixture.ts';

// Regression coverage for pagination in src/ports/github.ts: every drilled
// connection must drain to its final page, every continuation must restate the
// parent identity and page size it was bound to, and a continuation that
// contradicts the first page must fail the read instead of completing it.
//
// The fake `gh` on PATH answers the exact GraphQL requests the port issues, so
// these tests fail if a query, page argument or served source shape drifts.

const REPO_KEY = `${REPO.owner}/${REPO.name}`;
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

function factsOf(source: FakeGhSource, read: Result<Facts, PortError>): Facts {
  if (!read.ok) throw new Error(`Facts read failed (${read.error.kind}): ${read.error.message}\n${source.diagnostics()}`);
  return read.value;
}

function continuationCount(queries: string[], marker: string): number {
  return queries.filter(query => query.includes(marker)).length;
}

function linkedExpectation(link: LinkedPr): PrSnapshot {
  return {
    ref: {repo: REPO, number: link.number},
    headRepo: REPO,
    headBranch: link.headBranch,
    head: link.headOid,
    target: {repo: REPO, base: 'main'},
    title: `Linked pull request ${link.number}`,
    body: `Closes #${ISSUE_NUMBER}`,
    bodyHash: sha256(`Closes #${ISSUE_NUMBER}`),
    updatedAt: Date.parse(UPDATED_AT),
    state: {kind: 'open'},
    closes: [{repo: REPO, number: ISSUE_NUMBER}],
    mergeable: 'yes',
    checks: {kind: 'passing', required: []},
  };
}

describe('github port pagination', () => {
  test('reads every sub-issue page and the closing pull requests of an issue', async () => {
    const source = await startFakeGh({routes: issueRoutes()});
    const children: IssueRef[] = SERVED.childNumbers.map(number => ({repo: REPO, number}));
    const expected: Facts = {
      viewer: VIEWER,
      issues: [{
        ref: {repo: REPO, number: ISSUE_NUMBER},
        body: 'epic body',
        bodyHash: sha256('epic body'),
        updatedAt: Date.parse(UPDATED_AT),
        state: 'open',
        lastClose: {id: 'CLOSED_EVENT_1', at: Date.parse(CLOSED_AT)},
        lastReopen: {id: 'REOPENED_EVENT_1', at: Date.parse(REOPENED_AT)},
        children,
      }],
      prs: [linkedExpectation(LINKED[0]), linkedExpectation(LINKED[1])],
      links: [
        {issue: {repo: REPO, number: ISSUE_NUMBER}, pr: {repo: REPO, number: LINKED[0].number}},
        {issue: {repo: REPO, number: ISSUE_NUMBER}, pr: {repo: REPO, number: LINKED[1].number}},
      ],
      repos: [{
        repo: REPO,
        defaultBranch: 'main',
        defaultHead: MAIN_OID,
        bases: [{name: 'main', state: {kind: 'present', head: MAIN_OID, isDefault: true, rules: {required: [], strict: false, constraints: constraintsOf(SERVED.plainRules)}}}],
      }],
      branches: [
        {repo: REPO, name: 'main', state: {kind: 'present', head: MAIN_OID}},
        {repo: REPO, name: 'feat/a', state: {kind: 'present', head: LINKED[0].headOid}},
        {repo: REPO, name: 'feat/b', state: {kind: 'present', head: LINKED[1].headOid}},
      ],
      maintenance: [
        {
          pr: {repo: REPO, number: LINKED[0].number},
          result: {kind: 'foreign', basis: {headRepo: REPO, headBranch: 'feat/a', viewerPermission: 'WRITE', author: 'mouriya', maintainerCanModify: true, authorization: {kind: 'none'}}},
        },
        {
          pr: {repo: REPO, number: LINKED[1].number},
          result: {kind: 'foreign', basis: {headRepo: REPO, headBranch: 'feat/b', viewerPermission: 'WRITE', author: 'mouriya', maintainerCanModify: true, authorization: {kind: 'none'}}},
        },
      ],
      commits: [],
      checkAttempts: [],
      createdIssues: [],
    };
    try {
      const read = await source.run(() => createGitHubPort().facts(issueScope(), 'pagination regression'));
      expect(factsOf(source, read)).toEqual(expected);
      const queries = source.requests().map(request => request.query);
      // One batched first page, one sub-issue continuation restating issue #5,
      // and one batch reading the two linked pull requests.
      expect(queries).toHaveLength(3);
      expect(continuationCount(queries, `issue(number:${ISSUE_NUMBER}) { number repository { nameWithOwner } subIssues(first:10,after:"sub-1")`)).toBe(1);
    } finally {
      source.dispose();
    }
  });

  test('reads every status check page and every branch rules page of a pull request', async () => {
    const source = await startFakeGh({routes: prRoutes('paginated')});
    const expected: Facts = {
      viewer: VIEWER,
      issues: [],
      prs: [{
        ref: {repo: REPO, number: PR_NUMBER},
        headRepo: REPO,
        headBranch: 'feat/pagination',
        head: HEAD_OID,
        target: {repo: REPO, base: 'main'},
        title: 'Drain every page',
        body: 'Serves paginated connections.',
        bodyHash: sha256('Serves paginated connections.'),
        updatedAt: Date.parse(UPDATED_AT),
        state: {kind: 'open'},
        closes: [{repo: REPO, number: ISSUE_NUMBER}],
        mergeable: 'yes',
        // ci/nightly is required by the second rules page and observed only on
        // the second checks page, so a dropped page cannot complete the merge
        // requirements or the checks snapshot.
        checks: {kind: 'failing', required: [{kind: 'status', identity: {name: 'ci/nightly', source: {kind: 'any'}}, context: 'ci/nightly', sha: HEAD_OID}]},
      }],
      links: [{issue: {repo: REPO, number: ISSUE_NUMBER}, pr: {repo: REPO, number: PR_NUMBER}}],
      repos: [{
        repo: REPO,
        defaultBranch: 'main',
        defaultHead: MAIN_OID,
        bases: [{
          name: 'main',
          state: {kind: 'present', head: MAIN_OID, isDefault: true, rules: {required: SERVED.requiredChecks, strict: true, constraints: constraintsOf(...SERVED.rules)}},
        }],
      }],
      branches: [
        {repo: REPO, name: 'main', state: {kind: 'present', head: MAIN_OID}},
        {repo: REPO, name: 'feat/pagination', state: {kind: 'present', head: HEAD_OID}},
      ],
      maintenance: [{
        pr: {repo: REPO, number: PR_NUMBER},
        result: {
          kind: 'maintainable',
          basis: {headRepo: REPO, headBranch: 'feat/pagination', viewerPermission: 'WRITE', author: VIEWER, maintainerCanModify: true, authorization: {kind: 'actorIsAuthor', actor: VIEWER}},
        },
      }],
      commits: [],
      checkAttempts: [],
      createdIssues: [],
    };
    try {
      const read = await source.run(() => createGitHubPort().facts(prScope(), 'pagination regression'));
      expect(factsOf(source, read)).toEqual(expected);
      expect(SERVED.childNumbers).toHaveLength(13);
      expect(SERVED.contextsPages).toBe(12);
      expect(constraintsOf(...SERVED.rules)).toHaveLength(12);
      const queries = source.requests().map(request => request.query);
      // The batched first page, then one continuation per drilled connection:
      // the default branch read from the repository query, the status check
      // rollup, and the three branch reads of the pull request itself.
      expect(queries).toHaveLength(6);
      expect(continuationCount(queries, 'rules(first:10,after:"rules-main-1")')).toBe(4);
      expect(continuationCount(queries, 'contexts(first:10,after:"ctx-1")')).toBe(1);
    } finally {
      source.dispose();
    }
  });

  test('refuses checks pages observed at a different head commit', async () => {
    const source = await startFakeGh({routes: prRoutes('head-drift')});
    try {
      const read = await source.run(() => createGitHubPort().facts(prScope(), 'pagination regression'));
      expect(read).toEqual({ok: false, error: {kind: 'invalidResponse', message: `${REPO_KEY}#${PR_NUMBER} checks: source identity changed during pagination`}});
      expect(continuationCount(source.requests().map(request => request.query), 'contexts(first:10,after:"ctx-1")')).toBe(1);
    } finally {
      source.dispose();
    }
  });

  test('refuses a checks page whose cursor does not advance', async () => {
    const source = await startFakeGh({routes: prRoutes('stuck-cursor')});
    try {
      const read = await source.run(() => createGitHubPort().facts(prScope(), 'pagination regression'));
      expect(read).toEqual({ok: false, error: {kind: 'invalidResponse', message: `${REPO_KEY}#${PR_NUMBER} checks: pagination cursor did not advance`}});
      expect(source.requests()).toHaveLength(3);
    } finally {
      source.dispose();
    }
  });

  test('refuses a promised checks page that carries no cursor', async () => {
    const source = await startFakeGh({routes: prRoutes('null-cursor')});
    try {
      const read = await source.run(() => createGitHubPort().facts(prScope(), 'pagination regression'));
      expect(read).toEqual({ok: false, error: {kind: 'invalidResponse', message: `${REPO_KEY}#${PR_NUMBER} checks: pagination cursor did not advance`}});
      const queries = source.requests().map(request => request.query);
      // The rejected continuation was never requested: the batched first page
      // and the branch rules continuation only.
      expect(queries).toHaveLength(2);
      expect(continuationCount(queries, 'contexts(first:10,after:"ctx-1")')).toBe(0);
    } finally {
      source.dispose();
    }
  });
});
