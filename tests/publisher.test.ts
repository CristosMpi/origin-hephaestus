import { describe, it, expect, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { testProposal } from './fixtures/proposal';
import { getRequest, now, saveProposal, type RuntimeEnv } from '../worker/db';
import { publish } from '../worker/publisher';
import { boundedText } from '../worker/bounded';
import { parseProposal } from '../worker/domain';
const live: RuntimeEnv = {
  ...env,
  APP_MODE: 'live',
  GITHUB_WRITE_TOKEN: 'test-only-never-a-real-key',
};
async function approvedFixture() {
  const feedback = {
    type: 'improvement' as const,
    title: 'Normalize feedback titles',
    description: 'Trim feedback titles before recording them.',
    expected: 'Clean titles',
    application: 'ORIGIN Platform',
  };
  const p = { ...(await testProposal(feedback, 0, '')), mode: 'live' as const };
  const id = `HEP-${crypto.randomUUID().slice(0, 8)}`;
  const timestamp = now();
  await env.DB.prepare(
    'INSERT INTO requests(id,title,application,type,status,author,feedback_json,created_at,updated_at,destination,mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  )
    .bind(
      id,
      feedback.title,
      feedback.application,
      feedback.type,
      'Submitted',
      'human@example.com',
      JSON.stringify(feedback),
      timestamp,
      timestamp,
      `origin/app@main:hephaestus/${id}`,
      'live',
    )
    .run();
  await saveProposal(live, id, 0, p);
  await env.DB.prepare(
    'UPDATE requests SET approved_commit=?,approved_destination=destination,approved_by=?,approved_at=? WHERE id=?',
  )
    .bind(p.commit, 'human@example.com', timestamp, id)
    .run();
  return getRequest(live, id);
}
describe('GitHub publishing adapter', () => {
  it('checks exact tree and commit before creating a branch, and finds the PR on retry', async () => {
    const r = await approvedFixture();
    const writes: string[] = [];
    let branch = false;
    let pr = false;
    let simulateLostResponse = true;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.hostname).toBe('api.github.com');
      const method = init?.method || 'GET';
      const path = url.pathname;
      if (method === 'POST') writes.push(path);
      if (path.endsWith(`/git/commits/${r.proposal!.parent}`))
        return Response.json({ tree: { sha: 'base-tree' } });
      if (path.endsWith('/git/trees')) return Response.json({ sha: r.proposal!.tree });
      if (path.endsWith('/git/commits')) return Response.json({ sha: r.proposal!.commit });
      if (path.includes('/git/matching-refs/'))
        return Response.json(
          branch
            ? [{ ref: `refs/heads/hephaestus/${r.id}`, object: { sha: r.proposal!.commit } }]
            : [],
        );
      if (path.endsWith('/git/refs')) {
        branch = true;
        return Response.json({});
      }
      if (path.endsWith('/pulls') && method === 'GET')
        return Response.json(pr ? [{ html_url: 'https://github.com/origin/app/pull/1' }] : []);
      if (path.endsWith('/pulls') && method === 'POST') {
        pr = true;
        if (simulateLostResponse) {
          simulateLostResponse = false;
          throw new Error('Simulated lost PR response');
        }
        return Response.json({ html_url: 'https://github.com/origin/app/pull/1' });
      }
      throw new Error(`Unexpected outbound request ${method} ${path}`);
    });
    try {
      await expect(publish(live, r.id)).rejects.toThrow('lost PR response');
      expect((await getRequest(live, r.id)).push_claim).toBeNull();
      const result = await publish(live, r.id);
      expect(result.status).toBe('Pushed');
      expect(result.pr_url).toBe('https://github.com/origin/app/pull/1');
      expect(writes.filter((x) => x.endsWith('/git/refs'))).toHaveLength(1);
      expect(writes.filter((x) => x.endsWith('/pulls'))).toHaveLength(1);
      await publish(live, r.id);
      expect(writes.filter((x) => x.endsWith('/pulls'))).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
  it('never creates a branch when the reconstructed commit differs from approval', async () => {
    const r = await approvedFixture();
    const branches: string[] = [];
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(`/git/commits/${r.proposal!.parent}`))
        return Response.json({ tree: { sha: 'base' } });
      if (path.endsWith('/git/trees')) return Response.json({ sha: r.proposal!.tree });
      if (path.endsWith('/git/commits')) return Response.json({ sha: 'f'.repeat(40) });
      if (init?.method === 'POST') branches.push(path);
      throw new Error('Unexpected publication attempt');
    });
    try {
      await expect(publish(live, r.id)).rejects.toThrow('differs from the approved commit');
      expect(branches).toHaveLength(0);
      expect((await getRequest(live, r.id)).pushed_at).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
  it('never overwrites a dedicated branch containing a different commit', async () => {
    const r = await approvedFixture();
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith(`/git/commits/${r.proposal!.parent}`))
        return Response.json({ tree: { sha: 'base' } });
      if (path.endsWith('/git/trees')) return Response.json({ sha: r.proposal!.tree });
      if (path.endsWith('/git/commits')) return Response.json({ sha: r.proposal!.commit });
      if (path.includes('/git/matching-refs/'))
        return Response.json([
          { ref: `refs/heads/hephaestus/${r.id}`, object: { sha: 'f'.repeat(40) } },
        ]);
      throw new Error('Must not create or overwrite a branch');
    });
    try {
      await expect(publish(live, r.id)).rejects.toThrow('different commit');
      expect((await getRequest(live, r.id)).pushed_at).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
describe('untrusted runner responses', () => {
  it('rejects malformed model-generated review content before storage', () => {
    expect(() =>
      parseProposal({ commit: 'a'.repeat(40), plan: [{ injected: 'not text' }] }),
    ).toThrow();
  });
  it('bounds streamed responses before buffering them in memory', async () => {
    await expect(boundedText(new Response('123456'), 5)).rejects.toThrow('size limit');
    expect(await boundedText(new Response('12345'), 5)).toBe('12345');
  });
});
