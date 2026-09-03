/// <reference lib="webworker" />
/// <reference types="vite/client" />
import asetsShardWorkerUrl from './asetsShard.worker.ts?worker&url';
import {
  ASETS_ENGINE_VERSION,
  ASETS_SCHEMA_VERSION,
  CancelledError,
  createSearchMetrics,
  type DownsetRecord,
  type Point,
} from '../asetsCore';
import { createFamilyGeometryContext, geometryRecordCached } from '../asetsGeometry';
import { buildFastModulusContext, iterFastDownsets, type FastModulusContext } from '../asetsFast';
import { effectiveRuntimeFamily } from '../asetsRuntime';
import type {
  AsetsComputeRequest,
  AsetsFamilyChunk,
  AsetsFamilyHeader,
  AsetsFamilyKey,
  AsetsGroupTransform,
  AsetsPerformance,
  AsetsWorkerMessage,
  AsetsWorkerRequest,
} from '../asetsProtocol';
import type {
  AsetsShardMessage,
  AsetsShardPerformance,
  AsetsShardRequest,
} from '../asetsShardProtocol';

const cacheScopeRaw = new URL(self.location.href).searchParams.get('cache');
const cacheScope = cacheScopeRaw?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || '';
const CACHE_DB = cacheScope ? `knockout-asets-cache-${cacheScope}` : 'knockout-asets-cache';
const CACHE_DB_VERSION = 1;
const HEADER_STORE = 'asetFamilyHeaders';
const CHUNK_STORE = 'asetFamilyChunks';
const TRANSFORM_STORE = 'asetGroupTransforms';
const PROGRESS_RECORD_INTERVAL = 64;
const LIVE_CHUNK_SIZE = 64;
const CACHE_CHUNK_SIZE = 64;
const MODULUS_CONTEXT_CACHE_LIMIT = 3;
const PARALLEL_MIN_R = 410;
const GENERIC_PARALLEL_MIN_R = 700;
const MAX_PARALLEL_SHARDS = 4;
const PERMUTATIONS_3: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
];

let activeGeneration = 0;
let activeRequestId = 0;
let queuedRequest: AsetsComputeRequest | null = null;
let running = false;
const modulusContexts = new Map<number, FastModulusContext>();
let cachePromise: Promise<IDBDatabase | null> | null = null;
let cancelActiveParallel: (() => void) | null = null;

const familyKeyArray = (key: AsetsFamilyKey): IDBValidKey[] => [...key];
const chunkKeyArray = (key: AsetsFamilyKey, index: number): IDBValidKey[] => [...key, index];
const post = (message: AsetsWorkerMessage) => self.postMessage(message);

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

function coefficientStructure(r: number, residues: Point): {
  stabilizerSize: number;
  oppositePairCount: number;
} {
  let oppositePairCount = 0;
  for (let first = 0; first < 3; first += 1) {
    for (let second = first + 1; second < 3; second += 1) {
      if (mod(residues[first] + residues[second], r) === 0) oppositePairCount += 1;
    }
  }

  const units: number[] = [];
  for (let unit = 1; unit < r; unit += 1) if (gcd(unit, r) === 1) units.push(unit);
  let stabilizerSize = 0;
  for (const permutation of PERMUTATIONS_3) {
    for (const unit of units) {
      let matches = true;
      for (let axis = 0; axis < 3; axis += 1) {
        if (mod(unit * residues[permutation[axis]], r) !== residues[axis]) {
          matches = false;
          break;
        }
      }
      if (matches) stabilizerSize += 1;
    }
  }
  return { stabilizerSize, oppositePairCount };
}

function openCache(): Promise<IDBDatabase | null> {
  if (!('indexedDB' in self)) return Promise.resolve(null);
  if (cachePromise) return cachePromise;
  cachePromise = new Promise((resolve) => {
    const request = indexedDB.open(CACHE_DB, CACHE_DB_VERSION);
    request.onerror = () => resolve(null);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HEADER_STORE)) db.createObjectStore(HEADER_STORE);
      if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE);
      if (!db.objectStoreNames.contains(TRANSFORM_STORE)) db.createObjectStore(TRANSFORM_STORE);
    };
    request.onsuccess = () => resolve(request.result);
  });
  return cachePromise;
}

