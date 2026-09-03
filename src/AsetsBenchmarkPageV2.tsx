/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Paper from '@mui/material/Paper';
import Stack from '@mui/material/Stack';
import Typography from '@mui/material/Typography';
import asetsWorkerUrl from './workers/asets.worker.ts?worker&url';
import type { Point } from './asetsCore';
import type { AsetsCompleteMessage, AsetsWorkerMessage, AsetsWorkerRequest } from './asetsProtocol';

const CASE_TIMEOUT_MS = 60_000;
const EVENT_LOOP_SAMPLE_MS = 16;
const SUITE = [
  { r: 50, cold: [1, 24, 49] as Point, warm: [1, 13, 37] as Point },
  { r: 100, cold: [1, 49, 99] as Point, warm: [1, 31, 99] as Point },
  { r: 150, cold: [1, 73, 149] as Point, warm: [1, 47, 149] as Point },
  { r: 200, cold: [1, 99, 199] as Point, warm: [1, 61, 199] as Point },
] as const;

type ScenarioMode = 'cold' | 'same_modulus_warm' | 'persistent_cache_hit' | 'cancel_probe';

type ScenarioResult = {
  id: string;
  mode: ScenarioMode;
  r: number;
  residues: Point;
  wall_ms: number;
  first_message_ms: number | null;
  first_chunk_ms: number | null;
  records_received: number;
  status_messages: number;
  family_key: readonly unknown[] | null;
  effective_modulus: number | null;
  effective_residues: Point | null;
  cached: boolean | null;
  timed_out: boolean;
  cancelled: boolean;
  error: string | null;
  main_thread_delay_p95_ms: number;
  main_thread_delay_max_ms: number;
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
    harness_version: 2;
    case_timeout_ms: number;
    event_loop_sample_ms: number;
    safety_stop: ScenarioResult | null;
    scenarios: ScenarioResult[];
  };
};

type StoredResponse = { ok: true; id: string; sha: string; schema: string; received_at: string };

type DelayProbe = {
  stop: () => { p95: number; max: number };
};

function percentile95(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function startDelayProbe(): DelayProbe {
  const delays: number[] = [];
  let previous = performance.now();
  const interval = window.setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - previous - EVENT_LOOP_SAMPLE_MS));
    previous = now;
  }, EVENT_LOOP_SAMPLE_MS);
  return {
    stop: () => {
      window.clearInterval(interval);
      return {
        p95: percentile95(delays),
        max: delays.length ? Math.max(...delays) : 0,
      };
    },
  };
}

function createBenchmarkWorker(cacheScope: string): Worker {
  // Vite resolves ?worker&url to the production worker asset first. We then add
  // only the benchmark cache scope to that already-bundled URL.
  const resolved = new URL(asetsWorkerUrl, window.location.href);
  resolved.searchParams.set('cache', cacheScope);
  return new Worker(resolved, {
    type: 'module',
    name: `knockout-asets-benchmark-${cacheScope}`,
  });
}

function heapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return Number.isFinite(memory?.usedJSHeapSize) ? Number(memory?.usedJSHeapSize) : null;
}

