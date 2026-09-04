import type { Row } from '../shared/csv.js';
import type { CleaningRule } from '../shared/plan.js';
import { isMissing } from '../shared/profile.js';

export interface RuleOutcome {
  ruleId: string;
  action: string;
  column?: string;
  rowsChanged: number;
  rowsRemoved: number;
  skipped?: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'];

/** Parses the three date shapes present in the dataset. Returns '' when none match. */
function toIsoDate(value: string): string {
  const v = value.trim();

  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) return v;

  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (slash) {
    const [, d, m, y] = slash;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  const long = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(v);
  if (long) {
    const m = MONTHS.indexOf(long[1].toLowerCase());
    if (m >= 0) {
      return `${long[3]}-${String(m + 1).padStart(2, '0')}-${long[2].padStart(2, '0')}`;
    }
  }

  return '';
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mode(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = '';
  let bestCount = -1;
  for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
  return best;
}

/**
 * Computes the new value for one cell under a column-scoped rule.
 * Returns the input unchanged when the rule does not apply to it.
 */
function transformCell(value: string, rule: CleaningRule, column: string, rows: Row[]): string {
  const p = rule.params as Record<string, any>;

  switch (rule.action) {
    case 'trim_whitespace':
      return value.trim();

    case 'normalize': {
      const map = (p.map ?? {}) as Record<string, string>;
      if (Object.prototype.hasOwnProperty.call(map, value)) return map[value];
      const hit = Object.keys(map).find(
        (k) => k.trim().toLowerCase() === value.trim().toLowerCase(),
      );
      return hit ? map[hit] : value;
    }

    case 'title_case': {
      const t = value.trim();
      if (t === '') return value;
      return t.split(/\s+/)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    }

    case 'clip': {
      const n = Number(value);
      if (!Number.isFinite(n) || value.trim() === '') return value;
      const min = typeof p.min === 'number' ? p.min : -Infinity;
      const max = typeof p.max === 'number' ? p.max : Infinity;
      return String(Math.min(max, Math.max(min, n)));
    }

    case 'coerce_number': {
      if (isMissing(value)) return value;
      const n = Number(value);
      if (Number.isFinite(n) && value.trim() !== '') return String(n);
      const wordMap = (p.wordMap ?? {}) as Record<string, number>;
      const word = value.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(wordMap, word)) return String(wordMap[word]);
      const embedded = /(-?\d+(?:\.\d+)?)/.exec(value);
      return embedded ? embedded[1] : '';
    }

    case 'parse_date': {
      if (isMissing(value)) return value;
      const iso = toIsoDate(value);
      return iso === '' ? value : iso;
    }

    case 'fill': {
      if (!isMissing(value)) return value;
      const strategy = p.strategy ?? 'constant';
      if (strategy === 'constant') return String(p.value ?? '');
      const present = rows.map((r) => r[column] ?? '').filter((v) => !isMissing(v));
      if (strategy === 'median') {
        const nums = present.map(Number).filter((n) => Number.isFinite(n));
        return nums.length ? String(median(nums)) : value;
      }
      if (strategy === 'mode') return present.length ? mode(present) : value;
      return value;
    }

    default:
      return value;
  }
}

const COLUMN_SCOPED = new Set([
  'trim_whitespace', 'normalize', 'title_case', 'clip',
  'coerce_number', 'parse_date', 'fill',
]);

function matchesPredicate(value: string, predicate: any): boolean {
  if (!predicate || typeof predicate !== 'object') return false;
  const { op, value: target } = predicate as { op: string; value: unknown };
  const n = Number(value);
  switch (op) {
    case 'lt': return Number.isFinite(n) && n < Number(target);
    case 'lte': return Number.isFinite(n) && n <= Number(target);
    case 'gt': return Number.isFinite(n) && n > Number(target);
    case 'gte': return Number.isFinite(n) && n >= Number(target);
    case 'eq': return value === String(target);
    case 'missing': return isMissing(value);
    default: return false;
  }
}

export function applyRule(
  headers: string[],
  rows: Row[],
  rule: CleaningRule,
): { headers: string[]; rows: Row[]; outcome: RuleOutcome } {
  const outcome: RuleOutcome = {
    ruleId: rule.id, action: rule.action, column: rule.column,
    rowsChanged: 0, rowsRemoved: 0,
  };

  const needsColumn = COLUMN_SCOPED.has(rule.action)
    || rule.action === 'flag_invalid'
    || rule.action === 'drop_rows_where';

  if (needsColumn) {
    if (!rule.column) {
      return { headers, rows, outcome: { ...outcome, skipped: `action ${rule.action} requires a column` } };
    }
    if (!headers.includes(rule.column)) {
      return { headers, rows, outcome: { ...outcome, skipped: `unknown column "${rule.column}"` } };
    }
  }

  if (COLUMN_SCOPED.has(rule.action)) {
    const column = rule.column!;
    let changed = 0;
    const next = rows.map((row) => {
      const before = row[column] ?? '';
      const after = transformCell(before, rule, column, rows);
      if (after === before) return row;
      changed++;
      return { ...row, [column]: after };
    });
    return { headers, rows: next, outcome: { ...outcome, rowsChanged: changed } };
  }

  if (rule.action === 'flag_invalid') {
    const column = rule.column!;
    const flagColumn = `${column}_invalid`;
    const patternSource = String((rule.params as any).pattern ?? '.*');
    let pattern: RegExp;
    try {
      pattern = new RegExp(patternSource);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        headers, rows,
        outcome: { ...outcome, skipped: `invalid pattern for flag_invalid: ${message}` },
      };
    }
    let changed = 0;
    const next = rows.map((row) => {
      const value = row[column] ?? '';
      const invalid = isMissing(value) ? true : !pattern.test(value);
      if (invalid) changed++;
      return { ...row, [flagColumn]: String(invalid) };
    });
    const nextHeaders = headers.includes(flagColumn) ? headers : [...headers, flagColumn];
    return { headers: nextHeaders, rows: next, outcome: { ...outcome, rowsChanged: changed } };
  }

