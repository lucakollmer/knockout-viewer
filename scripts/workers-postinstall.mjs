import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.env.WORKERS_CI !== '1') process.exit(0);

const tsc = resolve('node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc');
const result = spawnSync(tsc, ['-p', 'tsconfig.ui-probe.json', '--noEmit'], {
  stdio: 'inherit',
  env: process.env,
});
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', '<!doctype html><meta charset="utf-8"><title>Knockout viewer UI typecheck probe</title><p>UI typecheck probe only; not a release.</p>', 'utf8');
