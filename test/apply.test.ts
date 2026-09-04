import { describe, it, expect } from 'vitest';
import { applyRule, previewRule } from '../src/cleaner/apply.js';
import type { CleaningRule } from '../src/shared/plan.js';
import type { Row } from '../src/shared/csv.js';

const headers = ['roll_no', 'city', 'age', 'marks', 'email', 'enrolled_date'];

function rule(partial: Partial<CleaningRule> & Pick<CleaningRule, 'action'>): CleaningRule {
  return {
    id: 'r', params: {}, reason: 'test', severity: 'medium', ...partial,
  } as CleaningRule;
}

const base: Row[] = [
  { roll_no: '1', city: ' Lahore ', age: '20', marks: '105', email: 'a@b.pk', enrolled_date: '2024-03-01' },
  { roll_no: '2', city: 'lahore', age: 'twenty', marks: '-5', email: 'bad@', enrolled_date: '01/03/2024' },
  { roll_no: '2', city: 'N/A', age: '', marks: '70', email: 'c@d.pk', enrolled_date: 'March 1, 2024' },
];

describe('applyRule', () => {
  it('trim_whitespace strips surrounding spaces', () => {
    const r = applyRule(headers, base, rule({ action: 'trim_whitespace', column: 'city' }));
    expect(r.rows[0].city).toBe('Lahore');
    expect(r.outcome.rowsChanged).toBe(1);
  });

  it('normalize maps values through an explicit map', () => {
    const r = applyRule(headers, base, rule({
      action: 'normalize', column: 'city', params: { map: { lahore: 'Lahore' } },
    }));
    expect(r.rows[1].city).toBe('Lahore');
  });

  it('title_case normalises casing', () => {
    const r = applyRule(headers, base, rule({ action: 'title_case', column: 'city' }));
    expect(r.rows[1].city).toBe('Lahore');
  });

  it('clip clamps numbers into range', () => {
    const r = applyRule(headers, base, rule({
      action: 'clip', column: 'marks', params: { min: 0, max: 100 },
    }));
    expect(r.rows[0].marks).toBe('100');
    expect(r.rows[1].marks).toBe('0');
    expect(r.outcome.rowsChanged).toBe(2);
  });

  it('coerce_number converts number words and blanks the rest', () => {
    const r = applyRule(headers, base, rule({
      action: 'coerce_number', column: 'age', params: { wordMap: { twenty: 20 } },
    }));
    expect(r.rows[1].age).toBe('20');
  });

  it('parse_date unifies formats to YYYY-MM-DD', () => {
    const r = applyRule(headers, base, rule({
      action: 'parse_date', column: 'enrolled_date', params: { targetFormat: 'YYYY-MM-DD' },
    }));
    expect(r.rows[1].enrolled_date).toBe('2024-03-01');
    expect(r.rows[2].enrolled_date).toBe('2024-03-01');
  });

  it('fill with the median imputes missing values', () => {
    const r = applyRule(headers, base, rule({
      action: 'fill', column: 'age', params: { strategy: 'median' },
    }));
    expect(r.rows[2].age).toBe('20');
  });

  it('fill with a constant uses the given value', () => {
    const r = applyRule(headers, base, rule({
      action: 'fill', column: 'city', params: { strategy: 'constant', value: 'Unknown' },
    }));
    expect(r.rows[2].city).toBe('Unknown');
  });

  it('drop_rows_where removes matching rows', () => {
    const r = applyRule(headers, base, rule({
      action: 'drop_rows_where', column: 'marks',
      params: { predicate: { op: 'lt', value: 0 } },
    }));
    expect(r.rows).toHaveLength(2);
    expect(r.outcome.rowsRemoved).toBe(1);
  });

  it('flag_invalid adds a boolean column and deletes nothing', () => {
    const r = applyRule(headers, base, rule({
      action: 'flag_invalid', column: 'email', params: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
    }));
    expect(r.headers).toContain('email_invalid');
    expect(r.rows[1].email_invalid).toBe('true');
    expect(r.rows[0].email_invalid).toBe('false');
    expect(r.rows).toHaveLength(3);
  });

  it('dedupe keeps the first row per key', () => {
    const r = applyRule(headers, base, rule({
      action: 'dedupe', params: { keys: ['roll_no'], keep: 'first' },
    }));
    expect(r.rows).toHaveLength(2);
    expect(r.rows[1].city).toBe('lahore');
  });

  it('dedupe with keep=last keeps the last row per key', () => {
    const r = applyRule(headers, base, rule({
      action: 'dedupe', params: { keys: ['roll_no'], keep: 'last' },
    }));
    expect(r.rows[1].city).toBe('N/A');
  });

  it('skips a rule naming an unknown column and reports why', () => {
    const r = applyRule(headers, base, rule({ action: 'trim_whitespace', column: 'nope' }));
    expect(r.outcome.skipped).toContain('nope');
    expect(r.rows).toEqual(base);
  });

  it('skips a column-scoped rule with no column', () => {
    const r = applyRule(headers, base, rule({ action: 'trim_whitespace' }));
    expect(r.outcome.skipped).toBeTruthy();
  });

  it('does not mutate the input rows', () => {
    const snapshot = JSON.stringify(base);
    applyRule(headers, base, rule({ action: 'trim_whitespace', column: 'city' }));
    expect(JSON.stringify(base)).toBe(snapshot);
  });

  it('skips flag_invalid with a malformed pattern instead of throwing', () => {
    expect(() => applyRule(headers, base, rule({
      action: 'flag_invalid', column: 'email', params: { pattern: '([unclosed' },
    }))).not.toThrow();
    const r = applyRule(headers, base, rule({
      action: 'flag_invalid', column: 'email', params: { pattern: '([unclosed' },
    }));
    expect(r.outcome.skipped).toContain('([unclosed');
    expect(r.rows).toEqual(base);
    expect(r.headers).not.toContain('email_invalid');
  });
});

describe('previewRule', () => {
  it('reports affected rows and examples without mutating', () => {
    const p = previewRule(headers, base, rule({
      action: 'clip', column: 'marks', params: { min: 0, max: 100 },
    }));
    expect(p.rowsAffected).toBe(2);
    expect(p.examples[0]).toEqual({ before: '105', after: '100' });
    expect(p.examples.length).toBeLessThanOrEqual(5);
  });

  it('reports non-empty examples for flag_invalid, diffing the flag column', () => {
    const p = previewRule(headers, base, rule({
      action: 'flag_invalid', column: 'email', params: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' },
    }));
    expect(p.rowsAffected).toBe(1);
    expect(p.examples.length).toBeGreaterThan(0);
    expect(['true', 'false']).toContain(p.examples[0].after);
  });
});
