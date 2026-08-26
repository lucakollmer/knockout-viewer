import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import oracle from './fixtures/current-universe-d3-12-r2-50.json';
import { enumerateCanonicalGroupsForModulus } from '../src/groupMath';

describe('authoritative current-universe differential', () => {
  it('matches all settled d=3..12, r=2..50 canonical rows and ordering', () => {
    const hash = createHash('sha256');
    let total = 0;

    for (const [d, r, expectedCount] of oracle.counts) {
      const rows = enumerateCanonicalGroupsForModulus(d, r);
      expect(rows.length, `count mismatch for d=${d}, r=${r}`).toBe(expectedCount);
      for (const row of rows) hash.update(`${row.join(',')}\n`);
      total += rows.length;
    }

    expect(total).toBe(oracle.totalRows);
    expect(total).toBe(73_571);
    expect(hash.digest('hex')).toBe(oracle.sha256);
  }, 120_000);
});
