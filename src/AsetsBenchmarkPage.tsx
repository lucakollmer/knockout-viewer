import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import type { Point } from './asetsCore';
import type { AsetsCompleteMessage, AsetsWorkerMessage, AsetsWorkerRequest } from './asetsProtocol';

const CASE_TIMEOUT_MS = 20_000;
const SUITE = [
  { r: 50, cold: [1, 24, 49] as Point, warm: [1, 13, 37] as Point },
  { r: 100, cold: [1, 49, 99] as Point, warm: [1, 31, 99] as Point },
  { r: 150, cold: [1, 73, 149] as Point, warm: [1, 47, 149] as Point },
  { r: 200, cold: [1, 99, 199] as Point, warm: [1, 61, 199] as Point },
] as const;

type ScenarioResult = {
  id: string;
  mode: 'cold' | 'same_modulus_warm' | 'persistent_cache_hit' | 'cancel_probe';
  r: number;
  residues: Point;
  wall_ms: number;
  first_chunk_ms: number | null;
  records_received: number;
  family_key: readonly unknown[] | null;
  effective_modulus: number | null;
  effective_residues: Point | null;
  cached: boolean | null;
  timed_out: boolean;
  cancelled: boolean;
  error: string | null;
  performance: AsetsCompleteMessage['header']['performance'] | null;
};

type BenchmarkPayload = {
  schema: 'knockout-asets.benchmark/v1';
  run_id: string;
  started_at: string;
  completed_at: string;
  deployment: unknown;
  client: Record<string, unknown>;
  benchmark: {
    suite: 'interactive-asets-v1';
    case_timeout_ms: number;
    safety_stop: ScenarioResult | null;
    scenarios: ScenarioResult[];
  };
};

type StoredResponse = { ok: true; id: string; sha: string; schema: string; received_at: string };

function createBenchmarkWorker(cacheScope: string): Worker {
  const url = new URL('./workers/asets.worker.ts', import.meta.url);
  url.searchParams.set('cache', cacheScope);
  return new Worker(url, { type: 'module' });
}

function heapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return Number.isFinite(memory?.usedJSHeapSize) ? Number(memory?.usedJSHeapSize) : null;
}

async function runRequest(
  worker: Worker,
  id: string,
  mode: ScenarioResult['mode'],
  r: number,
  residues: Point,
  requestId: number,
  timeoutMs = CASE_TIMEOUT_MS,
): Promise<ScenarioResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    let firstChunkMs: number | null = null;
    let recordsReceived = 0;
    let settled = false;
    let lastFamilyKey: readonly unknown[] | null = null;
    let effectiveModulus: number | null = null;
    let effectiveResidues: Point | null = null;

    const finish = (partial: Partial<ScenarioResult>) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      worker.removeEventListener('message', onMessage);
      resolve({
        id,
        mode,
        r,
        residues,
        wall_ms: performance.now() - started,
        first_chunk_ms: firstChunkMs,
        records_received: recordsReceived,
        family_key: lastFamilyKey,
        effective_modulus: effectiveModulus,
        effective_residues: effectiveResidues,
        cached: null,
        timed_out: false,
        cancelled: false,
        error: null,
        performance: null,
        ...partial,
      });
    };

    const onMessage = (event: MessageEvent<AsetsWorkerMessage>) => {
      const message = event.data;
      if (message.requestId !== requestId) return;
      if ('familyKey' in message && message.familyKey) lastFamilyKey = message.familyKey;
      if ('certificate' in message && message.certificate) {
        effectiveModulus = message.certificate.effectiveModulus;
        effectiveResidues = message.certificate.canonicalResidues;
      }
      if (message.type === 'chunk') {
        if (firstChunkMs === null) firstChunkMs = performance.now() - started;
        recordsReceived += message.records.length;
      } else if (message.type === 'complete') {
        finish({
          cached: message.cached,
          performance: message.header.performance,
          effective_modulus: message.certificate.effectiveModulus,
          effective_residues: message.certificate.canonicalResidues,
        });
      } else if (message.type === 'cancelled') {
        finish({ cancelled: true });
      } else if (message.type === 'error') {
        finish({ error: message.message });
      }
    };

    worker.addEventListener('message', onMessage);
    const timeout = window.setTimeout(() => {
      worker.terminate();
      finish({ timed_out: true, error: `timeout after ${timeoutMs} ms` });
    }, timeoutMs);
    const request: AsetsWorkerRequest = {
      type: 'compute',
      requestId,
      r,
      residues,
      includeRecords: true,
      groupId: `benchmark:${id}`,
    };
    worker.postMessage(request);
  });
}

