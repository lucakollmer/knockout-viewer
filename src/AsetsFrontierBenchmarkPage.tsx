/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import asetsWorkerUrl from './workers/asets.worker.ts?worker&url';
import type { Point } from './asetsCore';
import type { AsetsCompleteMessage, AsetsWorkerMessage, AsetsWorkerRequest } from './asetsProtocol';

const CASE_TIMEOUT_MS = 6_000;
const EVENT_LOOP_SAMPLE_MS = 16;
const THRESHOLDS_MS = [1_000, 5_000] as const;
const MAX_SCENARIOS = 30;

type Profile = {
  id: string;
  label: string;
  residues: (r: number) => Point;
};

const PROFILES: readonly Profile[] = [
  {
    id: 'balanced-half',
    label: 'balanced half',
    residues: (r) => [1, Math.max(2, Math.floor(r / 2) - 1), r - 1],
  },
  {
    id: 'balanced-third',
    label: 'balanced third',
    residues: (r) => [1, Math.max(2, Math.floor(r / 3)), r - 1],
  },
];

type ScenarioResult = {
  id: string;
  mode: 'cold';
  r: number;
  residues: Point;
  profile: string;
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

type RObservation = {
  r: number;
  scenarios: ScenarioResult[];
  worst_wall_ms: number;
  passed_1s: boolean;
  passed_5s: boolean;
};

type Frontier = {
  threshold_ms: number;
  largest_tested_passing_r: number | null;
  smallest_tested_failing_r: number | null;
};

type StoredResponse = { ok: true; id: string; sha: string; schema: string; received_at: string };

type DelayProbe = { stop: () => { p95: number; max: number } };

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
      return { p95: percentile95(delays), max: delays.length ? Math.max(...delays) : 0 };
    },
  };
}

function maxExactR(): number {
  let r = 1;
  while (Number.isSafeInteger(27 * (r + 1) ** 5)) r += 1;
  return r;
}

function createBenchmarkWorker(cacheScope: string): Worker {
  const resolved = new URL(asetsWorkerUrl, window.location.href);
  resolved.searchParams.set('cache', cacheScope);
  return new Worker(resolved, { type: 'module', name: `knockout-asets-frontier-${cacheScope}` });
}

