import type { RuntimeEnv } from './db';
import { event, getRequest, now } from './db';
import { assertPublish, HttpError } from './domain';
async function github<T>(
  env: RuntimeEnv,
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const r = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_WRITE_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'ORIGIN-Hephaestus',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok)
    throw new Error(
      `GitHub ${method} ${path} returned ${r.status}. Check repository permissions and branch protection.`,
    );
  return r.json<T>();
}
export async function publish(env: RuntimeEnv, id: string) {
  let r = await getRequest(env, id);
  if (r.mode !== 'live' || r.proposal?.mode !== 'live')
    throw new HttpError(409, 'Only real repository proposals can be published.');
  assertPublish(r);
  if (r.pushed_at) return r;
  const claim = crypto.randomUUID();
  const lock = await env.DB.prepare(
    "UPDATE requests SET push_claim=? WHERE id=? AND push_claim IS NULL AND approved_commit=? AND approved_destination=destination AND status='Awaiting approval'",
  )
    .bind(claim, id, r.proposal!.commit)
    .run();
  if (!lock.meta.changes)
    throw new HttpError(409, 'Publication is already running. Retry after it completes.');
  try {
    r = await getRequest(env, id);
    assertPublish(r);
    const p = r.proposal!;
    let pr: string | null = null;
    if (r.mode === 'live') {
      if (!env.GITHUB_WRITE_TOKEN)
        throw new Error(
          'GITHUB_WRITE_TOKEN is not configured. Approval is saved; publication can be retried.',
        );
      const match = r.destination.match(/^([\w.-]+\/[\w.-]+)@([^:]+):(.+)$/);
      if (!match) throw new Error('Invalid repository destination.');
      const [, repo, base, branch] = match;
      const root = `/repos/${repo}`;
      const parent = await github<{ tree: { sha: string } }>(
        env,
        `${root}/git/commits/${p.parent}`,
      );
      const tree = await github<{ sha: string }>(env, `${root}/git/trees`, 'POST', {
        base_tree: parent.tree.sha,
        tree: p.files.map((f) =>
          f.deleted
            ? { path: f.path, mode: f.mode, type: 'blob', sha: null }
            : { path: f.path, mode: f.mode, type: 'blob', content: f.after },
        ),
      });
      if (tree.sha !== p.tree)
        throw new Error('Published tree would differ from the reviewed tree. Publication stopped.');
      const commit = await github<{ sha: string }>(env, `${root}/git/commits`, 'POST', {
        message: p.message,
        tree: tree.sha,
        parents: [p.parent],
        author: p.author,
        committer: p.author,
      });
      if (commit.sha !== p.commit)
        throw new Error('Commit identity differs from the approved commit. Publication stopped.');
      // A retry reads the dedicated branch first. It must never overwrite a different head.
      const refs = await github<{ ref: string; object: { sha: string } }[]>(
        env,
        `${root}/git/matching-refs/heads/${encodeURIComponent(branch)}`,
      );
      const existing = refs.find((x) => x.ref === `refs/heads/${branch}`);
      if (existing && existing.object.sha !== p.commit)
        throw new Error('Dedicated branch already contains a different commit.');
      if (!existing)
        await github(env, `${root}/git/refs`, 'POST', {
          ref: `refs/heads/${branch}`,
          sha: p.commit,
        });
      const pulls = await github<{ html_url: string }[]>(
        env,
        `${root}/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}&base=${encodeURIComponent(base)}`,
      );
      pr =
        pulls[0]?.html_url ??
        (
          await github<{ html_url: string }>(env, `${root}/pulls`, 'POST', {
            title: r.title,
            head: branch,
            base,
            body: `## Request ${r.id}\n\n${p.summary}\n\nApproved by ${r.approved_by} at ${r.approved_at}.\nReviewed commit: ${p.commit}\nDestination: ${r.destination}\n\n${p.checks.map((c) => `- ${c.exitCode === 0 ? 'PASS' : 'FAIL'}: ${c.command}`).join('\n')}\n\n${p.limitations.join('\n')}`,
            draft: false,
          })
        ).html_url;
    }
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE requests SET status='Pushed',pushed_at=?,pr_url=?,updated_at=?,push_claim=NULL,version=version+1 WHERE id=? AND push_claim=? AND approved_commit=?",
      ).bind(timestamp, pr, timestamp, id, claim, p.commit),
      event(env, id, 'Pushed', 'publisher', 'Approved commit pushed and pull request opened.', {
        commit: p.commit,
        destination: r.destination,
        approvedBy: r.approved_by,
        pr,
      }),
    ]);
    return getRequest(env, id);
  } catch (e) {
    await env.DB.batch([
      env.DB.prepare('UPDATE requests SET push_claim=NULL WHERE id=? AND push_claim=?').bind(
        id,
        claim,
      ),
      event(
        env,
        id,
        'Publish failed',
        'publisher',
        e instanceof Error ? e.message : 'Publication failed.',
      ),
    ]);
    throw e;
  }
}