async function runCancelProbe(cacheScope: string, requestId: number): Promise<ScenarioResult> {
  const r = 400;
  const residues: Point = [1, 199, 399];
  const worker = createBenchmarkWorker(`${cacheScope}-cancel`);
  const started = performance.now();
  let completed = false;
  let records = 0;
  let firstChunk: number | null = null;
  worker.onmessage = (event: MessageEvent<AsetsWorkerMessage>) => {
    const message = event.data;
    if (message.requestId !== requestId) return;
    if (message.type === 'chunk') {
      records += message.records.length;
      if (firstChunk === null) firstChunk = performance.now() - started;
    }
    if (message.type === 'complete') completed = true;
  };
  const request: AsetsWorkerRequest = { type: 'compute', requestId, r, residues, includeRecords: true };
  worker.postMessage(request);
  await new Promise((resolve) => window.setTimeout(resolve, 250));
  worker.terminate();
  return {
    id: 'cancel-r400-after-250ms', mode: 'cancel_probe', r, residues,
    wall_ms: performance.now() - started, first_chunk_ms: firstChunk, records_received: records,
    family_key: null, effective_modulus: null, effective_residues: null,
    cached: null, timed_out: false, cancelled: !completed,
    error: completed ? 'completed before cancellation probe fired' : null,
    performance: null,
  };
}

