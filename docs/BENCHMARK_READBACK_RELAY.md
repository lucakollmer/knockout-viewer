# Benchmark readback relay

`knockout.lucakollmer.com/api/benchmarks/latest` provides stable readback of browser benchmark reports stored by review previews in the shared Cloudflare KV namespace. Supplying `?sha=<40-hex-candidate-sha>` returns only the latest report for that exact candidate SHA. This exists so benchmark analysis does not depend on ephemeral `workers.dev` preview hostnames.
