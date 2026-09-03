/// <reference types="vite/client" />
import { useEffect, useRef, useState } from 'react';
import asetsWorkerUrl from './workers/asets.worker.ts?worker&url';
import type { Point } from './asetsCore';
import { effectiveRuntimeFamily } from './asetsRuntime';
import type { AsetsCompleteMessage, AsetsWorkerMessage, AsetsWorkerRequest } from './asetsProtocol';

const CASE_TIMEOUT_MS = 10_000;
const EVENT_LOOP_SAMPLE_MS = 16;
const MATRIX_R_TARGETS = [250, 415, 600, 700, 780] as const;
const PERMUTATIONS_3: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

type Profile = { id: string; label: string; residues: (r: number) => Point };
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
type ScenarioResult = {
  id: string;
  benchmark_axis: 'coefficient-matrix';
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
type StoredResponse = { ok: true; id: string; sha: string; schema: string; received_at: string };

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

function genericHashResiduesSeed(r: number, seed: number): Point {
  if (r <= 6) return [1, Math.min(2, r - 1), Math.min(3, r - 1)];
  const span = r - 3;
  const a = 2 + mod(r * (97 + seed * 29) + 53 + seed * 71, span);
  let b = 2 + mod(r * (193 + seed * 31) + 101 + seed * 89, span);
  for (let attempt = 0; attempt < span; attempt += 1) {
    if (b !== a && mod(a + b, r) !== 0 && b !== r - 1) break;
    b = 2 + mod(b - 1, span);
  }
  return [1, a, b];
}

function oppositeSeedResidues(r: number, numerator: number, denominator: number): Point {
  const middle = Math.max(2, Math.min(r - 2, Math.floor(r * numerator / denominator)));
  return [1, middle, r - 1];
}

function repeatedNonOppositeResidues(r: number): Point {
  const repeated = Math.max(2, Math.min(r - 2, Math.floor(r / 3)));
  return [1, repeated, repeated];
}

const PROFILES: readonly Profile[] = [
  { id: 'all-equal', label: 'all coefficients equal', residues: () => [1, 1, 1] },
  { id: 'repeated-pair', label: 'repeated pair with opposite axis', residues: (r) => [1, 1, r - 1] },
  { id: 'unit-cycle', label: 'order-three unit cycle when available', residues: orderThreeResidues },
  { id: 'generic-hash', label: 'deterministic generic coefficients', residues: (r) => genericHashResiduesSeed(r, 0) },
  { id: 'opposite-fifth', label: 'opposite pair with one-fifth middle coefficient', residues: (r) => oppositeSeedResidues(r, 1, 5) },
  { id: 'opposite-two-fifths', label: 'opposite pair with two-fifths middle coefficient', residues: (r) => oppositeSeedResidues(r, 2, 5) },
  { id: 'repeated-nonopposite', label: 'repeated non-opposite coefficients', residues: repeatedNonOppositeResidues },
  { id: 'generic-hash-2', label: 'deterministic generic coefficients seed 2', residues: (r) => genericHashResiduesSeed(r, 1) },
  { id: 'generic-hash-3', label: 'deterministic generic coefficients seed 3', residues: (r) => genericHashResiduesSeed(r, 2) },
];

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
  return {
    effective_modulus: modulus,
    canonical_residues: canonical,
    unit_count: units.length,
    stabilizer_size: stabilizer,
    orbit_size: Math.floor(6 * units.length / Math.max(1, stabilizer)),
    symmetry_class: stabilizer >= 3 ? 'high-symmetry' : stabilizer === 2 ? 'pair-symmetric' : 'generic',
    distinct_residue_count: new Set(canonical).size,
    repeated_pair_count: repeatedPairs,
    opposite_pair_count: oppositePairs,
    additive_orders: orders,
    minimum_additive_order: Math.min(...orders),
  };
}

