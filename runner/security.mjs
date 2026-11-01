import path from 'node:path';
import { lstat } from 'node:fs/promises';
export function validateJob(job, allowed) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(job.repository) || !allowed.includes(job.repository))
    throw new Error('Repository is not in ALLOWED_REPOSITORIES.');
  if (
    !/^[\w./-]+$/.test(job.baseBranch) ||
    job.baseBranch.includes('..') ||
    job.baseBranch.startsWith('-')
  )
    throw new Error('Unsafe base branch.');
  if (!/^[A-Za-z0-9_-]{5,100}$/.test(job.jobId)) throw new Error('Invalid job ID.');
  if (
    !Array.isArray(job.checks) ||
    job.checks.length < 1 ||
    job.checks.length > 10 ||
    job.checks.some((c) => typeof c !== 'string' || c.length > 300)
  )
    throw new Error('Invalid required checks.');
  if (!Number.isInteger(job.timeoutSeconds) || job.timeoutSeconds < 30 || job.timeoutSeconds > 600)
    throw new Error('Timeout must be 30–600 seconds.');
  if (!Number.isInteger(job.maxAttempts) || job.maxAttempts < 1 || job.maxAttempts > 6)
    throw new Error('Revision attempts must be bounded.');
}
export async function safeFile(root, name) {
  if (
    typeof name !== 'string' ||
    !name ||
    name.length > 300 ||
    name.includes('\\') ||
    path.posix.isAbsolute(name) ||
    name
      .split('/')
      .some(
        (s) =>
          !s ||
          s === '.' ||
          s === '..' ||
          s === '.git' ||
          s === 'node_modules' ||
          s === '.env' ||
          s.startsWith('.env.'),
      )
  )
    throw new Error('Unsafe model file path.');
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(path.resolve(root) + path.sep))
    throw new Error('File escaped the workspace.');
  let current = root;
  for (const part of name.split('/')) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error('Symbolic links are not editable.');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
  }
  return resolved;
}
