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
    parts: [{
      content: { $case: 'text' as const, value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
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
