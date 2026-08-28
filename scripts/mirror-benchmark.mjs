import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const NAMESPACE_ID = '4391d2480c8f4a87b2c92f989a5735f0';
const OUTPUT_PATH = 'benchmarks/latest-browser.json';
const branch = process.env.WORKERS_CI_BRANCH || '';

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
}

if (process.env.WORKERS_CI !== '1' || !branch || branch === 'main') process.exit(0);

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const kv = run(npx, [
  'wrangler', 'kv', 'key', 'get', 'knockout:latest',
  '--namespace-id', NAMESPACE_ID,
  '--remote', '--text',
]);

if (kv.status !== 0 || !kv.stdout.trim()) {
  console.log('[benchmark-mirror] KV read unavailable; leaving repository unchanged.');
  if (kv.stderr.trim()) console.log(kv.stderr.trim().split('\n').slice(-2).join('\n'));
  process.exit(0);
}

let record;
try {
  record = JSON.parse(kv.stdout);
} catch {
  console.log('[benchmark-mirror] latest KV record is not valid JSON; leaving repository unchanged.');
  process.exit(0);
}

if (record?.schema !== 'knockout-asets.benchmark/v1' || typeof record?.run_id !== 'string') {
  console.log('[benchmark-mirror] latest KV record is not an Asets benchmark; leaving repository unchanged.');
  process.exit(0);
}

let existing = null;
try { existing = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')); } catch {}
if (existing?.run_id === record.run_id) {
  console.log(`[benchmark-mirror] run ${record.run_id} already mirrored.`);
  process.exit(0);
}

mkdirSync('benchmarks', { recursive: true });
writeFileSync(OUTPUT_PATH, `${JSON.stringify(record, null, 2)}\n`);

for (const [key, value] of [
  ['user.name', 'Cloudflare Benchmark Mirror'],
  ['user.email', 'benchmark-mirror@users.noreply.github.com'],
]) {
  const configured = run('git', ['config', key, value]);
  if (configured.status !== 0) {
    console.log(`[benchmark-mirror] git config failed for ${key}; leaving working tree only.`);
    process.exit(0);
  }
}

if (run('git', ['add', OUTPUT_PATH]).status !== 0) process.exit(0);
const commit = run('git', ['commit', '-m', `benchmark: mirror ${record.run_id}`]);
if (commit.status !== 0) {
  console.log('[benchmark-mirror] no mirror commit created.');
  process.exit(0);
}

const push = run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`]);
if (push.status !== 0) {
  console.log('[benchmark-mirror] Git push unavailable from Workers Builds checkout.');
  if (push.stderr.trim()) console.log(push.stderr.trim().split('\n').slice(-3).join('\n'));
  process.exit(0);
}

console.log(`[benchmark-mirror] mirrored run ${record.run_id} to ${OUTPUT_PATH}.`);