function runRequest(
  worker: Worker,
  id: string,
  mode: ScenarioMode,
  r: number,
  residues: Point,
  requestId: number,
  timeoutMs = CASE_TIMEOUT_MS,
): Promise<ScenarioResult> {
  return new Promise((resolve) => {
    const started = performance.now();
    const delayProbe = startDelayProbe();
    let firstMessageMs: number | null = null;
    let firstChunkMs: number | null = null;
    let recordsReceived = 0;
    let statusMessages = 0;
    let settled = false;
    let timeout = 0;
    let lastFamilyKey: readonly unknown[] | null = null;
    let effectiveModulus: number | null = null;
    let effectiveResidues: Point | null = null;

    const finish = (partial: Partial<ScenarioResult>) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
      worker.removeEventListener('messageerror', onMessageError);
      const mainThread = delayProbe.stop();
      resolve({
        id,
        mode,
        r,
        residues,
        wall_ms: performance.now() - started,
        first_message_ms: firstMessageMs,
        first_chunk_ms: firstChunkMs,
        records_received: recordsReceived,
        status_messages: statusMessages,
        family_key: lastFamilyKey,
        effective_modulus: effectiveModulus,
        effective_residues: effectiveResidues,
        cached: null,
        timed_out: false,
        cancelled: false,
        error: null,
        main_thread_delay_p95_ms: mainThread.p95,
        main_thread_delay_max_ms: mainThread.max,
        performance: null,
        ...partial,
      });
    };

    const onMessage = (event: MessageEvent<AsetsWorkerMessage>) => {
      const message = event.data;
      if (message.requestId !== requestId) return;
      if (firstMessageMs === null) firstMessageMs = performance.now() - started;
      if ('familyKey' in message && message.familyKey) lastFamilyKey = message.familyKey;
      if ('certificate' in message && message.certificate) {
        effectiveModulus = message.certificate.effectiveModulus;
        effectiveResidues = message.certificate.canonicalResidues;
      }
      if (message.type === 'status') {
        statusMessages += 1;
      } else if (message.type === 'chunk') {
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

    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      finish({ error: `worker error: ${event.message || 'failed to load or start'}` });
    };

    const onMessageError = () => {
      finish({ error: 'worker message deserialization error' });
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.addEventListener('messageerror', onMessageError);
    timeout = window.setTimeout(() => {
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

function runCancelProbe(cacheScope: string, requestId: number): Promise<ScenarioResult> {
  return new Promise((resolve) => {
    const r = 400;
    const residues: Point = [1, 199, 399];
    const worker = createBenchmarkWorker(`${cacheScope}-cancel`);
    const started = performance.now();
    const delayProbe = startDelayProbe();
    let completed = false;
    let settled = false;
    let records = 0;
    let statuses = 0;
    let firstMessage: number | null = null;
    let firstChunk: number | null = null;

    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      const mainThread = delayProbe.stop();
      worker.terminate();
      resolve({
        id: 'cancel-r400-after-250ms',
        mode: 'cancel_probe',
        r,
        residues,
        wall_ms: performance.now() - started,
        first_message_ms: firstMessage,
        first_chunk_ms: firstChunk,
        records_received: records,
        status_messages: statuses,
        family_key: null,
        effective_modulus: null,
        effective_residues: null,
        cached: null,
        timed_out: false,
        cancelled: !completed && error === null,
        error: completed ? 'completed before cancellation probe fired' : error,
        main_thread_delay_p95_ms: mainThread.p95,
        main_thread_delay_max_ms: mainThread.max,
        performance: null,
      });
    };

    worker.addEventListener('message', (event: MessageEvent<AsetsWorkerMessage>) => {
      const message = event.data;
      if (message.requestId !== requestId) return;
      if (firstMessage === null) firstMessage = performance.now() - started;
      if (message.type === 'status') statuses += 1;
      if (message.type === 'chunk') {
        records += message.records.length;
        if (firstChunk === null) firstChunk = performance.now() - started;
      }
      if (message.type === 'complete') completed = true;
      if (message.type === 'error') finish(message.message);
    });
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      finish(`worker error: ${event.message || 'failed to load or start'}`);
    });
    worker.addEventListener('messageerror', () => finish('worker message deserialization error'));

    const request: AsetsWorkerRequest = { type: 'compute', requestId, r, residues, includeRecords: true };
    worker.postMessage(request);
    window.setTimeout(() => finish(null), 250);
  });
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

export default function AsetsBenchmarkPageV2() {
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
          harness_version: 2,
          case_timeout_ms: CASE_TIMEOUT_MS,
          event_loop_sample_ms: EVENT_LOOP_SAMPLE_MS,
          safety_stop: safetyStop,
          scenarios,
        },
      };
      const storedResult = await upload(payload);
      setStored(storedResult);
      setStatus('uploaded');
      console.log('Knockout Asets benchmark v2 uploaded', payload, storedResult);
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
      <Paper variant="outlined" sx={{ maxWidth: 1180, mx: 'auto', overflow: 'hidden' }}>
        <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" sx={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 2 }}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>Asets browser benchmark v2</Typography>
              <Typography variant="body2" color="text.secondary">Bundled production Worker + isolated IndexedDB + main-thread responsiveness. Runs automatically and uploads to Cloudflare.</Typography>
            </Box>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{(elapsedMs / 1000).toFixed(1)} s</Typography>
          </Stack>
        </Box>
        {status !== 'uploaded' && status !== 'failed' ? <LinearProgress /> : null}
        <Stack spacing={1.5} sx={{ p: 2 }}>
          <Typography variant="body2"><b>Status:</b> {status}</Typography>
          {error ? <Alert severity="error">{error}</Alert> : null}
          {stored ? <Alert severity="success">Uploaded benchmark {stored.id} for {stored.sha.slice(0, 12)}.</Alert> : null}
          <Box sx={{ width: '100%', overflowX: 'auto' }}>
            <Box component="table" sx={{ width: '100%', minWidth: 1080, borderCollapse: 'collapse', fontSize: 13 }}>
              <Box component="thead"><Box component="tr">
                {['scenario', 'wall', 'first msg', 'first chunk', 'records', 'context', 'CSP', 'geometry', 'IDB', 'main p95', 'main max'].map((label) => (
                  <Box component="th" key={label} sx={{ textAlign: 'left', p: 0.75, borderBottom: 1, borderColor: 'divider', whiteSpace: 'nowrap' }}>{label}</Box>
                ))}
              </Box></Box>
              <Box component="tbody">
                {results.map((result) => (
                  <Box component="tr" key={result.id}>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider', whiteSpace: 'nowrap' }}>{result.id}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.wall_ms.toFixed(1)}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.first_message_ms?.toFixed(1) ?? '—'}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.first_chunk_ms?.toFixed(1) ?? '—'}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.records_received.toLocaleString()}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.performance?.modulusContextSetupMs.toFixed(1) ?? '—'}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.performance?.candidateCspEnumerationMs.toFixed(1) ?? '—'}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.performance?.geometryMs.toFixed(1) ?? '—'}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.cached ? result.performance?.indexedDbReadMs.toFixed(1) ?? '—' : result.performance?.indexedDbWriteMs.toFixed(1) ?? '—'}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.main_thread_delay_p95_ms.toFixed(1)}</Box>
                    <Box component="td" sx={{ p: 0.75, borderBottom: 1, borderColor: 'divider' }}>{result.main_thread_delay_max_ms.toFixed(1)}</Box>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
          <Button variant="outlined" onClick={() => void run()} disabled={runningRef.current}>Run again</Button>
        </Stack>
      </Paper>
    </Box>
  );
}
