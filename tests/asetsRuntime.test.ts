import { describe, expect, it } from 'vitest';
import { createFamilyGeometryContext } from '../src/asetsGeometry';
import { buildFastModulusContext } from '../src/asetsFast';
import { assertExactRuntimeModulus, effectiveRuntimeFamily } from '../src/asetsRuntime';

describe('interactive Asets runtime modulus policy', () => {
  it('has no fixed product-level modulus cap', () => {
    expect(() => assertExactRuntimeModulus(200)).not.toThrow();
    expect(effectiveRuntimeFamily(200, [1, 99, 199]).r).toBe(200);
    expect(() => createFamilyGeometryContext(400, [1, 199, 399])).not.toThrow();
  });

  it('builds the optimized modulus context above the former r=100 limit', () => {
    const context = buildFastModulusContext(101);
    expect(context.r).toBe(101);
    expect(context.points.length).toBeGreaterThan(0);
    expect(context.boxPointIds.length).toBe(context.points.length);
  });

  it('fails only at the proven Number arithmetic envelope', () => {
    expect(() => assertExactRuntimeModulus(802)).not.toThrow();
    expect(() => assertExactRuntimeModulus(803)).toThrow(/BigInt\/WASM exact backend/);
  });
});
