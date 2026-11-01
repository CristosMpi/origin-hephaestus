import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Actor } from '../src/shared';
import type { RuntimeEnv } from './db';
import { HttpError } from './domain';
import { timingSafeEqual } from 'node:crypto';
export async function hash(value: string) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function secretEquals(a: string, b: string) {
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  return timingSafeEqual(new TextEncoder().encode(x), new TextEncoder().encode(y));
}
export function cookie(name: string, token: string, maxAge: number, secure: boolean) {
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
export async function createSession(env: RuntimeEnv, kind: 'visitor' | 'admin') {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const role = kind === 'admin' ? 'admin' : 'user';
  const actor = `${kind === 'admin' ? 'administrator' : 'visitor'}:${crypto.randomUUID()}`;
  const maxAge = kind === 'admin' ? 28800 : 15552000;
  await env.DB.prepare(
    'INSERT INTO sessions(token_hash,actor,role,expires_at,kind,credential_hash) VALUES(?,?,?,?,?,?)',
  )
    .bind(
      await hash(token),
      actor,
      role,
      new Date(Date.now() + maxAge * 1000).toISOString(),
      kind,
      kind === 'admin' && env.ADMIN_ACCESS_KEY ? await hash(env.ADMIN_ACCESS_KEY) : null,
    )
    .run();
  return {
    token,
    maxAge,
    actor: { email: actor, role, method: kind === 'admin' ? 'admin' : 'public' } as Actor,
  };
}
export async function authenticate(req: Request, env: RuntimeEnv): Promise<Actor | null> {
  const bearer = req.headers.get('Authorization')?.replace(/^Bearer /, '');
  if (bearer && env.FEEDBACK_API_TOKEN && (await secretEquals(bearer, env.FEEDBACK_API_TOKEN)))
    return { email: 'origin-feedback-api', role: 'user', method: 'api' };
  for (const kind of ['admin', 'visitor'] as const) {
    const name = kind === 'admin' ? 'hephaestus_admin' : 'hephaestus_visitor';
    const token = req.headers.get('cookie')?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
    if (!token) continue;
    const s = await env.DB.prepare(
      'SELECT actor,role,credential_hash FROM sessions WHERE token_hash=? AND kind=? AND expires_at>?',
    )
      .bind(await hash(token), kind, new Date().toISOString())
      .first<{ actor: string; role: Actor['role']; credential_hash: string | null }>();
    if (!s) continue;
    if (
      kind === 'admin' &&
      (!env.ADMIN_ACCESS_KEY ||
        !s.credential_hash ||
        !(await secretEquals(s.credential_hash, await hash(env.ADMIN_ACCESS_KEY))))
    )
      continue;
    return {
      email: s.actor,
      role: kind === 'admin' ? 'admin' : 'user',
      method: kind === 'admin' ? 'admin' : 'public',
    };
  }
  // Optional existing team identity. Public visitors never need Cloudflare Access.
  if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    const token = req.headers.get('Cf-Access-Jwt-Assertion');
    if (token) {
      try {
        const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
        const { payload } = await jwtVerify(
          token,
          createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)),
          { issuer, audience: env.ACCESS_AUD },
        );
        if (typeof payload.email !== 'string') throw new Error('Missing identity');
        const email = payload.email.toLowerCase();
        const role = env.ADMIN_EMAILS?.toLowerCase()
          .split(',')
          .map((x) => x.trim())
          .includes(email)
          ? 'admin'
          : 'user';
        return { email, role, method: 'access' };
      } catch {
        throw new HttpError(401, 'Invalid administrator identity.');
      }
    }
  }
  return null;
}
