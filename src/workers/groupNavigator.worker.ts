/// <reference lib="webworker" />

import { enumerateCanonicalGroupsForModulus, type Group8 } from '../groupMath';

const CACHE_DB = 'knockout-group-cache';
const CACHE_STORE = 'batches';
const CACHE_VERSION = 'group-enumerator-cfirst-v2';
const MAX_CACHE_ROWS = 20_000;
const POST_CHUNK_ROWS = 4_096;

type StartMessage = {
  type: 'start';
  runId: number;
  d: number;
  r?: number;
  targetRows?: number;
};

type MoreMessage = {
  type: 'more';
  runId: number;
  targetRows: number;
};

type InMessage = StartMessage | MoreMessage;

type GroupBatch = {
  groups: Group8[];
  cached: boolean;
  cacheSkipped: boolean;
  durationMs: number;
};

let activeRun = 0;
let dimension = 3;
let exactModulus: number | undefined;
let nextModulus = 2;
let requestedRows = 0;
let emittedRows = 0;
let running = false;

function post(payload: Record<string, unknown>): void {
  self.postMessage({ runId: activeRun, ...payload });
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

let cachePromise: Promise<IDBDatabase | null> | null = null;

function openCache(): Promise<IDBDatabase | null> {
  if (!('indexedDB' in self)) return Promise.resolve(null);
  if (cachePromise) return cachePromise;
  cachePromise = new Promise((resolve) => {
    const request = indexedDB.open(CACHE_DB, 1);
    request.onerror = () => resolve(null);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  return cachePromise;
}

async function readCache(d: number, r: number): Promise<Group8[] | null> {
  const db = await openCache();
  if (!db) return null;
  const key = `${CACHE_VERSION}:${d}:${r}`;
  return new Promise((resolve) => {
    const tx = db.transaction(CACHE_STORE, 'readonly');
    const request = tx.objectStore(CACHE_STORE).get(key);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve((request.result as Group8[] | undefined) ?? null);
  });
}

async function writeCache(d: number, r: number, groups: Group8[]): Promise<void> {
  const db = await openCache();
  if (!db) return;
  const key = `${CACHE_VERSION}:${d}:${r}`;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).put(groups, key);
    tx.onerror = () => resolve();
    tx.oncomplete = () => resolve();
  });
}

async function batchFor(d: number, r: number): Promise<GroupBatch> {
  const cached = await readCache(d, r);
  if (cached) return { groups: cached, cached: true, cacheSkipped: false, durationMs: 0 };

  const started = performance.now();
  const groups = enumerateCanonicalGroupsForModulus(d, r);
  const durationMs = performance.now() - started;
  const cacheSkipped = groups.length > MAX_CACHE_ROWS;
  if (!cacheSkipped) void writeCache(d, r, groups);
  return { groups, cached: false, cacheSkipped, durationMs };
}

async function emitBatch(run: number, r: number, batch: GroupBatch, doneWhenComplete: boolean): Promise<void> {
  post({
    type: 'batch-start',
    d: dimension,
    r,
    batchRows: batch.groups.length,
    cached: batch.cached,
    cacheSkipped: batch.cacheSkipped,
    durationMs: batch.durationMs,
  });

  if (batch.groups.length === 0) {
    post({
      type: 'batch',
      d: dimension,
      r,
      groups: [],
      totalRows: emittedRows,
      batchRows: 0,
      batchDone: true,
      done: doneWhenComplete,
    });
    return;
  }

  for (let offset = 0; offset < batch.groups.length; offset += POST_CHUNK_ROWS) {
    if (run !== activeRun) return;
    const end = Math.min(batch.groups.length, offset + POST_CHUNK_ROWS);
    const groups = batch.groups.slice(offset, end);
    emittedRows += groups.length;
    const batchDone = end === batch.groups.length;
    post({
      type: 'batch',
      d: dimension,
      r,
      groups,
      totalRows: emittedRows,
      batchRows: batch.groups.length,
      batchDone,
      done: doneWhenComplete && batchDone,
    });
    if (!batchDone) await yieldToEventLoop();
  }
}

async function generate(): Promise<void> {
  if (running) return;
  running = true;
  const run = activeRun;
  try {
    if (exactModulus !== undefined) {
      post({ type: 'progress', d: dimension, r: exactModulus, computing: true });
      const batch = await batchFor(dimension, exactModulus);
      if (run !== activeRun) return;
      await emitBatch(run, exactModulus, batch, true);
      if (run !== activeRun) return;
      post({ type: 'progress', d: dimension, r: exactModulus, computing: false, done: true });
      return;
    }

    while (run === activeRun && emittedRows < requestedRows) {
      const r = nextModulus;
      post({ type: 'progress', d: dimension, r, computing: true });
      const batch = await batchFor(dimension, r);
      if (run !== activeRun) return;
      await emitBatch(run, r, batch, false);
      if (run !== activeRun) return;
      nextModulus += 1;
    }
    if (run === activeRun) {
      post({ type: 'progress', d: dimension, r: nextModulus, computing: false, done: false });
    }
  } catch (error) {
    if (run === activeRun) {
      post({ type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  } finally {
    if (run === activeRun) running = false;
  }
}

self.onmessage = (event: MessageEvent<InMessage>) => {
  const message = event.data;
  if (message.type === 'start') {
    activeRun = message.runId;
    dimension = message.d;
    exactModulus = message.r;
    nextModulus = 2;
    emittedRows = 0;
    requestedRows = exactModulus === undefined ? Math.max(250, message.targetRows ?? 400) : Number.POSITIVE_INFINITY;
    running = false;
    void generate();
    return;
  }

  if (message.runId !== activeRun || exactModulus !== undefined) return;
  requestedRows = Math.max(requestedRows, message.targetRows);
  void generate();
};
