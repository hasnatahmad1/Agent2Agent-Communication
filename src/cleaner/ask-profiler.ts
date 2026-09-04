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
  /**
   * Set when `onQuestion` answers without a human present (e.g. a delegated
   * A2A run using a documented default). Recorded on the returned
   * `humanDecision` so the report can disclose it instead of implying a
   * human answered.
   */
  automaticAnswer?: boolean;
  /** Deadline for the card fetch and each streaming call. Default 120000ms. */
  timeoutMs?: number;
}

export interface AskProfilerResult {
  plan: CleaningPlan;
  taskId: string;
  humanDecision?: { question: string; answer: string; automatic?: boolean };
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
 * Bounds a promise that has no signal/abort hook of its own (e.g.
 * `ClientFactory.createFromUrl`, which fetches the card internally with a
 * plain `fetch`). The underlying call may keep running after we give up on
 * it, but the timer is always cleared so it never keeps the process alive.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * The A2A call. Discovers the Profiler through its Agent Card, sends the profile
 * as a streaming task, relays status updates, answers an input-required pause on
 * the same task, and returns the validated cleaning plan artifact.
 */
export async function askProfiler(options: AskProfilerOptions): Promise<AskProfilerResult> {
  const { profilerUrl, profile, onUpdate, onQuestion, automaticAnswer, timeoutMs = 120_000 } = options;

  // 1. Discovery.
  const factory = new ClientFactory();
  const client = await withTimeout(
    factory.createFromUrl(profilerUrl),
    timeoutMs,
    `Profiler at ${profilerUrl} did not respond within ${timeoutMs}ms`,
  );

  let cardResponse: Response;
  try {
    cardResponse = await fetch(`${profilerUrl}/.well-known/agent-card.json`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`Profiler agent card at ${profilerUrl} did not respond within ${timeoutMs}ms`);
    }
    throw new Error(
      `Profiler agent card unavailable at ${profilerUrl}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
  let humanDecision: { question: string; answer: string; automatic?: boolean } | undefined;
  let pendingQuestion: string | undefined;
  let failure: string | undefined;

  const consume = async (message: Message) => {
    try {
      for await (const event of client.sendMessageStream(
        { tenant: '', message, configuration: undefined, metadata: undefined },
        { signal: AbortSignal.timeout(timeoutMs) },
      )) {
        const payload = event.payload;
        if (!payload) continue;

        if (payload.$case === 'task') {
          taskId = payload.value.id;
          contextId = payload.value.contextId;
        } else if (payload.$case === 'statusUpdate') {
          const state = payload.value.status?.state;
          const text = readText(payload.value.status?.message);
          // The input-required text is the question itself; it reaches the caller
          // through onQuestion, so relaying it here too would print it twice.
          if (state === TaskState.TASK_STATE_INPUT_REQUIRED) pendingQuestion = text;
          else if (text) onUpdate?.(text);
          if (state === TaskState.TASK_STATE_FAILED) failure = text || 'task failed';
        } else if (payload.$case === 'artifactUpdate') {
          const part = payload.value.artifact?.parts[0];
          if (part?.content?.$case === 'text') planJson = part.content.value;
        }
      }
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new Error(`Profiler at ${profilerUrl} did not complete the task within ${timeoutMs}ms`);
      }
      throw error;
    }
  };

  const MAX_ROUNDS = 3;
  await consume(userMessage(JSON.stringify(profile)));

  for (let round = 1; pendingQuestion; round++) {
    if (round > MAX_ROUNDS) {
      throw new Error(
        `Profiler asked for input more than ${MAX_ROUNDS} times on the same task; giving up.`,
      );
    }
    if (!onQuestion) {
      throw new Error(
        `Profiler paused in input-required and no answerer was supplied. Question was:\n${pendingQuestion}`,
      );
    }
    const question = pendingQuestion;
    pendingQuestion = undefined;
    const answer = await onQuestion(question);
    humanDecision = { question, answer, automatic: automaticAnswer };
    await consume(userMessage(answer, taskId, contextId));
  }

  if (failure) throw new Error(`Profiler agent failed: ${failure}`);
  if (!planJson) throw new Error('Profiler agent completed without returning a cleaning-plan artifact');

  let planValue: unknown;
  try {
    planValue = JSON.parse(planJson);
  } catch (error) {
    throw new Error(
      `Profiler returned an artifact that is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const parsed = parsePlan(planValue);
  if (!parsed.ok) throw new Error(`Profiler returned an invalid plan: ${parsed.error}`);

  return { plan: parsed.plan, taskId, humanDecision };
}
