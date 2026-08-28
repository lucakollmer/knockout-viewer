Benchmark API routing is restricted to `/api/benchmarks` and `/api/benchmarks/latest`. Static assets are served directly by Cloudflare Assets; the Worker retains a defensive ASSETS fallback only if invoked for a non-API request. Missing ASSETS or BENCHMARKS bindings return diagnostic responses rather than uncaught exceptions.

This routing hardening was added after the first benchmark preview returned Cloudflare error 1101 before the benchmark page could load. The change does not modify the Asets algorithm or benchmark scenarios.
