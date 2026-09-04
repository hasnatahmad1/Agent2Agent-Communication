import { describe, it, expect } from 'vitest';
import { computeProfile } from '../src/shared/profile.js';
import type { Row } from '../src/shared/csv.js';

const headers = ['city', 'marks'];
const rows: Row[] = [
  { city: 'Lahore', marks: '80' },
  { city: 'lahore', marks: '105' },
  { city: 'N/A', marks: '-5' },
  { city: 'Lahore', marks: '70' },
  { city: '', marks: 'abc' },
];

describe('computeProfile', () => {
  const profile = computeProfile(headers, rows);
  const city = profile.columns.find((c) => c.name === 'city')!;
  const marks = profile.columns.find((c) => c.name === 'marks')!;

  it('reports the row count', () => {
    expect(profile.rowCount).toBe(5);
  });

  it('counts missing values including N/A and empty string', () => {
    expect(city.nullCount).toBe(2);
  });

  it('counts distinct non-missing values', () => {
    expect(city.distinctCount).toBe(2);
  });

  it('orders topValues by frequency', () => {
    expect(city.topValues[0]).toEqual(['Lahore', 2]);
  });

  it('infers a numeric column and reports min, max and mean', () => {
    expect(marks.inferredType).toBe('number');
    expect(marks.min).toBe(-5);
    expect(marks.max).toBe(105);
  });

  it('lists values in a numeric column that are not numbers', () => {
    expect(marks.nonNumericValues).toContain('abc');
  });

  it('infers a string column', () => {
    expect(city.inferredType).toBe('string');
  });

  it('counts exact duplicate rows', () => {
    const dup = computeProfile(headers, [...rows, { ...rows[0] }]);
    expect(dup.exactDuplicateRows).toBe(1);
  });

  it('includes at most 15 sample rows', () => {
    const many = computeProfile(headers, Array.from({ length: 50 }, () => rows[0]));
    expect(many.sampleRows).toHaveLength(15);
  });

  it('caps topValues at 20 entries', () => {
    const wide: Row[] = Array.from({ length: 40 }, (_, i) => ({ city: `c${i}`, marks: '1' }));
    expect(computeProfile(headers, wide).columns[0].topValues.length).toBeLessThanOrEqual(20);
  });
});
