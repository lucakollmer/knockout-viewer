import { describe, expect, it } from 'vitest';
import {
  buildModulusContext,
  compareDownsets,
  computeFamily,
  effectiveFamily,
  iterDownsets,
  type FamilyResult,
  type Point,
} from '../src/asetsCore';
import { buildFastModulusContext, iterFastDownsets } from '../src/asetsFast';
import { createFamilyGeometryContext, geometryRecordCached } from '../src/asetsGeometry';

const CASES: ReadonlyArray<readonly [number, Point]> = [
  [4, [1, 2, 3]],
  [9, [0, 1, 8]],
  [14, [1, 9, 11]],
  [50, [1, 13, 37]],
  [50, [1, 24, 49]],
];

function computeFastFamily(r: number, residues: Point): FamilyResult {
  const normalized = effectiveFamily(r, residues);
  const modulusContext = buildFastModulusContext(normalized.r);
  const streamed = [...iterFastDownsets(normalized.r, normalized.residues, { modulusContext })];
  const ordered = streamed.slice().sort(compareDownsets);
  const geometryContext = createFamilyGeometryContext(normalized.r, normalized.residues);
  return {
    r: normalized.r,
    residues: normalized.residues,
    records: ordered.map((downset) => geometryRecordCached(
      downset,
      normalized.residues,
      normalized.r,
      geometryContext,
    )),
  };
}

describe('interactive fast Asets path', () => {
  it.each(CASES)('preserves frozen CSP stream order for r=%i residues=%j', (r: number, residues: Point) => {
    const normalized = effectiveFamily(r, residues);
    const frozenContext = buildModulusContext(normalized.r);
    const fastContext = buildFastModulusContext(normalized.r);
    expect([...iterFastDownsets(normalized.r, normalized.residues, { modulusContext: fastContext })]).toEqual(
      [...iterDownsets(normalized.r, normalized.residues, { modulusContext: frozenContext })],
    );
  });

  it.each(CASES)('matches the complete frozen family for r=%i residues=%j', (r: number, residues: Point) => {
    expect(computeFastFamily(r, residues)).toEqual(computeFamily(r, residues));
  });

  it('preserves effective reduction before the fast path', () => {
    expect(computeFastFamily(10, [2, 4, 6])).toEqual(computeFamily(10, [2, 4, 6]));
  });

  it('cancels during fast modulus preparation', () => {
    expect(() => buildFastModulusContext(50, () => true)).toThrow(/cancel/i);
  });
});
