/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import asetsWorkerUrl from './workers/asets.worker.ts?worker&url';
import type { Point } from './asetsCore';
import { effectiveRuntimeFamily } from './asetsRuntime';
import type { AsetsCompleteMessage, AsetsWorkerMessage, AsetsWorkerRequest } from './asetsProtocol';

const CASE_TIMEOUT_MS = 6_000;
const EVENT_LOOP_SAMPLE_MS = 16;
const THRESHOLDS_MS = [1_000, 5_000] as const;
const MAX_SCENARIOS = 48;
const MATRIX_R_TARGETS = [250, 415, 600, 780] as const;

const PERMUTATIONS_3: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

type BenchmarkAxis = 'frontier' | 'coefficient-matrix';
type BenchmarkScope = 'full' | 'frontier' | 'matrix';

type Profile = {
  id: string;
  label: string;
  residues: (r: number) => Point;
};

function gcd(first: number, second: number): number {
  let a = Math.abs(first);
  let b = Math.abs(second);
  while (a !== 0) {
    const next = b % a;
    b = a;
    a = next;
  }
  return b;
}

function mod(value: number, r: number): number {
  const out = value % r;
  return out < 0 ? out + r : out;
}

function findOrderThreeUnit(r: number): number | null {
  for (let unit = 2; unit < r; unit += 1) {
    if (gcd(unit, r) !== 1) continue;
    if (mod(unit * unit * unit, r) === 1) return unit;
  }
  return null;
}

function orderThreeResidues(r: number): Point {
  const unit = findOrderThreeUnit(r);
  if (unit !== null) return [1, unit, mod(unit * unit, r)];
  return [1, Math.max(2, Math.floor(r / 4)), r - 1];
}

function genericHashResidues(r: number): Point {
  if (r <= 6) return [1, Math.min(2, r - 1), Math.min(3, r - 1)];
  const span = r - 3;
  const a = 2 + mod(r * 97 + 53, span);
  let b = 2 + mod(r * 193 + 101, span);
  for (let attempt = 0; attempt < span; attempt += 1) {
    if (b !== a && mod(a + b, r) !== 0 && b !== r - 1) break;
    b = 2 + mod(b - 1, span);
  }
  return [1, a, b];
}

const FRONTIER_PROFILES: readonly Profile[] = [
  {
    id: 'balanced-half',
    label: 'legacy balanced half',
    residues: (r) => [1, Math.max(2, Math.floor(r / 2) - 1), r - 1],
  },
  {
    id: 'balanced-third',
    label: 'legacy balanced third',
    residues: (r) => [1, Math.max(2, Math.floor(r / 3)), r - 1],
  },
];

const MATRIX_PROFILES: readonly Profile[] = [
  {
    id: 'all-equal',
    label: 'all coefficients equal',
    residues: () => [1, 1, 1],
  },
  {
    id: 'repeated-pair',
    label: 'repeated pair with opposite axis',
    residues: (r) => [1, 1, r - 1],
  },
  {
    id: 'unit-cycle',
    label: 'order-three unit cycle when available',
    residues: orderThreeResidues,
  },
  {
    id: 'generic-hash',
    label: 'deterministic generic coefficients',
    residues: genericHashResidues,
  },
];

type CoefficientMetrics = {
  effective_modulus: number;
  canonical_residues: Point;
  unit_count: number;
  stabilizer_size: number;
  orbit_size: number;
  symmetry_class: 'generic' | 'pair-symmetric' | 'high-symmetry';
  distinct_residue_count: number;
  repeated_pair_count: number;
  opposite_pair_count: number;
  additive_orders: [number, number, number];
  minimum_additive_order: number;
};

