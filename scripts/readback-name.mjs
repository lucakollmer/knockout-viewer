import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const TARGET_SHA = '33de020906c9a4100eb74bf5500d18bf3b6aaf7b';
const NAMESPACE_ID = '4391d2480c8f4a87b2c92f989a5735f0';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

function b36(value, width) {
  if (value == null || !Number.isFinite(Number(value))) return 'z'.repeat(width);
  const limit = 36 ** width - 2;
  const rounded = Math.max(0, Math.min(limit, Math.round(Number(value))));
  return rounded.toString(36).padStart(width, '0');
}

const kv = spawnSync(npx, [
  'wrangler', 'kv', 'key', 'get', `knockout:latest:${TARGET_SHA}`,
  '--namespace-id', NAMESPACE_ID,
  '--remote', '--text',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
if (kv.status !== 0 || !kv.stdout.trim()) throw new Error('benchmark KV read failed');

const record = JSON.parse(kv.stdout);
if (record?.deployment?.sha !== TARGET_SHA) throw new Error('benchmark deployment SHA mismatch');
const frontier = record?.benchmark?.frontier;
const scenarios = Array.isArray(record?.benchmark?.scenarios) ? record.benchmark.scenarios : [];
const r1p = frontier?.under_1s?.largest_tested_passing_r ?? null;
const r1f = frontier?.under_1s?.smallest_tested_failing_r ?? null;
const r5p = frontier?.under_5s?.largest_tested_passing_r ?? null;
const r5f = frontier?.under_5s?.smallest_tested_failing_r ?? null;

function worstAt(r) {
  if (r == null) return null;
  const matches = scenarios.filter((scenario) => scenario?.r === r);
  if (!matches.length) return null;
  return matches.reduce((worst, scenario) => Number(scenario.wall_ms) > Number(worst.wall_ms) ? scenario : worst);
}

function packScenario(scenario) {
  if (!scenario) return 'z'.repeat(24);
  const performance = scenario.performance || {};
  const profile = scenario.profile === 'balanced-half' ? 'h' : scenario.profile === 'balanced-third' ? 't' : 'x';
  return [
    profile,
    b36(scenario.wall_ms, 3),
    b36(performance.geometryMs, 3),
    b36(performance.candidateCspEnumerationMs, 3),
    b36(performance.modulusContextSetupMs, 2),
    b36(performance.serializationChunkingMs, 2),
    b36(performance.indexedDbWriteMs, 3),
    b36(scenario.first_chunk_ms, 3),
    b36(scenario.records_received, 4),
  ].join('');
}

const encoded = [
  'kb1',
  b36(r1p, 2), b36(r1f, 2), b36(r5p, 2), b36(r5f, 2),
  packScenario(worstAt(r1p)),
  packScenario(worstAt(r5p)),
].join('');
if (encoded.length !== 59) throw new Error(`unexpected encoded readback length ${encoded.length}`);

const path = 'wrangler.jsonc';
const source = readFileSync(path, 'utf8');
const next = source.replace(/"name"\s*:\s*"[^"]+"/, `"name": "${encoded}"`);
if (next === source) throw new Error('failed to rewrite Worker name');
writeFileSync(path, next);
console.log(`[benchmark-readback] encoded exact-SHA summary into Worker name ${encoded}`);