function percentile95(values: readonly number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function createBenchmarkWorker(cacheScope: string): Worker {
  const resolved = new URL(asetsWorkerUrl, window.location.href);
  resolved.searchParams.set('cache', cacheScope);
  return new Worker(resolved, { type: 'module', name: `knockout-asets-matrix-v5-${cacheScope}` });
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
    const metrics = coefficientMetrics(r, residues);
    const cacheScope = `coefficient-matrix-v5-${runId}-${profile.id}-r${r}`;
    const worker = createBenchmarkWorker(cacheScope);
    const started = performance.now();
    let previous = started;
    const delays: number[] = [];
    const interval = window.setInterval(() => {
      const now = performance.now();
      delays.push(Math.max(0, now - previous - EVENT_LOOP_SAMPLE_MS));
      previous = now;
    }, EVENT_LOOP_SAMPLE_MS);
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
      window.clearInterval(interval);
      worker.terminate();
      void deleteBenchmarkCache(cacheScope);
      resolve({
        id: `coefficient-matrix-${profile.id}-r${r}`,
        benchmark_axis: 'coefficient-matrix',
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
        main_thread_delay_p95_ms: percentile95(delays),
        main_thread_delay_max_ms: delays.length ? Math.max(...delays) : 0,
        performance: null,
        ...partial,
      });
    };

    worker.addEventListener('message', (event: MessageEvent<AsetsWorkerMessage>) => {
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
    });
    worker.addEventListener('error', (event) => {
      event.preventDefault();
      finish({ error: `worker error: ${event.message || 'failed to load or start'}` });
    });
    worker.addEventListener('messageerror', () => finish({ error: 'worker message deserialization error' }));
    timeout = window.setTimeout(
      () => finish({ timed_out: true, error: `matrix timeout after ${CASE_TIMEOUT_MS} ms` }),
      CASE_TIMEOUT_MS,
    );

    const request: AsetsWorkerRequest = {
      type: 'compute',
      requestId,
      r,
      residues,
      includeRecords: true,
      groupId: `coefficient-matrix-v5:${profile.id}:r${r}`,
    };
    worker.postMessage(request);
  });
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

export default function AsetsExtendedMatrixBenchmarkPage() {
  const runningRef = useRef(false);
  const [status, setStatus] = useState('ready');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [scenarios, setScenarios] = useState<ScenarioResult[]>([]);
  const [stored, setStored] = useState<StoredResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const run = async () => {
      if (runningRef.current) return;
      runningRef.current = true;
      const runId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      const wallStart = performance.now();
      const timer = window.setInterval(() => setElapsedMs(performance.now() - wallStart), 100);
      const results: ScenarioResult[] = [];
      let requestId = 1;
      try {
        for (const r of MATRIX_R_TARGETS) {
          for (const profile of PROFILES) {
            setStatus(`matrix v5 r=${r} — ${profile.label}`);
            const result = await runCase(runId, profile, r, requestId++);
            results.push(result);
            setScenarios([...results]);
          }
        }
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
            harness_version: 5,
            benchmark_kind: 'extended-coefficient-symmetry-matrix',
            benchmark_scope: 'matrix',
            case_timeout_ms: CASE_TIMEOUT_MS,
            event_loop_sample_ms: EVENT_LOOP_SAMPLE_MS,
            safety_stop: null,
            scenarios: results,
            coefficient_matrix: {
              r_values: MATRIX_R_TARGETS,
              profiles: PROFILES.map((profile) => profile.id),
              classification: '45-case A/B matrix preserving the original 16 controls and adding r=700 plus deterministic opposite-pair, repeated-nonopposite, and generic samples',
              symmetry_metric: 'stabilizer of the effective canonical coefficient triple under coordinate permutations and unit multiplication modulo r',
              scenarios: results,
            },
            dimension_semantics: {
              family_coordinate_dimension: 3,
              representation_d: 'n+m+k; not a family-computation parameter',
              generalized_block_count_above_3_supported: false,
            },
          },
        };
        setStored(await upload(payload));
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
    void run();
  }, []);

  return (
    <main style={{ maxWidth: 1180, margin: '0 auto', padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ marginBottom: 4 }}>Asets extended coefficient-symmetry matrix v5</h1>
      <p style={{ marginTop: 0, color: '#666' }}>
        45 cold cases: five r values × nine deterministic coefficient profiles. Per-case timeout: 10 s.
      </p>
      <p><b>Status:</b> {status} · <b>elapsed:</b> {(elapsedMs / 1000).toFixed(1)} s · <b>cases:</b> {scenarios.length}/45</p>
      {error ? <pre style={{ whiteSpace: 'pre-wrap', color: '#b00020' }}>{error}</pre> : null}
      {stored ? <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(stored, null, 2)}</pre> : null}
      <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 12 }}>
        <thead><tr><th style={{ textAlign: 'left' }}>r</th><th style={{ textAlign: 'left' }}>profile</th><th style={{ textAlign: 'right' }}>opp</th><th style={{ textAlign: 'right' }}>stab</th><th style={{ textAlign: 'right' }}>records</th><th style={{ textAlign: 'right' }}>wall</th></tr></thead>
        <tbody>{scenarios.map((scenario) => (
          <tr key={scenario.id}>
            <td>{scenario.r}</td>
            <td>{scenario.profile}</td>
            <td style={{ textAlign: 'right' }}>{scenario.coefficient_metrics.opposite_pair_count}</td>
            <td style={{ textAlign: 'right' }}>{scenario.coefficient_metrics.stabilizer_size}</td>
            <td style={{ textAlign: 'right' }}>{scenario.records_received}</td>
            <td style={{ textAlign: 'right' }}>{scenario.wall_ms.toFixed(0)} ms{scenario.timed_out ? ' timeout' : ''}</td>
          </tr>
        ))}</tbody>
      </table>
    </main>
  );
}
