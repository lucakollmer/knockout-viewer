/// <reference lib="webworker" />

import {
  ASETS_ENGINE_VERSION,
  ASETS_SCHEMA_VERSION,
  CancelledError,
  buildModulusContext,
  compareDownsets,
  createSearchMetrics,
  effectiveFamily,
  familyCacheKey,
  familyDigest,
  geometryRecord,
  iterDownsets,
  type DownsetRecord,
  type FamilyResult,
  type ModulusContext,
} from '../asetsCore';
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
const CHUNK_SIZE = 16;

let activeGeneration = 0;
let activeRequestId = 0;
let queuedRequest: AsetsComputeRequest | null = null;
let running = false;
let activeContext: ModulusContext | null = null;

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

function yieldToWorkerEvents(): Promise<void> {
  const scheduler = (self as typeof self & {
    scheduler?: { postTask?: (callback: () => void, options?: { priority?: 'background' }) => Promise<void> };
  }).scheduler;
  if (scheduler?.postTask) return scheduler.postTask(() => undefined, { priority: 'background' });
  return new Promise((resolve) => setTimeout(resolve, 0));
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

async function idbPut(storeName: string, key: IDBValidKey, value: unknown): Promise<void> {
  const db = await openCache();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value, key);
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
  const readHeaderMs = performance.now() - started;
  assertActive(token);
  if (
    !header
    || header.schemaVersion !== ASETS_SCHEMA_VERSION
    || header.engineVersion !== ASETS_ENGINE_VERSION
    || header.status !== 'complete'
    || header.normalizedResultDigest === null
  ) return false;

  post({ type: 'status', requestId: request.requestId, phase: 'cache', familyKey: key, certificate, emittedRecords: 0 });
  let emitted = 0;
  let readMs = readHeaderMs;
  for (let chunkIndex = 0; chunkIndex < header.chunkCount; chunkIndex += 1) {
    const chunkStart = performance.now();
    const chunk = await idbGet<AsetsFamilyChunk>(CHUNK_STORE, chunkKeyArray(key, chunkIndex));
    readMs += performance.now() - chunkStart;
    assertActive(token);
    if (!chunk || chunk.schemaVersion !== ASETS_SCHEMA_VERSION || chunk.engineVersion !== ASETS_ENGINE_VERSION) return false;
    emitted += chunk.records.length;
    post({ type: 'chunk', requestId: request.requestId, familyKey: key, chunkIndex, records: chunk.records, cached: true });
    await yieldToWorkerEvents();
    assertActive(token);
  }
  if (emitted !== header.downsetTotal) return false;
  const cachedHeader: AsetsFamilyHeader = {
    ...header,
    performance: header.performance ? { ...header.performance, cacheHit: true, indexedDbReadMs: readMs } : null,
  };
  post({ type: 'complete', requestId: request.requestId, familyKey: key, certificate, header: cachedHeader, cached: true });
  return true;
}

async function writeTransform(request: AsetsComputeRequest, key: AsetsFamilyKey, certificate: ReturnType<typeof effectiveFamily>['certificate']): Promise<number> {
  if (!request.groupId) return 0;
  const value: AsetsGroupTransform = {
    schemaVersion: ASETS_SCHEMA_VERSION,
    engineVersion: ASETS_ENGINE_VERSION,
    groupId: request.groupId,
    familyKey: key,
    certificate,
    updatedAt: new Date().toISOString(),
  };
  const started = performance.now();
  await idbPut(TRANSFORM_STORE, request.groupId, value);
  return performance.now() - started;
}

