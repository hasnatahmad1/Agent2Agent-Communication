import type { Row } from './csv.js';

/** Strings that all mean "no value" in this dataset. */
export const MISSING_TOKENS = ['', 'n/a', 'null', '-', 'na'] as const;

export function isMissing(value: string): boolean {
  return (MISSING_TOKENS as readonly string[]).includes(value.trim().toLowerCase());
}

export interface ColumnProfile {
  name: string;
  inferredType: 'number' | 'string';
  nullCount: number;
  distinctCount: number;
  topValues: [string, number][];
  sampleValues: string[];
  min?: number;
  max?: number;
  mean?: number;
  outOfRangeCount?: number;
  nonNumericValues?: string[];
}

export interface DatasetProfile {
  rowCount: number;
  columns: ColumnProfile[];
  sampleRows: Row[];
  exactDuplicateRows: number;
}

/**
 * Builds a compact statistical summary of the dataset — roughly 2K tokens for
 * 400 rows. This is what crosses the network to the Profiler agent; the raw
 * rows never leave the Cleaner.
 */
export function computeProfile(headers: string[], rows: Row[]): DatasetProfile {
  const columns = headers.map((name) => profileColumn(name, rows));

  const seen = new Set<string>();
  let exactDuplicateRows = 0;
  for (const row of rows) {
    const key = JSON.stringify(headers.map((h) => row[h] ?? ''));
    if (seen.has(key)) exactDuplicateRows++;
    else seen.add(key);
  }

  return {
    rowCount: rows.length,
    columns,
    sampleRows: rows.slice(0, 15),
    exactDuplicateRows,
  };
}

function profileColumn(name: string, rows: Row[]): ColumnProfile {
  const values = rows.map((r) => r[name] ?? '');
  const present = values.filter((v) => !isMissing(v));
  const nullCount = values.length - present.length;

  const counts = new Map<string, number>();
  for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1);

  const topValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20) as [string, number][];

  const numeric: number[] = [];
  const nonNumericValues: string[] = [];
  for (const v of present) {
    const n = Number(v);
    if (v.trim() !== '' && Number.isFinite(n)) numeric.push(n);
    else if (!nonNumericValues.includes(v) && nonNumericValues.length < 10) {
      nonNumericValues.push(v);
    }
  }

  const isNumber = present.length > 0 && numeric.length / present.length >= 0.6;

  const base: ColumnProfile = {
    name,
    inferredType: isNumber ? 'number' : 'string',
    nullCount,
    distinctCount: counts.size,
    topValues,
    sampleValues: present.slice(0, 3),
  };

  if (!isNumber) return base;

  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const mean = numeric.reduce((a, b) => a + b, 0) / numeric.length;

  return {
    ...base,
    min,
    max,
    mean: Math.round(mean * 100) / 100,
    outOfRangeCount: numeric.filter((n) => n < 0 || n > 100).length,
    nonNumericValues,
  };
}
