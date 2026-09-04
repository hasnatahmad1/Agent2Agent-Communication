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
