/// <reference lib="webworker" />
import { createSearchMetrics, type DownsetRecord } from '../asetsCore';
import { createFamilyGeometryContext, geometryRecordCached } from '../asetsGeometry';
import { buildFastModulusContext, iterFastDownsets } from '../asetsFast';
import type {
  AsetsShardComplete,
  AsetsShardMessage,
  AsetsShardRequest,
} from '../asetsShardProtocol';

const SHARD_CHUNK_SIZE = 128;
const post = (message: AsetsShardMessage) => self.postMessage(message);

self.onmessage = (event: MessageEvent<AsetsShardRequest>) => {
  const request = event.data;
  if (request.type !== 'compute') return;
  try {
    const wallStart = performance.now();
    const contextStart = performance.now();
    const modulusContext = buildFastModulusContext(request.r);
    const modulusContextSetupMs = performance.now() - contextStart;
    const geometryContext = createFamilyGeometryContext(request.r, request.residues);
    const metrics = createSearchMetrics();
    const iterator = iterFastDownsets(request.r, request.residues, {
      modulusContext,
      rootPartition: { index: request.shardIndex, count: request.shardCount },
      metrics,
    });

    let candidateCspEnumerationMs = 0;
    let geometryMs = 0;
    let recordCount = 0;
    let chunk: DownsetRecord[] = [];

    const flush = () => {
      if (!chunk.length) return;
      const records = chunk;
      chunk = [];
      post({ type: 'chunk', shardIndex: request.shardIndex, records });
    };

    while (true) {
      const cspStart = performance.now();
      const next = iterator.next();
      candidateCspEnumerationMs += performance.now() - cspStart;
      if (next.done) break;
      const geometryStart = performance.now();
      const record = geometryRecordCached(next.value, request.residues, request.r, geometryContext);
      geometryMs += performance.now() - geometryStart;
      chunk.push(record);
      recordCount += 1;
      if (chunk.length >= SHARD_CHUNK_SIZE) flush();
    }
    flush();

    const complete: AsetsShardComplete = {
      type: 'complete',
      shardIndex: request.shardIndex,
      recordCount,
      performance: {
        modulusContextSetupMs,
        candidateCspEnumerationMs,
        geometryMs,
        totalWorkerComputeMs: performance.now() - wallStart,
        nodes: metrics.nodes,
        compatibilityChecks: metrics.compatibilityChecks,
        singletonPropagations: metrics.singletonPropagations,
        branches: metrics.branches,
        candidateCount: metrics.candidateCount,
      },
    };
    post(complete);
  } catch (error) {
    post({
      type: 'error',
      shardIndex: request.shardIndex,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
