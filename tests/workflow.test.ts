import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSession } from '../worker/auth';
import { env } from 'cloudflare:workers';
import worker from '../worker/index';
import { getRequest, saveProposal, now, type RuntimeEnv } from '../worker/db';
import { testProposal } from './fixtures/proposal';
import { assertApproval, assertPublish, metrics } from '../worker/domain';
import type { Feedback, RequestRecord } from '../src/shared';
const e: RuntimeEnv = {
  ...env,
  APP_MODE: 'live',
  ADMIN_ACCESS_KEY: 'test-admin-key-not-real',
  GITHUB_WRITE_TOKEN: 'test-github-key-not-real',
};
afterEach(() => vi.restoreAllMocks());
const feedback: Feedback = {
  type: 'bug',
  title: 'Search does not reset on clear',
  description: 'Clearing a search leaves the previous contact list visible.',
  steps: 'Open contacts, search for a name, then clear the query.',
  actual: 'Old results stay visible.',
  expected: 'Restore all contacts.',
  application: 'ORIGIN CRM',
};
async function call(path: string, method = 'GET', body?: unknown, cookie = '', customEnv = e) {
  return worker.fetch(
    new Request(`https://test.local/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }),
    customEnv,
    {} as ExecutionContext,
  );
}
async function login(role: 'user' | 'reviewer' | 'admin' = 'admin') {
  const kind = role === 'user' ? 'visitor' : 'admin';
  const s = await createSession(e, kind);
  return (kind === 'admin' ? 'hephaestus_admin' : 'hephaestus_visitor') + '=' + s.token;
}

async function fixture() {
  const id = `HEP-${crypto.randomUUID().slice(0, 8)}`;
  const t = now();
  await env.DB.prepare(
    'INSERT INTO requests(id,title,application,type,status,author,feedback_json,created_at,updated_at,destination,mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      feedback.title,
      feedback.application,
      feedback.type,
      'Submitted',
      'test-author',
      JSON.stringify(feedback),
      t,
      t,
      `origin/demo@main:hephaestus/${id}`,
      'live',
    )
    .run();
  await saveProposal(e, id, 0, await testProposal(feedback, 0, ''));
  return getRequest(e, id);
}
describe('backend approval and publication', () => {
  it('opens a private visitor workspace without requiring login', async () => {
    expect((await call('/requests')).status).toBe(200);
  });
  it('rejects invalid bugs without reproduction details', async () => {
    const cookie = await login();
    expect((await call('/requests', 'POST', { ...feedback, steps: '' }, cookie)).status).toBe(400);
  });
  it('denies approval and publishing to contributors', async () => {
    const r = await fixture();
    const cookie = await login('user');
    expect(
      (
        await call(
          `/requests/${r.id}/approve`,
          'POST',
          { commit: r.proposal!.commit, destination: r.destination, version: r.version },
          cookie,
        )
      ).status,
    ).toBe(403);
    expect((await call(`/requests/${r.id}/push`, 'POST', {}, cookie)).status).toBe(403);
  });
  it('prevents unapproved publication even by administrators', async () => {
    const r = await fixture();
    expect((await call(`/requests/${r.id}/push`, 'POST', {}, await login())).status).toBe(409);
    expect((await getRequest(e, r.id)).pushed_at).toBeNull();
  });
  it('refuses a stale commit, destination, and version', async () => {
    const r = await fixture();
    const cookie = await login();
    for (const body of [
      { commit: 'a'.repeat(40), destination: r.destination, version: r.version },
      { commit: r.proposal!.commit, destination: 'evil/repo@main:branch', version: r.version },
      { commit: r.proposal!.commit, destination: r.destination, version: r.version - 1 },
    ])
      expect((await call(`/requests/${r.id}/approve`, 'POST', body, cookie)).status).toBe(409);
  });
  it('records approval and publishes once; publication retries are idempotent', async () => {
    const r = await fixture();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/git/commits/' + r.proposal!.parent))
        return Response.json({ tree: { sha: 'base' } });
      if (path.endsWith('/git/trees')) return Response.json({ sha: r.proposal!.tree });
      if (path.endsWith('/git/commits')) return Response.json({ sha: r.proposal!.commit });
      if (path.includes('/git/matching-refs/')) return Response.json([]);
      if (path.endsWith('/git/refs')) return Response.json({});
      if (path.endsWith('/pulls'))
        return Response.json(
          init?.method === 'POST' ? { html_url: 'https://github.com/origin/demo/pull/1' } : [],
        );
      throw new Error('Unexpected GitHub request');
    });
    const cookie = await login();
    const response = await call(
      `/requests/${r.id}/approve`,
      'POST',
      { commit: r.proposal!.commit, destination: r.destination, version: r.version },
      cookie,
    );
    expect(response.status).toBe(200);
    const published = (await response.json()) as RequestRecord;
    expect(published.status).toBe('Pushed');
    expect(published.approved_commit).toBe(r.proposal!.commit);
    expect(published.approved_destination).toBe(r.destination);
    expect(published.approved_by).toMatch(/^administrator:/);
    expect(published.pr_url).toBe('https://github.com/origin/demo/pull/1');
    const again = await call(`/requests/${r.id}/push`, 'POST', {}, cookie);
    expect(((await again.json()) as RequestRecord).pushed_at).toBe(published.pushed_at);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM events WHERE request_id=? AND kind='Pushed'",
    )
      .bind(r.id)
      .first<{ n: number }>();
    expect(count!.n).toBe(1);
    await call(`/requests/${r.id}/review-start`, 'POST', {}, cookie);
    expect((await getRequest(e, r.id)).review_started_at).toBeNull();
  });
  it('invalidates approval at the database layer when a proposal changes', async () => {
    const r = await fixture();
    await env.DB.prepare(
      'UPDATE requests SET approved_commit=?,approved_destination=?,approved_by=?,approved_at=? WHERE id=?',
    )
      .bind(r.proposal!.commit, r.destination, 'reviewer@origin.local', now(), r.id)
      .run();
    const next = await testProposal(feedback, 1, 'Please refine the implementation.');
    await env.DB.prepare('UPDATE requests SET proposal_json=?,version=version+1 WHERE id=?')
      .bind(JSON.stringify(next), r.id)
      .run();
    const updated = await getRequest(e, r.id);
    expect(updated.approved_commit).toBeNull();
    expect(updated.approved_by).toBeNull();
    expect(() => assertPublish(updated)).toThrow('recorded approval');
    expect((await call(`/requests/${r.id}/push`, 'POST', {}, await login())).status).toBe(409);
  });
  it('invalidates approval when the repository destination changes', async () => {
    const r = await fixture();
    await env.DB.prepare(
      'UPDATE requests SET approved_commit=?,approved_destination=?,approved_by=?,approved_at=? WHERE id=?',
    )
      .bind(r.proposal!.commit, r.destination, 'human', now(), r.id)
      .run();
    await env.DB.prepare('UPDATE requests SET destination=? WHERE id=?')
      .bind('other/repo@main:other', r.id)
      .run();
    expect((await getRequest(e, r.id)).approved_by).toBeNull();
  });
  it('locks approved proposal contents while publication is in progress', async () => {
    const r = await fixture();
    await env.DB.prepare('UPDATE requests SET push_claim=? WHERE id=?')
      .bind('in-progress', r.id)
      .run();
    await expect(
      env.DB.prepare('UPDATE requests SET destination=? WHERE id=?')
        .bind('other/repo@main:other', r.id)
        .run(),
    ).rejects.toThrow('locked');
  });
  it('blocks approval with validation failures', async () => {
    const r = await fixture();
    r.proposal!.checks[0].exitCode = 1;
    await env.DB.prepare('UPDATE requests SET proposal_json=? WHERE id=?')
      .bind(JSON.stringify(r.proposal), r.id)
      .run();
    expect(
      (
        await call(
          `/requests/${r.id}/approve`,
          'POST',
          { commit: r.proposal!.commit, destination: r.destination, version: r.version },
          await login(),
        )
      ).status,
    ).toBe(409);
  });
  it('does not allow API credentials or AI actors to approve', () => {
    const r = {} as RequestRecord;
    expect(() =>
      assertApproval(r, { email: 'engine', role: 'admin', method: 'api' }, '', ''),
    ).toThrow('Administrator access');
  });
  it('isolates contributor access to their own feedback', async () => {
    const r = await fixture();
    expect((await call(`/requests/${r.id}`, 'GET', undefined, await login('user'))).status).toBe(
      403,
    );
  });
  it('persists comments and preserves append-only audit history', async () => {
    const r = await fixture();
    const cookie = await login('reviewer');
    expect(
      (
        await call(
          `/requests/${r.id}/comment`,
          'POST',
          { comment: 'Reviewed the reproduction steps.' },
          cookie,
        )
      ).status,
    ).toBe(200);
    const event = await env.DB.prepare(
      "SELECT id FROM events WHERE request_id=? AND kind='Comment'",
    )
      .bind(r.id)
      .first<{ id: number }>();
    await expect(
      env.DB.prepare('DELETE FROM events WHERE id=?').bind(event!.id).run(),
    ).rejects.toThrow('append-only');
  });
  it('rejects cross-origin approval attempts', async () => {
    const response = await worker.fetch(
      new Request('https://test.local/api/demo/session', {
        method: 'POST',
        headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' },
        body: '{}',
      }),
      e,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
  });
  it('disables demo login in live mode', async () => {
    expect(
      (await call('/demo/session', 'POST', { role: 'admin' }, '', { ...e, APP_MODE: 'live' }))
        .status,
    ).toBe(404);
  });
});
describe('metrics', () => {
  it('shows empty measurements until outcomes exist', () => {
    const ms = metrics([]);
    expect(ms.find((x) => x.key === 'development')!.value).toBeNull();
    expect(ms.find((x) => x.key === 'coverage')!.samples).toBe(0);
    expect(ms.find((x) => x.key === 'completed')!.value).toBe(0);
  });
  it('separates development, review and approval-to-push timing', async () => {
    const r = await fixture();
    const base = Date.parse('2026-10-28T10:00:00Z');
    const at = (seconds: number) => new Date(base + seconds * 1000).toISOString();
    const ms = metrics([
      {
        ...r,
        created_at: at(0),
        first_ready_at: at(60),
        review_started_at: at(120),
        approved_at: at(180),
        pushed_at: at(190),
        approved_by: 'human',
        approved_commit: r.proposal!.commit,
        approved_destination: r.destination,
      },
    ]);
    expect(ms.find((x) => x.key === 'development')!.value).toBe(60000);
    expect(ms.find((x) => x.key === 'review')!.value).toBe(60000);
    expect(ms.find((x) => x.key === 'push')!.value).toBe(10000);
    expect(ms.find((x) => x.key === 'coverage')!.value).toBe(100);
  });
});
