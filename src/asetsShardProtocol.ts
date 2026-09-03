import type { DownsetRecord, Point } from './asetsCore';

export type AsetsShardRequest = {
  type: 'compute';
  shardIndex: number;
  shardCount: number;
  r: number;
  residues: Point;
};

export type AsetsShardPerformance = {
  modulusContextSetupMs: number;
  candidateCspEnumerationMs: number;
  geometryMs: number;
  totalWorkerComputeMs: number;
  nodes: number;
  compatibilityChecks: number;
  singletonPropagations: number;
  branches: number;
  candidateCount: number;
};

export type AsetsShardChunk = {
  type: 'chunk';
  shardIndex: number;
  records: readonly DownsetRecord[];
};

export type AsetsShardComplete = {
  type: 'complete';
  shardIndex: number;
  recordCount: number;
  performance: AsetsShardPerformance;
};

export type AsetsShardError = {
  type: 'error';
  shardIndex: number;
  message: string;
};

export type AsetsShardMessage = AsetsShardChunk | AsetsShardComplete | AsetsShardError;
