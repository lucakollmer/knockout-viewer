/// <reference lib="webworker" />

import {
  ASETS_ENGINE_VERSION,
  ASETS_SCHEMA_VERSION,
  CancelledError,
  createSearchMetrics,
  effectiveFamily,
  type DownsetRecord,
} from '../asetsCore';
import { createFamilyGeometryContext, geometryRecordCached } from '../asetsGeometry';
import { buildFastModulusContext, iterFastDownsets, type FastModulusContext } from '../asetsFast';
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

const CACHE_DB = 'knockout-asets-cache';
const CACHE_DB_VERSION = 1;
const HEADER_STORE = 'asetFamilyHeaders';
const CHUNK_STORE = 'asetFamilyChunks';
const TRANSFORM_STORE = 'asetGroupTransforms';
const PROGRESS_RECORD_INTERVAL = 64;
const CACHE_CHUNK_SIZE = 64;
const MODULUS_CONTEXT_CACHE_LIMIT = 3;

let activeGeneration = 0;
let activeRequestId = 0;
let queuedRequest: AsetsComputeRequest | null = null;
let running = false;
const modulusContexts = new Map<number, FastModulusContext>();

let cachePromise: Promise<IDBDatabase | null> | null = null;

function familyKeyArray(key: AsetsFamilyKey): IDBValidKey[] {
  return [...key];
}

function chunkKeyArray(key: AsetsFamilyKey, chunkIndex: number): IDBValidKey[] {
  return [...key, chunkIndex];
}

function post(message: AsetsWorkerMessage): void {
  self.postMessage(message);
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
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
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

function emptyPerformance(): AsetsPerformance {
  return {
    cacheHit: false,
    modulusContextSetupMs: 0,
    candidateCspEnumerationMs: 0,
    geometryMs: 0,
    totalWorkerComputeMs: 0,
    serializationChunkingMs: 0,
    indexedDbReadMs: 0,
    indexedDbWriteMs: 0,
    peakUsedJsHeapBytes: null,
  };
}

function heapBytes(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize?: number } }).memory;
  return Number.isFinite(memory?.usedJSHeapSize) ? Number(memory?.usedJSHeapSize) : null;
}

function updatePeakHeap(performanceData: AsetsPerformance): void {
  const value = heapBytes();
  if (value === null) return;
  performanceData.peakUsedJsHeapBytes = Math.max(performanceData.peakUsedJsHeapBytes ?? 0, value);
}

function makeHeader(
  key: AsetsFamilyKey,
  r: number,
  residues: readonly [number, number, number],
  status: AsetsFamilyHeader['status'],
): AsetsFamilyHeader {
  return {
    schemaVersion: ASETS_SCHEMA_VERSION,
    engineVersion: ASETS_ENGINE_VERSION,
    familyKey: key,
    r,
    residues,
    status,
    downsetTotal: 0,
    coherentTotal: 0,
    noncoherentTotal: 0,
    chunkCount: 0,
    normalizedResultDigest: null,
    completedAt: null,
    performance: null,
  };
}

function assertActive(token: number): void {
  if (token !== activeGeneration) throw new CancelledError();
}

async function readCompleteFamily(
  request: AsetsComputeRequest,
  key: AsetsFamilyKey,
  certificate: ReturnType<typeof effectiveFamily>['certificate'],
  token: number,
): Promise<boolean> {
  const started = performance.now();
  const header = await idbGet<AsetsFamilyHeader>(HEADER_STORE, familyKeyArray(key));
  const readMs = performance.now() - started;
  assertActive(token);
  if (
    !header
    || header.schemaVersion !== ASETS_SCHEMA_VERSION
    || header.engineVersion !== ASETS_ENGINE_VERSION
    || header.status !== 'complete'
  ) return false;

  // A completed header and its chunks are committed atomically. The navigator only
  // needs totals here; record chunks can be loaded lazily by a future visualizer.
  post({ type: 'status', requestId: request.requestId, phase: 'cache', familyKey: key, certificate, emittedRecords: header.downsetTotal });
  const cachedHeader: AsetsFamilyHeader = {
    ...header,
    performance: header.performance ? { ...header.performance, cacheHit: true, indexedDbReadMs: readMs } : null,
  };
  post({ type: 'complete', requestId: request.requestId, familyKey: key, certificate, header: cachedHeader, cached: true });
  return true;
}

function makeTransform(
  request: AsetsComputeRequest,
  key: AsetsFamilyKey,
  certificate: ReturnType<typeof effectiveFamily>['certificate'],
): AsetsGroupTransform | null {
  if (!request.groupId) return null;
  return {
    schemaVersion: ASETS_SCHEMA_VERSION,
    engineVersion: ASETS_ENGINE_VERSION,
    groupId: request.groupId,
    familyKey: key,
    certificate,
    updatedAt: new Date().toISOString(),
  };
}

