import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

if (process.env.WORKERS_CI !== '1') {
  process.exit(0);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const vite = resolve('node_modules', '.bin', process.platform === 'win32' ? 'vite.cmd' : 'vite');
const stages = [];

function sanitize(value) {
  const text = String(value ?? '');
  return text
    .split('\n')
    .filter((line) => !/(authorization|bearer|cookie|secret|api[_-]?key|token)/i.test(line))
    .slice(-240)
    .join('\n')
    .slice(-20_000);
}

function run(name, command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
  });
  stages.push({
    name,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
    stdout: sanitize(result.stdout),
    stderr: sanitize(result.stderr),
  });
  return result.status === 0;
}

run('tests', npm, ['run', 'test']);
run('typecheck', npm, ['run', 'typecheck']);
run('deployment-marker', process.execPath, ['scripts/write-deployment.mjs']);
const viteOk = run('vite-build', vite, ['build']);

await mkdir('dist', { recursive: true });
if (!viteOk) {
  await writeFile(
    'dist/index.html',
    '<!doctype html><meta charset="utf-8"><title>Knockout viewer diagnostic</title><p>Provider diagnostic build. No application preview is valid for this version.</p>',
    'utf8',
  );
}

const diagnostic = {
  schema: 'knockout-viewer.provider-diagnostic/v1',
  sha: process.env.WORKERS_CI_COMMIT_SHA ?? null,
  branch: process.env.WORKERS_CI_BRANCH ?? null,
  buildUuid: process.env.WORKERS_CI_BUILD_UUID ?? null,
  node: process.version,
  stages,
};
await writeFile('dist/provider-diagnostic.json', `${JSON.stringify(diagnostic, null, 2)}\n`, 'utf8');

// Diagnostic build deliberately allows Wrangler to run so that the stage report can be read back.
process.exit(0);
