import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClientFactory } from '@a2a-js/sdk/client';
import { Role, TaskState } from '@a2a-js/sdk';
import { startProfiler } from '../src/profiler/index.js';
import { startCleaner } from '../src/cleaner/index.js';
import { runCleaning } from '../src/cleaner/executor.js';

function textMessage(text: string, taskId = '', contextId = '') {
  return {
    messageId: crypto.randomUUID(),
    contextId, taskId,
    role: Role.ROLE_USER,
    parts: [{
      content: { $case: 'text' as const, value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
    metadata: undefined, extensions: [], referenceTaskIds: [],
  };
}

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

describe('CleanerExecutor', () => {
  it('completes a delegated clean-dataset task instead of failing on the Profiler pause', async () => {
    // The shipped dataset always makes the Profiler pause in input-required. A
    // delegated A2A run (no human on the other end of this task) must still
    // complete, using the documented default answer, rather than fail.
    const outDir = mkdtempSync(join(tmpdir(), 'a2a-delegated-'));
    const prevProfilerUrl = process.env.PROFILER_URL;
    const prevOutDir = process.env.OUT_DIR;
    process.env.PROFILER_URL = profiler.url;
    process.env.OUT_DIR = outDir;

    try {
      const client = await new ClientFactory().createFromUrl(cleaner.url);
      let finalState: number | undefined;
      let finalText = '';

      for await (const event of client.sendMessageStream({
        tenant: '', message: textMessage('data/students_raw.csv'),
        configuration: undefined, metadata: undefined,
      })) {
        const p = event.payload;
        if (p?.$case === 'statusUpdate') {
          finalState = p.value.status!.state;
          const part = p.value.status!.message?.parts[0];
          if (part?.content?.$case === 'text') finalText = part.content.value;
        }
      }

      expect(finalState).toBe(TaskState.TASK_STATE_COMPLETED);
      expect(finalText).toBeTruthy();
    } finally {
      if (prevProfilerUrl === undefined) delete process.env.PROFILER_URL;
      else process.env.PROFILER_URL = prevProfilerUrl;
      if (prevOutDir === undefined) delete process.env.OUT_DIR;
      else process.env.OUT_DIR = prevOutDir;
    }
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
