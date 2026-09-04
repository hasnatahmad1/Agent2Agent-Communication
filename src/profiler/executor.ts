import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import { getLLM } from '../shared/llm.js';
import { parsePlan } from '../shared/plan.js';
import type { DatasetProfile } from '../shared/profile.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

function textPart(value: string) {
  return {
    content: { $case: 'text' as const, value },
    metadata: undefined,
    filename: '',
    mediaType: 'text/plain',
  };
}

function agentMessage(taskId: string, contextId: string, text: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_AGENT,
    parts: [textPart(text)],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

export function readText(message: Message | undefined): string {
  if (!message) return '';
  return message.parts
    .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
    .join('');
}

export class ProfilerExecutor implements AgentExecutor {
  private readonly cancelled = new Set<string>();

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const { taskId, contextId } = ctx;

    const status = (state: TaskState, text?: string) =>
      bus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state,
            message: text ? agentMessage(taskId, contextId, text) : undefined,
            timestamp: new Date().toISOString(),
          },
          metadata: undefined,
        }),
      );

    // The first event of every execute() call must be a task or message event.
    const task: Task = {
      id: taskId,
      contextId,
      status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date().toISOString() },
      artifacts: [],
      history: [],
      metadata: undefined,
    };
    bus.publish(AgentEvent.task(task));

    try {
      const raw = readText(ctx.userMessage);
      const profile = parseProfile(raw);

      status(TaskState.TASK_STATE_WORKING, `${profile.columns.length} columns received`);

      for (const column of profile.columns) {
        if (this.cancelled.has(taskId)) return;
        const notes: string[] = [];
        if (column.distinctCount > 3 && column.inferredType === 'string') {
          notes.push(`${column.distinctCount} distinct variants`);
        }
        if (column.nullCount > 0) notes.push(`${column.nullCount} missing`);
        if (column.outOfRangeCount) notes.push(`${column.outOfRangeCount} out of range`);
        if (notes.length) {
          status(TaskState.TASK_STATE_WORKING, `${column.name}: ${notes.join(', ')}`);
        }
      }

      status(TaskState.TASK_STATE_WORKING, 'asking Claude for a cleaning plan');

      const plan = await this.requestPlan(profile, undefined, (text) =>
        status(TaskState.TASK_STATE_WORKING, text),
      );

      bus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: crypto.randomUUID(),
            name: 'cleaning-plan',
            description: 'Cleaning rules with justifications',
            parts: [textPart(JSON.stringify(plan, null, 2))],
            metadata: undefined,
            extensions: [],
          },
          append: false,
          lastChunk: true,
          metadata: undefined,
        }),
      );

      status(TaskState.TASK_STATE_COMPLETED, plan.summary);
    } catch (error) {
      status(
        TaskState.TASK_STATE_FAILED,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      bus.finished();
    }
  }

  /** Calls Claude and validates the reply, retrying once with the validation error. */
  protected async requestPlan(
    profile: DatasetProfile,
    humanAnswer: string | undefined,
    onProgress: (text: string) => void,
  ) {
    const llm = getLLM('profiler');
    let user = buildUserPrompt(profile, humanAnswer);

    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await llm.run({ system: SYSTEM_PROMPT, user, onProgress, maxTurns: 1 });
      const json = extractJson(reply);
      const parsed = json === undefined
        ? { ok: false as const, error: 'reply contained no JSON object' }
        : parsePlan(json);

      if (parsed.ok) return parsed.plan;

      if (attempt === 1) throw new Error(`Claude returned an invalid plan: ${parsed.error}`);
      user = `${user}\n\nYour previous reply was rejected: ${parsed.error}\nReturn corrected JSON only.`;
    }

    throw new Error('unreachable');
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.cancelled.add(taskId);
    bus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
        metadata: undefined,
      }),
    );
    bus.finished();
  }
}

function parseProfile(raw: string): DatasetProfile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Expected a JSON column profile in the message, but the text was not JSON.');
  }
  const p = value as Partial<DatasetProfile>;
  if (typeof p?.rowCount !== 'number' || !Array.isArray(p?.columns)) {
    throw new Error('Message is not a column profile: rowCount and columns are required.');
  }
  return p as DatasetProfile;
}

/** Pulls the first JSON object out of a reply, tolerating a markdown fence. */
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
