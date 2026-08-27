import type { DownsetRecord, FamilyTransformCertificate, Point } from './asetsCore';

export type AsetsFamilyKey = readonly [
  engineVersion: string,
  rEff: number,
  residue0: number,
  residue1: number,
  residue2: number,
];

export type AsetsComputationStatus = 'computing' | 'complete' | 'cancelled' | 'error';

export type AsetsPerformance = {
  cacheHit: boolean;
  modulusContextSetupMs: number;
  candidateCspEnumerationMs: number;
  geometryMs: number;
  totalWorkerComputeMs: number;
  serializationChunkingMs: number;
  indexedDbReadMs: number;
  indexedDbWriteMs: number;
  peakUsedJsHeapBytes: number | null;
};

export type AsetsFamilyHeader = {
  schemaVersion: number;
  engineVersion: string;
  familyKey: AsetsFamilyKey;
  r: number;
  residues: Point;
  status: AsetsComputationStatus;
  downsetTotal: number;
  coherentTotal: number;
  noncoherentTotal: number;
  chunkCount: number;
  normalizedResultDigest: string | null;
  completedAt: string | null;
  performance: AsetsPerformance | null;
};

export type AsetsFamilyChunk = {
  schemaVersion: number;
  engineVersion: string;
  familyKey: AsetsFamilyKey;
  chunkIndex: number;
  records: readonly DownsetRecord[];
};

export type AsetsGroupTransform = {
  schemaVersion: number;
  engineVersion: string;
  groupId: string;
  familyKey: AsetsFamilyKey;
  certificate: FamilyTransformCertificate;
  updatedAt: string;
};

export type AsetsComputeRequest = {
  type: 'compute';
  requestId: number;
  r: number;
  residues: Point;
  groupId?: string;
  /** Visual consumers request exact records; header-only consumers can omit this. */
  includeRecords?: boolean;
};

export type AsetsCancelRequest = {
  type: 'cancel';
  requestId?: number;
};

export type AsetsWorkerRequest = AsetsComputeRequest | AsetsCancelRequest;

export type AsetsStatusMessage = {
  type: 'status';
  requestId: number;
  phase: 'cache' | 'context' | 'compute' | 'finalize';
  familyKey: AsetsFamilyKey;
  certificate: FamilyTransformCertificate;
  emittedRecords: number;
};

export type AsetsChunkMessage = {
  type: 'chunk';
  requestId: number;
  familyKey: AsetsFamilyKey;
  chunkIndex: number;
  records: readonly DownsetRecord[];
  cached: boolean;
};

export type AsetsCompleteMessage = {
  type: 'complete';
  requestId: number;
  familyKey: AsetsFamilyKey;
  certificate: FamilyTransformCertificate;
  header: AsetsFamilyHeader;
  cached: boolean;
};

export type AsetsCancelledMessage = {
  type: 'cancelled';
  requestId: number;
  familyKey?: AsetsFamilyKey;
};

export type AsetsErrorMessage = {
  type: 'error';
  requestId: number;
  familyKey?: AsetsFamilyKey;
  message: string;
};

export type AsetsWorkerMessage =
  | AsetsStatusMessage
  | AsetsChunkMessage
  | AsetsCompleteMessage
  | AsetsCancelledMessage
  | AsetsErrorMessage;
