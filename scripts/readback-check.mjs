import { spawnSync } from 'node:child_process';

const TARGET_SHA = '33de020906c9a4100eb74bf5500d18bf3b6aaf7b';
const NAMESPACE_ID = '4391d2480c8f4a87b2c92f989a5735f0';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const kv = spawnSync(npx, [
  'wrangler', 'kv', 'key', 'get', `knockout:latest:${TARGET_SHA}`,
  '--namespace-id', NAMESPACE_ID,
  '--remote', '--text',
], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

if (kv.status !== 0 || !kv.stdout.trim()) {
  throw new Error(`ASETS_READBACK_KV_FAILED:${kv.stderr.trim().slice(-1000)}`);
}

const record = JSON.parse(kv.stdout);
const scenarios = Array.isArray(record?.benchmark?.scenarios) ? record.benchmark.scenarios : [];
const compactScenario = (scenario) => {
  const performance = scenario?.performance || {};
  return {
    r: scenario?.r ?? null,
    p: scenario?.profile ?? null,
    w: Math.round(scenario?.wall_ms ?? 0),
    fm: scenario?.first_message_ms == null ? null : Math.round(scenario.first_message_ms),
    fc: scenario?.first_chunk_ms == null ? null : Math.round(scenario.first_chunk_ms),
    n: scenario?.records_received ?? 0,
    to: Boolean(scenario?.timed_out),
    e: scenario?.error ?? null,
    c: performance.contextBuildMs ?? null,
    s: performance.cspMs ?? null,
    g: performance.geometryMs ?? null,
    tw: performance.totalWorkerComputeMs ?? null,
    z: performance.serializationMs ?? null,
    iw: performance.indexedDbWriteMs ?? null,
  };
};
const summary = {
  run: record?.run_id ?? null,
  sha: record?.deployment?.sha ?? null,
  client: {
    ua: record?.client?.user_agent ?? null,
    hc: record?.client?.hardware_concurrency ?? null,
  },
  frontier: record?.benchmark?.frontier ?? null,
  scenarios: scenarios.map(compactScenario),
};

throw new Error(`ASETS_READBACK:${JSON.stringify(summary)}`);
