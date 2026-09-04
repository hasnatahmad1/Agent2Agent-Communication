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
