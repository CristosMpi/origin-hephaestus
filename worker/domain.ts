import type { Actor, Metric, Proposal, RequestRecord } from '../src/shared';
import { z } from 'zod';
const checkSchema = z.object({
  command: z.string().min(1).max(300),
  exitCode: z.number().int(),
  output: z.string().max(50000),
  durationMs: z.number().nonnegative(),
});
const proposalSchema = z.object({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  parent: z.string().regex(/^[a-f0-9]{40}$/),
  tree: z.string().regex(/^[a-f0-9]{40}$/),
  summary: z.string().min(1).max(5000),
  plan: z.array(z.string().max(2000)).max(20),
  files: z
    .array(
      z.object({
        path: z.string().max(300),
        before: z.string().max(300000),
        after: z.string().max(300000),
        mode: z.enum(['100644', '100755']),
        deleted: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(40),
  diff: z.string().max(300000),
  checks: z.array(checkSchema).min(1).max(15),
  limitations: z.array(z.string().max(2000)).max(30),
  author: z.object({ name: z.string().min(1).max(100), email: z.email(), date: z.iso.datetime() }),
  message: z.string().min(1).max(5000),
  readyAt: z.iso.datetime(),
  mode: z.literal('live'),
  commands: z.array(checkSchema).max(100).optional(),
  inspectedFiles: z.array(z.string().max(300)).max(100).optional(),
  localBranch: z.string().max(300).optional(),
});
export function parseProposal(value: unknown): Proposal {
  return proposalSchema.parse(value);
}
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function assertReviewer(actor: Actor) {
  if (!['admin', 'access'].includes(actor.method) || actor.role !== 'admin')
    throw new HttpError(
      403,
      'Administrator access is required to review, approve or push changes.',
    );
}
export function assertApproval(
  r: RequestRecord,
  actor: Actor,
  commit: string,
  destination: string,
) {
  assertReviewer(actor);
  if (r.status !== 'Awaiting approval' || !r.proposal)
    throw new HttpError(409, 'This request is not awaiting approval.');
  if (r.proposal.commit !== commit || r.destination !== destination)
    throw new HttpError(
      409,
      'The reviewed commit or repository changed. Refresh and review again.',
    );
  if (!r.proposal.checks.length || r.proposal.checks.some((x) => x.exitCode !== 0))
    throw new HttpError(409, 'All required validation checks must pass before approval.');
}
export function assertPublish(r: RequestRecord) {
  if (
    !r.proposal ||
    !r.approved_by ||
    !r.approved_at ||
    r.approved_commit !== r.proposal.commit ||
    r.approved_destination !== r.destination
  )
    throw new HttpError(
      409,
      'Publication requires recorded approval for this exact commit and destination.',
    );
  if (r.status !== 'Awaiting approval' && r.status !== 'Pushed')
    throw new HttpError(409, 'Request cannot be published in this state.');
}
export function median(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function metrics(rows: RequestRecord[]): Metric[] {
  const elapsed = (a: string | null, b: string | null) =>
    a && b ? Math.max(0, Date.parse(b) - Date.parse(a)) : null;
  const med = (
    key: string,
    label: string,
    values: (number | null)[],
    definition: string,
  ): Metric => {
    const xs = values.filter((x): x is number => x !== null);
    return { key, label, value: median(xs), unit: 'duration', samples: xs.length, definition };
  };
  const rate = (
    key: string,
    label: string,
    values: (number | null)[],
    definition: string,
  ): Metric => {
    const xs = values.filter((x): x is number => x !== null);
    return {
      key,
      label,
      value: xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length) * 100 : null,
      unit: 'percent',
      samples: xs.length,
      definition,
    };
  };
  return [
    med(
      'development',
      'Time to review-ready code',
      rows.map((r) => elapsed(r.created_at, r.first_ready_at)),
      'Median submission → first review-ready proposal. Includes queue, analysis, implementation and checks. Stops before approval waiting.',
    ),
    med(
      'review',
      'Developer review time',
      rows.map((r) => elapsed(r.review_started_at, r.approved_at)),
      'Median first reviewer opening → approval; includes revision discussions. Only approved requests with a recorded review start.',
    ),
    rate(
      'acceptance',
      'First-review acceptance',
      rows.map((r) => r.first_review_accepted),
      'Approved without a revision request ÷ requests with a first review decision. Rejections and revision requests count as not accepted.',
    ),
    rate(
      'validation',
      'First-pass validation',
      rows.map((r) => r.validation_first),
      'Requests whose first implementation passed every configured check ÷ requests with completed first validation.',
    ),
    {
      key: 'completed',
      label: 'Requests completed',
      value: rows.filter((r) => r.pushed_at).length,
      unit: 'count',
      samples: rows.length,
      definition:
        'Real requests pushed to a dedicated branch after administrator approval. Archived samples are excluded.',
    },
    med(
      'waiting',
      'Approval waiting time',
      rows.map((r) =>
        r.first_ready_at
          ? elapsed(
              r.first_ready_at,
              r.approved_at ?? (r.status === 'Rejected' ? r.updated_at : new Date().toISOString()),
            )
          : null,
      ),
      'Median first review-ready time → approval, rejection, or now for pending requests. Includes waiting and revision cycles; separate from initial development.',
    ),
    med(
      'push',
      'Approval to push',
      rows.map((r) => elapsed(r.approved_at, r.pushed_at)),
      'Median recorded approval → successful branch publication and pull request.',
    ),
    rate(
      'coverage',
      'Pushes with approval',
      rows
        .filter((r) => r.pushed_at)
        .map((r) =>
          r.approved_by &&
          r.approved_commit === r.proposal?.commit &&
          r.approved_destination === r.destination
            ? 1
            : 0,
        ),
      'Pushes with approval matching the exact published commit and destination ÷ all completed pushes.',
    ),
  ];
}
export function validateProposal(p: Proposal, checks: string[]) {
  if (
    !/^[a-f0-9]{40}$/.test(p.commit) ||
    !/^[a-f0-9]{40}$/.test(p.parent) ||
    !/^[a-f0-9]{40}$/.test(p.tree)
  )
    throw new Error('Runner returned invalid Git identifiers.');
  if (!p.files.length || p.files.length > 40 || p.diff.length > 300000)
    throw new Error('Proposal exceeds review bounds or has no changes.');
  for (const f of p.files)
    if (
      !/^[\w./@ -]+$/.test(f.path) ||
      f.path.startsWith('/') ||
      f.path.split('/').some((x) => x === '..' || x === '.git') ||
      !['100644', '100755'].includes(f.mode)
    )
      throw new Error('Unsafe file path or mode in proposal.');
  for (const command of checks)
    if (!p.checks.some((c) => c.command === command))
      throw new Error(`Missing required validation: ${command}`);
}
