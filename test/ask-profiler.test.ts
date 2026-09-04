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

  it('fails clearly (not a bare SyntaxError) when the artifact is not valid JSON', async () => {
    const bad = await startBadArtifactServer();
    try {
      await expect(
        askProfiler({ profilerUrl: bad.url, profile: cleanProfile }),
      ).rejects.toThrow(/JSON/i);
    } finally {
      await bad.close();
    }
  });

  it('rejects rather than hanging when the agent never responds, within the given timeout', async () => {
    const hung = await startHungServer();
    try {
      await expect(
        askProfiler({ profilerUrl: hung.url, profile: cleanProfile, timeoutMs: 300 }),
      ).rejects.toThrow();
    } finally {
      await hung.close();
    }
  }, 5000);
});

/** A minimal A2A agent whose artifact text is not valid JSON, to exercise F6. */
async function startBadArtifactServer() {
  const express = (await import('express')).default;
  const { DefaultRequestHandler, InMemoryTaskStore, AgentEvent } = await import('@a2a-js/sdk/server');
  const { agentCardHandler, jsonRpcHandler, UserBuilder } = await import('@a2a-js/sdk/server/express');
  const { TaskState } = await import('@a2a-js/sdk');
  const { profilerCard } = await import('../src/profiler/card.js');

  const executor = {
    async execute(ctx: any, bus: any) {
      const { taskId, contextId } = ctx;
      bus.publish(
        AgentEvent.task({
          id: taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
          artifacts: [],
          history: [],
          metadata: undefined,
        }),
      );
      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: crypto.randomUUID(),
            name: 'cleaning-plan',
            description: 'not JSON',
            parts: [{ content: { $case: 'text', value: 'this is not JSON' }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
          metadata: undefined,
        }),
      );
      bus.finished();
    },
    async cancelTask() {},
  };

  const app = express();
  app.use(express.json({ limit: '5mb' }));
  const httpServer = await new Promise<any>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = httpServer.address().port;
  const card = { ...profilerCard(port) };
  const requestHandler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor as any);
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: async () => card }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return {
    url: `http://localhost:${port}`,
    close: () => new Promise<void>((r) => httpServer.close(() => r())),
  };
}

/** A server that accepts the connection and never responds, to exercise F7. */
async function startHungServer() {
  const http = await import('node:http');
  const httpServer = http.createServer(() => {
    // Never respond.
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((r) => {
        httpServer.closeAllConnections();
        httpServer.close(() => r());
      }),
  };
}

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
