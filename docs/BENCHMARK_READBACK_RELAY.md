# Benchmark readback relay

The unified Cloudflare Worker in `worker/index.js` stores browser benchmark reports in the shared `BENCHMARKS` KV namespace and exposes stable readback routes.

- `POST /api/benchmarks` stores a validated benchmark for the exact deployment SHA.
- `GET /api/benchmarks/latest` returns the latest benchmark for the Worker version serving the request and is `no-store`.
- `GET /api/benchmarks/latest?sha=<40-hex-sha>` returns the latest benchmark for that exact candidate SHA.
- `GET /api/benchmarks/readback/<40-hex-sha>` is the equivalent path-form exact-SHA readback route.

Exact-SHA responses carry an ETag and short shared-cache headers because a benchmark associated with an immutable candidate SHA is stable. The unqualified deployment-local latest route remains `no-store`.
