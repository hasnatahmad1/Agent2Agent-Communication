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

function textPart(value: string) {
  return {
    content: { $case: 'text' as const, value },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

function userMessage(text: string, taskId = '', contextId = ''): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [textPart(text)],
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
