# A2A Data Cleaning System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two independent AI agents that cooperate over the A2A protocol to clean a messy 400-row CSV — a Profiler that reasons about data quality, and a Cleaner that executes the resulting plan.

**Architecture:** Two Express servers on ports 4001 and 4002, each publishing an A2A Agent Card and serving JSON-RPC. The Cleaner is a Claude agent whose tools include `ask_profiler`, which performs the A2A call to the Profiler. The Profiler is a Claude advisor with no tools; it streams status updates over SSE, pauses in `input-required` for one ambiguous decision, and returns a cleaning plan as an Artifact. Rules are applied deterministically in code from a closed action set.

**Tech Stack:** TypeScript (ESM), Node 24, `@a2a-js/sdk@1.1.0` (A2A protocol v1), `@anthropic-ai/claude-agent-sdk@0.3.260`, Express 5, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-a2a-data-cleaning-design.md`

## Global Constraints

- **Node >= 24.** Package is ESM: `"type": "module"` in `package.json`; every relative import carries a `.js` extension.
- **A2A protocol v1 only.** Never pass `legacyCompat`. JSON-RPC methods are `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask` — never `message/send` or `tasks/get`.
- **SDK wire shapes (protocol v1, verified against the installed `.d.ts`):**
  - `Part` is `{ content: { $case: 'text', value: string } }` — never `{ kind: 'text', text: '...' }`.
  - `Role` is the enum `Role.ROLE_USER` / `Role.ROLE_AGENT`.
  - `TaskState` is the enum `TaskState.TASK_STATE_WORKING`, etc.
  - `AgentCard` has `supportedInterfaces: AgentInterface[]` — no `url`, `preferredTransport`, or `protocolVersion` field.
  - Executor events are published with `AgentEvent.task(...)` / `AgentEvent.statusUpdate(...)` / `AgentEvent.artifactUpdate(...)`. **The first event of every `execute()` call must be `task` or `message`.**
  - Client stream events are `StreamResponse` with `payload.$case` of `'task' | 'message' | 'statusUpdate' | 'artifactUpdate'`.
- **Model:** `claude-opus-5`. No Anthropic API key — the Claude Agent SDK uses the machine's existing Claude Code login.
- **`USE_MOCK=1` selects `MockLLM`.** All tests run with `USE_MOCK=1`. Real Claude is used only in Task 14.
- **Ports:** Profiler 4002, Cleaner 4001. Both read `PORT` from env when set, so tests can use ephemeral ports.
- **Closed action set:** exactly 10 actions. Any rule with an unlisted `action` is rejected before execution. Never `eval` a rule.
- **Runtime dependencies are fixed:** `@a2a-js/sdk`, `@anthropic-ai/claude-agent-sdk`, `express`, `zod`. Add no others. There is no CSV library — a small RFC 4180 parser is Task 1.
- **Commits:** conventional commits, one per task.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/csv.ts` | RFC 4180 parse/serialize. No domain knowledge. |
| `src/shared/plan.ts` | `CleaningPlan` Zod schema — the wire contract between both agents. |
| `src/shared/profile.ts` | `ColumnProfile` types + `computeProfile()`. |
| `src/shared/llm.ts` | `LLM` interface + `getLLM()` factory. |
| `src/shared/llm-mock.ts` | `MockLLM`. |
| `src/shared/llm-agent-sdk.ts` | `AgentSdkLLM` over `@anthropic-ai/claude-agent-sdk`. |
| `src/profiler/card.ts` | Profiler Agent Card. |
| `src/profiler/prompt.ts` | System + user prompt builders. |
| `src/profiler/executor.ts` | `AgentExecutor`: lifecycle, SSE updates, `input-required` gate, artifact. |
| `src/profiler/index.ts` | Express bootstrap, port 4002. |
| `src/cleaner/apply.ts` | Rule engine — the 10 actions. Pure functions. |
| `src/cleaner/report.ts` | `report.md` generation from the change log. |
| `src/cleaner/ask-profiler.ts` | A2A client: discovery, streaming, `input-required` resume. |
| `src/cleaner/tools.ts` | Dataset session state + the 8 Claude tools. |
| `src/cleaner/card.ts` | Cleaner Agent Card. |
| `src/cleaner/executor.ts` | `AgentExecutor` for the `clean-dataset` skill. |
| `src/cleaner/index.ts` | Express bootstrap + CLI entry, port 4001. |
| `scripts/generate-dataset.ts` | Seeded generator for `data/students_raw.csv`. |

**Deviation from spec §11, applied deliberately:** the spec grouped CSV, profiling, and rule
application into `cleaner/tools/csv.ts`. That file would carry four responsibilities. This plan
splits them (`shared/csv.ts`, `shared/profile.ts`, `cleaner/apply.ts`, `cleaner/tools.ts`) so each
file has one job and each is independently testable. Everything else follows the spec.

---

### Task 1: Project scaffold and CSV parser

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/shared/csv.ts`
- Test: `test/csv.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `parseCsv(text: string): { headers: string[]; rows: Row[] }` where `type Row = Record<string, string>`
  - `toCsv(headers: string[], rows: Row[]): string`
  - `type Row = Record<string, string>`

- [ ] **Step 1: Initialise the repository and write the config files**

```bash
cd /c/Users/HP/Desktop/Temp/A2A
git init
```

`package.json` (replace the file generated by `npm init -y`; the dependency versions below are already installed):

```json
{
  "name": "a2a-data-cleaning",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "profiler": "tsx src/profiler/index.ts",
    "cleaner": "tsx src/cleaner/index.ts",
    "clean": "tsx src/cleaner/index.ts --cli",
    "generate-dataset": "tsx scripts/generate-dataset.ts",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@a2a-js/sdk": "^1.1.0",
    "@anthropic-ai/claude-agent-sdk": "^0.3.260",
    "express": "^5.0.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^24.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    env: { USE_MOCK: '1' },
  },
});
```

`.gitignore`:

```
node_modules/
out/
*.log
```

- [ ] **Step 2: Write the failing test**

`test/csv.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/csv.test.ts`
Expected: FAIL — cannot resolve `../src/shared/csv.js`.

- [ ] **Step 4: Write the implementation**

`src/shared/csv.ts`:

```ts
export type Row = Record<string, string>;

/** Parses RFC 4180 CSV. Values are returned verbatim — no trimming, no type coercion. */
export function parseCsv(text: string): { headers: string[]; rows: Row[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      record.push(field);
      field = '';
    } else if (ch === '\n') {
      record.push(field);
      records.push(record);
      field = '';
      record = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }

  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }

  const headers = records.shift() ?? [];
  const rows = records.map((values) => {
    const row: Row = {};
    headers.forEach((h, i) => {
      row[h] = values[i] ?? '';
    });
    return row;
  });

  return { headers, rows };
}

function escapeField(value: string): string {
  return /[",\n\r]|^\s|\s$/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(headers: string[], rows: Row[]): string {
  const lines = [headers.map(escapeField).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeField(row[h] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/csv.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/shared/csv.ts test/csv.test.ts
git commit -m "feat: project scaffold and RFC 4180 CSV parser"
```

---

### Task 2: Cleaning plan schema

**Files:**
- Create: `src/shared/plan.ts`
- Test: `test/plan.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `CleaningPlanSchema` (Zod), `type CleaningPlan`, `type CleaningRule`
  - `parsePlan(json: unknown): { ok: true; plan: CleaningPlan } | { ok: false; error: string }`
  - `ACTIONS: readonly string[]` — the 10 allowed action names

- [ ] **Step 1: Write the failing test**

`test/plan.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePlan, ACTIONS } from '../src/shared/plan.js';

const validPlan = {
  summary: 'Normalise city names and clamp marks.',
  rules: [
    {
      id: 'r1',
      column: 'city',
      action: 'normalize',
      params: { map: { lahore: 'Lahore', LHR: 'Lahore' } },
      reason: 'Same city written several ways',
      severity: 'medium',
    },
    {
      id: 'r2',
      action: 'dedupe',
      params: { keys: ['roll_no'], keep: 'first' },
      reason: 'roll_no must be unique',
      severity: 'high',
    },
  ],
};

describe('ACTIONS', () => {
  it('is a closed set of exactly 10 actions', () => {
    expect(ACTIONS).toHaveLength(10);
    expect(ACTIONS).toContain('normalize');
    expect(ACTIONS).toContain('dedupe');
  });
});

