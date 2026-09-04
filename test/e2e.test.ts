import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProfiler } from '../src/profiler/index.js';
import { runCleaning } from '../src/cleaner/executor.js';
import { parseCsv } from '../src/shared/csv.js';
import { parsePlan } from '../src/shared/plan.js';

let profiler: { url: string; close: () => Promise<void> };
let outDir: string;
let cleaned: ReturnType<typeof parseCsv>;

beforeAll(async () => {
  profiler = await startProfiler(0);
  outDir = mkdtempSync(join(tmpdir(), 'a2a-e2e-'));
  await runCleaning({
    csvPath: 'data/students_raw.csv',
    profilerUrl: profiler.url,
    outDir,
    onQuestion: async () => 'b',
  });
  cleaned = parseCsv(readFileSync(join(outDir, 'cleaned.csv'), 'utf8'));
}, 60_000);

afterAll(async () => { await profiler.close(); });

describe('end-to-end cleaning invariants', () => {
  it('removes duplicate roll numbers', () => {
    const rolls = cleaned.rows.map((r) => r.roll_no);
    expect(new Set(rolls).size).toBe(rolls.length);
  });

  it('bounds every numeric marks value to 0-100', () => {
    for (const row of cleaned.rows) {
      const n = Number(row.marks);
      if (Number.isFinite(n) && row.marks.trim() !== '') {
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(100);
      }
    }
  });

  it('leaves one canonical spelling per city', () => {
    const cities = new Set(cleaned.rows.map((r) => r.city).filter((c) => c.trim() !== ''));
    expect(cities.has('lahore')).toBe(false);
    expect(cities.has('LHR')).toBe(false);
    expect(cities.has(' Lahore ')).toBe(false);
    expect(cities.has('Lahore')).toBe(true);
  });

  it('writes every date in YYYY-MM-DD', () => {
    const bad = cleaned.rows.filter(
      (r) => r.enrolled_date.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(r.enrolled_date),
    );
    expect(bad).toHaveLength(0);
  });

  it('flags invalid emails without deleting those rows', () => {
    expect(cleaned.headers).toContain('email_invalid');
    expect(cleaned.rows.some((r) => r.email_invalid === 'true')).toBe(true);
  });

  it('loses no column from the original dataset', () => {
    for (const h of ['roll_no', 'name', 'email', 'age', 'city', 'marks', 'enrolled_date']) {
      expect(cleaned.headers).toContain(h);
    }
  });

  it('saves a valid plan artifact and a report naming the human decision', () => {
    const plan = JSON.parse(readFileSync(join(outDir, 'cleaning-plan.json'), 'utf8'));
    expect(parsePlan(plan).ok).toBe(true);

    const report = readFileSync(join(outDir, 'report.md'), 'utf8');
    expect(report).toContain('Human decision');
    expect(report).toContain('Rules applied');
  });
});