async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | null> {
  const db = await openCache();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const request = tx.objectStore(storeName).get(key);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
  });
}

async function idbGetMany<T>(storeName: string, keys: readonly IDBValidKey[]): Promise<Array<T | null>> {
  const db = await openCache();
  if (!db) return keys.map(() => null);
  return new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const values: Array<T | null> = keys.map(() => null);
    let failed = false;
    keys.forEach((key, index) => {
      const request = store.get(key);
      request.onerror = () => { failed = true; };
      request.onsuccess = () => { values[index] = (request.result as T | undefined) ?? null; };
    });
    tx.onerror = () => resolve(keys.map(() => null));
    tx.oncomplete = () => resolve(failed ? keys.map(() => null) : values);
  });
}

async function idbPutCompleteFamily(
  key: AsetsFamilyKey,
  chunks: readonly AsetsFamilyChunk[],
  header: AsetsFamilyHeader,
  transform: AsetsGroupTransform | null,
): Promise<void> {
  const db = await openCache();
  if (!db) return;
  const stores = transform
    ? [CHUNK_STORE, HEADER_STORE, TRANSFORM_STORE]
    : [CHUNK_STORE, HEADER_STORE];
  await new Promise<void>((resolve) => {
    const tx = db.transaction(stores, 'readwrite');
    const chunkStore = tx.objectStore(CHUNK_STORE);
    for (const chunk of chunks) chunkStore.put(chunk, chunkKeyArray(key, chunk.chunkIndex));
    tx.objectStore(HEADER_STORE).put(header, familyKeyArray(key));
    if (transform) tx.objectStore(TRANSFORM_STORE).put(transform, transform.groupId);
    tx.onerror = () => resolve();
    tx.oncomplete = () => resolve();
  });
}

const emptyPerformance = (): AsetsPerformance => ({
  cacheHit: false,
  modulusContextSetupMs: 0,
  candidateCspEnumerationMs: 0,
  geometryMs: 0,
  totalWorkerComputeMs: 0,
  serializationChunkingMs: 0,
  indexedDbReadMs: 0,
  indexedDbWriteMs: 0,
  peakUsedJsHeapBytes: null,
  parallelShards: 1,
});

function heapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return Number.isFinite(memory?.usedJSHeapSize) ? Number(memory?.usedJSHeapSize) : null;
}

function updatePeakHeap(performanceData: AsetsPerformance): void {
  const value = heapBytes();
  if (value === null) return;
  performanceData.peakUsedJsHeapBytes = Math.max(performanceData.peakUsedJsHeapBytes ?? 0, value);
}

const makeHeader = (key: AsetsFamilyKey, r: number, residues: readonly [number, number, number]): AsetsFamilyHeader => ({
  schemaVersion: ASETS_SCHEMA_VERSION,
  engineVersion: ASETS_ENGINE_VERSION,
  familyKey: key,
  r,
  residues,
  status: 'computing',
  downsetTotal: 0,
  coherentTotal: 0,
  noncoherentTotal: 0,
  chunkCount: 0,
  normalizedResultDigest: null,
  completedAt: null,
  performance: null,
});

function assertActive(token: number): void {
  if (token !== activeGeneration) throw new CancelledError();
}

function parallelShardCount(r: number, residues: Point): number {
  if (r < PARALLEL_MIN_R || typeof Worker === 'undefined') return 1;
  const hardwareConcurrency = self.navigator.hardwareConcurrency || 1;
  if (hardwareConcurrency < 4) return 1;

  const structure = coefficientStructure(r, residues);
  const structuredHardCase = structure.stabilizerSize === 1 && structure.oppositePairCount > 0;
  const highRLowSymmetry = r >= GENERIC_PARALLEL_MIN_R && structure.stabilizerSize <= 2;
  if (!structuredHardCase && !highRLowSymmetry) return 1;
  return Math.min(MAX_PARALLEL_SHARDS, hardwareConcurrency >= 8 ? 4 : 2);
}

