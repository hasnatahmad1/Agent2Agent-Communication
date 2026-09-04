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
    parts: [{
      content: { $case: 'text' as const, value: text },
      metadata: undefined,
      filename: '',
      mediaType: 'text/plain',
    }],
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
