/// <reference lib="webworker" />

import { enumerateCanonicalGroupsForModulus, groupRow, type GroupRow } from '../groupMath';

const CACHE_DB = 'knockout-group-cache';
const CACHE_STORE = 'batches';
const CACHE_VERSION = 'group-enumerator-cfirst-v1';

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

async function readCache(d: number, r: number): Promise<GroupRow[] | null> {
  const db = await openCache();
  if (!db) return null;
  const key = `${CACHE_VERSION}:${d}:${r}`;
  return new Promise((resolve) => {
    const tx = db.transaction(CACHE_STORE, 'readonly');
    const request = tx.objectStore(CACHE_STORE).get(key);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve((request.result as GroupRow[] | undefined) ?? null);
  });
}

async function writeCache(d: number, r: number, rows: GroupRow[]): Promise<void> {
  const db = await openCache();
  if (!db) return;
  const key = `${CACHE_VERSION}:${d}:${r}`;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(CACHE_STORE, 'readwrite');
    tx.objectStore(CACHE_STORE).put(rows, key);
    tx.onerror = () => resolve();
    tx.oncomplete = () => resolve();
  });
}

async function batchFor(d: number, r: number): Promise<{ rows: GroupRow[]; cached: boolean; durationMs: number }> {
  const cached = await readCache(d, r);
  if (cached) return { rows: cached, cached: true, durationMs: 0 };
  const started = performance.now();
  const rows = enumerateCanonicalGroupsForModulus(d, r).map(groupRow);
  const durationMs = performance.now() - started;
  void writeCache(d, r, rows);
  return { rows, cached: false, durationMs };
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
      emittedRows = batch.rows.length;
      post({
        type: 'batch',
        d: dimension,
        r: exactModulus,
        rows: batch.rows,
        cached: batch.cached,
        durationMs: batch.durationMs,
        totalRows: emittedRows,
        done: true,
      });
      post({ type: 'progress', d: dimension, r: exactModulus, computing: false, done: true });
      return;
    }

    while (run === activeRun && emittedRows < requestedRows) {
      const r = nextModulus;
      post({ type: 'progress', d: dimension, r, computing: true });
      const batch = await batchFor(dimension, r);
      if (run !== activeRun) return;
      emittedRows += batch.rows.length;
      nextModulus += 1;
      post({
        type: 'batch',
        d: dimension,
        r,
        rows: batch.rows,
        cached: batch.cached,
        durationMs: batch.durationMs,
        totalRows: emittedRows,
        done: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
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