async function runParallelFamily(
  r: number,
  residues: readonly [number, number, number],
  shardCount: number,
  token: number,
  acceptRecords: (records: readonly DownsetRecord[]) => void,
): Promise<AsetsShardPerformance> {
  return new Promise<AsetsShardPerformance>((resolve, reject) => {
    const workers: Worker[] = [];
    const buffers: Array<Array<readonly DownsetRecord[]>> = Array.from({ length: shardCount }, () => []);
    const completed = new Uint8Array(shardCount);
    const performances: Array<AsetsShardPerformance | null> = Array.from({ length: shardCount }, () => null);
    const reportedCounts = new Uint32Array(shardCount);
    let nextShard = 0;
    let completedCount = 0;
    let acceptedCount = 0;
    let settled = false;

    const cleanup = () => {
      for (const worker of workers) worker.terminate();
      if (cancelActiveParallel === cancel) cancelActiveParallel = null;
    };

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const drain = () => {
      try {
        assertActive(token);
        while (nextShard < shardCount) {
          const queue = buffers[nextShard];
          while (queue.length) {
            const records = queue.shift();
            if (!records) break;
            acceptRecords(records);
            acceptedCount += records.length;
          }
          if (completed[nextShard] === 0) break;
          nextShard += 1;
        }
      } catch (error) {
        fail(error);
      }
    };

    const finishIfComplete = () => {
      if (completedCount !== shardCount || settled) return;
      drain();
      if (settled) return;
      if (nextShard !== shardCount) {
        fail(new Error('internal Asets shard ordering failure'));
        return;
      }
      const reportedTotal = reportedCounts.reduce((sum, value) => sum + value, 0);
      if (reportedTotal !== acceptedCount) {
        fail(new Error('internal Asets shard record-count mismatch'));
        return;
      }
      let critical = performances[0];
      if (!critical) {
        fail(new Error('internal Asets shard performance missing'));
        return;
      }
      for (let index = 1; index < performances.length; index += 1) {
        const candidate = performances[index];
        if (!candidate) {
          fail(new Error('internal Asets shard performance missing'));
          return;
        }
        if (candidate.totalWorkerComputeMs > critical.totalWorkerComputeMs) critical = candidate;
      }
      settled = true;
      cleanup();
      resolve(critical);
    };

    const cancel = () => fail(new CancelledError());
    cancelActiveParallel = cancel;

    try {
      for (let shardIndex = 0; shardIndex < shardCount; shardIndex += 1) {
        const resolved = new URL(asetsShardWorkerUrl, self.location.href);
        const worker = new Worker(resolved, { type: 'module', name: `knockout-asets-shard-${shardIndex}` });
        workers.push(worker);
        worker.onmessage = (event: MessageEvent<AsetsShardMessage>) => {
          const message = event.data;
          if (message.shardIndex !== shardIndex || settled) return;
          if (message.type === 'chunk') {
            buffers[shardIndex].push(message.records);
            drain();
          } else if (message.type === 'complete') {
            completed[shardIndex] = 1;
            completedCount += 1;
            reportedCounts[shardIndex] = message.recordCount;
            performances[shardIndex] = message.performance;
            drain();
            finishIfComplete();
          } else {
            fail(new Error(`Asets shard ${shardIndex} failed: ${message.message}`));
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          fail(new Error(`Asets shard ${shardIndex} worker error: ${event.message || 'failed to load or start'}`));
        };
        worker.onmessageerror = () => fail(new Error(`Asets shard ${shardIndex} message deserialization error`));
        const shardRequest: AsetsShardRequest = {
          type: 'compute',
          shardIndex,
          shardCount,
          r,
          residues,
        };
        worker.postMessage(shardRequest);
      }
    } catch (error) {
      fail(error);
    }
  });
}

async function readCompleteFamily(
  request: AsetsComputeRequest,
  key: AsetsFamilyKey,
  certificate: ReturnType<typeof effectiveRuntimeFamily>['certificate'],
  token: number,
): Promise<boolean> {
  const start = performance.now();
  const header = await idbGet<AsetsFamilyHeader>(HEADER_STORE, familyKeyArray(key));
  let readMs = performance.now() - start;
  assertActive(token);
  if (!header
    || header.schemaVersion !== ASETS_SCHEMA_VERSION
    || header.engineVersion !== ASETS_ENGINE_VERSION
    || header.status !== 'complete') return false;

  post({
    type: 'status', requestId: request.requestId, phase: 'cache', familyKey: key,
    certificate, emittedRecords: header.downsetTotal,
  });
  if (request.includeRecords) {
    const keys = Array.from({ length: header.chunkCount }, (_, index) => chunkKeyArray(key, index));
    const chunkStart = performance.now();
    const chunks = await idbGetMany<AsetsFamilyChunk>(CHUNK_STORE, keys);
    readMs += performance.now() - chunkStart;
    assertActive(token);
    let emitted = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk) return false;
      emitted += chunk.records.length;
      post({
        type: 'chunk', requestId: request.requestId, familyKey: key,
        chunkIndex: index, records: chunk.records, cached: true,
      });
    }
    if (emitted !== header.downsetTotal) return false;
  }
  const cachedHeader = {
    ...header,
    performance: header.performance
      ? { ...header.performance, cacheHit: true, indexedDbReadMs: readMs }
      : null,
  };
  post({ type: 'complete', requestId: request.requestId, familyKey: key, certificate, header: cachedHeader, cached: true });
  return true;
}

