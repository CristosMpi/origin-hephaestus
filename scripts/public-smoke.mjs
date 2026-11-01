import assert from 'node:assert/strict';
import fs from 'node:fs';
const base = process.argv[2] || 'http://127.0.0.1:8787';
const response = await fetch(base + '/api/me');
assert.equal(response.status, 200);
const visitorCookie = response.headers.get('set-cookie')?.split(';')[0];
assert.ok(visitorCookie);
const me = await response.json();
assert.equal(me.mode, 'live');
assert.equal(me.actor.role, 'user');
assert.equal(me.actor.method, 'public');
console.log('PASS public workspace opens without login');
async function call(path, method = 'GET', body, cookie = visitorCookie) {
  const response = await fetch(base + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
assert.equal((await call('/requests')).status, 200);
assert.equal((await call('/demo/session', 'POST', { role: 'admin' })).status, 404);
assert.equal(
  (
    await call('/requests/not-a-request/approve', 'POST', {
      commit: 'a'.repeat(40),
      destination: 'origin/app@main:branch',
      version: 0,
    })
  ).status,
  403,
);
assert.equal((await call('/requests/not-a-request/push', 'POST', {})).status, 403);
assert.equal((await call('/settings', 'PUT', {})).status, 403);
console.log('PASS visitor cannot approve, push or change settings; demo role endpoint removed');
const config = (await call('/settings')).body;
if (!config.integrations.codingReady) {
  const record = await call('/requests', 'POST', {
    type: 'improvement',
    title: '[Verification] Public feedback without an account',
    description:
      'Deployment verification: confirm a visitor can submit and track real feedback without creating an account.',
    expected: 'Feedback is persisted and can be followed in this browser.',
    application: config.settings.applications[0],
  });
  assert.equal(record.status, 201);
  assert.equal(record.body.status, 'Submitted');
  assert.equal(record.body.proposal, null);
  const detail = await call('/requests/' + record.body.id);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.events.some((e) => e.kind === 'Waiting for setup'));
  console.log('PASS real feedback saved with setup status: ' + record.body.id);
}
const keyIndex = process.argv.indexOf('--admin-key-file');
if (keyIndex !== -1) {
  const key = fs.readFileSync(process.argv[keyIndex + 1], 'utf8').trim();
  const opened = await fetch(base + '/api/admin/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  });
  assert.equal(opened.status, 200);
  const adminCookie = opened.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/me', 'GET', undefined, adminCookie)).body.actor.role, 'admin');
  assert.equal((await call('/requests/not-a-request/push', 'POST', {}, adminCookie)).status, 404);
  assert.equal((await call('/admin/session', 'DELETE', undefined, adminCookie)).status, 200);
  assert.equal((await call('/requests/not-a-request/push', 'POST', {}, adminCookie)).status, 403);
  console.log('PASS protected admin access works and logout revokes publishing permission');
}
console.log('Public/admin deployment checks passed. No repository was modified.');
