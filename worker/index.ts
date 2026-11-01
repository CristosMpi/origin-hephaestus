import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { authenticate, createSession, cookie, hash, secretEquals } from './auth';
import { allRequests, event, events, getRequest, now, settings, type RuntimeEnv } from './db';
import { assertApproval, assertReviewer, HttpError, metrics } from './domain';
import { publish } from './publisher';
import type { Actor, Feedback, Settings } from '../src/shared';
export { CodingWorkflow } from './workflow';
const app = new Hono<{ Bindings: RuntimeEnv; Variables: { actor: Actor } }>();
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'same-origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    if (origin && origin !== new URL(c.req.url).origin)
      throw new HttpError(403, 'Cross-origin mutations are not allowed.');
  }
  await next();
});
app.use(
  '/api/*',
  bodyLimit({
    maxSize: 128 * 1024,
    onError: (c) => c.json({ error: 'Request exceeds 128 KB.' }, 413),
  }),
);
app.get('/api/health', (c) => c.json({ ok: true, mode: c.env.APP_MODE }));
app.post('/api/demo/session', () => {
  throw new HttpError(404, 'Endpoint not found.');
});
app.post('/api/admin/session', async (c) => {
  const ip = await hash(c.req.header('CF-Connecting-IP') || 'local');
  const key = `admin-access:${ip}:${Math.floor(Date.now() / 900000)}`;
  const attempts = await c.env.DB.prepare(
    'INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
  )
    .bind(key, Date.now() + 900000)
    .first<{ count: number }>();
  if ((attempts?.count ?? 0) > 10)
    throw new HttpError(429, 'Too many admin access attempts. Try again in fifteen minutes.');
  const body = z.object({ key: z.string().min(1).max(256) }).parse(await c.req.json());
  if (!c.env.ADMIN_ACCESS_KEY)
    throw new HttpError(503, 'Administrator access has not been configured.');
  if (!(await secretEquals(body.key, c.env.ADMIN_ACCESS_KEY)))
    throw new HttpError(401, 'Invalid administrator access key.');
  const s = await createSession(c.env, 'admin');
  c.header(
    'Set-Cookie',
    cookie('hephaestus_admin', s.token, s.maxAge, new URL(c.req.url).protocol === 'https:'),
  );
  await c.env.DB.prepare(
    'INSERT INTO workspace_audit(actor,action,created_at,details_json) VALUES(?,?,?,?)',
  )
    .bind(s.actor.email, 'Admin access opened', now(), '{}')
    .run();
  return c.json({ ok: true });
});
app.use('/api/*', async (c, next) => {
  let actor = await authenticate(c.req.raw, c.env);
  if (!actor) {
    const s = await createSession(c.env, 'visitor');
    actor = s.actor;
    c.header(
      'Set-Cookie',
      cookie('hephaestus_visitor', s.token, s.maxAge, new URL(c.req.url).protocol === 'https:'),
    );
  }
  if (actor.method === 'api' && !(c.req.path === '/api/requests' && c.req.method === 'POST'))
    throw new HttpError(403, 'The feedback API token can only submit requests.');
  c.set('actor', actor);
  await next();
});
app.get('/api/me', (c) => c.json({ actor: c.get('actor'), mode: c.env.APP_MODE }));
app.delete('/api/admin/session', async (c) => {
  c.header(
    'Set-Cookie',
    cookie('hephaestus_admin', '', 0, new URL(c.req.url).protocol === 'https:'),
  );
  const token = c.req.header('cookie')?.match(/(?:^|;\s*)hephaestus_admin=([^;]+)/)?.[1];
  if (token)
    await c.env.DB.prepare("DELETE FROM sessions WHERE token_hash=? AND kind='admin'")
      .bind(await hash(token))
      .run();
  return c.json({ ok: true });
});
app.get('/api/requests', async (c) => {
  const actor = c.get('actor');
  const rows = await allRequests(c.env);
  return c.json(
    rows
      .filter((r) => actor.role !== 'user' || r.author === actor.email)
      .map(({ proposal, ...r }) => ({
        ...r,
        proposal: proposal ? { commit: proposal.commit, checks: proposal.checks } : null,
      })),
  );
});
const feedbackSchema = z
  .object({
    type: z.enum(['bug', 'feature', 'improvement']),
    title: z.string().trim().min(5).max(160),
    description: z.string().trim().min(10).max(16000),
    expected: z.string().trim().min(3).max(8000),
    actual: z.string().max(8000).optional(),
    steps: z.string().max(8000).optional(),
    application: z.string().trim().min(1).max(100),
    pageUrl: z.union([z.url().max(2000), z.literal('')]).optional(),
    version: z.string().max(80).optional(),
  })
  .superRefine((x, ctx) => {
    if (x.type === 'bug' && (!x.actual?.trim() || !x.steps?.trim()))
      ctx.addIssue({
        code: 'custom',
        message: 'Bugs require actual behavior and reproduction steps.',
      });
  });
