import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:workers';
import worker from '../worker/index';
import { hash } from '../worker/auth';
import type { RuntimeEnv } from '../worker/db';
import { assertReviewer } from '../worker/domain';
const bindings: RuntimeEnv = { ...env, APP_MODE: 'live', ADMIN_ACCESS_KEY: 'test-admin-key-only' };
const context = {
  waitUntil(promise: Promise<unknown>) {
    void promise.catch(() => {});
  },
} as ExecutionContext;
async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  cookie = '',
  extra: Partial<RuntimeEnv> = {},
) {
  return worker.fetch(
    new Request('https://test.local/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    { ...bindings, ...extra },
    context,
  );
}
async function visitor() {
  const response = await request('/me');
  return { response, cookie: response.headers.get('set-cookie')!.split(';')[0] };
}
describe('public feedback and admin-only controls', () => {
  it('restricts review and publishing to administrators, not reviewer labels or anonymous role claims', () => {
    expect(() => assertReviewer({ email: 'visitor', role: 'admin', method: 'public' })).toThrow(
      'Administrator access',
    );
    expect(() => assertReviewer({ email: 'reviewer', role: 'reviewer', method: 'access' })).toThrow(
      'Administrator access',
    );
  });
  it('creates an anonymous contributor automatically, with no login or role selection', async () => {
    const v = await visitor();
    const me = (await v.response.json()) as {
      actor: { role: string; method: string };
      mode: string;
    };
    expect(me.mode).toBe('live');
    expect(me.actor).toMatchObject({ role: 'user', method: 'public' });
    expect(v.cookie).toContain('hephaestus_visitor=');
    expect(v.response.headers.get('set-cookie')).toContain('HttpOnly');
  });
  it('saves real feedback without login and waits honestly when coding integrations are absent', async () => {
    const v = await visitor();
    const response = await request(
      '/requests',
      'POST',
      {
        type: 'feature',
        title: 'Add export to contacts',
        description: 'Allow users to download the contacts list as a CSV file.',
        expected: 'A CSV download is available.',
        application: 'ORIGIN CRM',
        role: 'admin',
      },
      v.cookie,
    );
    expect(response.status).toBe(201);
    const record = (await response.json()) as {
      id: string;
      mode: string;
      status: string;
      proposal: unknown;
      destination: string;
    };
    expect(record).toMatchObject({
      mode: 'live',
      status: 'Submitted',
      proposal: null,
      destination: '',
    });
    const detail = await request(`/requests/${record.id}`, 'GET', undefined, v.cookie);
    expect(detail.status).toBe(200);
    const data = (await detail.json()) as { events: { kind: string }[] };
    expect(data.events.some((e) => e.kind === 'Waiting for setup')).toBe(true);
    expect(data.events.some((e) => e.kind === 'Job queued')).toBe(false);
    const other = await visitor();
    expect((await request(`/requests/${record.id}`, 'GET', undefined, other.cookie)).status).toBe(
      403,
    );
  });
  it('blocks public approvals, pushes, settings mutations and fabricated role headers', async () => {
    const cookie = (await visitor()).cookie;
    expect(
      (
        await request(
          '/requests/missing/approve',
          'POST',
          { commit: 'a'.repeat(40), destination: 'origin/app@main:branch', version: 0 },
          cookie,
        )
      ).status,
    ).toBe(403);
    expect((await request('/requests/missing/push', 'POST', {}, cookie)).status).toBe(403);
    expect((await request('/settings', 'PUT', {}, cookie)).status).toBe(403);
    const spoof = new Request('https://test.local/api/me', {
      headers: { cookie, 'X-Role': 'admin', 'X-User-Role': 'admin' },
    });
    const response = await worker.fetch(spoof, bindings, context);
    expect(((await response.json()) as { actor: { role: string } }).actor.role).toBe('user');
  });
  it('rejects invalid admin keys and opens protected admin controls with a valid key', async () => {
    expect((await request('/admin/session', 'POST', { key: 'incorrect' })).status).toBe(401);
    const response = await request('/admin/session', 'POST', {
      key: bindings.ADMIN_ACCESS_KEY,
      role: 'user',
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const me = await request('/me', 'GET', undefined, cookie);
    expect(((await me.json()) as { actor: { role: string; method: string } }).actor).toMatchObject({
      role: 'admin',
      method: 'admin',
    });
    expect((await request('/requests/missing/push', 'POST', {}, cookie)).status).toBe(404);
    expect((await request('/admin/session', 'DELETE', undefined, cookie)).status).toBe(200);
    expect((await request('/me', 'GET', undefined, cookie)).status).toBe(200);
    const after = await request('/me', 'GET', undefined, cookie);
    expect(((await after.json()) as { actor: { role: string } }).actor.role).toBe('user');
  });
  it('invalidates admin sessions when the access key is rotated', async () => {
    const response = await request('/admin/session', 'POST', { key: bindings.ADMIN_ACCESS_KEY });
    const cookie = response.headers.get('set-cookie')!.split(';')[0];
    const me = await request('/me', 'GET', undefined, cookie, {
      ADMIN_ACCESS_KEY: 'rotated-test-key',
    });
    expect(((await me.json()) as { actor: { role: string } }).actor.role).toBe('user');
  });
  it('does not honor previously issued demo administrator cookies or allow demo login', async () => {
    const token = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO sessions(token_hash,actor,role,expires_at) VALUES(?,?,'admin',?)",
    )
      .bind(await hash(token), 'legacy-admin', new Date(Date.now() + 86400000).toISOString())
      .run();
    const me = await request('/me', 'GET', undefined, `hephaestus_session=${token}`);
    expect(((await me.json()) as { actor: { role: string } }).actor.role).toBe('user');
    expect((await request('/demo/session', 'POST', { role: 'admin' })).status).toBe(404);
  });
});
