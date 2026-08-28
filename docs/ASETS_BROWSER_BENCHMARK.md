# Asets browser benchmark

The review build exposes `?benchmark=asets` as a self-running target-device benchmark for the interactive Asets engine.

The suite uses the same Web Worker computation path as the navigator, but isolates benchmark IndexedDB data under a disposable cache scope so benchmark cold/warm/cache measurements do not alter the normal viewer cache. It exercises deterministic families at effective moduli 50, 100, 150, and 200, records cold, same-modulus warm, persistent IndexedDB cache-hit, first-chunk, worker-stage, and cancellation measurements, then uploads the report to the same-origin Cloudflare Worker endpoint.

Benchmark payload schema: `knockout-asets.benchmark/v1`.

Routes:

- `POST /api/benchmarks` validates and stores the report in Cloudflare KV, stamped with the current `/deployment.json` marker.
- `GET /api/benchmarks/latest` returns the most recent report for the exact deployed SHA.

Stored KV records use the `knockout:` prefix and a 30-day TTL.

The interactive runtime has no product-level modulus cap. It remains exact while the current Number backend's proved integer envelope holds; exceeding that arithmetic envelope is a backend-upgrade condition rather than a normal support limit. Long computations display elapsed time and remain cancellable by terminating the active Worker.
