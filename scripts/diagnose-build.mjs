import { spawnSync } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';

function runStage(name, command, args) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });

  return {
    name,
    status: result.status,
    signal: result.signal,
    error: result.error ? String(result.error) : null,
    stdout: (result.stdout ?? '').slice(-250_000),
    stderr: (result.stderr ?? '').slice(-250_000),
  };
}

const stages = [
  runStage('test', 'npm', ['run', 'test', '--', '--reporter=verbose']),
  runStage('typecheck', 'npm', ['run', 'typecheck']),
  runStage('deployment-marker', 'node', ['scripts/write-deployment.mjs']),
  runStage('vite-build', 'npx', ['vite', 'build']),
];

await mkdir('dist', { recursive: true });
try {
  await access('dist/index.html');
} catch {
  await writeFile(
    'dist/index.html',
    '<!doctype html><meta charset="utf-8"><title>Knockout build diagnostic</title><p>Diagnostic build only.</p>',
    'utf8',
  );
}

const report = {
  diagnostic: true,
  sourceCommit: process.env.WORKERS_CI_COMMIT_SHA ?? null,
  sourceBranch: process.env.WORKERS_CI_BRANCH ?? null,
  buildUuid: process.env.WORKERS_CI_BUILD_UUID ?? null,
  stages,
};
await writeFile('dist/diagnostic.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const stage of stages) {
  console.log(`[diagnostic] ${stage.name}: ${stage.status === 0 ? 'passed' : `failed (${stage.status})`}`);
}
console.log('[diagnostic] stage failures were captured in dist/diagnostic.json; exiting 0 so the non-production preview can be inspected.');
