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

async function readBenchmark(request, env) {
  if (request.method !== 'GET') return json({ ok: false, error: 'method_not_allowed' }, 405);
  if (!env.BENCHMARKS) return json({ ok: false, error: 'benchmarks_binding_unavailable' }, 503);

  const url = new URL(request.url);
  const requestedSha = url.searchParams.get('sha');
  if (requestedSha !== null && !/^[0-9a-f]{40}$/.test(requestedSha)) {
    return json({ ok: false, error: 'invalid_sha' }, 400);
  }

  const key = requestedSha ? `${KEY_PREFIX}latest:${requestedSha}` : `${KEY_PREFIX}latest`;
  const serialized = await env.BENCHMARKS.get(key);
  if (!serialized) return json({ ok: false, error: 'benchmark_not_found', sha: requestedSha }, 404);

  let record;
  try { record = JSON.parse(serialized); }
  catch { return json({ ok: false, error: 'stored_benchmark_invalid' }, 500); }

  if (requestedSha && record?.deployment?.sha !== requestedSha) {
    return json({ ok: false, error: 'benchmark_sha_mismatch', requested_sha: requestedSha, stored_sha: record?.deployment?.sha ?? null }, 409);
  }

  return new Response(`${JSON.stringify(record)}\n`, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/benchmarks/latest') return readBenchmark(request, env);
    if (!env.ASSETS) return json({ ok: false, error: 'assets_binding_unavailable' }, 503);
    return env.ASSETS.fetch(request);
  },
};
