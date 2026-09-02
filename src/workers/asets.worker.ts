/// <reference lib="webworker" />
import {
  ASETS_ENGINE_VERSION,
  ASETS_SCHEMA_VERSION,
  CancelledError,
  createSearchMetrics,
  type DownsetRecord,
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

const cacheScopeRaw = new URL(self.location.href).searchParams.get('cache');
const cacheScope = cacheScopeRaw?.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || '';
const CACHE_DB = cacheScope ? `knockout-asets-cache-${cacheScope}` : 'knockout-asets-cache';
const CACHE_DB_VERSION = 1;
const HEADER_STORE = 'asetFamilyHeaders';
const CHUNK_STORE = 'asetFamilyChunks';
const TRANSFORM_STORE = 'asetGroupTransforms';
const PROGRESS_RECORD_INTERVAL = 64;
// Live chunks are larger than the old 64-record batches to reduce structured-clone
// and React update overhead. Cache chunks are larger again because they are replayed
// only after a complete-family cache hit and can optimize for IndexedDB put count.
const LIVE_CHUNK_SIZE = 128;
const CACHE_CHUNK_SIZE = 256;
const MODULUS_CONTEXT_CACHE_LIMIT = 3;

let activeGeneration = 0;
let activeRequestId = 0;
let queuedRequest: AsetsComputeRequest | null = null;
let running = false;
const modulusContexts = new Map<number, FastModulusContext>();
let cachePromise: Promise<IDBDatabase | null> | null = null;

const familyKeyArray = (key: AsetsFamilyKey): IDBValidKey[] => [...key];
const chunkKeyArray = (key: AsetsFamilyKey, index: number): IDBValidKey[] => [...key, index];
const post = (message: AsetsWorkerMessage) => self.postMessage(message);

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

  post({ type: 'status', requestId: request.requestId, phase: 'context', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
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
  let header = makeHeader(key, normalized.r, normalized.residues);
  post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  const metrics = createSearchMetrics();
  const iterator = iterFastDownsets(normalized.r, normalized.residues, {
    modulusContext: context,
    cancelCheck: () => token !== activeGeneration,
    metrics,
  });

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

  while (true) {
    assertActive(token);
    const cspStart = performance.now();
    const next = iterator.next();
    performanceData.candidateCspEnumerationMs += performance.now() - cspStart;
    if (next.done) break;
    const geometryStart = performance.now();
    const record = geometryRecordCached(next.value, normalized.residues, normalized.r, geometryContext);
    performanceData.geometryMs += performance.now() - geometryStart;
    recordCount += 1;
    liveChunk.push(record);
    cacheChunk.push(record);
    if (record.coherent) coherent += 1;
    if (recordCount % PROGRESS_RECORD_INTERVAL === 0) {
      post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: recordCount });
      updatePeakHeap(performanceData);
    }
    if (liveChunk.length >= LIVE_CHUNK_SIZE) flushLive();
    if (cacheChunk.length >= CACHE_CHUNK_SIZE) flushCache();
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
    }
    return;
  }
  activeGeneration += 1;
  queuedRequest = message;
  void runLoop();
};
