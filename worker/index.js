const MAX_BENCHMARK_BYTES = 512 * 1024;
const BENCHMARK_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_BENCHMARK_SCENARIOS = 64;
const KEY_PREFIX = 'knockout:';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const EXACT_CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=60';

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
  if (!Array.isArray(scenarios) || scenarios.length < 1 || scenarios.length > MAX_BENCHMARK_SCENARIOS) throw new Error('Invalid benchmark scenarios.');
  for (const scenario of scenarios) if (!validScenario(scenario)) throw new Error(`Invalid benchmark scenario ${scenario?.id ?? '?'}.`);
}

function assetsBinding(env) {
  const assets = env?.ASSETS;
  if (!assets || typeof assets.fetch !== 'function') throw new Error('ASSETS binding is unavailable');
  return assets;
}

function benchmarkBinding(env) {
  const benchmarks = env?.BENCHMARKS;
  if (!benchmarks || typeof benchmarks.get !== 'function' || typeof benchmarks.put !== 'function') {
    throw new Error('BENCHMARKS KV binding is unavailable');
  }
  return benchmarks;
}

async function deploymentMarker(request, env) {
  const markerUrl = new URL('/deployment.json', request.url);
  const response = await assetsBinding(env).fetch(new Request(markerUrl, { method: 'GET' }));
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
  let benchmarks;
  try {
    deployment = await deploymentMarker(request, env);
    benchmarks = benchmarkBinding(env);
  } catch (error) {
    return json({ ok: false, error: 'benchmark_backend_unavailable', detail: String(error?.message || error) }, 503);
  }

  const receivedAt = new Date().toISOString();
  const id = crypto.randomUUID();
  const record = { ...payload, deployment, server_received_at: receivedAt, benchmark_record_id: id };
  const serialized = JSON.stringify(record);
  const timestamp = Date.now();
  try {
    await Promise.all([
      benchmarks.put(`${KEY_PREFIX}run:${deployment.sha}:${timestamp}:${id}`, serialized, { expirationTtl: BENCHMARK_TTL_SECONDS }),
      benchmarks.put(`${KEY_PREFIX}latest:${deployment.sha}`, serialized, { expirationTtl: BENCHMARK_TTL_SECONDS }),
      benchmarks.put(`${KEY_PREFIX}latest`, serialized, { expirationTtl: BENCHMARK_TTL_SECONDS }),
    ]);
  } catch (error) {
    return json({ ok: false, error: 'benchmark_storage_failed', detail: String(error?.message || error) }, 503);
  }
  return json({ ok: true, id, sha: deployment.sha, schema: payload.schema, received_at: receivedAt });
}

async function storedBenchmark(env, requestedSha) {
  let benchmarks;
  try {
    benchmarks = benchmarkBinding(env);
  } catch (error) {
    return { response: json({ ok: false, error: 'benchmark_backend_unavailable', detail: String(error?.message || error) }, 503) };
  }

  let serialized;
  try {
    serialized = await benchmarks.get(`${KEY_PREFIX}latest:${requestedSha}`);
  } catch (error) {
    return { response: json({ ok: false, error: 'benchmark_storage_failed', detail: String(error?.message || error) }, 503) };
  }
  if (!serialized) return { response: json({ ok: false, error: 'benchmark_not_found', sha: requestedSha }, 404) };

  let record;
  try {
    record = JSON.parse(serialized);
  } catch {
    return { response: json({ ok: false, error: 'stored_benchmark_invalid' }, 500) };
  }
  if (record?.deployment?.sha !== requestedSha) {
    return {
      response: json({
        ok: false,
        error: 'benchmark_sha_mismatch',
        requested_sha: requestedSha,
        stored_sha: record?.deployment?.sha ?? null,
      }, 409),
    };
  }
  return { record, serialized };
}

function exactBenchmarkResponse(request, stored, requestedSha) {
  const validator = String(stored.record?.benchmark_record_id || stored.record?.run_id || requestedSha)
    .replace(/[^A-Za-z0-9._-]/g, '');
  const etag = `"${validator}"`;
  const cacheHeaders = {
    etag,
    'cache-control': EXACT_CACHE_CONTROL,
    'cdn-cache-control': 'public, max-age=300',
  };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: cacheHeaders });
  return new Response(`${stored.serialized}\n`, {
    headers: {
      ...cacheHeaders,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function readExactBenchmark(request, env, requestedSha) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!SHA_PATTERN.test(requestedSha)) return json({ ok: false, error: 'invalid_sha' }, 400);
  const stored = await storedBenchmark(env, requestedSha);
  if (stored.response) return stored.response;
  return exactBenchmarkResponse(request, stored, requestedSha);
}

async function readLatest(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const requestedSha = new URL(request.url).searchParams.get('sha');
  if (requestedSha !== null) return readExactBenchmark(request, env, requestedSha);

  let deployment;
  let benchmarks;
  try {
    deployment = await deploymentMarker(request, env);
    benchmarks = benchmarkBinding(env);
  } catch (error) {
    return json({ ok: false, error: 'benchmark_backend_unavailable', detail: String(error?.message || error) }, 503);
  }
  let serialized;
  try {
    serialized = await benchmarks.get(`${KEY_PREFIX}latest:${deployment.sha}`);
  } catch (error) {
    return json({ ok: false, error: 'benchmark_storage_failed', detail: String(error?.message || error) }, 503);
  }
  if (!serialized) return json({ ok: false, error: 'benchmark_not_found', sha: deployment.sha }, 404);
  return new Response(`${serialized}\n`, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/benchmarks') return await storeBenchmark(request, env);
      if (url.pathname === '/api/benchmarks/latest') return await readLatest(request, env);
      const readbackMatch = url.pathname.match(/^\/api\/benchmarks\/readback\/([0-9a-f]{40})$/);
      if (readbackMatch) return await readExactBenchmark(request, env, readbackMatch[1]);
      return await assetsBinding(env).fetch(request);
    } catch (error) {
      return json({ ok: false, error: 'worker_runtime_error', detail: String(error?.message || error) }, 500);
    }
  },
};