async function deploymentMarker(): Promise<unknown> {
  const response = await fetch('/deployment.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`deployment marker HTTP ${response.status}`);
  return response.json();
}

async function upload(payload: BenchmarkPayload): Promise<StoredResponse> {
  const response = await fetch('/api/benchmarks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`benchmark upload HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as StoredResponse;
}

export default function AsetsBenchmarkPage() {
  const runningRef = useRef(false);
  const [status, setStatus] = useState('ready');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [results, setResults] = useState<ScenarioResult[]>([]);
  const [stored, setStored] = useState<StoredResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setStored(null);
    setError(null);
    setResults([]);
    const runId = crypto.randomUUID();
    const cacheScope = `benchmark-${runId}`;
    const startedAt = new Date().toISOString();
    const wallStart = performance.now();
    const timer = window.setInterval(() => setElapsedMs(performance.now() - wallStart), 100);
    let requestId = 1;
    const scenarios: ScenarioResult[] = [];
    let safetyStop: ScenarioResult | null = null;

    try {
      for (const definition of SUITE) {
        setStatus(`r=${definition.r}: cold family`);
        let worker = createBenchmarkWorker(cacheScope);
        const cold = await runRequest(worker, `r${definition.r}-cold`, 'cold', definition.r, definition.cold, requestId++);
        scenarios.push(cold);
        setResults([...scenarios]);
        if (cold.timed_out || cold.error) {
          safetyStop = cold;
          worker.terminate();
          break;
        }

        setStatus(`r=${definition.r}: same-modulus warm family`);
        const warm = await runRequest(worker, `r${definition.r}-same-modulus`, 'same_modulus_warm', definition.r, definition.warm, requestId++);
        scenarios.push(warm);
        setResults([...scenarios]);
        worker.terminate();
        if (warm.timed_out || warm.error) {
          safetyStop = warm;
          break;
        }

        setStatus(`r=${definition.r}: persistent cache hit`);
        worker = createBenchmarkWorker(cacheScope);
        const cached = await runRequest(worker, `r${definition.r}-cache-hit`, 'persistent_cache_hit', definition.r, definition.cold, requestId++);
        scenarios.push(cached);
        setResults([...scenarios]);
        worker.terminate();
        if (cached.timed_out || cached.error) {
          safetyStop = cached;
          break;
        }

        await new Promise((resolve) => window.setTimeout(resolve, 0));
      }

      if (!safetyStop) {
        setStatus('cancellation probe');
        const cancelResult = await runCancelProbe(cacheScope, requestId++);
        scenarios.push(cancelResult);
        setResults([...scenarios]);
      }

      setStatus('uploading');
      const deployment = await deploymentMarker();
      const payload: BenchmarkPayload = {
        schema: 'knockout-asets.benchmark/v1',
        run_id: runId,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        deployment,
        client: {
          user_agent: navigator.userAgent,
          language: navigator.language,
          device_pixel_ratio: window.devicePixelRatio || 1,
          hardware_concurrency: navigator.hardwareConcurrency || null,
          device_memory_gb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
          cross_origin_isolated: window.crossOriginIsolated,
          page_heap_bytes: heapBytes(),
        },
        benchmark: {
          suite: 'interactive-asets-v1',
          case_timeout_ms: CASE_TIMEOUT_MS,
          safety_stop: safetyStop,
          scenarios,
        },
      };
      const storedResult = await upload(payload);
      setStored(storedResult);
      setStatus('uploaded');
      console.log('Knockout Asets benchmark uploaded', payload, storedResult);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      setStatus('failed');
    } finally {
      window.clearInterval(timer);
      setElapsedMs(performance.now() - wallStart);
      runningRef.current = false;
    }
  };

  useEffect(() => { void run(); }, []);

  return (
    <Box sx={{ minHeight: '100dvh', bgcolor: 'background.default', p: { xs: 2, md: 4 } }}>
      <Paper variant="outlined" sx={{ maxWidth: 980, mx: 'auto', overflow: 'hidden' }}>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 2 }}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>Asets browser benchmark</Typography>
              <Typography variant="body2" color="text.secondary">Real Web Worker + IndexedDB path. Runs automatically and uploads to Cloudflare.</Typography>
            </Box>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{(elapsedMs / 1000).toFixed(1)} s</Typography>
          </Stack>
        </Box>
        {status !== 'uploaded' && status !== 'failed' ? <LinearProgress /> : null}
        <Stack spacing={1.5} sx={{ p: 2 }}>
          <Typography variant="body2"><b>Status:</b> {status}</Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {stored ? <Alert severity="success">Uploaded benchmark {stored.id} for {stored.sha.slice(0, 12)}.</Alert> : null}
          <Box component="table" sx={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <Box component="thead"><Box component="tr">
              {['scenario', 'wall', 'first chunk', 'records', 'context', 'CSP', 'geometry', 'IDB'].map((label) => (
                <Box component="th" key={label} sx={{ textAlign: 'left', p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{label}</Box>
              ))}
            </Box></Box>
            <Box component="tbody">
              {results.map((result) => (
                <Box component="tr" key={result.id}>
                  <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.id}</Box>
                  <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.wall_ms.toFixed(1)} ms</Box>
                  <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.first_chunk_ms?.toFixed(1) ?? '—'}</Box>
                  <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.records_received.toLocaleString()}</Box>
                  <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.performance?.modulusContextSetupMs.toFixed(1) ?? '—'}</Box>
                  <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.performance?.candidateCspEnumerationMs.toFixed(1) ?? '—'}</Box>
                  <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.performance?.geometryMs.toFixed(1) ?? '—'}</Box>
                  <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.cached ? result.performance?.indexedDbReadMs.toFixed(1) ?? '—' : result.performance?.indexedDbWriteMs.toFixed(1) ?? '—'}</Box>
                </Box>
              ))}
            </Box>
          </Box>
          <Button variant="outlined" onClick={() => void run()} disabled={runningRef.current}>Run again</Button>
        </Stack>
      </Paper>
    </Box>
  );
}
