const KEY_PREFIX = 'knockout:';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const CACHE_CONTROL = 'public, max-age=60, s-maxage=300, stale-while-revalidate=60';

function json(data, status = 200) {
  return new Response(`${JSON.stringify(data)}\n`, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function storedBenchmark(env, requestedSha) {
  if (!env.BENCHMARKS) return { response: json({ ok: false, error: 'benchmarks_binding_unavailable' }, 503) };
  const key = requestedSha ? `${KEY_PREFIX}latest:${requestedSha}` : `${KEY_PREFIX}latest`;
  const serialized = await env.BENCHMARKS.get(key);
  if (!serialized) return { response: json({ ok: false, error: 'benchmark_not_found', sha: requestedSha }, 404) };

  let record;
  try { record = JSON.parse(serialized); }
  catch { return { response: json({ ok: false, error: 'stored_benchmark_invalid' }, 500) }; }

  if (requestedSha && record?.deployment?.sha !== requestedSha) {
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

function cacheableResponse(request, stored, requestedSha) {
  const validator = String(stored.record?.benchmark_record_id || stored.record?.run_id || requestedSha)
    .replace(/[^A-Za-z0-9._-]/g, '');
  const etag = `\"${validator}\"`;
  const headers = {
    etag,
    'cache-control': CACHE_CONTROL,
    'cdn-cache-control': 'public, max-age=300',
  };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
  return new Response(`${stored.serialized}\n`, {
    headers: {
      ...headers,
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

async function readBenchmark(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  const url = new URL(request.url);
  const requestedSha = url.searchParams.get('sha');
  if (requestedSha !== null && !SHA_PATTERN.test(requestedSha)) {
    return json({ ok: false, error: 'invalid_sha' }, 400);
  }
  const stored = await storedBenchmark(env, requestedSha);
  if (stored.response) return stored.response;
  if (requestedSha) return cacheableResponse(request, stored, requestedSha);
  return new Response(`${stored.serialized}\n`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function readCacheableBenchmark(request, env, requestedSha) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!SHA_PATTERN.test(requestedSha)) return json({ ok: false, error: 'invalid_sha' }, 400);
  const stored = await storedBenchmark(env, requestedSha);
  if (stored.response) return stored.response;
  return cacheableResponse(request, stored, requestedSha);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/benchmarks/latest') return readBenchmark(request, env);
    const cachedMatch = url.pathname.match(/^\/api\/benchmarks\/readback\/([0-9a-f]{40})$/);
    if (cachedMatch) return readCacheableBenchmark(request, env, cachedMatch[1]);
    if (!env.ASSETS) return json({ ok: false, error: 'assets_binding_unavailable' }, 503);
    return env.ASSETS.fetch(request);
  },
};
