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
