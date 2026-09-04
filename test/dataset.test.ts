import { describe, it, expect } from 'vitest';
import { generateDataset } from '../scripts/generate-dataset.js';

describe('generateDataset', () => {
  const { headers, rows } = generateDataset();

  it('produces 400 rows with the agreed columns', () => {
    expect(rows).toHaveLength(400);
    expect(headers).toEqual([
      'roll_no', 'name', 'email', 'age', 'city', 'marks', 'enrolled_date',
    ]);
  });

  it('is deterministic', () => {
    expect(generateDataset().rows).toEqual(rows);
  });

  it('contains exactly 3 implausible ages (the input-required trigger)', () => {
    const bad = rows.filter((r) => {
      const n = Number(r.age);
      return Number.isFinite(n) && (n < 5 || n > 100);
    });
    expect(bad).toHaveLength(3);
  });

  it('contains at least 4 spellings of Lahore', () => {
    const variants = new Set(
      rows.map((r) => r.city).filter((c) => c.trim().toLowerCase().startsWith('l')),
    );
    expect(variants.size).toBeGreaterThanOrEqual(4);
  });

  it('contains out-of-range marks', () => {
    const bad = rows.filter((r) => {
      const n = Number(r.marks);
      return Number.isFinite(n) && (n < 0 || n > 100);
    });
    expect(bad.length).toBeGreaterThanOrEqual(10);
  });

  it('contains at least 3 date formats', () => {
    const iso = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.enrolled_date));
    const slash = rows.filter((r) => /^\d{2}\/\d{2}\/\d{4}$/.test(r.enrolled_date));
    const long = rows.filter((r) => /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(r.enrolled_date));
    expect(iso.length).toBeGreaterThan(0);
    expect(slash.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(0);
  });

  it('contains exact duplicate rows', () => {
    const seen = new Set<string>();
    let dupes = 0;
    for (const r of rows) {
      const key = JSON.stringify(r);
      if (seen.has(key)) dupes++;
      else seen.add(key);
    }
    expect(dupes).toBeGreaterThanOrEqual(15);
  });

  it('contains missing values written several ways', () => {
    const blanks = rows.filter((r) =>
      ['', 'N/A', 'NULL', '-'].includes(r.city) || ['', 'N/A', 'NULL', '-'].includes(r.age),
    );
    expect(blanks.length).toBeGreaterThanOrEqual(40);
  });

  it('contains non-numeric ages and invalid emails', () => {
    expect(rows.some((r) => r.age === 'twenty')).toBe(true);
    expect(rows.some((r) => !r.email.includes('@') || r.email.endsWith('@'))).toBe(true);
  });
});