function coefficientMetrics(r: number, residues: Point): CoefficientMetrics {
  const normalized = effectiveRuntimeFamily(r, residues);
  const modulus = normalized.r;
  const canonical = normalized.residues;
  if (modulus === 1) {
    return {
      effective_modulus: 1,
      canonical_residues: [0, 0, 0],
      unit_count: 1,
      stabilizer_size: 6,
      orbit_size: 1,
      symmetry_class: 'high-symmetry',
      distinct_residue_count: 1,
      repeated_pair_count: 3,
      opposite_pair_count: 3,
      additive_orders: [1, 1, 1],
      minimum_additive_order: 1,
    };
  }

  const units: number[] = [];
  for (let unit = 1; unit < modulus; unit += 1) if (gcd(unit, modulus) === 1) units.push(unit);
  let stabilizer = 0;
  for (const permutation of PERMUTATIONS_3) {
    for (const unit of units) {
      let matches = true;
      for (let axis = 0; axis < 3; axis += 1) {
        if (mod(unit * canonical[permutation[axis]], modulus) !== canonical[axis]) {
          matches = false;
          break;
        }
      }
      if (matches) stabilizer += 1;
    }
  }

  let repeatedPairs = 0;
  let oppositePairs = 0;
  for (let first = 0; first < 3; first += 1) {
    for (let second = first + 1; second < 3; second += 1) {
      if (canonical[first] === canonical[second]) repeatedPairs += 1;
      if (mod(canonical[first] + canonical[second], modulus) === 0) oppositePairs += 1;
    }
  }
  const orders = canonical.map((value) => modulus / gcd(modulus, value)) as [number, number, number];
  const symmetryClass = stabilizer >= 3
    ? 'high-symmetry'
    : stabilizer === 2
      ? 'pair-symmetric'
      : 'generic';
  return {
    effective_modulus: modulus,
    canonical_residues: canonical,
    unit_count: units.length,
    stabilizer_size: stabilizer,
    orbit_size: Math.floor(6 * units.length / Math.max(1, stabilizer)),
    symmetry_class: symmetryClass,
    distinct_residue_count: new Set(canonical).size,
    repeated_pair_count: repeatedPairs,
    opposite_pair_count: oppositePairs,
    additive_orders: orders,
    minimum_additive_order: Math.min(...orders),
  };
}

