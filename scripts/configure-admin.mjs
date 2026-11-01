import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = process.cwd();
const folder = path.join(root, '.local');
fs.mkdirSync(folder, { recursive: true });
const filename = path.join(folder, 'admin-access-key.txt');
const key = fs.existsSync(filename)
  ? fs.readFileSync(filename, 'utf8').trim()
  : randomBytes(32).toString('base64url');
if (key.length < 32) throw new Error('Existing administrator key is too short.');
if (!fs.existsSync(filename)) fs.writeFileSync(filename, key + '\n', { mode: 0o600 });
const varsFile = path.join(root, '.dev.vars');
let vars = fs.existsSync(varsFile) ? fs.readFileSync(varsFile, 'utf8') : '';
vars = /^ADMIN_ACCESS_KEY=/m.test(vars)
  ? vars.replace(/^ADMIN_ACCESS_KEY=.*$/m, 'ADMIN_ACCESS_KEY=' + key)
  : vars + '\nADMIN_ACCESS_KEY=' + key + '\n';
fs.writeFileSync(varsFile, vars, { mode: 0o600 });
const result = spawnSync(
  process.execPath,
  [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'put', 'ADMIN_ACCESS_KEY'],
  { input: key + '\n', encoding: 'utf8', windowsHide: true },
);
process.stdout.write((result.stdout || '').replaceAll(key, '[redacted]'));
process.stderr.write((result.stderr || '').replaceAll(key, '[redacted]'));
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(
  'Administrator key saved privately in .local/admin-access-key.txt. It was not printed or added to source.',
);
