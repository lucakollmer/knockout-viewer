const MAX_BENCHMARK_BYTES = 512 * 1024;
const BENCHMARK_TTL_SECONDS = 60 * 60 * 24 * 30;
const KEY_PREFIX = 'knockout:';

function json(data, status = 200) {
  return new Response(`${JSON.stringify(data)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function validScenario(scenario) {
  if (!scenario || typeof scenario.id !== 'string' || scenario.id.length > 120) return false;
  if (!['cold', 'same_modulus_warm', 'persistent_cache_hit', 'cancel_probe'].includes(scenario.mode)) return false;
  if (!Number.isSafeInteger(scenario.r) || scenario.r < 1) return false;
  if (!Array.isArray(scenario.residues) || scenario.residues.length !== 3 || scenario.residues.some((x) => !Number.isSafeInteger(x))) return false;
  if (!finiteNonNegative(scenario.wall_ms)) return false;
  if (scenario.first_chunk_ms !== null && !finiteNonNegative(scenario.first_chunk_ms)) return false;
  if (!Number.isSafeInteger(scenario.records_received) || scenario.records_received < 0) return false;
  if (typeof scenario.timed_out !== 'boolean' || typeof scenario.cancelled !== 'boolean') return false;
  if (scenario.error !== null && typeof scenario.error !== 'string') return false;
  return true;
}

function validateBenchmark(payload) {
  if (!payload || payload.schema !== 'knockout-asets.benchmark/v1') throw new Error('Unsupported benchmark schema.');
  if (typeof payload.run_id !== 'string' || payload.run_id.length < 8 || payload.run_id.length > 128) throw new Error('Invalid run_id.');
  if (payload.benchmark?.suite !== 'interactive-asets-v1') throw new Error('Invalid benchmark suite.');
  if (!Number.isFinite(payload.benchmark?.case_timeout_ms) || payload.benchmark.case_timeout_ms < 1000) throw new Error('Invalid benchmark timeout.');
  const scenarios = payload.benchmark?.scenarios;
  if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > 32) throw new Error('Invalid benchmark scenarios.');
  for (const scenario of scenarios) if (!validScenario(scenario)) throw new Error(`Invalid benchmark scenario ${scenario?.id ?? '?'}.`);
}

async function deploymentMarker(request, env) {
  const markerUrl = new URL('/deployment.json', request.url);
  const response = await env.ASSETS.fetch(new Request(markerUrl, { method: 'GET' }));
  if (!response.ok) throw new Error(`deployment marker HTTP ${response.status}`);
  const marker = await response.json();
  if (!marker?.sha || typeof marker.sha !== 'string') throw new Error('deployment marker is missing sha');
  return marker;
}

async function storeBenchmark(request, env) {
  if (request.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if (origin && origin !== url.origin) return json({ ok: false, error: 'cross_origin_forbidden' }, 403);
  if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) {
    return json({ ok: false, error: 'content_type_must_be_json' }, 415);
  }
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_BENCHMARK_BYTES) return json({ ok: false, error: 'payload_too_large' }, 413);
  const text = await request.text();
  if (text.length > MAX_BENCHMARK_BYTES) return json({ ok: false, error: 'payload_too_large' }, 413);

  let payload;
  try {
    payload = JSON.parse(text);
    validateBenchmark(payload);
  } catch (error) {
    return json({ ok: false, error: 'invalid_benchmark', detail: String(error?.message || error) }, 400);
  }

  let deployment;
  try {
    deployment = await deploymentMarker(request, env);
  } catch (error) {
    return json({ ok: false, error: 'deployment_marker_unavailable', detail: String(error?.message || error) }, 503);
  }

  const receivedAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const record = { ...payload, deployment, server_received_at: receivedAt, benchmark_record_id: id };
  const serialized = JSON.stringify(record);
  const timestamp = Date.now();
  await Promise.all([
    env.BENCHMARKS.put(`${KEY_PREFIX}run:${deployment.sha}:${timestamp}:${id}`, serialized, { expirationTtl: BENCHMARK_TTL_SECONDS }),
    env.BENCHMARKS.put(`${KEY_PREFIX}latest:${deployment.sha}`, serialized, { expirationTtl: BENCHMARK_TTL_SECONDS }),
    env.BENCHMARKS.put(`${KEY_PREFIX}latest`, serialized, { expirationTtl: BENCHMARK_TTL_SECONDS }),
  ]);
  return json({ ok: true, id, sha: deployment.sha, schema: payload.schema, received_at: receivedAt });
}

async function readLatest(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  let deployment;
  try {
    deployment = await deploymentMarker(request, env);
  } catch (error) {
    return json({ ok: false, error: 'deployment_marker_unavailable', detail: String(error?.message || error) }, 503);
  }
  const serialized = await env.BENCHMARKS.get(`${KEY_PREFIX}latest:${deployment.sha}`);
  if (!serialized) return json({ ok: false, error: 'benchmark_not_found', sha: deployment.sha }, 404);
  return new Response(`${serialized}\n`, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/benchmarks') return storeBenchmark(request, env);
    if (url.pathname === '/api/benchmarks/latest') return readLatest(request, env);
    return env.ASSETS.fetch(request);
  },
};
