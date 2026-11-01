import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { safeFile, validateJob } from './security.mjs';
test('rejects traversal, secrets, git metadata and absolute model paths', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hep-test-'));
  try {
    for (const name of [
      '../secret',
      '/etc/passwd',
      '.git/config',
      '.env',
      'src/../../escape',
      'C:\\secrets',
      'node_modules/a',
    ])
      await assert.rejects(safeFile(root, name));
    assert.equal(await safeFile(root, 'src/feedback.ts'), path.join(root, 'src/feedback.ts'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('requires allowlisted repositories and bounded jobs', () => {
  const job = {
    repository: 'origin/app',
    baseBranch: 'main',
    jobId: 'HEP-123-r0',
    checks: ['npm test'],
    timeoutSeconds: 600,
    maxAttempts: 3,
  };
  assert.doesNotThrow(() => validateJob(job, ['origin/app']));
  assert.throws(() => validateJob({ ...job, repository: 'evil/repo' }, ['origin/app']));
  assert.throws(() => validateJob({ ...job, baseBranch: '--upload-pack=evil' }, ['origin/app']));
  assert.throws(() => validateJob({ ...job, timeoutSeconds: 99999 }, ['origin/app']));
  assert.throws(() => validateJob({ ...job, maxAttempts: 100 }, ['origin/app']));
});
