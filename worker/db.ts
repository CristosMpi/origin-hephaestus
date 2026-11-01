import type { AuditEvent, Proposal, RequestRecord, Settings, Status } from '../src/shared';
import { HttpError } from './domain';
export type RuntimeEnv = Omit<Env, 'APP_MODE'> & {
  APP_MODE: string;
  ADMIN_ACCESS_KEY?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAILS?: string;
  FEEDBACK_API_TOKEN?: string;
  RUNNER_URL?: string;
  RUNNER_TOKEN?: string;
  GITHUB_WRITE_TOKEN?: string;
};
export const now = () => new Date().toISOString();
export function decode(row: Record<string, unknown>): RequestRecord {
  const { feedback_json, proposal_json, ...rest } = row;
  return {
    ...rest,
    feedback: JSON.parse(feedback_json as string),
    proposal: proposal_json ? JSON.parse(proposal_json as string) : null,
  } as RequestRecord;
}
export async function getRequest(env: RuntimeEnv, id: string) {
  const row = await env.DB.prepare('SELECT * FROM requests WHERE id=? AND mode=?')
    .bind(id, env.APP_MODE)
    .first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, 'Request not found.');
  return decode(row);
}
export async function allRequests(env: RuntimeEnv) {
  const x = await env.DB.prepare(
    'SELECT * FROM requests WHERE mode=? ORDER BY created_at DESC LIMIT 500',
  )
    .bind(env.APP_MODE)
    .all<Record<string, unknown>>();
  return x.results.map(decode);
}
export function event(
  env: RuntimeEnv,
  id: string,
  kind: string,
  actor: string,
  message: string,
  data?: unknown,
) {
  return env.DB.prepare(
    'INSERT INTO events(request_id,kind,actor,message,created_at,data_json) VALUES(?,?,?,?,?,?)',
  ).bind(id, kind, actor, message, now(), data ? JSON.stringify(data) : null);
}
export async function events(env: RuntimeEnv, id: string) {
  return (
    await env.DB.prepare('SELECT * FROM events WHERE request_id=? ORDER BY id')
      .bind(id)
      .all<AuditEvent>()
  ).results;
}
export async function settings(env: RuntimeEnv): Promise<Settings> {
  const r = await env.DB.prepare('SELECT json FROM settings WHERE id=1').first<{ json: string }>();
  const reviewers = (
    await env.DB.prepare('SELECT email,role FROM reviewers ORDER BY email').all<
      Settings['reviewers'][number]
    >()
  ).results;
  return {
    ...(r
      ? JSON.parse(r.json)
      : {
          repository: '',
          baseBranch: 'main',
          applications: ['ORIGIN Platform', 'ORIGIN CRM', 'ORIGIN Commerce'],
          provider: 'openai-compatible',
          model: env.MODEL_NAME || 'gpt-4.1',
          maxRevisions: Number(env.MAX_REVISIONS) || 3,
          timeoutSeconds: Number(env.JOB_TIMEOUT_SECONDS) || 600,
          checks: ['git diff --check', 'npm test', 'npm run build'],
        }),
    reviewers,
  };
}
export async function transition(env: RuntimeEnv, id: string, status: Status, message: string) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE requests SET status=?,updated_at=?,version=version+1 WHERE id=? AND approved_at IS NULL AND status NOT IN ('Rejected','Pushed')",
    ).bind(status, now(), id),
    event(env, id, status, 'hephaestus-engine', message),
  ]);
}
export async function saveProposal(env: RuntimeEnv, id: string, revision: number, p: Proposal) {
  const json = JSON.stringify(p);
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT OR IGNORE INTO proposals(request_id,revision,commit_sha,proposal_json,created_at) VALUES(?,?,?,?,?)',
    ).bind(id, revision, p.commit, json, timestamp),
    env.DB.prepare(
      "UPDATE requests SET proposal_json=?,status='Awaiting approval',first_ready_at=COALESCE(first_ready_at,?),validation_first=COALESCE(validation_first,?),updated_at=?,version=version+1 WHERE id=? AND revision=? AND approved_at IS NULL AND status NOT IN ('Rejected','Pushed')",
    ).bind(
      json,
      timestamp,
      p.checks.every((c) => c.exitCode === 0) ? 1 : 0,
      timestamp,
      id,
      revision,
    ),
    event(
      env,
      id,
      'Awaiting approval',
      'hephaestus-engine',
      `Revision ${revision + 1} is ready for human review.`,
      { commit: p.commit, checks: p.checks },
    ),
  ]);
}