function deleteBenchmarkCache(cacheScope: string): Promise<void> {
  if (!('indexedDB' in window)) return Promise.resolve();
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(`knockout-asets-cache-${cacheScope}`);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function runCase(runId: string, profile: Profile, r: number, requestId: number): Promise<ScenarioResult> {
  return new Promise((resolve) => {
    const residues = profile.residues(r);
    const cacheScope = `frontier-${runId}-${profile.id}-r${r}`;
    const worker = createBenchmarkWorker(cacheScope);
    const started = performance.now();
    const delayProbe = startDelayProbe();
    let firstMessageMs: number | null = null;
    let firstChunkMs: number | null = null;
    let recordsReceived = 0;
    let statusMessages = 0;
    let familyKey: readonly unknown[] | null = null;
    let effectiveModulus: number | null = null;
    let effectiveResidues: Point | null = null;
    let settled = false;
    let timeout = 0;

    const finish = (partial: Partial<ScenarioResult>) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      const mainThread = delayProbe.stop();
      worker.terminate();
      void deleteBenchmarkCache(cacheScope);
      resolve({
        id: `frontier-${profile.id}-r${r}`,
        mode: 'cold',
        r,
        residues,
        profile: profile.id,
        wall_ms: performance.now() - started,
        first_message_ms: firstMessageMs,
        first_chunk_ms: firstChunkMs,
        records_received: recordsReceived,
        status_messages: statusMessages,
        family_key: familyKey,
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
      if ('familyKey' in message && message.familyKey) familyKey = message.familyKey;
      if ('certificate' in message && message.certificate) {
        effectiveModulus = message.certificate.effectiveModulus;
        effectiveResidues = message.certificate.canonicalResidues;
      }
      if (message.type === 'status') statusMessages += 1;
      else if (message.type === 'chunk') {
        if (firstChunkMs === null) firstChunkMs = performance.now() - started;
        recordsReceived += message.records.length;
      } else if (message.type === 'complete') {
        finish({
          cached: message.cached,
          performance: message.header.performance,
          effective_modulus: message.certificate.effectiveModulus,
          effective_residues: message.certificate.canonicalResidues,
        });
      } else if (message.type === 'cancelled') finish({ cancelled: true });
      else if (message.type === 'error') finish({ error: message.message });
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      finish({ error: `worker error: ${event.message || 'failed to load or start'}` });
    });
    worker.addEventListener('messageerror', () => finish({ error: 'worker message deserialization error' }));
    timeout = window.setTimeout(() => finish({ timed_out: true, error: `frontier timeout after ${CASE_TIMEOUT_MS} ms` }), CASE_TIMEOUT_MS);

    const request: AsetsWorkerRequest = {
      type: 'compute',
      requestId,
      r,
      residues,
      includeRecords: true,
      groupId: `frontier:${profile.id}:r${r}`,
    };
    worker.postMessage(request);
  });
}

function classify(observation: RObservation, thresholdMs: number): boolean {
  return observation.scenarios.every((scenario) => !scenario.timed_out && !scenario.error && scenario.wall_ms <= thresholdMs);
}

function frontierFor(observations: readonly RObservation[], thresholdMs: number): Frontier {
  const ordered = [...observations].sort((a, b) => a.r - b.r);
  const passing = ordered.filter((observation) => classify(observation, thresholdMs));
  const largestPass = passing.length ? passing[passing.length - 1].r : null;
  const failingAbove = ordered.filter((observation) => !classify(observation, thresholdMs) && (largestPass === null || observation.r > largestPass));
  return {
    threshold_ms: thresholdMs,
    largest_tested_passing_r: largestPass,
    smallest_tested_failing_r: failingAbove.length ? failingAbove[0].r : null,
  };
}

function roundR(value: number): number {
  return Math.max(2, Math.round(value));
}

async function deploymentMarker(): Promise<unknown> {
  const response = await fetch('/deployment.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`deployment marker HTTP ${response.status}`);
  return response.json();
}

async function upload(payload: unknown): Promise<StoredResponse> {
  const response = await fetch('/api/benchmarks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`benchmark upload HTTP ${response.status}: ${text}`);
  return JSON.parse(text) as StoredResponse;
}

export default function AsetsFrontierBenchmarkPage() {
  const runningRef = useRef(false);
  const [status, setStatus] = useState('ready');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [observations, setObservations] = useState<RObservation[]>([]);
  const [stored, setStored] = useState<StoredResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setStored(null);
    setError(null);
    setObservations([]);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const wallStart = performance.now();
    const timer = window.setInterval(() => setElapsedMs(performance.now() - wallStart), 100);
    const maxR = maxExactR();
    const byR = new Map<number, RObservation>();
    const allScenarios: ScenarioResult[] = [];
    let requestId = 1;

    const evaluateR = async (rInput: number): Promise<RObservation> => {
      const r = Math.min(maxR, roundR(rInput));
      const existing = byR.get(r);
      if (existing) return existing;
      if (allScenarios.length + PROFILES.length > MAX_SCENARIOS) throw new Error('frontier benchmark scenario budget exhausted');
      const scenarios: ScenarioResult[] = [];
      for (const profile of PROFILES) {
        setStatus(`testing r=${r} — ${profile.label}`);
        const result = await runCase(runId, profile, r, requestId++);
        scenarios.push(result);
        allScenarios.push(result);
      }
      const worst = Math.max(...scenarios.map((scenario) => scenario.timed_out || scenario.error ? CASE_TIMEOUT_MS : scenario.wall_ms));
      const observation: RObservation = {
        r,
        scenarios,
        worst_wall_ms: worst,
        passed_1s: scenarios.every((scenario) => !scenario.timed_out && !scenario.error && scenario.wall_ms <= THRESHOLDS_MS[0]),
        passed_5s: scenarios.every((scenario) => !scenario.timed_out && !scenario.error && scenario.wall_ms <= THRESHOLDS_MS[1]),
      };
      byR.set(r, observation);
      setObservations([...byR.values()].sort((a, b) => a.r - b.r));
      return observation;
    };

    const refine = async (thresholdMs: number, iterations: number) => {
      for (let iteration = 0; iteration < iterations; iteration += 1) {
        const current = [...byR.values()].sort((a, b) => a.r - b.r);
        const frontier = frontierFor(current, thresholdMs);
        if (frontier.largest_tested_passing_r === null || frontier.smallest_tested_failing_r === null) return;
        const low = frontier.largest_tested_passing_r;
        const high = frontier.smallest_tested_failing_r;
        if (high - low <= 2 || allScenarios.length + PROFILES.length > MAX_SCENARIOS) return;
        const midpoint = roundR((low + high) / 2);
        if (midpoint === low || midpoint === high) return;
        await evaluateR(midpoint);
      }
    };

    try {
      let r = 100;
      let growthSteps = 0;
      while (growthSteps < 7) {
        const observation = await evaluateR(r);
        growthSteps += 1;
        if (!observation.passed_5s || r >= maxR) break;
        const next = Math.min(maxR, Math.ceil((r * 1.35) / 5) * 5);
        if (next === r) break;
        r = next;
      }

      await refine(5_000, 4);
      await refine(1_000, 4);

      const ordered = [...byR.values()].sort((a, b) => a.r - b.r);
      const frontier1s = frontierFor(ordered, 1_000);
      const frontier5s = frontierFor(ordered, 5_000);
      setStatus('uploading');
      const deployment = await deploymentMarker();
      const payload = {
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
        },
        benchmark: {
          suite: 'interactive-asets-v1',
          harness_version: 3,
          benchmark_kind: 'adaptive-r-frontier',
          case_timeout_ms: CASE_TIMEOUT_MS,
          event_loop_sample_ms: EVENT_LOOP_SAMPLE_MS,
          safety_stop: null,
          scenarios: allScenarios,
          frontier: {
            exact_number_backend_max_r: maxR,
            profiles: PROFILES.map((profile) => profile.id),
            classification: 'worst of deterministic sampled families at each r',
            under_1s: frontier1s,
            under_5s: frontier5s,
            observations: ordered.map(({ r: observedR, worst_wall_ms, passed_1s, passed_5s }) => ({ r: observedR, worst_wall_ms, passed_1s, passed_5s })),
          },
          dimension_semantics: {
            family_coordinate_dimension: 3,
            representation_d: 'n+m+k; not a family-computation parameter',
            generalized_block_count_above_3_supported: false,
          },
        },
      };
      const storedResult = await upload(payload);
      setStored(storedResult);
      setStatus('uploaded');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStatus('failed');
    } finally {
      window.clearInterval(timer);
      setElapsedMs(performance.now() - wallStart);
      runningRef.current = false;
    }
  };

  useEffect(() => { void run(); }, []);

  const frontier1s = frontierFor(observations, 1_000);
  const frontier5s = frontierFor(observations, 5_000);
  return (
    <main style={{ maxWidth: 1080, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginBottom: 4 }}>Asets adaptive r-frontier benchmark</h1>
      <p style={{ marginTop: 0, color: '#666' }}>Automatically searches for the largest sampled effective modulus under 1 s and 5 s, then uploads the trace.</p>
      <p><b>Status:</b> {status} · <b>elapsed:</b> {(elapsedMs / 1000).toFixed(1)} s</p>
      <p><b>1 s frontier:</b> {frontier1s.largest_tested_passing_r ?? '—'} {frontier1s.smallest_tested_failing_r ? `(next tested fail ${frontier1s.smallest_tested_failing_r})` : ''}</p>
      <p><b>5 s frontier:</b> {frontier5s.largest_tested_passing_r ?? '—'} {frontier5s.smallest_tested_failing_r ? `(next tested fail ${frontier5s.smallest_tested_failing_r})` : ''}</p>
      {error ? <pre style={{ whiteSpace: 'pre-wrap', color: '#b00020' }}>{error}</pre> : null}
      {stored ? <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(stored, null, 2)}</pre> : null}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 20 }}>
        <thead><tr><th style={{ textAlign: 'left' }}>r</th><th style={{ textAlign: 'right' }}>worst wall</th><th style={{ textAlign: 'center' }}>≤1 s</th><th style={{ textAlign: 'center' }}>≤5 s</th></tr></thead>
        <tbody>{observations.map((observation) => (
          <tr key={observation.r}>
            <td>{observation.r}</td>
            <td style={{ textAlign: 'right' }}>{observation.worst_wall_ms.toFixed(0)} ms</td>
            <td style={{ textAlign: 'center' }}>{observation.passed_1s ? 'yes' : 'no'}</td>
            <td style={{ textAlign: 'center' }}>{observation.passed_5s ? 'yes' : 'no'}</td>
          </tr>
        ))}</tbody>
      </table>
      <p style={{ color: '#666', marginTop: 20 }}>Here d=n+m+k is representation metadata and does not change A-set family compute cost. This engine is genuinely three-coordinate; d&gt;3 as block/coordinate count requires a generalized engine rather than a benchmark flag.</p>
    </main>
  );
}