describe('parsePlan', () => {
  it('accepts a valid plan', () => {
    const result = parsePlan(validPlan);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.rules).toHaveLength(2);
  });

  it('rejects an action outside the closed set', () => {
    const bad = { ...validPlan, rules: [{ ...validPlan.rules[0], action: 'run_shell' }] };
    const result = parsePlan(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('action');
  });

  it('rejects a rule with no reason', () => {
    const rule = { ...validPlan.rules[0] } as Record<string, unknown>;
    delete rule.reason;
    const result = parsePlan({ ...validPlan, rules: [rule] });
    expect(result.ok).toBe(false);
  });

  it('rejects a plan with no rules', () => {
    expect(parsePlan({ summary: 'x', rules: [] }).ok).toBe(false);
  });

  it('rejects non-object input without throwing', () => {
    expect(parsePlan('not a plan').ok).toBe(false);
  });

  it('defaults severity to medium when omitted', () => {
    const rule = { ...validPlan.rules[0] } as Record<string, unknown>;
    delete rule.severity;
    const result = parsePlan({ ...validPlan, rules: [rule] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.rules[0].severity).toBe('medium');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/plan.test.ts`
Expected: FAIL — cannot resolve `../src/shared/plan.js`.

- [ ] **Step 3: Write the implementation**

`src/shared/plan.ts`:

```ts
import { z } from 'zod';

/**
 * The closed action set. The rule engine executes nothing outside this list,
 * so a plan — however it was produced — cannot request an arbitrary transformation.
 */
export const ACTIONS = [
  'trim_whitespace',
  'normalize',
  'title_case',
  'clip',
  'coerce_number',
  'parse_date',
  'fill',
  'drop_rows_where',
  'flag_invalid',
  'dedupe',
] as const;

export type Action = (typeof ACTIONS)[number];

export const CleaningRuleSchema = z.object({
  id: z.string().min(1),
  column: z.string().min(1).optional(),
  action: z.enum(ACTIONS),
  params: z.record(z.unknown()).default({}),
  reason: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
});

export const CleaningPlanSchema = z.object({
  summary: z.string().min(1),
  rules: z.array(CleaningRuleSchema).min(1),
});

export type CleaningRule = z.infer<typeof CleaningRuleSchema>;
export type CleaningPlan = z.infer<typeof CleaningPlanSchema>;

export function parsePlan(
  json: unknown,
): { ok: true; plan: CleaningPlan } | { ok: false; error: string } {
  const result = CleaningPlanSchema.safeParse(json);
  if (result.success) return { ok: true, plan: result.data };
  const error = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/plan.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/plan.ts test/plan.test.ts
git commit -m "feat: cleaning plan schema with closed action set"
```

---

### Task 3: Dataset generator

**Files:**
- Create: `scripts/generate-dataset.ts`
- Create (generated, committed): `data/students_raw.csv`
- Test: `test/dataset.test.ts`

**Interfaces:**
- Consumes: `toCsv`, `type Row` from `src/shared/csv.js`
- Produces: `generateDataset(): { headers: string[]; rows: Row[] }` — deterministic, 400 rows, columns `roll_no, name, email, age, city, marks, enrolled_date`

- [ ] **Step 1: Write the failing test**

`test/dataset.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/dataset.test.ts`
Expected: FAIL — cannot resolve `../scripts/generate-dataset.js`.

- [ ] **Step 3: Write the implementation**

`scripts/generate-dataset.ts`:

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { toCsv, type Row } from '../src/shared/csv.js';

/** Deterministic PRNG (mulberry32) so the dataset is reproducible. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEADERS = ['roll_no', 'name', 'email', 'age', 'city', 'marks', 'enrolled_date'];

const FIRST = ['Ali', 'Sara', 'Bilal', 'Ayesha', 'Usman', 'Hina', 'Ahmed', 'Fatima',
  'Hamza', 'Zainab', 'Omar', 'Maryam', 'Talha', 'Noor', 'Saad', 'Iqra'];
const LAST = ['Raza', 'Khan', 'Ahmed', 'Malik', 'Sheikh', 'Butt', 'Chaudhry', 'Qureshi'];
const CITIES_CLEAN = ['Lahore', 'Karachi', 'Islamabad', 'Multan', 'Peshawar'];
const CITY_VARIANTS = ['lahore', 'LHR', ' Lahore ', 'khi', 'karachi', 'ISB'];
const MISSING = ['', 'N/A', 'NULL', '-'];

function isoDate(rand: () => number): string {
  const month = 1 + Math.floor(rand() * 12);
  const day = 1 + Math.floor(rand() * 28);
  return `2024-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

function reformat(iso: string, style: number): string {
  const [y, m, d] = iso.split('-');
  if (style === 1) return `${d}/${m}/${y}`;
  if (style === 2) return `${MONTHS[Number(m) - 1]} ${Number(d)}, ${y}`;
  return iso;
}

export function generateDataset(): { headers: string[]; rows: Row[] } {
  const rand = rng(20260904);
  const rows: Row[] = [];

  // 383 base rows; 17 exact duplicates are appended afterwards to reach 400.
  for (let i = 0; i < 383; i++) {
    const first = FIRST[Math.floor(rand() * FIRST.length)];
    const last = LAST[Math.floor(rand() * LAST.length)];
    const roll = String(1000 + i);

    let name = `${first} ${last}`;
    const nameStyle = rand();
    if (nameStyle < 0.06) name = `  ${name.toUpperCase()} `;
    else if (nameStyle < 0.11) name = name.toLowerCase();

    let email = `${first.toLowerCase()}.${last.toLowerCase()}@uni.edu.pk`;
    const emailStyle = rand();
    if (emailStyle < 0.035) email = `${first.toLowerCase()}@`;
    else if (emailStyle < 0.055) email = `${first.toLowerCase()}.uni.edu.pk`;

    let age = String(18 + Math.floor(rand() * 8));
    const ageStyle = rand();
    if (ageStyle < 0.025) age = 'twenty';
    else if (ageStyle < 0.04) age = '22 years';
    else if (ageStyle < 0.09) age = MISSING[Math.floor(rand() * MISSING.length)];

    let city: string;
    const cityStyle = rand();
    if (cityStyle < 0.21) city = CITY_VARIANTS[Math.floor(rand() * CITY_VARIANTS.length)];
    else if (cityStyle < 0.24) city = MISSING[Math.floor(rand() * MISSING.length)];
    else city = CITIES_CLEAN[Math.floor(rand() * CITIES_CLEAN.length)];

    let marks = String(35 + Math.floor(rand() * 61));
    const marksStyle = rand();
    if (marksStyle < 0.022) marks = String(101 + Math.floor(rand() * 10));
    else if (marksStyle < 0.036) marks = String(-1 - Math.floor(rand() * 8));
    else if (marksStyle < 0.049) marks = MISSING[Math.floor(rand() * MISSING.length)];

    const enrolled = reformat(isoDate(rand), Math.floor(rand() * 3));

    rows.push({
      roll_no: roll, name, email, age, city, marks, enrolled_date: enrolled,
    });
  }

  // Exactly 3 implausible ages — the deterministic input-required trigger.
  rows[7].age = '-5';
  rows[113].age = '-5';
  rows[251].age = '250';

  // 17 exact duplicates, spread across the file.
  for (let i = 0; i < 17; i++) {
    rows.push({ ...rows[i * 19] });
  }

  return { headers: HEADERS, rows };
}

// Running the script writes the file; importing it does not.
if (process.argv[1]?.endsWith('generate-dataset.ts')) {
  const { headers, rows } = generateDataset();
  mkdirSync('data', { recursive: true });
  writeFileSync('data/students_raw.csv', toCsv(headers, rows), 'utf8');
  console.log(`Wrote data/students_raw.csv — ${rows.length} rows`);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/dataset.test.ts`
Expected: PASS — 9 tests.

If a count assertion fails, adjust the probability thresholds in `generateDataset` (not the
test) until the counts land in range, then re-run. The counts are the point; the exact
probabilities are not.

- [ ] **Step 5: Generate the committed dataset**

Run: `npm run generate-dataset`
Expected: `Wrote data/students_raw.csv — 400 rows`

- [ ] **Step 6: Commit**

```bash
git add scripts/generate-dataset.ts test/dataset.test.ts data/students_raw.csv
git commit -m "feat: seeded generator for the messy 400-row dataset"
```

---

### Task 4: Column profiler

**Files:**
- Create: `src/shared/profile.ts`
- Test: `test/profile.test.ts`

**Interfaces:**
- Consumes: `type Row` from `src/shared/csv.js`
- Produces:
  - `type ColumnProfile`, `type DatasetProfile`
  - `computeProfile(headers: string[], rows: Row[]): DatasetProfile`
  - `MISSING_TOKENS: readonly string[]`

- [ ] **Step 1: Write the failing test**

`test/profile.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/profile.test.ts`
Expected: FAIL — cannot resolve `../src/shared/profile.js`.

- [ ] **Step 3: Write the implementation**

`src/shared/profile.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/profile.test.ts`
Expected: PASS — 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/profile.ts test/profile.test.ts
git commit -m "feat: deterministic column profiler"
```

---

### Task 5: Rule engine

**Files:**
- Create: `src/cleaner/apply.ts`
- Test: `test/apply.test.ts`

**Interfaces:**
- Consumes: `type Row` from `src/shared/csv.js`; `type CleaningRule` from `src/shared/plan.js`; `isMissing` from `src/shared/profile.js`
- Produces:
  - `type RuleOutcome = { ruleId: string; action: string; column?: string; rowsChanged: number; rowsRemoved: number; skipped?: string }`
  - `applyRule(headers: string[], rows: Row[], rule: CleaningRule): { headers: string[]; rows: Row[]; outcome: RuleOutcome }` — pure; returns new arrays
  - `previewRule(headers: string[], rows: Row[], rule: CleaningRule): { rowsAffected: number; examples: { before: string; after: string }[] }`

- [ ] **Step 1: Write the failing test**

`test/apply.test.ts`:

```ts
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
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/apply.test.ts`
Expected: FAIL — cannot resolve `../src/cleaner/apply.js`.

- [ ] **Step 3: Write the implementation**

`src/cleaner/apply.ts`:

```ts
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
    const pattern = new RegExp(String((rule.params as any).pattern ?? '.*'));
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

  const column = rule.column
    ?? (rule.action === 'flag_invalid' ? `${rule.column}_invalid` : undefined);

  if (column) {
    for (let i = 0; i < rows.length && examples.length < 5; i++) {
      const before = rows[i][column] ?? '';
      const after = result.rows[i]?.[column] ?? '';
      if (before !== after) examples.push({ before, after });
    }
  }

  return { rowsAffected: result.outcome.rowsChanged, examples };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/apply.test.ts`
Expected: PASS — 16 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner/apply.ts test/apply.test.ts
git commit -m "feat: rule engine over the closed action set"
```

---

### Task 6: Report generator

**Files:**
- Create: `src/cleaner/report.ts`
- Test: `test/report.test.ts`

**Interfaces:**
- Consumes: `type RuleOutcome` from `src/cleaner/apply.js`; `type CleaningPlan` from `src/shared/plan.js`
- Produces: `buildReport(input: ReportInput): string` where

```ts
interface ReportInput {
  narrative: string;
  rowsBefore: number;
  rowsAfter: number;
  plan: CleaningPlan | null;
  outcomes: RuleOutcome[];
  humanDecision?: { question: string; answer: string };
}
```

- [ ] **Step 1: Write the failing test**

`test/report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/cleaner/report.js';
import type { CleaningPlan } from '../src/shared/plan.js';

const plan: CleaningPlan = {
  summary: 'Normalise cities and clamp marks.',
  rules: [
    { id: 'r1', column: 'city', action: 'normalize', params: {}, reason: 'Variants of one city', severity: 'medium' },
    { id: 'r2', column: 'zzz', action: 'clip', params: {}, reason: 'Range', severity: 'low' },
  ],
};

const report = buildReport({
  narrative: 'The dataset is now consistent.',
  rowsBefore: 400,
  rowsAfter: 383,
  plan,
  outcomes: [
    { ruleId: 'r1', action: 'normalize', column: 'city', rowsChanged: 72, rowsRemoved: 0 },
    { ruleId: 'r2', action: 'clip', column: 'zzz', rowsChanged: 0, rowsRemoved: 0, skipped: 'unknown column "zzz"' },
  ],
  humanDecision: { question: 'How should implausible ages be handled?', answer: 'b' },
});

describe('buildReport', () => {
  it('includes the narrative supplied by Claude', () => {
    expect(report).toContain('The dataset is now consistent.');
  });

  it('reports the row counts from the change log, not from the narrative', () => {
    expect(report).toContain('400');
    expect(report).toContain('383');
    expect(report).toContain('17');
  });

  it('lists each applied rule with its reason and count', () => {
    expect(report).toContain('Variants of one city');
    expect(report).toContain('72');
  });

  it('lists skipped rules in their own section', () => {
    expect(report).toContain('Skipped rules');
    expect(report).toContain('unknown column "zzz"');
  });

  it('records the human decision made at the input-required gate', () => {
    expect(report).toContain('How should implausible ages be handled?');
    expect(report).toContain('b');
  });

  it('works when no plan was obtained', () => {
    const bare = buildReport({
      narrative: 'n', rowsBefore: 10, rowsAfter: 10, plan: null, outcomes: [],
    });
    expect(bare).toContain('No cleaning plan');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/report.test.ts`
Expected: FAIL — cannot resolve `../src/cleaner/report.js`.

- [ ] **Step 3: Write the implementation**

`src/cleaner/report.ts`:

```ts
import type { CleaningPlan } from '../shared/plan.js';
import type { RuleOutcome } from './apply.js';

export interface ReportInput {
  /** Written by Claude. Prose only — every number below comes from the change log. */
  narrative: string;
  rowsBefore: number;
  rowsAfter: number;
  plan: CleaningPlan | null;
  outcomes: RuleOutcome[];
  humanDecision?: { question: string; answer: string };
}

export function buildReport(input: ReportInput): string {
  const { narrative, rowsBefore, rowsAfter, plan, outcomes, humanDecision } = input;
  const reasons = new Map(plan?.rules.map((r) => [r.id, r.reason]) ?? []);
  const applied = outcomes.filter((o) => !o.skipped);
  const skipped = outcomes.filter((o) => o.skipped);

  const lines: string[] = [
    '# Data Cleaning Report',
    '',
    narrative.trim(),
    '',
    '## Rows',
    '',
    `| | Count |`,
    `|---|---|`,
    `| Before | ${rowsBefore} |`,
    `| After | ${rowsAfter} |`,
    `| Removed | ${rowsBefore - rowsAfter} |`,
    '',
  ];

  if (!plan) {
    lines.push('## Plan', '', 'No cleaning plan was obtained from the Profiler agent.', '');
  } else {
    lines.push('## Plan summary', '', plan.summary.trim(), '');
  }

  lines.push('## Rules applied', '');
  if (applied.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| Rule | Action | Column | Rows changed | Rows removed | Reason |');
    lines.push('|---|---|---|---|---|---|');
    for (const o of applied) {
      lines.push(
        `| ${o.ruleId} | ${o.action} | ${o.column ?? '—'} | ${o.rowsChanged} | ${o.rowsRemoved} | ${reasons.get(o.ruleId) ?? '—'} |`,
      );
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('## Skipped rules', '');
    lines.push('| Rule | Action | Why |');
    lines.push('|---|---|---|');
    for (const o of skipped) {
      lines.push(`| ${o.ruleId} | ${o.action} | ${o.skipped} |`);
    }
    lines.push('');
  }

  if (humanDecision) {
    lines.push(
      '## Human decision',
      '',
      `The Profiler agent paused in \`input-required\` and asked:`,
      '',
      `> ${humanDecision.question.replace(/\n/g, '\n> ')}`,
      '',
      `Answer given: **${humanDecision.answer}**`,
      '',
    );
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/report.test.ts`
Expected: PASS — 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner/report.ts test/report.test.ts
git commit -m "feat: report generator with code-supplied numbers"
```

---

### Task 7: LLM abstraction with mock and Agent SDK backends

**Files:**
- Create: `src/shared/llm.ts`, `src/shared/llm-mock.ts`, `src/shared/llm-agent-sdk.ts`
- Test: `test/llm.test.ts`

**Interfaces:**
- Consumes: `type CleaningPlan` from `src/shared/plan.js`
- Produces:

```ts
interface LlmTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: any) => Promise<string>;
}

interface LlmRequest {
  system: string;
  user: string;
  tools?: LlmTool[];
  maxTurns?: number;
  onProgress?: (text: string) => void;
}

interface LLM {
  run(request: LlmRequest): Promise<string>;  // returns Claude's final text
}

function getLLM(role: 'profiler' | 'cleaner'): LLM;
```

`MockLLM` is constructed with a scripted behaviour so tests stay deterministic:
`new MockLLM({ finalText: string; toolCalls?: { name: string; args: any }[] })`.

- [ ] **Step 1: Write the failing test**

`test/llm.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { getLLM } from '../src/shared/llm.js';
import { MockLLM } from '../src/shared/llm-mock.js';

describe('getLLM', () => {
  it('returns MockLLM when USE_MOCK is set', () => {
    expect(getLLM('profiler')).toBeInstanceOf(MockLLM);
  });
});

describe('MockLLM', () => {
  it('returns its scripted final text', async () => {
    const llm = new MockLLM({ finalText: 'done' });
    expect(await llm.run({ system: 's', user: 'u' })).toBe('done');
  });

  it('invokes the scripted tool calls in order and reports progress', async () => {
    const seen: string[] = [];
    const progress: string[] = [];
    const llm = new MockLLM({
      finalText: 'finished',
      toolCalls: [
        { name: 'load_csv', args: { path: 'x.csv' } },
        { name: 'save_csv', args: { path: 'y.csv' } },
      ],
    });

    const result = await llm.run({
      system: 's',
      user: 'u',
      onProgress: (t) => progress.push(t),
      tools: [
        {
          name: 'load_csv', description: 'load', schema: { path: z.string() },
          handler: async (a) => { seen.push(`load:${a.path}`); return 'loaded'; },
        },
        {
          name: 'save_csv', description: 'save', schema: { path: z.string() },
          handler: async (a) => { seen.push(`save:${a.path}`); return 'saved'; },
        },
      ],
    });

    expect(seen).toEqual(['load:x.csv', 'save:y.csv']);
    expect(result).toBe('finished');
    expect(progress.length).toBeGreaterThan(0);
  });

  it('throws a clear error when a scripted tool is not registered', async () => {
    const llm = new MockLLM({ finalText: 'x', toolCalls: [{ name: 'nope', args: {} }] });
    await expect(llm.run({ system: 's', user: 'u', tools: [] })).rejects.toThrow(/nope/);
  });

  it('surfaces a tool handler error rather than swallowing it', async () => {
    const llm = new MockLLM({ finalText: 'x', toolCalls: [{ name: 'boom', args: {} }] });
    await expect(
      llm.run({
        system: 's', user: 'u',
        tools: [{
          name: 'boom', description: 'b', schema: {},
          handler: async () => { throw new Error('kaboom'); },
        }],
      }),
    ).rejects.toThrow(/kaboom/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/llm.test.ts`
Expected: FAIL — cannot resolve `../src/shared/llm.js`.

- [ ] **Step 3: Write the interface and the mock**

`src/shared/llm.ts`:

```ts
import type { z } from 'zod';

export interface LlmTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: any) => Promise<string>;
}

export interface LlmRequest {
  system: string;
  user: string;
  tools?: LlmTool[];
  maxTurns?: number;
  /** Called with short human-readable progress lines as the model works. */
  onProgress?: (text: string) => void;
}

export interface LLM {
  run(request: LlmRequest): Promise<string>;
}

Add these two imports at the top of the same file (static, not `require` — this is ESM):

```ts
import { MockLLM, mockScriptFor } from './llm-mock.js';
import { AgentSdkLLM } from './llm-agent-sdk.js';
```

And the factory at the bottom:

```ts
/**
 * Chooses the backend. `USE_MOCK=1` selects the deterministic mock — used by
 * every test and by development runs, so the protocol can be exercised without
 * consuming Claude quota.
 */
export function getLLM(role: 'profiler' | 'cleaner'): LLM {
  return process.env.USE_MOCK === '1'
    ? new MockLLM(mockScriptFor(role))
    : new AgentSdkLLM();
}
```

Write `llm-mock.ts` and `llm-agent-sdk.ts` in the same step (both are below), so the
imports resolve.

`src/shared/llm-mock.ts`:

```ts
import type { LLM, LlmRequest } from './llm.js';

export interface MockScript {
  finalText: string;
  toolCalls?: { name: string; args: any }[];
}

/**
 * Placeholders the cleaner script uses instead of hardcoded paths. They are
 * resolved from the prompt at run time, so a test using a temporary output
 * directory gets its files where it expects them.
 */
const PATH_PATTERNS: Record<string, RegExp> = {
  '{{csvPath}}': /Clean the dataset at (.+?)\.?$/m,
  '{{cleanedPath}}': /Save the cleaned CSV to (.+?)\.?$/m,
  '{{reportPath}}': /Write the report to (.+?)\.?$/m,
};

function resolvePlaceholders(args: any, prompt: string): any {
  if (typeof args !== 'object' || args === null) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value in PATH_PATTERNS) {
      const match = PATH_PATTERNS[value].exec(prompt);
      if (!match) throw new Error(`MockLLM: could not resolve ${value} from the prompt`);
      out[key] = match[1].trim();
    } else {
      out[key] = value;
    }
  }
  return out;
}

export class MockLLM implements LLM {
  constructor(private readonly script: MockScript) {}

  async run(request: LlmRequest): Promise<string> {
    const tools = new Map((request.tools ?? []).map((t) => [t.name, t]));

    for (const call of this.script.toolCalls ?? []) {
      const tool = tools.get(call.name);
      if (!tool) {
        throw new Error(`MockLLM: scripted tool "${call.name}" is not registered`);
      }
      request.onProgress?.(`calling ${call.name}`);
      await tool.handler(resolvePlaceholders(call.args, request.user));
    }

    request.onProgress?.('writing final answer');
    return this.script.finalText;
  }
}

/** The default script each agent's mock follows. */
export function mockScriptFor(role: 'profiler' | 'cleaner'): MockScript {
  if (role === 'profiler') {
    return { finalText: JSON.stringify(MOCK_PLAN) };
  }
  return {
    finalText: 'Cleaned the dataset using the plan from the Profiler agent.',
    toolCalls: [
      { name: 'load_csv', args: { path: '{{csvPath}}' } },
      { name: 'profile_columns', args: {} },
      { name: 'ask_profiler', args: {} },
      { name: 'apply_plan', args: {} },
      { name: 'save_csv', args: { path: '{{cleanedPath}}' } },
      {
        name: 'write_report',
        args: { summary: 'Cleaned with the Profiler plan.', path: '{{reportPath}}' },
      },
    ],
  };
}

/** The plan the mocked Profiler returns. Mirrors what Claude produces for this dataset. */
export const MOCK_PLAN = {
  summary: 'Normalise city spellings and names, unify dates, and bound numeric ranges.',
  rules: [
    { id: 'r1', column: 'name', action: 'trim_whitespace', params: {}, reason: 'Stray leading and trailing spaces', severity: 'low' },
    { id: 'r2', column: 'name', action: 'title_case', params: {}, reason: 'Mixed upper and lower case', severity: 'low' },
    { id: 'r3', column: 'city', action: 'trim_whitespace', params: {}, reason: 'Padded values such as " Lahore "', severity: 'low' },
    {
      id: 'r4', column: 'city', action: 'normalize',
      params: { map: { lahore: 'Lahore', LHR: 'Lahore', khi: 'Karachi', karachi: 'Karachi', ISB: 'Islamabad' } },
      reason: 'One city written several ways', severity: 'medium',
    },
    { id: 'r5', column: 'age', action: 'coerce_number', params: { wordMap: { twenty: 20 } }, reason: 'Ages written as words', severity: 'medium' },
    { id: 'r6', column: 'age', action: 'fill', params: { strategy: 'median' }, reason: 'Missing ages, imputed per the human decision', severity: 'medium' },
    { id: 'r7', column: 'marks', action: 'clip', params: { min: 0, max: 100 }, reason: 'Marks must lie between 0 and 100', severity: 'high' },
    { id: 'r8', column: 'enrolled_date', action: 'parse_date', params: { targetFormat: 'YYYY-MM-DD' }, reason: 'Three different date formats', severity: 'medium' },
    { id: 'r9', column: 'email', action: 'flag_invalid', params: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' }, reason: 'Malformed addresses are flagged, not deleted', severity: 'low' },
    { id: 'r10', action: 'dedupe', params: { keys: ['roll_no'], keep: 'first' }, reason: 'roll_no must be unique', severity: 'high' },
  ],
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/llm.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Write the Agent SDK backend**

`src/shared/llm-agent-sdk.ts`:

```ts
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { LLM, LlmRequest } from './llm.js';

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5';
const SERVER_NAME = 'agent-tools';

/**
 * Drives Claude through the Claude Agent SDK, which authenticates using the
 * machine's existing Claude Code login. No ANTHROPIC_API_KEY is required.
 */
export class AgentSdkLLM implements LLM {
  async run(request: LlmRequest): Promise<string> {
    const sdkTools = (request.tools ?? []).map((t) =>
      tool(t.name, t.description, t.schema, async (args) => {
        const text = await t.handler(args);
        return { content: [{ type: 'text' as const, text }] };
      }),
    );

    const mcpServers = sdkTools.length
      ? {
          [SERVER_NAME]: createSdkMcpServer({
            name: SERVER_NAME,
            version: '1.0.0',
            tools: sdkTools,
          }),
        }
      : undefined;

    const allowedTools = sdkTools.length
      ? (request.tools ?? []).map((t) => `mcp__${SERVER_NAME}__${t.name}`)
      : [];

    const response = query({
      prompt: request.user,
      options: {
        model: MODEL,
        systemPrompt: { type: 'custom', prompt: request.system },
        mcpServers,
        allowedTools,
        // The tools are ours and touch only this project's files.
        permissionMode: 'bypassPermissions',
        // Do not inherit the developer's CLAUDE.md, settings, or plugins.
        settingSources: [],
        maxTurns: request.maxTurns ?? 30,
      },
    });

    let finalText = '';
    for await (const message of response) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            request.onProgress?.(firstLine(block.text));
          } else if (block.type === 'tool_use') {
            request.onProgress?.(`calling ${String(block.name).split('__').pop()}`);
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error(`Claude run failed: ${message.subtype}`);
        }
        finalText = message.result;
      }
    }

    if (!finalText) throw new Error('Claude returned no final result');
    return finalText;
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0];
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If the Agent SDK's `CallToolResult` or message-union types
disagree, fix the code to match the installed `.d.ts` — it is authoritative.

- [ ] **Step 7: Commit**

```bash
git add src/shared/llm.ts src/shared/llm-mock.ts src/shared/llm-agent-sdk.ts test/llm.test.ts
git commit -m "feat: LLM abstraction with mock and Claude Agent SDK backends"
```

---

### Task 8: Profiler agent — card, server, and happy path

**Files:**
- Create: `src/profiler/card.ts`, `src/profiler/prompt.ts`, `src/profiler/executor.ts`, `src/profiler/index.ts`
- Test: `test/profiler.test.ts`

**Interfaces:**
- Consumes: `getLLM` from `src/shared/llm.js`; `parsePlan` from `src/shared/plan.js`; `type DatasetProfile` from `src/shared/profile.js`
- Produces:
  - `profilerCard(port: number): AgentCard`
  - `class ProfilerExecutor implements AgentExecutor`
  - `startProfiler(port: number): Promise<{ url: string; close: () => Promise<void> }>`

- [ ] **Step 1: Write the failing test**

`test/profiler.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role, TaskState } from '@a2a-js/sdk';
import { startProfiler } from '../src/profiler/index.js';
import { parsePlan } from '../src/shared/plan.js';
import { computeProfile } from '../src/shared/profile.js';

let server: { url: string; close: () => Promise<void> };

const profile = computeProfile(
  ['city', 'marks'],
  [
    { city: 'Lahore', marks: '80' },
    { city: 'lahore', marks: '105' },
  ],
);

beforeAll(async () => {
  server = await startProfiler(0);
});

afterAll(async () => {
  await server.close();
});

function textMessage(text: string) {
  return {
    messageId: crypto.randomUUID(),
    contextId: '',
    taskId: '',
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text' as const, value: text } }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

describe('Profiler agent', () => {
  it('serves an agent card advertising analyze-data-quality', async () => {
    const res = await fetch(`${server.url}/.well-known/agent-card.json`);
    expect(res.status).toBe(200);
    const card = await res.json();
    expect(card.name).toBe('Data Profiler Agent');
    expect(card.skills.map((s: any) => s.id)).toContain('analyze-data-quality');
    expect(card.capabilities.streaming).toBe(true);
  });

  it('streams a task through working to completed and returns a plan artifact', async () => {
    const client = await new ClientFactory().createFromUrl(server.url);
    const states: number[] = [];
    let planJson: string | undefined;

    for await (const event of client.sendMessageStream({
      tenant: '',
      message: textMessage(JSON.stringify(profile)),
      configuration: undefined,
      metadata: undefined,
    })) {
      const p = event.payload;
      if (p?.$case === 'statusUpdate') states.push(p.value.status!.state);
      if (p?.$case === 'artifactUpdate') {
        const part = p.value.artifact!.parts[0];
        if (part.content?.$case === 'text') planJson = part.content.value;
      }
    }

    expect(states).toContain(TaskState.TASK_STATE_WORKING);
    expect(states.at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(planJson).toBeTruthy();
    expect(parsePlan(JSON.parse(planJson!)).ok).toBe(true);
  });

  it('fails the task with a clear message when the input is not a profile', async () => {
    const client = await new ClientFactory().createFromUrl(server.url);
    let lastState: number | undefined;
    let errorText = '';

    for await (const event of client.sendMessageStream({
      tenant: '', message: textMessage('hello there'),
      configuration: undefined, metadata: undefined,
    })) {
      const p = event.payload;
      if (p?.$case === 'statusUpdate') {
        lastState = p.value.status!.state;
        const part = p.value.status!.message?.parts[0];
        if (part?.content?.$case === 'text') errorText = part.content.value;
      }
    }

    expect(lastState).toBe(TaskState.TASK_STATE_FAILED);
    expect(errorText.toLowerCase()).toContain('profile');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/profiler.test.ts`
Expected: FAIL — cannot resolve `../src/profiler/index.js`.

- [ ] **Step 3: Write the card and prompt**

`src/profiler/card.ts`:

```ts
import type { AgentCard } from '@a2a-js/sdk';

export function profilerCard(port: number): AgentCard {
  return {
    name: 'Data Profiler Agent',
    description:
      'Analyzes a dataset column profile and returns a cleaning plan with justifications.',
    version: '1.0.0',
    supportedInterfaces: [
      { url: `http://localhost:${port}/`, protocolBinding: 'JSONRPC', tenant: '' },
    ],
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['application/json'],
    skills: [
      {
        id: 'analyze-data-quality',
        name: 'Data Quality Analysis',
        description:
          'Given a column profile, identify data quality issues and propose cleaning rules.',
        tags: ['data', 'quality', 'cleaning', 'profiling'],
        examples: [
          'Analyze this profile of a student records CSV and tell me how to clean it.',
        ],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
```

> If `tsc` reports that `AgentCard` requires a field not listed here, add it with
> its zero value. The installed `.d.ts` is authoritative.

`src/profiler/prompt.ts`:

```ts
import { ACTIONS } from '../shared/plan.js';
import type { DatasetProfile } from '../shared/profile.js';

export const SYSTEM_PROMPT = `You are a data quality expert.

You receive a statistical profile of a CSV dataset — never the raw rows. Identify the
data quality problems it reveals and propose a cleaning rule for each one.

Reply with JSON only. No prose, no markdown fence. The shape is:

{
  "summary": "one paragraph in plain English",
  "rules": [
    {
      "id": "r1",
      "column": "<column name, omit for row-scoped rules>",
      "action": "<one of the allowed actions>",
      "params": { },
      "reason": "<why this rule is needed, for a human reader>",
      "severity": "low" | "medium" | "high"
    }
  ]
}

The allowed actions are exactly: ${ACTIONS.join(', ')}.
Using any other action is an error.

Rules:
- Only reference columns that appear in the profile. Never invent one.
- Every rule needs a reason a human can read.
- "normalize" takes params.map — an explicit mapping of the exact variant strings
  found in the profile to their canonical value.
- "clip" takes params.min and params.max.
- "coerce_number" may take params.wordMap, e.g. {"twenty": 20}.
- "parse_date" takes params.targetFormat, always "YYYY-MM-DD".
- "fill" takes params.strategy ("median" | "mode" | "constant") and params.value for constant.
- "flag_invalid" takes params.pattern, a JavaScript regular expression source string.
- "dedupe" is row-scoped: omit "column", pass params.keys (array) and params.keep ("first" | "last").
- "drop_rows_where" takes params.predicate, e.g. {"op": "lt", "value": 0}.`;

export function buildUserPrompt(profile: DatasetProfile, humanAnswer?: string): string {
  const parts = [
    'Here is the column profile of the dataset:',
    '',
    JSON.stringify(profile, null, 2),
  ];

  if (humanAnswer) {
    parts.push(
      '',
      'The human operator was asked how to handle implausible values in the "age" column',
      'and answered:',
      '',
      humanAnswer,
      '',
      'Your plan must follow that decision.',
    );
  }

  return parts.join('\n');
}
```

- [ ] **Step 4: Write the executor (happy path and failure only — the `input-required` gate is Task 9)**

`src/profiler/executor.ts`:

```ts
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import { getLLM } from '../shared/llm.js';
import { parsePlan } from '../shared/plan.js';
import type { DatasetProfile } from '../shared/profile.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

function textPart(value: string) {
  return { content: { $case: 'text' as const, value } };
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function readText(message: Message | undefined): string {
  if (!message) return '';
  return message.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join('');
}

export class ProfilerExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>();

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;

    const status = (state: TaskState, text?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state,
            message: text ? agentMessage(taskId, contextId, text) : undefined,
            timestamp: new Date().toISOString(),
          },
          final: state === TaskState.TASK_STATE_COMPLETED
            || state === TaskState.TASK_STATE_FAILED
            || state === TaskState.TASK_STATE_INPUT_REQUIRED,
          metadata: undefined,
        }),
      );

    // The first event of every execute() call must be a task or message event.
    const task: Task = {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: undefined,
    };
    bus.publish(AgentEvent.task(task));

    try {
      const raw = readText(ctx.userMessage);
      const profile = parseProfile(raw);

      status(TaskState.TASK_STATE_WORKING, `${profile.columns.length} columns received`);

      for (const column of profile.columns) {
        if (this.cancelled.has(taskId)) return;
        const notes: string[] = [];
        if (column.distinctCount > 3 && column.inferredType === 'string') {
          notes.push(`${column.distinctCount} distinct variants`);
        }
        if (column.nullCount > 0) notes.push(`${column.nullCount} missing`);
        if (column.outOfRangeCount) notes.push(`${column.outOfRangeCount} out of range`);
        if (notes.length) {
          status(TaskState.TASK_STATE_WORKING, `${column.name}: ${notes.join(', ')}`);
        }
      }

      status(TaskState.TASK_STATE_WORKING, 'asking Claude for a cleaning plan');

      const plan = await this.requestPlan(profile, undefined, (text) =>
        status(TaskState.TASK_STATE_WORKING, text),
      );

      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: crypto.randomUUID(),
            name: 'cleaning-plan',
            description: 'Cleaning rules with justifications',
            parts: [textPart(JSON.stringify(plan, null, 2))],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );

      status(TaskState.TASK_STATE_COMPLETED, plan.summary);
    } catch (error) {
      status(
        TaskState.TASK_STATE_FAILED,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      bus.finished();
    }
  }

  /** Calls Claude and validates the reply, retrying once with the validation error. */
  protected async requestPlan(
    profile: DatasetProfile,
    humanAnswer: string | undefined,
    onProgress: (text: string) => void,
  ) {
    const llm = getLLM('profiler');
    let user = buildUserPrompt(profile, humanAnswer);

    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await llm.run({ system: SYSTEM_PROMPT, user, onProgress, maxTurns: 1 });
      const json = extractJson(reply);
      const parsed = json === undefined
        ? { ok: false as const, error: 'reply contained no JSON object' }
        : parsePlan(json);

      if (parsed.ok) return parsed.plan;

      if (attempt === 1) throw new Error(`Claude returned an invalid plan: ${parsed.error}`);
      user = `${user}\n\nYour previous reply was rejected: ${parsed.error}\nReturn corrected JSON only.`;
    }

    throw new Error('unreachable');
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.cancelled.add(taskId);
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
        final: true,
        metadata: undefined,
      }),
    );
    bus.finished();
  }
}

function parseProfile(raw: string): DatasetProfile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Expected a JSON column profile in the message, but the text was not JSON.');
  }
  const p = value as Partial<DatasetProfile>;
  if (typeof p?.rowCount !== 'number' || !Array.isArray(p?.columns)) {
    throw new Error('Message is not a column profile: rowCount and columns are required.');
  }
  return p as DatasetProfile;
}

/** Pulls the first JSON object out of a reply, tolerating a markdown fence. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 5: Write the server bootstrap**

`src/profiler/index.ts`:

```ts
import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { profilerCard } from './card.js';
import { ProfilerExecutor } from './executor.js';

export async function startProfiler(
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const card = profilerCard(actualPort);

  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new ProfilerExecutor(),
  );

  app.use(agentCardHandler({ agentCardProvider: async () => card }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return {
    url: `http://localhost:${actualPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1]?.endsWith('profiler/index.ts')) {
  const port = Number(process.env.PORT ?? 4002);
  startProfiler(port).then(({ url }) => {
    console.log(`Profiler Agent listening on ${url}`);
    console.log(`Agent card: ${url}/.well-known/agent-card.json`);
  });
}
```

> **Ordering note:** `app.listen` must resolve before the card is built, because the
> card's `supportedInterfaces[0].url` needs the real port when `port` is `0`.
> Express accepts middleware registered after `listen`, so this ordering is safe.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/profiler.test.ts`
Expected: PASS — 3 tests.

If the card fetch 404s, check the path `agentCardHandler` mounts; if the SDK serves a
different default path, use the path it serves and pass it as the second argument to
`ClientFactory.createFromUrl`.

- [ ] **Step 7: Commit**

```bash
git add src/profiler test/profiler.test.ts
git commit -m "feat: Profiler agent with A2A card, streaming, and plan artifact"
```

---

### Task 9: Profiler `input-required` gate

**Files:**
- Modify: `src/profiler/executor.ts`
- Test: `test/profiler-input-required.test.ts`

**Interfaces:**
- Consumes: everything from Task 8.
- Produces: no new exports. `ProfilerExecutor.execute` gains a pause/resume path keyed on
  `ctx.task` being present (a follow-up turn) versus absent (a first turn).

- [ ] **Step 1: Write the failing test**

`test/profiler-input-required.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role, TaskState } from '@a2a-js/sdk';
import { startProfiler } from '../src/profiler/index.js';
import { computeProfile } from '../src/shared/profile.js';

let server: { url: string; close: () => Promise<void> };

/** A profile whose age column contains implausible values. */
const ambiguous = computeProfile(
  ['age'],
  [{ age: '20' }, { age: '-5' }, { age: '250' }, { age: '21' }],
);

beforeAll(async () => { server = await startProfiler(0); });
afterAll(async () => { await server.close(); });

function textMessage(text: string, taskId = '', contextId = '') {
  return {
    messageId: crypto.randomUUID(),
    contextId, taskId,
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text' as const, value: text } }],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  };
}

describe('Profiler input-required gate', () => {
  it('pauses for an ambiguous age column, then resumes on the same task', async () => {
    const client = await new ClientFactory().createFromUrl(server.url);

    let taskId = '';
    let contextId = '';
    let question = '';
    let pausedState: number | undefined;

    for await (const event of client.sendMessageStream({
      tenant: '', message: textMessage(JSON.stringify(ambiguous)),
      configuration: undefined, metadata: undefined,
    })) {
      const p = event.payload;
      if (p?.$case === 'task') { taskId = p.value.id; contextId = p.value.contextId; }
      if (p?.$case === 'statusUpdate') {
        pausedState = p.value.status!.state;
        const part = p.value.status!.message?.parts[0];
        if (part?.content?.$case === 'text') question = part.content.value;
      }
    }

    expect(pausedState).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(question).toContain('age');
    expect(question).toMatch(/\(a\)|\(b\)|\(c\)/);
    expect(taskId).toBeTruthy();

    // Resume the SAME task with the human's answer.
    let finalState: number | undefined;
    let planJson = '';

    for await (const event of client.sendMessageStream({
      tenant: '', message: textMessage('b', taskId, contextId),
      configuration: undefined, metadata: undefined,
    })) {
      const p = event.payload;
      if (p?.$case === 'statusUpdate') finalState = p.value.status!.state;
      if (p?.$case === 'artifactUpdate') {
        const part = p.value.artifact!.parts[0];
        if (part.content?.$case === 'text') planJson = part.content.value;
      }
    }

    expect(finalState).toBe(TaskState.TASK_STATE_COMPLETED);
    expect(planJson).toBeTruthy();
  });

  it('does not pause when no age values are implausible', async () => {
    const client = await new ClientFactory().createFromUrl(server.url);
    const clean = computeProfile(['age'], [{ age: '20' }, { age: '21' }]);
    const states: number[] = [];

    for await (const event of client.sendMessageStream({
      tenant: '', message: textMessage(JSON.stringify(clean)),
      configuration: undefined, metadata: undefined,
    })) {
      const p = event.payload;
      if (p?.$case === 'statusUpdate') states.push(p.value.status!.state);
    }

    expect(states).not.toContain(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(states.at(-1)).toBe(TaskState.TASK_STATE_COMPLETED);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/profiler-input-required.test.ts`
Expected: FAIL — the first test's `pausedState` is `TASK_STATE_COMPLETED`, not `TASK_STATE_INPUT_REQUIRED`.

- [ ] **Step 3: Add the gate to the executor**

In `src/profiler/executor.ts`, add the pending-profile store and the ambiguity check.

Add near the top of the class:

```ts
  /** Profiles for tasks paused in input-required, keyed by taskId. */
  private readonly pending = new Map<string, DatasetProfile>();
```

Add this helper below `parseProfile`:

```ts
export const AMBIGUITY_QUESTION = [
  'The age column contains values outside the plausible range 5-100.',
  'How should these rows be handled?',
  '  (a) drop those rows',
  '  (b) replace with the column median',
  '  (c) leave as-is and flag them in the report',
].join('\n');

/** Returns true when the profile contains a defect the agent must not resolve alone. */
export function needsHumanDecision(profile: DatasetProfile): boolean {
  const age = profile.columns.find((c) => c.name === 'age');
  if (!age || age.inferredType !== 'number') return false;
  return (age.min !== undefined && age.min < 5) || (age.max !== undefined && age.max > 100);
}
```

Replace the body of `execute` between the `bus.publish(AgentEvent.task(task))` line and the
artifact publication with this branch:

```ts
    try {
      const raw = readText(ctx.userMessage);

      // A follow-up turn: ctx.task is set and we are holding this task's profile.
      const resuming = ctx.task !== undefined && this.pending.has(taskId);

      if (resuming) {
        const profile = this.pending.get(taskId)!;
        this.pending.delete(taskId);
        status(TaskState.TASK_STATE_WORKING, `answer received: ${raw.trim()}`);

        const plan = await this.requestPlan(profile, raw.trim(), (text) =>
          status(TaskState.TASK_STATE_WORKING, text),
        );
        this.publishPlan(bus, taskId, contextId, plan);
        status(TaskState.TASK_STATE_COMPLETED, plan.summary);
        return;
      }

      const profile = parseProfile(raw);
      status(TaskState.TASK_STATE_WORKING, `${profile.columns.length} columns received`);

      for (const column of profile.columns) {
        if (this.cancelled.has(taskId)) return;
        const notes: string[] = [];
        if (column.distinctCount > 3 && column.inferredType === 'string') {
          notes.push(`${column.distinctCount} distinct variants`);
        }
        if (column.nullCount > 0) notes.push(`${column.nullCount} missing`);
        if (column.outOfRangeCount) notes.push(`${column.outOfRangeCount} out of range`);
        if (notes.length) {
          status(TaskState.TASK_STATE_WORKING, `${column.name}: ${notes.join(', ')}`);
        }
      }

      if (needsHumanDecision(profile)) {
        this.pending.set(taskId, profile);
        status(TaskState.TASK_STATE_INPUT_REQUIRED, AMBIGUITY_QUESTION);
        return;
      }

      status(TaskState.TASK_STATE_WORKING, 'asking Claude for a cleaning plan');
      const plan = await this.requestPlan(profile, undefined, (text) =>
        status(TaskState.TASK_STATE_WORKING, text),
      );
      this.publishPlan(bus, taskId, contextId, plan);
      status(TaskState.TASK_STATE_COMPLETED, plan.summary);
    } catch (error) {
      status(TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : String(error));
    } finally {
      bus.finished();
    }
```

Extract the artifact publication into a method so both branches use it:

```ts
  private publishPlan(
    bus: ExecutionEventBus,
    taskId: string,
    contextId: string,
    plan: { summary: string },
  ): void {
    bus.publish(
      AgentEvent.artifactUpdate({
        taskId,
        contextId,
        artifact: {
          artifactId: crypto.randomUUID(),
          name: 'cleaning-plan',
          description: 'Cleaning rules with justifications',
          parts: [textPart(JSON.stringify(plan, null, 2))],
          metadata: undefined,
          extensions: [],
        },
        append: false,
        lastChunk: true,
        metadata: undefined,
      }),
    );
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/profiler-input-required.test.ts test/profiler.test.ts`
Expected: PASS — 5 tests.

If the resume turn arrives with `ctx.task` undefined, key the resume decision on
`this.pending.has(taskId)` alone — the store is the source of truth.

- [ ] **Step 5: Commit**

```bash
git add src/profiler/executor.ts test/profiler-input-required.test.ts
git commit -m "feat: Profiler pauses in input-required for the ambiguous age column"
```

---

### Task 10: A2A client — `ask_profiler`

**Files:**
- Create: `src/cleaner/ask-profiler.ts`
- Test: `test/ask-profiler.test.ts`

**Interfaces:**
- Consumes: `startProfiler` (tests only); `parsePlan` from `src/shared/plan.js`
- Produces:

```ts
interface AskProfilerOptions {
  profilerUrl: string;
  profile: DatasetProfile;
  /** Called for every SSE status line. */
  onUpdate?: (text: string) => void;
  /** Called when the Profiler pauses; must resolve to the human's answer. */
  onQuestion?: (question: string) => Promise<string>;
}

interface AskProfilerResult {
  plan: CleaningPlan;
  taskId: string;
  humanDecision?: { question: string; answer: string };
}

async function askProfiler(options: AskProfilerOptions): Promise<AskProfilerResult>;
```

- [ ] **Step 1: Write the failing test**

`test/ask-profiler.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startProfiler } from '../src/profiler/index.js';
import { askProfiler } from '../src/cleaner/ask-profiler.js';
import { computeProfile } from '../src/shared/profile.js';

let server: { url: string; close: () => Promise<void> };

beforeAll(async () => { server = await startProfiler(0); });
afterAll(async () => { await server.close(); });

const cleanProfile = computeProfile(['age'], [{ age: '20' }, { age: '21' }]);
const ambiguousProfile = computeProfile(['age'], [{ age: '20' }, { age: '250' }]);

describe('askProfiler', () => {
  it('discovers the agent, sends the profile, and returns a validated plan', async () => {
    const updates: string[] = [];
    const result = await askProfiler({
      profilerUrl: server.url,
      profile: cleanProfile,
      onUpdate: (t) => updates.push(t),
    });

    expect(result.plan.rules.length).toBeGreaterThan(0);
    expect(result.taskId).toBeTruthy();
    expect(updates.length).toBeGreaterThan(0);
  });

  it('answers an input-required question and completes the same task', async () => {
    let asked = '';
    const result = await askProfiler({
      profilerUrl: server.url,
      profile: ambiguousProfile,
      onQuestion: async (q) => { asked = q; return 'b'; },
    });

    expect(asked).toContain('age');
    expect(result.humanDecision).toEqual({ question: asked, answer: 'b' });
    expect(result.plan.rules.length).toBeGreaterThan(0);
  });

  it('fails clearly when the agent card lacks the required skill', async () => {
    const fake = await startFakeCardServer();
    await expect(
      askProfiler({ profilerUrl: fake.url, profile: cleanProfile }),
    ).rejects.toThrow(/analyze-data-quality/);
    await fake.close();
  });

  it('fails clearly when the Profiler is unreachable', async () => {
    await expect(
      askProfiler({ profilerUrl: 'http://localhost:1', profile: cleanProfile }),
    ).rejects.toThrow();
  });

  it('throws rather than hanging when the Profiler pauses and no answerer is supplied', async () => {
    await expect(
      askProfiler({ profilerUrl: server.url, profile: ambiguousProfile }),
    ).rejects.toThrow(/input/i);
  });
});

/** Serves a valid A2A card whose skills do not include analyze-data-quality. */
async function startFakeCardServer() {
  const express = (await import('express')).default;
  const { profilerCard } = await import('../src/profiler/card.js');
  const app = express();
  const server = await new Promise<any>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  const card = { ...profilerCard(port), skills: [] };
  app.get('/.well-known/agent-card.json', (_req: any, res: any) => res.json(card));
  return {
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/ask-profiler.test.ts`
Expected: FAIL — cannot resolve `../src/cleaner/ask-profiler.js`.

- [ ] **Step 3: Write the implementation**

`src/cleaner/ask-profiler.ts`:

```ts
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role, TaskState, type Message } from '@a2a-js/sdk';
import { parsePlan, type CleaningPlan } from '../shared/plan.js';
import type { DatasetProfile } from '../shared/profile.js';

const REQUIRED_SKILL = 'analyze-data-quality';

export interface AskProfilerOptions {
  profilerUrl: string;
  profile: DatasetProfile;
  onUpdate?: (text: string) => void;
  onQuestion?: (question: string) => Promise<string>;
}

export interface AskProfilerResult {
  plan: CleaningPlan;
  taskId: string;
  humanDecision?: { question: string; answer: string };
}

function userMessage(text: string, taskId = '', contextId = ''): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [{ content: { $case: 'text', value: text } }],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function readText(message: Message | undefined): string {
  if (!message) return '';
  return message.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join('');
}

/**
 * The A2A call. Discovers the Profiler through its Agent Card, sends the profile
 * as a streaming task, relays status updates, answers an input-required pause on
 * the same task, and returns the validated cleaning plan artifact.
 */
export async function askProfiler(options: AskProfilerOptions): Promise<AskProfilerResult> {
  const { profilerUrl, profile, onUpdate, onQuestion } = options;

  // 1. Discovery.
  const factory = new ClientFactory();
  const client = await factory.createFromUrl(profilerUrl);

  const cardResponse = await fetch(`${profilerUrl}/.well-known/agent-card.json`);
  if (!cardResponse.ok) {
    throw new Error(`Profiler agent card unavailable at ${profilerUrl} (HTTP ${cardResponse.status})`);
  }
  const card = (await cardResponse.json()) as { name?: string; skills?: { id: string }[] };
  const skills = card.skills ?? [];
  if (!skills.some((s) => s.id === REQUIRED_SKILL)) {
    throw new Error(
      `Agent at ${profilerUrl} does not advertise the required skill "${REQUIRED_SKILL}". ` +
        `It advertises: ${skills.map((s) => s.id).join(', ') || '(none)'}`,
    );
  }
  onUpdate?.(`discovered "${card.name ?? 'agent'}" with skill ${REQUIRED_SKILL}`);

  // 2-5. Send, stream, answer, collect.
  let taskId = '';
  let contextId = '';
  let planJson = '';
  let humanDecision: { question: string; answer: string } | undefined;
  let pendingQuestion: string | undefined;
  let failure: string | undefined;

  const consume = async (message: Message) => {
    for await (const event of client.sendMessageStream({
      tenant: '',
      message,
      configuration: undefined,
      metadata: undefined,
    })) {
      const payload = event.payload;
      if (!payload) continue;

      if (payload.$case === 'task') {
        taskId = payload.value.id;
        contextId = payload.value.contextId;
      } else if (payload.$case === 'statusUpdate') {
        const state = payload.value.status?.state;
        const text = readText(payload.value.status?.message);
        if (text) onUpdate?.(text);
        if (state === TaskState.TASK_STATE_INPUT_REQUIRED) pendingQuestion = text;
        if (state === TaskState.TASK_STATE_FAILED) failure = text || 'task failed';
      } else if (payload.$case === 'artifactUpdate') {
        const part = payload.value.artifact?.parts[0];
        if (part?.content?.$case === 'text') planJson = part.content.value;
      }
    }
  };

  await consume(userMessage(JSON.stringify(profile)));

  if (pendingQuestion) {
    if (!onQuestion) {
      throw new Error(
        `Profiler paused in input-required and no answerer was supplied. Question was:\n${pendingQuestion}`,
      );
    }
    const question = pendingQuestion;
    pendingQuestion = undefined;
    const answer = await onQuestion(question);
    humanDecision = { question, answer };
    await consume(userMessage(answer, taskId, contextId));
  }

  if (failure) throw new Error(`Profiler agent failed: ${failure}`);
  if (!planJson) throw new Error('Profiler agent completed without returning a cleaning-plan artifact');

  const parsed = parsePlan(JSON.parse(planJson));
  if (!parsed.ok) throw new Error(`Profiler returned an invalid plan: ${parsed.error}`);

  return { plan: parsed.plan, taskId, humanDecision };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/ask-profiler.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner/ask-profiler.ts test/ask-profiler.test.ts
git commit -m "feat: A2A client with discovery, streaming, and input-required resume"
```

---

### Task 11: Cleaner tools and session state

**Files:**
- Create: `src/cleaner/tools.ts`
- Test: `test/tools.test.ts`

**Interfaces:**
- Consumes: `parseCsv`/`toCsv`, `computeProfile`, `applyRule`/`previewRule`, `buildReport`, `askProfiler`, `parsePlan`
- Produces:

```ts
class CleanSession {
  constructor(opts: { profilerUrl: string; onUpdate?: (t: string) => void;
                      onQuestion?: (q: string) => Promise<string>; });
  tools(): LlmTool[];                 // the 8 tools
  get outcomes(): RuleOutcome[];
  get plan(): CleaningPlan | null;
  get humanDecision(): { question: string; answer: string } | undefined;
  get rowsBefore(): number;
  get rowsAfter(): number;
}
```

Tool names: `load_csv`, `profile_columns`, `ask_profiler`, `preview_changes`, `apply_rule`,
`apply_plan`, `save_csv`, `write_report`.

> `apply_plan` is the eighth tool. It applies every rule in the stored plan in order —
> present so a run does not need one `apply_rule` turn per rule, which would burn turns
> and quota. `apply_rule` remains available for Claude to apply or re-apply a single rule.

- [ ] **Step 1: Write the failing test**

`test/tools.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProfiler } from '../src/profiler/index.js';
import { CleanSession } from '../src/cleaner/tools.js';

let server: { url: string; close: () => Promise<void> };
let outDir: string;

beforeAll(async () => {
  server = await startProfiler(0);
  outDir = mkdtempSync(join(tmpdir(), 'a2a-'));
});
afterAll(async () => { await server.close(); });

function session() {
  return new CleanSession({ profilerUrl: server.url, onQuestion: async () => 'b' });
}

function toolMap(s: CleanSession) {
  return new Map(s.tools().map((t) => [t.name, t]));
}

describe('CleanSession tools', () => {
  it('exposes exactly the eight agreed tools', () => {
    expect(session().tools().map((t) => t.name).sort()).toEqual([
      'apply_plan', 'apply_rule', 'ask_profiler', 'load_csv',
      'preview_changes', 'profile_columns', 'save_csv', 'write_report',
    ]);
  });

  it('load_csv reports the row count and columns', async () => {
    const t = toolMap(session());
    const out = await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });
    expect(out).toContain('400');
    expect(out).toContain('roll_no');
  });

  it('tools that need data refuse to run before load_csv', async () => {
    const t = toolMap(session());
    await expect(t.get('profile_columns')!.handler({})).rejects.toThrow(/load_csv/);
  });

  it('profile_columns returns JSON that includes every column', async () => {
    const t = toolMap(session());
    await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });
    const profile = JSON.parse(await t.get('profile_columns')!.handler({}));
    expect(profile.rowCount).toBe(400);
    expect(profile.columns).toHaveLength(7);
  });

  it('ask_profiler performs the A2A call and stores the plan', async () => {
    const s = session();
    const t = toolMap(s);
    await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });
    await t.get('profile_columns')!.handler({});
    const out = await t.get('ask_profiler')!.handler({});
    expect(out).toContain('rules');
    expect(s.plan).not.toBeNull();
    expect(s.humanDecision?.answer).toBe('b');
  });

  it('apply_plan applies every rule and records outcomes', async () => {
    const s = session();
    const t = toolMap(s);
    await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });
    await t.get('profile_columns')!.handler({});
    await t.get('ask_profiler')!.handler({});
    const out = await t.get('apply_plan')!.handler({});
    expect(out).toMatch(/applied \d+ rules/i);
    expect(s.outcomes.length).toBeGreaterThan(5);
    expect(s.rowsAfter).toBeLessThan(s.rowsBefore);
  });

  it('preview_changes does not mutate the dataset', async () => {
    const s = session();
    const t = toolMap(s);
    await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });
    const before = s.rowsAfter;
    const out = await t.get('preview_changes')!.handler({
      rule: { id: 'p', column: 'marks', action: 'clip', params: { min: 0, max: 100 }, reason: 'r' },
    });
    expect(out).toMatch(/\d+ rows/);
    expect(s.rowsAfter).toBe(before);
  });

  it('apply_rule rejects an action outside the closed set', async () => {
    const t = toolMap(session());
    await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });
    await expect(
      t.get('apply_rule')!.handler({
        rule: { id: 'x', column: 'city', action: 'run_shell', params: {}, reason: 'r' },
      }),
    ).rejects.toThrow(/action/);
  });

  it('save_csv and write_report write files', async () => {
    const s = session();
    const t = toolMap(s);
    await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });
    await t.get('profile_columns')!.handler({});
    await t.get('ask_profiler')!.handler({});
    await t.get('apply_plan')!.handler({});

    const csvPath = join(outDir, 'cleaned.csv');
    const reportPath = join(outDir, 'report.md');
    await t.get('save_csv')!.handler({ path: csvPath });
    await t.get('write_report')!.handler({ summary: 'All good.', path: reportPath });

    expect(readFileSync(csvPath, 'utf8').split('\n').length).toBeGreaterThan(300);
    const report = readFileSync(reportPath, 'utf8');
    expect(report).toContain('All good.');
    expect(report).toContain('Human decision');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/tools.test.ts`
Expected: FAIL — cannot resolve `../src/cleaner/tools.js`.

- [ ] **Step 3: Write the implementation**

`src/cleaner/tools.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { parseCsv, toCsv, type Row } from '../shared/csv.js';
import { computeProfile, type DatasetProfile } from '../shared/profile.js';
import { CleaningRuleSchema, type CleaningPlan, type CleaningRule } from '../shared/plan.js';
import type { LlmTool } from '../shared/llm.js';
import { applyRule, previewRule, type RuleOutcome } from './apply.js';
import { buildReport } from './report.js';
import { askProfiler } from './ask-profiler.js';

export interface CleanSessionOptions {
  profilerUrl: string;
  onUpdate?: (text: string) => void;
  onQuestion?: (question: string) => Promise<string>;
}

/**
 * Holds the working dataset and exposes it to Claude as tools. Claude decides
 * which tool to call and in what order; this class only guarantees that each
 * tool is safe and that every change is recorded.
 */
export class CleanSession {
  private headers: string[] = [];
  private rows: Row[] = [];
  private initialRowCount = 0;
  private profile: DatasetProfile | null = null;

  private _plan: CleaningPlan | null = null;
  private _outcomes: RuleOutcome[] = [];
  private _humanDecision?: { question: string; answer: string };

  constructor(private readonly options: CleanSessionOptions) {}

  get plan(): CleaningPlan | null { return this._plan; }
  get outcomes(): RuleOutcome[] { return this._outcomes; }
  get humanDecision() { return this._humanDecision; }
  get rowsBefore(): number { return this.initialRowCount; }
  get rowsAfter(): number { return this.rows.length; }

  private requireLoaded(): void {
    if (this.headers.length === 0) {
      throw new Error('No dataset loaded. Call load_csv first.');
    }
  }

  private validateRule(input: unknown): CleaningRule {
    const parsed = CleaningRuleSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid rule — the action must be one of the allowed set. ${detail}`);
    }
    return parsed.data;
  }

  tools(): LlmTool[] {
    return [
      {
        name: 'load_csv',
        description: 'Load a CSV file into the working dataset. Must be called first.',
        schema: { path: z.string().describe('Path to the CSV file') },
        handler: async ({ path }) => {
          const parsed = parseCsv(readFileSync(path, 'utf8'));
          this.headers = parsed.headers;
          this.rows = parsed.rows;
          this.initialRowCount = parsed.rows.length;
          return `Loaded ${parsed.rows.length} rows with columns: ${parsed.headers.join(', ')}`;
        },
      },
      {
        name: 'profile_columns',
        description:
          'Compute a statistical profile of the loaded dataset: per-column types, missing counts, distinct values, ranges, and 15 sample rows.',
        schema: {},
        handler: async () => {
          this.requireLoaded();
          this.profile = computeProfile(this.headers, this.rows);
          return JSON.stringify(this.profile);
        },
      },
      {
        name: 'ask_profiler',
        description:
          'Ask the specialist Profiler agent, over the A2A protocol, for a cleaning plan based on the computed profile. Returns the plan as JSON.',
        schema: {},
        handler: async () => {
          this.requireLoaded();
          if (!this.profile) this.profile = computeProfile(this.headers, this.rows);

          const result = await askProfiler({
            profilerUrl: this.options.profilerUrl,
            profile: this.profile,
            onUpdate: (t) => this.options.onUpdate?.(`[profiler] ${t}`),
            onQuestion: this.options.onQuestion,
          });

          this._plan = result.plan;
          this._humanDecision = result.humanDecision;
          return JSON.stringify(result.plan);
        },
      },
      {
        name: 'preview_changes',
        description:
          'Show how many rows a rule would change, with up to 5 before/after examples. Does not modify the dataset.',
        schema: { rule: z.record(z.unknown()).describe('A single cleaning rule') },
        handler: async ({ rule }) => {
          this.requireLoaded();
          const validated = this.validateRule(rule);
          const preview = previewRule(this.headers, this.rows, validated);
          const examples = preview.examples
            .map((e) => `  "${e.before}" -> "${e.after}"`)
            .join('\n');
          return `${preview.rowsAffected} rows of ${this.rows.length} would change.\n${examples}`;
        },
      },
      {
        name: 'apply_rule',
        description: 'Apply one cleaning rule to the working dataset.',
        schema: { rule: z.record(z.unknown()).describe('A single cleaning rule') },
        handler: async ({ rule }) => {
          this.requireLoaded();
          const validated = this.validateRule(rule);
          return this.runRule(validated);
        },
      },
      {
        name: 'apply_plan',
        description:
          'Apply every rule from the plan returned by ask_profiler, in order. Use this instead of calling apply_rule once per rule.',
        schema: {},
        handler: async () => {
          this.requireLoaded();
          if (!this._plan) throw new Error('No plan available. Call ask_profiler first.');
          const lines = this._plan.rules.map((rule) => this.runRule(rule));
          return `Applied ${this._plan.rules.length} rules.\n${lines.join('\n')}`;
        },
      },
      {
        name: 'save_csv',
        description: 'Write the cleaned dataset to a CSV file.',
        schema: { path: z.string().describe('Output path, e.g. out/cleaned.csv') },
        handler: async ({ path }) => {
          this.requireLoaded();
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, toCsv(this.headers, this.rows), 'utf8');
          return `Wrote ${this.rows.length} rows to ${path}`;
        },
      },
      {
        name: 'write_report',
        description:
          'Write out/report.md. Supply a short narrative paragraph; every number in the report is filled in from the recorded change log, not from your summary.',
        schema: {
          summary: z.string().describe('One short paragraph describing what was cleaned'),
          path: z.string().optional().describe('Output path, default out/report.md'),
        },
        handler: async ({ summary, path }) => {
          const target = path ?? 'out/report.md';
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(
            target,
            buildReport({
              narrative: summary,
              rowsBefore: this.initialRowCount,
              rowsAfter: this.rows.length,
              plan: this._plan,
              outcomes: this._outcomes,
              humanDecision: this._humanDecision,
            }),
            'utf8',
          );
          return `Wrote ${target}`;
        },
      },
    ];
  }

  private runRule(rule: CleaningRule): string {
    const result = applyRule(this.headers, this.rows, rule);
    this.headers = result.headers;
    this.rows = result.rows;
    this._outcomes.push(result.outcome);

    if (result.outcome.skipped) return `  ${rule.id} skipped: ${result.outcome.skipped}`;
    return `  ${rule.id} (${rule.action}): ${result.outcome.rowsChanged} changed, ${result.outcome.rowsRemoved} removed`;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/tools.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/cleaner/tools.ts test/tools.test.ts
git commit -m "feat: Cleaner session state and the eight Claude tools"
```

---

### Task 12: Cleaner agent — card, executor, server, and CLI

**Files:**
- Create: `src/cleaner/card.ts`, `src/cleaner/executor.ts`, `src/cleaner/index.ts`
- Test: `test/cleaner.test.ts`

**Interfaces:**
- Consumes: `CleanSession`, `getLLM`
- Produces:
  - `cleanerCard(port: number): AgentCard`
  - `runCleaning(opts: { csvPath: string; profilerUrl: string; outDir: string; onUpdate?: (t: string) => void; onQuestion?: (q: string) => Promise<string> }): Promise<{ narrative: string; rowsBefore: number; rowsAfter: number }>`
  - `class CleanerExecutor implements AgentExecutor`
  - `startCleaner(port: number): Promise<{ url: string; close: () => Promise<void> }>`

- [ ] **Step 1: Write the failing test**

`test/cleaner.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProfiler } from '../src/profiler/index.js';
import { startCleaner } from '../src/cleaner/index.js';
import { runCleaning } from '../src/cleaner/executor.js';

let profiler: { url: string; close: () => Promise<void> };
let cleaner: { url: string; close: () => Promise<void> };

beforeAll(async () => {
  profiler = await startProfiler(0);
  cleaner = await startCleaner(0);
});
afterAll(async () => {
  await cleaner.close();
  await profiler.close();
});

describe('Cleaner agent', () => {
  it('serves an agent card advertising clean-dataset', async () => {
    const card = await (await fetch(`${cleaner.url}/.well-known/agent-card.json`)).json();
    expect(card.name).toBe('Data Cleaner Agent');
    expect(card.skills.map((s: any) => s.id)).toContain('clean-dataset');
  });
});

describe('runCleaning', () => {
  it('drives the whole flow and writes both outputs', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'a2a-run-'));
    const updates: string[] = [];

    const result = await runCleaning({
      csvPath: 'data/students_raw.csv',
      profilerUrl: profiler.url,
      outDir,
      onUpdate: (t) => updates.push(t),
      onQuestion: async () => 'b',
    });

    expect(result.rowsBefore).toBe(400);
    expect(result.rowsAfter).toBeLessThan(400);
    expect(existsSync(join(outDir, 'cleaned.csv'))).toBe(true);
    expect(existsSync(join(outDir, 'report.md'))).toBe(true);
    expect(existsSync(join(outDir, 'cleaning-plan.json'))).toBe(true);
    expect(updates.some((u) => u.startsWith('[profiler]'))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/cleaner.test.ts`
Expected: FAIL — cannot resolve `../src/cleaner/index.js`.

- [ ] **Step 3: Write the card**

`src/cleaner/card.ts`:

```ts
import type { AgentCard } from '@a2a-js/sdk';

export function cleanerCard(port: number): AgentCard {
  return {
    name: 'Data Cleaner Agent',
    description:
      'Cleans a CSV dataset, consulting a specialist Profiler agent over A2A for a cleaning plan.',
    version: '1.0.0',
    supportedInterfaces: [
      { url: `http://localhost:${port}/`, protocolBinding: 'JSONRPC', tenant: '' },
    ],
    provider: undefined,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [],
    },
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      {
        id: 'clean-dataset',
        name: 'Dataset Cleaning',
        description:
          'Given a path to a CSV file, clean it and produce a cleaned CSV plus a report.',
        tags: ['data', 'cleaning', 'csv'],
        examples: ['Clean data/students_raw.csv'],
        inputModes: ['text/plain'],
        outputModes: ['text/plain'],
        securityRequirements: [],
      },
    ],
    signatures: [],
  };
}
```

- [ ] **Step 4: Write `runCleaning` and the executor**

`src/cleaner/executor.ts`:

```ts
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import { getLLM } from '../shared/llm.js';
import { CleanSession } from './tools.js';

const SYSTEM_PROMPT = `You are a careful data cleaning agent.

Your job is to clean a CSV dataset using the tools you have been given. You decide
the order of operations.

A specialist Profiler agent is reachable through the ask_profiler tool. It analyses a
column profile and returns a cleaning plan with justifications. Use it — do not invent
cleaning rules yourself when the Profiler can supply them.

Guidance:
- Load the file first, then compute the profile, then consult the Profiler.
- Before applying a rule that looks like it will change a large share of the rows, call
  preview_changes on it and check the examples are what you expect.
- Use apply_plan to apply the Profiler's rules; use apply_rule only for a single extra rule.
- Save the cleaned dataset, then call write_report with a short paragraph describing what
  was cleaned. Do not put statistics in that paragraph — the report fills in every number
  from the recorded change log.

When you are finished, reply with a short summary for the operator.`;

export interface RunCleaningOptions {
  csvPath: string;
  profilerUrl: string;
  outDir: string;
  onUpdate?: (text: string) => void;
  onQuestion?: (question: string) => Promise<string>;
}

export async function runCleaning(options: RunCleaningOptions): Promise<{
  narrative: string;
  rowsBefore: number;
  rowsAfter: number;
}> {
  const { csvPath, profilerUrl, outDir, onUpdate, onQuestion } = options;
  mkdirSync(outDir, { recursive: true });

  const session = new CleanSession({ profilerUrl, onUpdate, onQuestion });
  const llm = getLLM('cleaner');

  const narrative = await llm.run({
    system: SYSTEM_PROMPT,
    user: [
      `Clean the dataset at ${csvPath}.`,
      `Save the cleaned CSV to ${join(outDir, 'cleaned.csv')}.`,
      `Write the report to ${join(outDir, 'report.md')}.`,
    ].join('\n'),
    tools: session.tools(),
    maxTurns: 30,
    onProgress: (text) => onUpdate?.(`[cleaner] ${text}`),
  });

  if (session.plan) {
    writeFileSync(
      join(outDir, 'cleaning-plan.json'),
      JSON.stringify(session.plan, null, 2),
      'utf8',
    );
  }

  return { narrative, rowsBefore: session.rowsBefore, rowsAfter: session.rowsAfter };
}

function textPart(value: string) {
  return { content: { $case: 'text' as const, value } };
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId, taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  };
}

/** Lets another agent delegate a cleaning job to this one over A2A. */
export class CleanerExecutor implements AgentExecutor {
  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;

    const status = (state: TaskState, text?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId, contextId,
          status: {
            state,
            message: text ? agentMessage(taskId, contextId, text) : undefined,
            timestamp: new Date().toISOString(),
          },
          final: state === TaskState.TASK_STATE_COMPLETED || state === TaskState.TASK_STATE_FAILED,
          metadata: undefined,
        }),
      );

    const task: Task = {
      id: taskId, contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [], history: [], metadata: undefined,
    };
    bus.publish(AgentEvent.task(task));

    try {
      const csvPath = ctx.userMessage.parts
        .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
        .join('')
        .trim();

      if (!csvPath) throw new Error('Send the path to a CSV file as the message text.');

      status(TaskState.TASK_STATE_WORKING, `cleaning ${csvPath}`);

      const result = await runCleaning({
        csvPath,
        profilerUrl: process.env.PROFILER_URL ?? 'http://localhost:4002',
        outDir: process.env.OUT_DIR ?? 'out',
        onUpdate: (text) => status(TaskState.TASK_STATE_WORKING, text),
      });

      status(
        TaskState.TASK_STATE_COMPLETED,
        `${result.narrative}\n(${result.rowsBefore} rows in, ${result.rowsAfter} rows out)`,
      );
    } catch (error) {
      status(TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : String(error));
    } finally {
      bus.finished();
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    bus.publish(
      AgentEvent.statusUpdate({
        taskId, contextId: '',
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
        final: true, metadata: undefined,
      }),
    );
    bus.finished();
  }
}
```

- [ ] **Step 5: Write the server bootstrap and CLI**

`src/cleaner/index.ts`:

```ts
import { createInterface } from 'node:readline/promises';
import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { cleanerCard } from './card.js';
import { CleanerExecutor, runCleaning } from './executor.js';

export async function startCleaner(
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const card = cleanerCard(actualPort);

  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new CleanerExecutor(),
  );

  app.use(agentCardHandler({ agentCardProvider: async () => card }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return {
    url: `http://localhost:${actualPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function cli(csvPath: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const result = await runCleaning({
    csvPath,
    profilerUrl: process.env.PROFILER_URL ?? 'http://localhost:4002',
    outDir: process.env.OUT_DIR ?? 'out',
    onUpdate: (text) => console.log(text),
    onQuestion: async (question) => {
      console.log(`\n${question}\n`);
      const answer = await rl.question('Your answer: ');
      return answer.trim();
    },
  });

  rl.close();
  console.log(`\n${result.narrative}`);
  console.log(`Rows: ${result.rowsBefore} -> ${result.rowsAfter}`);
  console.log('Wrote out/cleaned.csv, out/report.md, out/cleaning-plan.json');
}

if (process.argv[1]?.endsWith('cleaner/index.ts')) {
  const args = process.argv.slice(2);
  const cliIndex = args.indexOf('--cli');

  if (cliIndex !== -1) {
    const csvPath = args[cliIndex + 1] ?? args.find((a) => a.endsWith('.csv'));
    if (!csvPath) {
      console.error('Usage: npm run clean <path-to-csv>');
      process.exit(1);
    }
    cli(csvPath).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  } else {
    const port = Number(process.env.PORT ?? 4001);
    startCleaner(port).then(({ url }) => {
      console.log(`Cleaner Agent listening on ${url}`);
      console.log(`Agent card: ${url}/.well-known/agent-card.json`);
    });
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/cleaner.test.ts`
Expected: PASS — 2 tests.

- [ ] **Step 7: Commit**

```bash
git add src/cleaner/card.ts src/cleaner/executor.ts src/cleaner/index.ts test/cleaner.test.ts
git commit -m "feat: Cleaner agent with A2A card, executor, server, and CLI"
```

---

### Task 13: Full suite green and end-to-end invariants

**Files:**
- Create: `test/e2e.test.ts`
- Test: the whole suite

**Interfaces:**
- Consumes: everything.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

`test/e2e.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/e2e.test.ts`
Expected: PASS. Any failure here is a real defect in an earlier task — fix the source,
not the assertion. The likely culprits are rule ordering in `MOCK_PLAN` (trim before
normalize before title_case) and `parse_date` not handling one of the three formats.

- [ ] **Step 3: Run the whole suite and the typechecker**

Run: `npm test`
Expected: PASS — every test file.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add test/e2e.test.ts
git commit -m "test: end-to-end cleaning invariants"
```

---

### Task 14: Real Claude run, README, and demo runbook

**Files:**
- Create: `README.md`
- Modify: whatever the real Claude run exposes as broken

**Interfaces:**
- Consumes: everything.
- Produces: nothing new.

- [ ] **Step 1: Start both agents against real Claude**

Terminal 2:

```bash
npm run profiler
```

Terminal 1:

```bash
npm run clean data/students_raw.csv
```

Note: `USE_MOCK` must be unset in these shells. Vitest sets it only for tests.

Expected: the Cleaner prints `[cleaner]` tool-call lines and `[profiler]` SSE updates,
pauses with the age question, accepts an answer, and writes the three output files.

- [ ] **Step 2: Fix whatever the real run exposes**

Likely issues and where they live:

| Symptom | Where to look |
|---|---|
| Claude never calls `ask_profiler` | Strengthen the instruction in `SYSTEM_PROMPT` in `src/cleaner/executor.ts` |
| Claude's plan JSON is rejected | Tighten the schema description in `src/profiler/prompt.ts`; the retry already appends the validation error |
| Run exceeds `maxTurns` | Raise `maxTurns` in `runCleaning`, or make the prompt point harder at `apply_plan` |
| Tool arguments arrive as strings | Parse in the tool handler; never string-match a serialised argument |

After each fix, re-run `npm test` to confirm the mock path still passes.

- [ ] **Step 3: Verify the demo steps from the spec's runbook**

```bash
# 1. Discovery
curl http://localhost:4002/.well-known/agent-card.json

# 4. Task state is server-side, addressable by id
curl -X POST http://localhost:4002/ \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"GetTask","params":{"id":"<taskId>","tenant":""}}'
```

Expected: the card returns JSON with `analyze-data-quality`; `GetTask` returns the task
with its final state. Record the exact `taskId` from the Cleaner's output.

- [ ] **Step 4: Write the README**

`README.md` must contain, in this order:

1. One paragraph: what this is and what A2A is.
2. The architecture diagram from spec §3.
3. **Run it:** the three-terminal runbook, and the note that `USE_MOCK=1` runs without Claude.
4. **What to look at:** `out/report.md`, `out/cleaning-plan.json`, `out/cleaned.csv`.
5. **Where the A2A protocol lives in the code:** a table pointing at
   `src/profiler/card.ts` (Agent Card), `src/cleaner/ask-profiler.ts` (discovery, JSON-RPC,
   SSE, resume), `src/profiler/executor.ts` (task lifecycle, `input-required`, artifact).
6. **Design notes:** why the LLM plans and code executes; why the action set is closed.
7. A link to `docs/superpowers/specs/2026-09-04-a2a-data-cleaning-design.md`.

- [ ] **Step 5: Final verification**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add README.md src out
git commit -m "docs: README and demo runbook; fixes from the first real Claude run"
```

---

## Spec Coverage

| Spec section | Task |
|---|---|
| §3 architecture, division of responsibility | 8, 11, 12 |
| §4.1 Profiler Agent Card | 8 |
| §4.2 executor behaviour, progress updates | 8 |
| §4.3 `input-required` trigger | 9 |
| §4.4 prompt, JSON validation, one retry | 8 |
| §5.1 Cleaner Agent Card | 12 |
| §5.2 tools (8) | 11 |
| §5.3 `ask_profiler` — 7 steps | 10 |
| §5.4 column profile format | 4 |
| §6 protocol surface, v1 wire shapes | 8, 10 |
| §7 plan schema, closed action set | 2, 5 |
| §8 dataset | 3 |
| §9 LLM abstraction, mock and Agent SDK | 7 |
| §10 outputs | 6, 11, 12 |
| §11 project structure | all (with the documented split) |
| §12 error handling | 5, 10, 11 |
| §13 testing | 1-13 |
| §14 demo runbook | 14 |