async function computeAndCache(request: AsetsComputeRequest, token: number): Promise<void> {
  const normalized = effectiveFamily(request.r, request.residues);
  const key: AsetsFamilyKey = [ASETS_ENGINE_VERSION, normalized.r, ...normalized.residues];
  const performanceData = emptyPerformance();
  const wallStarted = performance.now();

  post({ type: 'status', requestId: request.requestId, phase: 'cache', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  const cacheReadStarted = performance.now();
  const cacheHit = await readCompleteFamily(request, key, normalized.certificate, token);
  performanceData.indexedDbReadMs += performance.now() - cacheReadStarted;
  assertActive(token);
  if (cacheHit) return;

  post({ type: 'status', requestId: request.requestId, phase: 'context', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  let activeContext = modulusContexts.get(normalized.r);
  if (activeContext) {
    // Refresh LRU position without rebuilding anything.
    modulusContexts.delete(normalized.r);
    modulusContexts.set(normalized.r, activeContext);
  } else {
    const contextStarted = performance.now();
    activeContext = buildFastModulusContext(normalized.r, () => token !== activeGeneration);
    performanceData.modulusContextSetupMs = performance.now() - contextStarted;
    modulusContexts.set(normalized.r, activeContext);
    if (modulusContexts.size > MODULUS_CONTEXT_CACHE_LIMIT) {
      const oldest = modulusContexts.keys().next().value as number | undefined;
      if (oldest !== undefined) modulusContexts.delete(oldest);
    }
  }
  assertActive(token);

  const geometryContext = createFamilyGeometryContext(normalized.r, normalized.residues);
  let header = makeHeader(key, normalized.r, normalized.residues, 'computing');

  post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  const metrics = createSearchMetrics();
  const iterator = iterFastDownsets(normalized.r, normalized.residues, {
    modulusContext: activeContext,
    cancelCheck: () => token !== activeGeneration,
    metrics,
  });
  let recordCount = 0;
  let nextProgressAt = PROGRESS_RECORD_INTERVAL;
  let cacheChunk: DownsetRecord[] = [];
  let cacheChunkIndex = 0;
  const storedChunks: AsetsFamilyChunk[] = [];
  let coherentTotal = 0;

  const flushCacheChunk = (): void => {
    if (cacheChunk.length === 0) return;
    assertActive(token);
    const storedRecords = cacheChunk;
    cacheChunk = [];
    storedChunks.push({
      schemaVersion: ASETS_SCHEMA_VERSION,
      engineVersion: ASETS_ENGINE_VERSION,
      familyKey: key,
      chunkIndex: cacheChunkIndex,
      records: storedRecords,
    });
    cacheChunkIndex += 1;
    header = {
      ...header,
      downsetTotal: recordCount,
      coherentTotal,
      noncoherentTotal: recordCount - coherentTotal,
      chunkCount: cacheChunkIndex,
    };
  };

  while (true) {
    assertActive(token);
    const cspStarted = performance.now();
    const next = iterator.next();
    performanceData.candidateCspEnumerationMs += performance.now() - cspStarted;
    if (next.done) break;
    const geometryStarted = performance.now();
    const record = geometryRecordCached(next.value, normalized.residues, normalized.r, geometryContext);
    performanceData.geometryMs += performance.now() - geometryStarted;
    recordCount += 1;
    cacheChunk.push(record);
    if (record.coherent) coherentTotal += 1;
    assertActive(token);
    if (recordCount >= nextProgressAt) {
      post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: recordCount });
      nextProgressAt += PROGRESS_RECORD_INTERVAL;
      updatePeakHeap(performanceData);
    }
    if (cacheChunk.length >= CACHE_CHUNK_SIZE) flushCacheChunk();
  }
  flushCacheChunk();
  assertActive(token);

  post({ type: 'status', requestId: request.requestId, phase: 'finalize', familyKey: key, certificate: normalized.certificate, emittedRecords: recordCount });
  // Runtime correctness is enforced by the frozen/full-oracle tests. Avoid rebuilding
  // and serializing the entire family solely to produce a diagnostic digest on every click.
  performanceData.totalWorkerComputeMs = performance.now() - wallStarted;
  updatePeakHeap(performanceData);
  header = {
    ...header,
    status: 'complete',
    downsetTotal: recordCount,
    coherentTotal,
    noncoherentTotal: recordCount - coherentTotal,
    chunkCount: cacheChunkIndex,
    normalizedResultDigest: null,
    completedAt: new Date().toISOString(),
    performance: performanceData,
  };
  const transform = makeTransform(request, key, normalized.certificate);
  const finalWriteStarted = performance.now();
  await idbPutCompleteFamily(key, storedChunks, header, transform);
  performanceData.indexedDbWriteMs += performance.now() - finalWriteStarted;
  assertActive(token);
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
