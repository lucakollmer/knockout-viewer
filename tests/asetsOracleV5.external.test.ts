import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  buildModulusContext,
  computeFamily,
  familyPayloadJson,
  stableStringify,
  type Point,
} from '../src/asetsCore';

const DATABASE_SHA256 = 'a662628f57add19c75b929552684df4cf7b5dfa96de226f47e3a712f82d0e76f';
const databasePath = process.env.ASETS_V5_DB;

type OraclePayload = {
  r: number;
  residues: number[];
  downsets: number[][][];
  coherence_certificates: Array<{
    rows: number[][];
    coherent: boolean;
    witness: null | Array<[number, number]>;
  }>;
  geometry_templates: Array<{
    active_axes: number[];
    inactive_axes: number[];
    shape: string;
    low_rays: Array<Array<[number, number]>>;
  }>;
};

function pointCompare(left: readonly number[], right: readonly number[]): number {
  for (let axis = 0; axis < 3; axis += 1) if (left[axis] !== right[axis]) return left[axis] - right[axis];
  return 0;
}

function downsetCompare(left: readonly number[][], right: readonly number[][]): number {
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const compared = pointCompare(left[i], right[i]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function fractionInt(value: [number, number]): number {
  const [numerator, denominator] = value.map(Number);
  if (denominator !== 1) throw new Error(`expected integral oracle coordinate, got ${value}`);
  return numerator;
}

function normalizedOraclePayload(compressed: Uint8Array): string {
  const raw = JSON.parse(inflateSync(compressed).toString('utf8')) as OraclePayload;
  const records = raw.downsets.map((downset, index) => {
    const certificate = raw.coherence_certificates[index];
    const geometry = raw.geometry_templates[index];
    return {
      downset: downset
        .map((point) => point.map(Number))
        .sort((left, right) => left.reduce((sum, x) => sum + x, 0) - right.reduce((sum, x) => sum + x, 0) || pointCompare(left, right)),
      transition_rows: certificate.rows.map((row) => row.map(Number)).sort(pointCompare),
      coherent: Boolean(certificate.coherent),
      witness: certificate.witness === null ? null : certificate.witness.map(fractionInt),
      active_axes: geometry.active_axes.map(Number),
      inactive_axes: geometry.inactive_axes.map(Number),
      shape: String(geometry.shape),
      low_rays: geometry.low_rays.map((ray) => ray.map(fractionInt)).sort(pointCompare),
    };
  }).sort((left, right) => downsetCompare(left.downset, right.downset));
  return stableStringify({ r: Number(raw.r), residues: raw.residues.map(Number), records });
}

describe.skipIf(!databasePath)('authoritative generalized v5 Asets differential', () => {
  it('matches all 12,709 canonical families exactly', { timeout: 30 * 60_000 }, () => {
    if (!databasePath) throw new Error('ASETS_V5_DB is required');
    expect(createHash('sha256').update(readFileSync(databasePath)).digest('hex')).toBe(DATABASE_SHA256);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database.prepare(
      'SELECT family_id,r,residues_json,payload FROM families ORDER BY r,family_id',
    ).all() as Array<{ family_id: number; r: number; residues_json: string; payload: Uint8Array }>;

    let currentR = -1;
    let context: ReturnType<typeof buildModulusContext> | undefined;
    let checked = 0;
    let downsets = 0;
    let noncoherent = 0;

    for (const row of rows) {
      const r = Number(row.r);
      if (r !== currentR) {
        context = buildModulusContext(r);
        currentR = r;
      }
      const parsedResidues = JSON.parse(row.residues_json) as number[];
      const residues: Point = [Number(parsedResidues[0]), Number(parsedResidues[1]), Number(parsedResidues[2])];
      const actual = computeFamily(r, residues, { modulusContext: context });
      expect(familyPayloadJson(actual), `family ${row.family_id}, r=${r}, residues=${residues.join(',')}`).toBe(
        normalizedOraclePayload(row.payload),
      );
      checked += 1;
      downsets += actual.records.length;
      noncoherent += actual.records.filter((record) => !record.coherent).length;
    }
    database.close();

    expect({ checked, downsets, noncoherent }).toEqual({ checked: 12_709, downsets: 483_780, noncoherent: 498 });
  });
});