  if (rule.action === 'drop_rows_where') {
    const column = rule.column!;
    const predicate = (rule.params as any).predicate;
    const next = rows.filter((row) => !matchesPredicate(row[column] ?? '', predicate));
    return {
      headers, rows: next,
      outcome: { ...outcome, rowsRemoved: rows.length - next.length },
    };
  }

  if (rule.action === 'dedupe') {
    const keys = ((rule.params as any).keys ?? headers) as string[];
    const missing = keys.filter((k) => !headers.includes(k));
    if (missing.length) {
      return { headers, rows, outcome: { ...outcome, skipped: `unknown column "${missing[0]}"` } };
    }
    const keep = (rule.params as any).keep === 'last' ? 'last' : 'first';
    const byKey = new Map<string, Row>();
    for (const row of rows) {
      const key = JSON.stringify(keys.map((k) => row[k] ?? ''));
      if (keep === 'last' || !byKey.has(key)) byKey.set(key, row);
    }
    const next = [...byKey.values()];
    return { headers, rows: next, outcome: { ...outcome, rowsRemoved: rows.length - next.length } };
  }

  return { headers, rows, outcome: { ...outcome, skipped: `unsupported action "${rule.action}"` } };
}

export function previewRule(
  headers: string[],
  rows: Row[],
  rule: CleaningRule,
): { rowsAffected: number; examples: { before: string; after: string }[] } {
  const result = applyRule(headers, rows, rule);
  const examples: { before: string; after: string }[] = [];

  if (result.outcome.rowsRemoved > 0) {
    const kept = new Set(result.rows);
    for (const row of rows) {
      if (!kept.has(row) && examples.length < 5) {
        examples.push({ before: JSON.stringify(row), after: '(row removed)' });
      }
    }
    return { rowsAffected: result.outcome.rowsRemoved, examples };
  }

  const column = rule.action === 'flag_invalid' && rule.column
    ? `${rule.column}_invalid`
    : rule.column;

  if (column) {
    for (let i = 0; i < rows.length && examples.length < 5; i++) {
      const before = rows[i][column] ?? '';
      const after = result.rows[i]?.[column] ?? '';
      if (before !== after) examples.push({ before, after });
    }
  }

  return { rowsAffected: result.outcome.rowsChanged, examples };
}
