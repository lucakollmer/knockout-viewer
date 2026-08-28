import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const NAMESPACE_ID = '4391d2480c8f4a87b2c92f989a5735f0';
const TARGET_PATH = 'benchmarks/MIRROR_TRIGGER.md';

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: 'inherit', ...options });
}
function capture(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
function b36(value) {
  return value == null || !Number.isFinite(Number(value)) ? 'x' : Math.max(0, Math.round(Number(value))).toString(36);
}
function value(frontier, key) {
  const candidate = frontier?.[key];
  return candidate == null ? null : candidate;
}

const targetText = readFileSync(TARGET_PATH, 'utf8');
const targetMatch = targetText.match(/Target SHA:\s*([0-9a-f]{40})/i);
if (!targetMatch) throw new Error('benchmark readback target SHA missing');
const targetSha = targetMatch[1].toLowerCase();
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const kv = capture(npx, [
  'wrangler', 'kv', 'key', 'get', `knockout:latest:${targetSha}`,
  '--namespace-id', NAMESPACE_ID,
  '--remote', '--text',
]);

let alias = 'b3-kvfail';
if (kv.status === 0 && kv.stdout.trim()) {
  const record = JSON.parse(kv.stdout);
  if (record?.deployment?.sha !== targetSha) throw new Error('benchmark deployment SHA mismatch');
  const frontier = record.benchmark?.frontier;
  const r1p = value(frontier?.under_1s, 'largest_tested_passing_r');
  const r1f = value(frontier?.under_1s, 'smallest_tested_failing_r');
  const r5p = value(frontier?.under_5s, 'largest_tested_passing_r');
  const r5f = value(frontier?.under_5s, 'smallest_tested_failing_r');
  const scenarios = Array.isArray(record.benchmark?.scenarios) ? record.benchmark.scenarios : [];
  const atFrontier = scenarios.filter((scenario) => scenario?.r === r5p);
  const critical = atFrontier.sort((a, b) => Number(b?.wall_ms ?? 0) - Number(a?.wall_ms ?? 0))[0] ?? null;
  const performance = critical?.performance ?? null;
  alias = [
    'b3',
    `1p${b36(r1p)}`,
    `1f${b36(r1f)}`,
    `5p${b36(r5p)}`,
    `5f${b36(r5f)}`,
    `w${b36(critical?.wall_ms)}`,
    `g${b36(performance?.geometryMs)}`,
    `c${b36(performance?.cspMs)}`,
    `f${b36(critical?.first_chunk_ms)}`,
  ].join('-');
}
if (alias.length > 47) throw new Error(`benchmark preview alias too long: ${alias}`);
console.log(`[benchmark-readback] preview alias ${alias}`);

if (process.env.WORKERS_CI === '1' && process.env.WORKERS_CI_BRANCH && process.env.WORKERS_CI_BRANCH !== 'main') {
  const result = run(npx, ['wrangler', 'versions', 'upload', '--preview-alias', alias, '--message', `benchmark-readback ${targetSha}`]);
  process.exit(result.status ?? 1);
}
const result = run(npx, ['wrangler', 'deploy']);
process.exit(result.status ?? 1);