type ScenarioResult = {
  id: string;
  benchmark_axis: BenchmarkAxis;
  mode: 'cold';
  r: number;
  residues: Point;
  profile: string;
  coefficient_metrics: CoefficientMetrics;
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

function runCase(
  runId: string,
  axis: BenchmarkAxis,
  profile: Profile,
  r: number,
  requestId: number,
): Promise<ScenarioResult> {
  return new Promise((resolve) => {
    const residues = profile.residues(r);
    const metrics = coefficientMetrics(r, residues);
    const cacheScope = `${axis}-${runId}-${profile.id}-r${r}`;
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
        id: `${axis}-${profile.id}-r${r}`,
        benchmark_axis: axis,
        mode: 'cold',
        r,
        residues,
        profile: profile.id,
        coefficient_metrics: metrics,
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
    timeout = window.setTimeout(
      () => finish({ timed_out: true, error: `frontier timeout after ${CASE_TIMEOUT_MS} ms` }),
      CASE_TIMEOUT_MS,
    );

    const request: AsetsWorkerRequest = {
      type: 'compute',
      requestId,
      r,
      residues,
      includeRecords: true,
      groupId: `${axis}:${profile.id}:r${r}`,
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
  const failingAbove = ordered.filter(
    (observation) => !classify(observation, thresholdMs) && (largestPass === null || observation.r > largestPass),
  );
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
  const [matrixScenarios, setMatrixScenarios] = useState<ScenarioResult[]>([]);
  const [stored, setStored] = useState<StoredResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const scopeRaw = new URL(window.location.href).searchParams.get('scope');
  const benchmarkScope: BenchmarkScope = scopeRaw === 'matrix' || scopeRaw === 'frontier' ? scopeRaw : 'full';

  const run = async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setStored(null);
    setError(null);
    setObservations([]);
    setMatrixScenarios([]);
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const wallStart = performance.now();
    const timer = window.setInterval(() => setElapsedMs(performance.now() - wallStart), 100);
    const maxR = maxExactR();
    const byR = new Map<number, RObservation>();
    const allScenarios: ScenarioResult[] = [];
    const matrixResults: ScenarioResult[] = [];
    let requestId = 1;

    const evaluateR = async (rInput: number): Promise<RObservation> => {
      const r = Math.min(maxR, roundR(rInput));
      const existing = byR.get(r);
      if (existing) return existing;
      if (allScenarios.length + FRONTIER_PROFILES.length > MAX_SCENARIOS) {
        throw new Error('frontier benchmark scenario budget exhausted');
      }
      const scenarios: ScenarioResult[] = [];
      for (const profile of FRONTIER_PROFILES) {
        setStatus(`frontier r=${r} — ${profile.label}`);
        const result = await runCase(runId, 'frontier', profile, r, requestId++);
        scenarios.push(result);
        allScenarios.push(result);
      }
      const worst = Math.max(...scenarios.map(
        (scenario) => scenario.timed_out || scenario.error ? CASE_TIMEOUT_MS : scenario.wall_ms,
      ));
      const observation: RObservation = {
        r,
        scenarios,
        worst_wall_ms: worst,
        passed_1s: scenarios.every(
          (scenario) => !scenario.timed_out && !scenario.error && scenario.wall_ms <= THRESHOLDS_MS[0],
        ),
        passed_5s: scenarios.every(
          (scenario) => !scenario.timed_out && !scenario.error && scenario.wall_ms <= THRESHOLDS_MS[1],
        ),
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
        if (high - low <= 2 || allScenarios.length + FRONTIER_PROFILES.length > MAX_SCENARIOS) return;
        const midpoint = roundR((low + high) / 2);
        if (midpoint === low || midpoint === high) return;
        await evaluateR(midpoint);
      }
    };

    try {
      if (benchmarkScope !== 'matrix') {
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
      }

      const matrixRs = [...new Set(MATRIX_R_TARGETS.map((value) => Math.min(maxR, value)))];
      if (benchmarkScope !== 'frontier') {
        for (const matrixR of matrixRs) {
          for (const profile of MATRIX_PROFILES) {
            if (allScenarios.length >= MAX_SCENARIOS) break;
            setStatus(`coefficient matrix r=${matrixR} — ${profile.label}`);
            const result = await runCase(runId, 'coefficient-matrix', profile, matrixR, requestId++);
            matrixResults.push(result);
            allScenarios.push(result);
            setMatrixScenarios([...matrixResults]);
          }
        }
      }

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
          harness_version: 4,
          benchmark_kind: 'adaptive-r-frontier+coefficient-symmetry-matrix',
          benchmark_scope: benchmarkScope,
          case_timeout_ms: CASE_TIMEOUT_MS,
          event_loop_sample_ms: EVENT_LOOP_SAMPLE_MS,
          safety_stop: null,
          scenarios: allScenarios,
          frontier: {
            exact_number_backend_max_r: maxR,
            profiles: FRONTIER_PROFILES.map((profile) => profile.id),
            classification: 'legacy two-profile envelope retained for historical comparison; r is not assumed to determine family complexity globally',
            under_1s: frontier1s,
            under_5s: frontier5s,
            observations: ordered.map(({ r: observedR, worst_wall_ms, passed_1s, passed_5s }) => ({
              r: observedR, worst_wall_ms, passed_1s, passed_5s,
            })),
          },
          coefficient_matrix: {
            r_values: matrixRs,
            profiles: MATRIX_PROFILES.map((profile) => profile.id),
            classification: 'fixed-r matrix spanning generic, repeated-axis, and high-stabilizer coefficient triples',
            symmetry_metric: 'stabilizer of the effective canonical coefficient triple under coordinate permutations and unit multiplication modulo r',
            scenarios: matrixResults,
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
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginBottom: 4 }}>Asets adaptive frontier + coefficient-symmetry benchmark</h1>
      <p style={{ marginTop: 0, color: '#666' }}>
        Scope: {benchmarkScope}. The historical r-frontier and fixed high-r coefficient matrix can be run independently or together.
      </p>
      <p><b>Status:</b> {status} · <b>elapsed:</b> {(elapsedMs / 1000).toFixed(1)} s</p>
      <p><b>1 s legacy envelope:</b> {frontier1s.largest_tested_passing_r ?? '—'} {frontier1s.smallest_tested_failing_r ? `(next tested fail ${frontier1s.smallest_tested_failing_r})` : ''}</p>
      <p><b>5 s legacy envelope:</b> {frontier5s.largest_tested_passing_r ?? '—'} {frontier5s.smallest_tested_failing_r ? `(next tested fail ${frontier5s.smallest_tested_failing_r})` : ''}</p>
      {error ? <pre style={{ whiteSpace: 'pre-wrap', color: '#b00020' }}>{error}</pre> : null}
      {stored ? <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(stored, null, 2)}</pre> : null}

      <h2>Legacy frontier envelope</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
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

      <h2>Coefficient-symmetry matrix</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead><tr><th style={{ textAlign: 'left' }}>r</th><th style={{ textAlign: 'left' }}>profile</th><th style={{ textAlign: 'right' }}>stabilizer</th><th style={{ textAlign: 'right' }}>records</th><th style={{ textAlign: 'right' }}>wall</th></tr></thead>
        <tbody>{matrixScenarios.map((scenario) => (
          <tr key={scenario.id}>
            <td>{scenario.r}</td>
            <td>{scenario.profile}</td>
            <td style={{ textAlign: 'right' }}>{scenario.coefficient_metrics.stabilizer_size}</td>
            <td style={{ textAlign: 'right' }}>{scenario.records_received}</td>
            <td style={{ textAlign: 'right' }}>{scenario.wall_ms.toFixed(0)} ms{scenario.timed_out ? ' timeout' : ''}</td>
          </tr>
        ))}</tbody>
      </table>
      <p style={{ color: '#666', marginTop: 20 }}>
        The frontier remains only a historical envelope. The coefficient matrix is the optimization guide: equal r can have very different family sizes and runtimes because the coefficient triple can have additional automorphisms or low-order structure.
      </p>
    </main>
  );
}