async function computeAndCache(request: AsetsComputeRequest, token: number): Promise<void> {
  const normalized = effectiveFamily(request.r, request.residues);
  const key = familyCacheKey(request.r, request.residues) as AsetsFamilyKey;
  const performanceData = emptyPerformance();
  const wallStarted = performance.now();

  post({ type: 'status', requestId: request.requestId, phase: 'cache', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  const cacheReadStarted = performance.now();
  const cacheHit = await readCompleteFamily(request, key, normalized.certificate, token);
  performanceData.indexedDbReadMs += performance.now() - cacheReadStarted;
  assertActive(token);
  if (cacheHit) return;

  performanceData.indexedDbWriteMs += await writeTransform(request, key, normalized.certificate);
  assertActive(token);

  post({ type: 'status', requestId: request.requestId, phase: 'context', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  if (!activeContext || activeContext.r !== normalized.r) {
    const contextStarted = performance.now();
    activeContext = buildModulusContext(normalized.r, () => token !== activeGeneration);
    performanceData.modulusContextSetupMs = performance.now() - contextStarted;
  }
  assertActive(token);

  let header = makeHeader(key, normalized.r, normalized.residues, 'computing');
  const headerWriteStarted = performance.now();
  await idbPut(HEADER_STORE, familyKeyArray(key), header);
  performanceData.indexedDbWriteMs += performance.now() - headerWriteStarted;
  assertActive(token);

  post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: 0 });
  const metrics = createSearchMetrics();
  const iterator = iterDownsets(normalized.r, normalized.residues, {
    modulusContext: activeContext,
    cancelCheck: () => token !== activeGeneration,
    metrics,
  });
  const allRecords: DownsetRecord[] = [];
  let chunk: DownsetRecord[] = [];
  let chunkIndex = 0;
  let coherentTotal = 0;

  const flushChunk = async (): Promise<void> => {
    if (chunk.length === 0) return;
    assertActive(token);
    const storedChunk: AsetsFamilyChunk = {
      schemaVersion: ASETS_SCHEMA_VERSION,
      engineVersion: ASETS_ENGINE_VERSION,
      familyKey: key,
      chunkIndex,
      records: chunk,
    };
    const writeStarted = performance.now();
    await idbPut(CHUNK_STORE, chunkKeyArray(key, chunkIndex), storedChunk);
    performanceData.indexedDbWriteMs += performance.now() - writeStarted;
    assertActive(token);
    const serializationStarted = performance.now();
    post({ type: 'chunk', requestId: request.requestId, familyKey: key, chunkIndex, records: chunk, cached: false });
    performanceData.serializationChunkingMs += performance.now() - serializationStarted;
    chunkIndex += 1;
    header = {
      ...header,
      downsetTotal: allRecords.length,
      coherentTotal,
      noncoherentTotal: allRecords.length - coherentTotal,
      chunkCount: chunkIndex,
    };
    const progressWriteStarted = performance.now();
    await idbPut(HEADER_STORE, familyKeyArray(key), header);
    performanceData.indexedDbWriteMs += performance.now() - progressWriteStarted;
    chunk = [];
    updatePeakHeap(performanceData);
    await yieldToWorkerEvents();
    assertActive(token);
    post({ type: 'status', requestId: request.requestId, phase: 'compute', familyKey: key, certificate: normalized.certificate, emittedRecords: allRecords.length });
  };

  while (true) {
    assertActive(token);
    const cspStarted = performance.now();
    const next = iterator.next();
    performanceData.candidateCspEnumerationMs += performance.now() - cspStarted;
    if (next.done) break;
    const geometryStarted = performance.now();
    const record = geometryRecord(next.value, normalized.residues, normalized.r);
    performanceData.geometryMs += performance.now() - geometryStarted;
    allRecords.push(record);
    chunk.push(record);
    if (record.coherent) coherentTotal += 1;
    assertActive(token);
    if (chunk.length >= CHUNK_SIZE) await flushChunk();
  }
  await flushChunk();
  assertActive(token);

  post({ type: 'status', requestId: request.requestId, phase: 'finalize', familyKey: key, certificate: normalized.certificate, emittedRecords: allRecords.length });
  const ordered = allRecords.slice().sort((left, right) => compareDownsets(left.downset, right.downset));
  const result: FamilyResult = { r: normalized.r, residues: normalized.residues, records: ordered };
  const digest = await familyDigest(result);
  assertActive(token);

  performanceData.totalWorkerComputeMs = performance.now() - wallStarted;
  updatePeakHeap(performanceData);
  header = {
    ...header,
    status: 'complete',
    downsetTotal: allRecords.length,
    coherentTotal,
    noncoherentTotal: allRecords.length - coherentTotal,
    chunkCount: chunkIndex,
    normalizedResultDigest: digest,
    completedAt: new Date().toISOString(),
    performance: performanceData,
  };
  const finalWriteStarted = performance.now();
  await idbPut(HEADER_STORE, familyKeyArray(key), header);
  performanceData.indexedDbWriteMs += performance.now() - finalWriteStarted;
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