function makeTransform(
  request: AsetsComputeRequest,
  key: AsetsFamilyKey,
  certificate: ReturnType<typeof effectiveRuntimeFamily>['certificate'],
): AsetsGroupTransform | null {
  return request.groupId ? {
    schemaVersion: ASETS_SCHEMA_VERSION,
    engineVersion: ASETS_ENGINE_VERSION,
    groupId: request.groupId,
    familyKey: key,
    certificate,
    updatedAt: new Date().toISOString(),
  } : null;
}

async function computeAndCache(request: AsetsComputeRequest, token: number): Promise<void> {
  const normalized = effectiveRuntimeFamily(request.r, request.residues);
  const key = [ASETS_ENGINE_VERSION, normalized.r, ...normalized.residues] as AsetsFamilyKey;
  const performanceData = emptyPerformance();
  const wallStart = performance.now();
  post({ type: 'status', requestId: request.requestId, phase: 'cache', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  if (await readCompleteFamily(request, key, normalized.certificate, token)) return;

  let header = makeHeader(key, normalized.r, normalized.residues);
  let recordCount = 0;
  let coherent = 0;
  let liveChunkIndex = 0;
  let liveChunk: DownsetRecord[] = [];
  let cacheChunkIndex = 0;
  let cacheChunk: DownsetRecord[] = [];
  const cacheChunks: AsetsFamilyChunk[] = [];

  const flushLive = () => {
    if (!liveChunk.length) return;
    const records = liveChunk;
    liveChunk = [];
    if (request.includeRecords) {
      const serializeStart = performance.now();
      post({ type: 'chunk', requestId: request.requestId, familyKey: key, chunkIndex: liveChunkIndex, records, cached: false });
      performanceData.serializationChunkingMs += performance.now() - serializeStart;
    }
    liveChunkIndex += 1;
  };

  const flushCache = () => {
    if (!cacheChunk.length) return;
    const records = cacheChunk;
    cacheChunk = [];
    cacheChunks.push({
      schemaVersion: ASETS_SCHEMA_VERSION,
      engineVersion: ASETS_ENGINE_VERSION,
      familyKey: key,
      chunkIndex: cacheChunkIndex,
      records,
    });
    cacheChunkIndex += 1;
  };

  const acceptRecords = (records: readonly DownsetRecord[]) => {
    assertActive(token);
    for (const record of records) {
      recordCount += 1;
      if (record.coherent) coherent += 1;
      liveChunk.push(record);
      cacheChunk.push(record);
      if (recordCount % PROGRESS_RECORD_INTERVAL === 0) {
        post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: recordCount });
        updatePeakHeap(performanceData);
      }
      if (liveChunk.length >= LIVE_CHUNK_SIZE) flushLive();
      if (cacheChunk.length >= CACHE_CHUNK_SIZE) flushCache();
    }
  };

  const shardCount = parallelShardCount(normalized.r, normalized.residues);
  performanceData.parallelShards = shardCount;
  post({ type: 'status', requestId: request.requestId, phase: 'context', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  if (shardCount > 1) {
    post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
    const critical = await runParallelFamily(normalized.r, normalized.residues, shardCount, token, acceptRecords);
    performanceData.modulusContextSetupMs = critical.modulusContextSetupMs;
    performanceData.candidateCspEnumerationMs = critical.candidateCspEnumerationMs;
    performanceData.geometryMs = critical.geometryMs;
  } else {
    let context = modulusContexts.get(normalized.r);
    if (context) {
      modulusContexts.delete(normalized.r);
      modulusContexts.set(normalized.r, context);
    } else {
      const contextStart = performance.now();
      context = buildFastModulusContext(normalized.r, () => token !== activeGeneration);
      performanceData.modulusContextSetupMs = performance.now() - contextStart;
      modulusContexts.set(normalized.r, context);
      if (modulusContexts.size > MODULUS_CONTEXT_CACHE_LIMIT) {
        const oldest = modulusContexts.keys().next().value;
        if (oldest !== undefined) modulusContexts.delete(oldest);
      }
    }
    assertActive(token);

    const geometryContext = createFamilyGeometryContext(normalized.r, normalized.residues);
    post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
    const metrics = createSearchMetrics();
    const iterator = iterFastDownsets(normalized.r, normalized.residues, {
      modulusContext: context,
      cancelCheck: () => token !== activeGeneration,
      metrics,
    });

    while (true) {
      assertActive(token);
      const cspStart = performance.now();
      const next = iterator.next();
      performanceData.candidateCspEnumerationMs += performance.now() - cspStart;
      if (next.done) break;
      const geometryStart = performance.now();
      const record = geometryRecordCached(next.value, normalized.residues, normalized.r, geometryContext);
      performanceData.geometryMs += performance.now() - geometryStart;
      acceptRecords([record]);
    }
  }
  flushLive();
  flushCache();

  post({ type: 'status', requestId: request.requestId, phase: 'finalize', familyKey: key, certificate: normalized.certificate, emittedRecords: recordCount });
  performanceData.totalWorkerComputeMs = performance.now() - wallStart;
  updatePeakHeap(performanceData);
  header = {
    ...header,
    status: 'complete',
    downsetTotal: recordCount,
    coherentTotal: coherent,
    noncoherentTotal: recordCount - coherent,
    chunkCount: cacheChunkIndex,
    completedAt: new Date().toISOString(),
    performance: performanceData,
  };
  const writeStart = performance.now();
  await idbPutCompleteFamily(key, cacheChunks, header, makeTransform(request, key, normalized.certificate));
  performanceData.indexedDbWriteMs += performance.now() - writeStart;
  header = { ...header, performance: { ...performanceData } };
  post({ type: 'complete', requestId: request.requestId, familyKey: key, certificate: normalized.certificate, header, cached: false });
}

async function runLoop(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (queuedRequest) {
      const request = queuedRequest;
      queuedRequest = null;
      activeRequestId = request.requestId;
      const token = activeGeneration;
      try {
        await computeAndCache(request, token);
      } catch (error) {
        if (error instanceof CancelledError || token !== activeGeneration) {
          post({ type: 'cancelled', requestId: request.requestId });
        } else {
          post({ type: 'error', requestId: request.requestId, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  } finally {
    running = false;
    if (queuedRequest) void runLoop();
  }
}

self.onmessage = (event: MessageEvent<AsetsWorkerRequest>) => {
  const message = event.data;
  if (message.type === 'cancel') {
    if (message.requestId === undefined || message.requestId === activeRequestId) {
      activeGeneration += 1;
      queuedRequest = null;
      cancelActiveParallel?.();
    }
    return;
  }
  activeGeneration += 1;
  cancelActiveParallel?.();
  queuedRequest = message;
  void runLoop();
};