app.post('/api/requests', async (c) => {
  const feedback = feedbackSchema.parse(await c.req.json()) as Feedback;
  const actor = c.get('actor');
  const identity =
    actor.method === 'public'
      ? await hash(c.req.header('CF-Connecting-IP') || actor.email)
      : actor.email;
  const key = `feedback:${identity}:${Math.floor(Date.now() / 600000)}`;
  const limit = await c.env.DB.prepare(
    'INSERT INTO rate_limits(key,count,reset_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count',
  )
    .bind(key, Date.now() + 600000)
    .first<{ count: number }>();
  if ((limit?.count ?? 0) > 20)
    throw new HttpError(429, 'Feedback limit reached. Try again in ten minutes.');
  const config = await settings(c.env);
  if (!config.applications.includes(feedback.application))
    throw new HttpError(400, 'Choose a configured ORIGIN application.');
  const id = `HEP-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const timestamp = now();
  const destination = config.repository
    ? `${config.repository}@${config.baseBranch}:hephaestus/${id.toLowerCase()}`
    : '';
  await c.env.DB.batch([
    c.env.DB.prepare(
      'INSERT INTO requests(id,title,application,type,status,author,feedback_json,created_at,updated_at,destination,mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).bind(
      id,
      feedback.title,
      feedback.application,
      feedback.type,
      'Submitted',
      actor.email,
      JSON.stringify(feedback),
      timestamp,
      timestamp,
      destination,
      c.env.APP_MODE,
    ),
    event(c.env, id, 'Submitted', actor.email, 'Feedback received and saved.'),
  ]);
  if (await codingReady(c.env)) await startJob(c.env, id, 0);
  else
    await event(
      c.env,
      id,
      'Waiting for setup',
      'scheduler',
      'Feedback is saved. An administrator must connect the repository and coding runner before implementation can begin.',
    ).run();
  return c.json(await getRequest(c.env, id), 201);
});
async function startJob(env: RuntimeEnv, id: string, revision: number, comment?: string) {
  try {
    const timestamp = now();
    const claim = await env.DB.prepare(
      "INSERT OR IGNORE INTO events(request_id,kind,actor,message,created_at,data_json) VALUES(?,'Job queued','scheduler',?,?,NULL)",
    )
      .bind(id, `Revision ${revision} queued.`, timestamp)
      .run();
    if (!claim.meta.changes) return;
    await env.CODING.create({ id: `${id}-r${revision}`, params: { id, revision, comment } });
  } catch (e) {
    await env.DB.batch([
      env.DB.prepare("UPDATE requests SET status='Failed',updated_at=? WHERE id=?").bind(now(), id),
      event(
        env,
        id,
        'Failed',
        'scheduler',
        `Could not enqueue coding job: ${e instanceof Error ? e.message : 'Unknown error'}`,
      ),
    ]);
  }
}
async function codingReady(env: RuntimeEnv) {
  return !!(
    (await settings(env)).repository &&
    env.RUNNER_URL?.startsWith('https://') &&
    env.RUNNER_TOKEN
  );
}
async function queueWaiting(env: RuntimeEnv) {
  if (!(await codingReady(env))) return;
  const config = await settings(env);
  const queued = await env.DB.prepare(
    "SELECT id,revision,destination FROM requests r WHERE mode='live' AND status='Submitted' AND NOT EXISTS (SELECT 1 FROM events e WHERE e.request_id=r.id AND e.kind='Job queued' AND e.message='Revision '||r.revision||' queued.') LIMIT 20",
  ).all<{ id: string; revision: number; destination: string }>();
  for (const r of queued.results) {
    if (!r.destination)
      await env.DB.prepare(
        "UPDATE requests SET destination=?,updated_at=?,version=version+1 WHERE id=? AND destination='' AND proposal_json IS NULL",
      )
        .bind(
          `${config.repository}@${config.baseBranch}:hephaestus/${r.id.toLowerCase()}`,
          now(),
          r.id,
        )
        .run();
    await startJob(env, r.id, r.revision);
  }
}
async function authorizedRequest(env: RuntimeEnv, id: string, actor: Actor) {
  const r = await getRequest(env, id);
  if (actor.role === 'user' && r.author !== actor.email)
    throw new HttpError(403, 'You can only view your own requests.');
  return r;
}
app.get('/api/requests/:id', async (c) => {
  const r = await authorizedRequest(c.env, c.req.param('id'), c.get('actor'));
  const history = (
    await c.env.DB.prepare(
      'SELECT revision,commit_sha,created_at FROM proposals WHERE request_id=? ORDER BY revision DESC',
    )
      .bind(r.id)
      .all()
  ).results;
  return c.json({ request: r, events: await events(c.env, r.id), history });
});
app.get('/api/requests/:id/proposals/:revision', async (c) => {
  await authorizedRequest(c.env, c.req.param('id'), c.get('actor'));
  const row = await c.env.DB.prepare(
    'SELECT proposal_json FROM proposals WHERE request_id=? AND revision=?',
  )
    .bind(c.req.param('id'), Number(c.req.param('revision')))
    .first<{ proposal_json: string }>();
  if (!row) throw new HttpError(404, 'Revision not found.');
  return c.json(JSON.parse(row.proposal_json));
});
app.post('/api/requests/:id/review-start', async (c) => {
  assertReviewer(c.get('actor'));
  const r = await getRequest(c.env, c.req.param('id'));
  if (r.proposal && r.status === 'Awaiting approval' && !r.approved_at)
    await c.env.DB.prepare(
      "UPDATE requests SET review_started_at=COALESCE(review_started_at,?) WHERE id=? AND status='Awaiting approval' AND approved_at IS NULL",
    )
      .bind(now(), r.id)
      .run();
  return c.json({ ok: true });
});
app.post('/api/requests/:id/comment', async (c) => {
  assertReviewer(c.get('actor'));
  const body = z.object({ comment: z.string().trim().min(1).max(8000) }).parse(await c.req.json());
  await getRequest(c.env, c.req.param('id'));
  await event(c.env, c.req.param('id'), 'Comment', c.get('actor').email, body.comment).run();
  return c.json({ ok: true });
});
app.post('/api/requests/:id/revise', async (c) => {
  const actor = c.get('actor');
  assertReviewer(actor);
  const body = z
    .object({ comment: z.string().trim().min(5).max(8000), commit: z.string() })
    .parse(await c.req.json());
  const r = await getRequest(c.env, c.req.param('id'));
  const config = await settings(c.env);
  if (r.status !== 'Awaiting approval' || r.push_claim || r.approved_at)
    throw new HttpError(409, 'This proposal cannot be revised while approved or publishing.');
  if (r.proposal?.commit !== body.commit)
    throw new HttpError(409, 'Proposal changed. Refresh before requesting revisions.');
  if (r.revision >= config.maxRevisions)
    throw new HttpError(
      409,
      'Revision limit reached. Reject this request or adjust the configured limit.',
    );
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE requests SET revision=revision+1,status='Changes requested',proposal_json=NULL,first_review_accepted=COALESCE(first_review_accepted,0),updated_at=?,version=version+1 WHERE id=? AND version=? AND approved_at IS NULL AND push_claim IS NULL",
    ).bind(now(), r.id, r.version),
    event(c.env, r.id, 'Changes requested', actor.email, body.comment),
  ]);
  if (!result[0].meta.changes) throw new HttpError(409, 'Request changed. Refresh and retry.');
  await startJob(c.env, r.id, r.revision + 1, body.comment);
  return c.json({ ok: true });
});
app.post('/api/requests/:id/reject', async (c) => {
  const actor = c.get('actor');
  assertReviewer(actor);
  const body = z
    .object({ comment: z.string().trim().min(5).max(8000), commit: z.string() })
    .parse(await c.req.json());
  const r = await getRequest(c.env, c.req.param('id'));
  if (
    r.status !== 'Awaiting approval' ||
    r.push_claim ||
    r.approved_at ||
    r.proposal?.commit !== body.commit
  )
    throw new HttpError(409, 'Proposal changed, is approved, or is not awaiting review.');
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE requests SET status='Rejected',first_review_accepted=COALESCE(first_review_accepted,0),updated_at=?,version=version+1 WHERE id=? AND version=? AND approved_at IS NULL AND push_claim IS NULL",
    ).bind(now(), r.id, r.version),
    event(c.env, r.id, 'Rejected', actor.email, body.comment),
  ]);
  if (!result[0].meta.changes) throw new HttpError(409, 'Request changed.');
  return c.json({ ok: true });
});
app.post('/api/requests/:id/approve', async (c) => {
  const actor = c.get('actor');
  assertReviewer(actor);
  const body = z
    .object({ commit: z.string(), destination: z.string(), version: z.number().int() })
    .parse(await c.req.json());
  const r = await getRequest(c.env, c.req.param('id'));
  assertApproval(r, actor, body.commit, body.destination);
  if (r.mode === 'live' && !c.env.GITHUB_WRITE_TOKEN)
    throw new HttpError(
      503,
      'Configure the server-side GitHub publishing credential before approving.',
    );
  const result = await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE requests SET approved_commit=?,approved_destination=?,approved_by=?,approved_at=?,first_review_accepted=COALESCE(first_review_accepted,1),updated_at=?,version=version+1 WHERE id=? AND version=? AND status='Awaiting approval' AND approved_at IS NULL AND push_claim IS NULL",
    ).bind(body.commit, body.destination, actor.email, now(), now(), r.id, body.version),
    event(
      c.env,
      r.id,
      'Approval attempted',
      actor.email,
      'Human approval submitted for the reviewed commit and repository destination.',
      { commit: body.commit, destination: body.destination },
    ),
  ]);
  if (!result[0].meta.changes)
    throw new HttpError(
      409,
      'The proposal was modified or already approved. Refresh before continuing.',
    );
  await event(
    c.env,
    r.id,
    'Approved',
    actor.email,
    'Human approval recorded. Publishing is now permitted.',
    { commit: body.commit, destination: body.destination },
  ).run();
  return c.json(await publish(c.env, r.id));
});
app.post('/api/requests/:id/push', async (c) => {
  assertReviewer(c.get('actor'));
  return c.json(await publish(c.env, c.req.param('id')));
});
app.post('/api/requests/:id/retry', async (c) => {
  assertReviewer(c.get('actor'));
  const r = await getRequest(c.env, c.req.param('id'));
  if (r.status !== 'Failed' || r.approved_at)
    throw new HttpError(409, 'Only failed coding jobs can be retried.');
  const config = await settings(c.env);
  if (r.revision >= config.maxRevisions)
    throw new HttpError(409, 'Revision attempt limit reached.');
  await c.env.DB.batch([
    c.env.DB.prepare(
      "UPDATE requests SET revision=revision+1,status='Submitted',updated_at=? WHERE id=? AND status='Failed'",
    ).bind(now(), r.id),
    event(c.env, r.id, 'Retry', c.get('actor').email, 'Coding retry requested.'),
  ]);
  await startJob(c.env, r.id, r.revision + 1);
  return c.json({ ok: true });
});
app.get('/api/metrics', async (c) => {
  const actor = c.get('actor');
  const rows = (await allRequests(c.env)).filter(
    (r) => actor.role !== 'user' || r.author === actor.email,
  );
  return c.json({ mode: c.env.APP_MODE, metrics: metrics(rows), samples: rows.length });
});
app.get('/api/activity', async (c) => {
  const actor = c.get('actor');
  return c.json(
    (
      await c.env.DB.prepare(
        "SELECT e.*,r.title FROM events e JOIN requests r ON e.request_id=r.id WHERE r.mode=? AND (?!='user' OR r.author=?) ORDER BY e.id DESC LIMIT 20",
      )
        .bind(c.env.APP_MODE, actor.role, actor.email)
        .all()
    ).results,
  );
});
app.get('/api/settings', async (c) =>
  c.json({
    settings: {
      ...(await settings(c.env)),
      reviewers: c.get('actor').role === 'admin' ? (await settings(c.env)).reviewers : [],
    },
    integrations: {
      repository: !!(await settings(c.env)).repository,
      runner: !!(c.env.RUNNER_URL && c.env.RUNNER_TOKEN),
      publisher: !!c.env.GITHUB_WRITE_TOKEN,
      authentication: 'public',
      administrator: !!c.env.ADMIN_ACCESS_KEY,
      codingReady: await codingReady(c.env),
      mode: c.env.APP_MODE,
    },
  }),
);
app.put('/api/settings', async (c) => {
  const actor = c.get('actor');
  if (actor.role !== 'admin') throw new HttpError(403, 'Administrator permission is required.');
  const body = z
    .object({
      repository: z.string().regex(/^$|^[\w.-]+\/[\w.-]+$/),
      baseBranch: z
        .string()
        .regex(/^[\w./-]+$/)
        .refine((x) => !x.includes('..') && !x.startsWith('-')),
      applications: z.array(z.string().trim().min(1).max(100)).min(1).max(20),
      provider: z.literal('openai-compatible'),
      model: z.string().trim().min(1).max(100),
      maxRevisions: z.number().int().min(0).max(5),
      timeoutSeconds: z.number().int().min(30).max(600),
      checks: z.array(z.string().trim().min(1).max(300)).min(1).max(10),
      reviewers: z
        .array(z.object({ email: z.email(), role: z.enum(['reviewer', 'admin']) }))
        .max(50),
    })
    .parse(await c.req.json()) as Settings;
  const statements = [
    c.env.DB.prepare(
      'INSERT INTO settings VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json',
    ).bind(JSON.stringify({ ...body, reviewers: [] })),
    c.env.DB.prepare('DELETE FROM reviewers'),
    ...body.reviewers.map((r) =>
      c.env.DB.prepare('INSERT INTO reviewers VALUES(?,?)').bind(r.email.toLowerCase(), r.role),
    ),
    c.env.DB.prepare(
      'INSERT INTO workspace_audit(actor,action,created_at,details_json) VALUES(?,?,?,?)',
    ).bind(actor.email, 'Settings updated', now(), JSON.stringify(body)),
  ];
  await c.env.DB.batch(statements);
  c.executionCtx.waitUntil(queueWaiting(c.env));
  return c.json({ ok: true });
});
app.onError((e, c) => {
  if (e instanceof z.ZodError)
    return c.json(
      { error: e.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') },
      400,
    );
  if (e instanceof HttpError)
    return new Response(JSON.stringify({ error: e.message }), {
      status: e.status,
      headers: { 'Content-Type': 'application/json' },
    });
  console.error(JSON.stringify({ event: 'api_error', path: c.req.path, error: e.message }));
  return c.json(
    { error: 'Operation failed. Check the request activity log and server configuration.' },
    500,
  );
});
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: RuntimeEnv, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const stale = new Date(Date.now() - 15 * 60000).toISOString();
        const stuck = await env.DB.prepare(
          "SELECT id FROM requests r WHERE mode='live' AND (status IN ('Analyzing','Implementing','Validating','Changes requested') OR (status='Submitted' AND EXISTS (SELECT 1 FROM events e WHERE e.request_id=r.id AND e.kind='Job queued'))) AND updated_at<? AND approved_at IS NULL",
        )
          .bind(stale)
          .all<{ id: string }>();
        for (const r of stuck.results)
          await env.DB.batch([
            env.DB.prepare(
              "UPDATE requests SET status='Failed',updated_at=? WHERE id=? AND approved_at IS NULL",
            ).bind(now(), r.id),
            event(
              env,
              r.id,
              'Failed',
              'watchdog',
              'Job exceeded its execution window. A reviewer can retry it.',
            ),
          ]);
        await env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()).run();
        await env.DB.prepare('DELETE FROM rate_limits WHERE reset_at<?').bind(Date.now()).run();
        await queueWaiting(env);
      })(),
    );
  },
} satisfies ExportedHandler<RuntimeEnv>;
