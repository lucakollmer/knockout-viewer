# Asets browser benchmark v2

Benchmark v1 run `3435985c-ab02-4a31-ace3-437d0815299b` is not performance evidence: the first r=50 case received no Worker message, no family key, no record chunk, and timed out at 20 seconds. The v1 harness constructed the Worker through an intermediate URL object and did not listen for Worker startup errors.

Benchmark v2 imports the production Asets Worker through Vite `?worker&url`, appends the disposable IndexedDB cache scope only after Vite resolves the bundled asset URL, reports `error` and `messageerror` immediately, and measures first Worker message, first record chunk, stage timings, persistent cache-hit latency, and main-thread event-loop delay. The Asets algorithm/runtime is unchanged by this harness correction.
