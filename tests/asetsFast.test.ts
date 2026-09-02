import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  compareDownsets,
  effectiveFamily,
  familyPayloadJson,
  type FamilyResult,
  type Point,
} from '../src/asetsCore';
import { buildFastModulusContext, iterFastDownsets } from '../src/asetsFast';
import { createFamilyGeometryContext, geometryRecordCached } from '../src/asetsGeometry';

function computeInteractive(r: number, residues: Point): FamilyResult {
  const modulusContext = buildFastModulusContext(r);
  const downsets = [...iterFastDownsets(r, residues, { modulusContext })].sort(compareDownsets);
  const geometryContext = createFamilyGeometryContext(r, residues);
  return {
    r,
    residues,
    records: downsets.map((downset) => geometryRecordCached(downset, residues, r, geometryContext)),
  };
}

function digest(result: FamilyResult): string {
  return createHash('sha256').update(familyPayloadJson(result)).digest('hex');
}

describe('interactive optimized Asets path', () => {
  it('matches the frozen small-family digest', () => {
    const result = computeInteractive(4, [1, 2, 3]);
    expect(result.records).toHaveLength(7);
    expect(digest(result)).toBe('f3a127d19eb96c1e41151ca1674d1587a1bec6078a7cedc3310e98429788fa9b');
  });

  it('matches the frozen noncoherent sentinel digest', () => {
    const result = computeInteractive(14, [1, 9, 11]);
    expect(result.records).toHaveLength(35);
    expect(digest(result)).toBe('219f70e239e54e83e45ebb129155a7f86ae3b148ad3c73ba3eb823c1a5a532ee');
  });

  it('matches the frozen hard r=50 digest', () => {
    const result = computeInteractive(50, [1, 24, 49]);
    expect(result.records).toHaveLength(386);
    expect(digest(result)).toBe('713db807af7888ffe80f13f408bfa3e55912e8a94770a1d6fa1abd2a210546d5');
  });

  it('concatenates deterministic root partitions into the exact single-thread order', () => {
    const r = 14;
    const residues: Point = [1, 9, 11];
    const modulusContext = buildFastModulusContext(r);
    const single = [...iterFastDownsets(r, residues, { modulusContext })];
    const partitioned = Array.from({ length: 4 }, (_, index) => (
      [...iterFastDownsets(r, residues, {
        modulusContext,
        rootPartition: { index, count: 4 },
      })]
    )).flat();
    expect(partitioned).toEqual(single);
  });

  it('preserves effective reduction before optimized computation', () => {
    const normalized = effectiveFamily(10, [2, 4, 6]);
    expect(normalized.r).toBe(5);
    expect(normalized.residues).toEqual([1, 2, 3]);
  });

  it('honors cancellation while building a cold modulus context', () => {
    expect(() => buildFastModulusContext(50, () => true)).toThrow(/cancel/i);
  });
});
