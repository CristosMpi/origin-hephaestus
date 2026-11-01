import type { Feedback, Proposal } from '../../src/shared';
async function gitHash(type: string, data: Uint8Array | string) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const head = new TextEncoder().encode(`${type} ${bytes.length}\0`);
  const all = new Uint8Array(head.length + bytes.length);
  all.set(head);
  all.set(bytes, head.length);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', all))]
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}
export async function testProposal(
  feedback: Feedback,
  revision: number,
  comment: string,
): Promise<Proposal> {
  const before = 'export function normalizeFeedback(title: string) {\n  return title;\n}\n';
  const after =
    'export function normalizeFeedback(title: string) {\n  const normalized = title.trim();\n  if (!normalized) throw new Error("A title is required");\n  return normalized;\n}\n';
  const tests =
    'import { expect, test } from "vitest";\nimport { normalizeFeedback } from "./feedback";\ntest("trims whitespace", () => {\n  expect(normalizeFeedback("  ORIGIN  ")).toBe("ORIGIN");\n});\ntest("rejects an empty title", () => {\n  expect(() => normalizeFeedback("   ")).toThrow();\n});\n';
  const files = [
    { path: 'feedback.ts', before, after, mode: '100644' as const },
    { path: 'feedback.test.ts', before: '', after: tests, mode: '100644' as const },
  ];
  const entries = [];
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const sha = await gitHash('blob', f.after);
    entries.push(
      ...new TextEncoder().encode(`100644 ${f.path}\0`),
      ...sha.match(/../g)!.map((x) => parseInt(x, 16)),
    );
  }
  const tree = await gitHash('tree', new Uint8Array(entries));
  const parent = await gitHash('commit', 'Hephaestus demo fixture v1');
  const author = {
    name: 'Hephaestus Demo',
    email: 'demo@origin.local',
    date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
  const message = `Demo: ${feedback.title}\n\nRevision ${revision + 1}${comment ? `\nReviewer: ${comment}` : ''}`;
  const commit = await gitHash(
    'commit',
    `tree ${tree}\nparent ${parent}\nauthor ${author.name} <${author.email}> ${Date.parse(author.date) / 1000} +0000\ncommitter ${author.name} <${author.email}> ${Date.parse(author.date) / 1000} +0000\n\n${message}\n`,
  );
  const start = performance.now();
  function normalizeFeedback(title: string) {
    const normalized = title.trim();
    if (!normalized) throw new Error('A title is required');
    return normalized;
  }
  const trim = normalizeFeedback('  ORIGIN  ') === 'ORIGIN';
  let empty = false;
  try {
    normalizeFeedback('   ');
  } catch {
    empty = true;
  }
  const diff = files
    .map(
      (f) =>
        `diff --git a/${f.path} b/${f.path}\n--- ${f.before ? 'a/' + f.path : '/dev/null'}\n+++ b/${f.path}\n@@ -1,${f.before ? f.before.trimEnd().split('\n').length : 0} +1,${f.after.trimEnd().split('\n').length} @@\n${f.before
          .trimEnd()
          .split('\n')
          .filter(Boolean)
          .map((x) => '-' + x)
          .join('\n')}${f.before ? '\n' : ''}${f.after
          .trimEnd()
          .split('\n')
          .map((x) => '+' + x)
          .join('\n')}\n`,
    )
    .join('\n');
  return {
    commit,
    parent,
    tree,
    author,
    message,
    files,
    diff,
    mode: 'live',
    readyAt: new Date().toISOString(),
    summary:
      'Demonstration proposal: validate and normalize feedback titles at the input boundary, with regression coverage for whitespace and missing titles.',
    plan: [
      'Inspect the included feedback normalization fixture.',
      'Normalize whitespace and reject empty feedback titles.',
      'Run fixture assertions and prepare a reviewable Git diff.',
    ],
    checks: [
      {
        command: 'Demo fixture assertions (in-process)',
        exitCode: trim && empty ? 0 : 1,
        output: `${trim ? 'PASS' : 'FAIL'} trims surrounding whitespace\n${empty ? 'PASS' : 'FAIL'} rejects empty titles\n2 assertions executed by the Worker. No repository tests were run.`,
        durationMs: Math.round((performance.now() - start) * 1000) / 1000,
      },
      {
        command: 'Demo diff whitespace check',
        exitCode: files.every((f) => !f.after.split('\n').some((l) => /\s+$/.test(l))) ? 0 : 1,
        output: 'Checked changed fixture lines for trailing whitespace.',
        durationMs: 0,
      },
    ],
    limitations: [
      'Demo mode uses a bundled fixture, not the configured repository.',
      'This proposal demonstrates the approval workflow; it does not implement the submitted request in real ORIGIN software.',
      'No remote branches or pull requests are created in demo mode.',
    ],
  };
}
