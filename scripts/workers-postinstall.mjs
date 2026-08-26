import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';

if (process.env.WORKERS_CI !== '1') {
  process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const typecheck = spawnSync(npm, ['run', 'typecheck'], {
  stdio: 'inherit',
  env: process.env,
});

if (typecheck.error) {
  console.error(typecheck.error);
  process.exit(1);
}
if (typecheck.status !== 0) {
  process.exit(typecheck.status ?? 1);
}

await mkdir('dist', { recursive: true });
await writeFile(
  'dist/index.html',
  '<!doctype html><meta charset="utf-8"><title>Knockout viewer typecheck probe</title><p>Typecheck probe only; this is not an application release.</p>',
  'utf8',
);
await writeFile(
  'dist/deployment.json',
  `${JSON.stringify({ sha: process.env.WORKERS_CI_COMMIT_SHA ?? null, probe: 'typecheck-passed' }, null, 2)}\n`,
  'utf8',
);
