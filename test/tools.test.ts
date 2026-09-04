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

  it('write_report refuses to run before load_csv', async () => {
    const t = toolMap(session());
    await expect(
      t.get('write_report')!.handler({ summary: 'nothing was cleaned' }),
    ).rejects.toThrow(/load_csv/);
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

  it('load_csv called a second time resets the change log', async () => {
    const s = session();
    const t = toolMap(s);
    await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });
    await t.get('profile_columns')!.handler({});
    await t.get('ask_profiler')!.handler({});
    await t.get('apply_plan')!.handler({});
    expect(s.outcomes.length).toBeGreaterThan(0);

    await t.get('load_csv')!.handler({ path: 'data/students_raw.csv' });

    expect(s.outcomes).toEqual([]);
    expect(s.plan).toBeNull();
    expect(s.humanDecision).toBeUndefined();
    expect(s.rowsBefore).toBe(400);
    expect(s.rowsAfter).toBe(400);
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
