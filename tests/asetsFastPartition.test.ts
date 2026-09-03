import { describe, expect, it } from 'vitest';
import { buildFastModulusContext, iterFastDownsets } from '../src/asetsFast';
import type { Point } from '../src/asetsCore';

describe('Asets parallel partition strategies', () => {
  it('concatenates depth-two opposite-pair partitions into exact single-thread order', () => {
    const r = 50;
    const residues: Point = [1, 24, 49];
    const modulusContext = buildFastModulusContext(r);
    const single = [...iterFastDownsets(r, residues, { modulusContext })];
    expect(single).toHaveLength(386);

    const partitioned = Array.from({ length: 4 }, (_, index) => (
      [...iterFastDownsets(r, residues, {
        modulusContext,
        rootPartition: { index, count: 4 },
      })]
    )).flat();

    expect(partitioned).toEqual(single);
  });
});
