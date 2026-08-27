import { describe, expect, it } from 'vitest';
import { buildFastModulusContext } from '../src/asetsFast';

describe('interactive optimized Asets path', () => {
  it('builds a cold modulus context without preloaded data', () => {
    const context = buildFastModulusContext(4);
    expect(context.r).toBe(4);
    expect(context.points.length).toBeGreaterThan(0);
    expect(context.boxPointIds.length).toBe(context.points.length);
  });
});
