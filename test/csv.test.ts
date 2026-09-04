import { describe, it, expect } from 'vitest';
import { parseCsv, toCsv } from '../src/shared/csv.js';

describe('parseCsv', () => {
  it('parses headers and rows', () => {
    const { headers, rows } = parseCsv('a,b\n1,2\n3,4\n');
    expect(headers).toEqual(['a', 'b']);
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    const { rows } = parseCsv('name,date\nAli,"March 1, 2024"\n');
    expect(rows[0].date).toBe('March 1, 2024');
  });

  it('unescapes doubled quotes', () => {
    const { rows } = parseCsv('a\n"he said ""hi"""\n');
    expect(rows[0].a).toBe('he said "hi"');
  });

  it('preserves surrounding whitespace inside quotes', () => {
    const { rows } = parseCsv('city\n" Lahore "\n');
    expect(rows[0].city).toBe(' Lahore ');
  });

  it('ignores a trailing newline and tolerates CRLF', () => {
    const { rows } = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toHaveLength(1);
  });

  it('fills missing trailing fields with empty strings', () => {
    const { rows } = parseCsv('a,b,c\n1,2\n');
    expect(rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });
});

describe('toCsv', () => {
  it('round-trips values that need quoting', () => {
    const headers = ['a', 'b'];
    const rows = [{ a: 'x,y', b: 'he said "hi"' }, { a: ' z ', b: '' }];
    const parsed = parseCsv(toCsv(headers, rows));
    expect(parsed.rows).toEqual(rows);
  });
});
