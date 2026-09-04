import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext,
} from '@a2a-js/sdk/server';
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import { getLLM } from '../shared/llm.js';
import { CleanSession } from './tools.js';

const SYSTEM_PROMPT = `You are a careful data cleaning agent.

Your job is to clean a CSV dataset using the tools you have been given. You decide
the order of operations.

A specialist Profiler agent is reachable through the ask_profiler tool. It analyses a
column profile and returns a cleaning plan with justifications. Use it — do not invent
cleaning rules yourself when the Profiler can supply them.

Guidance:
- Load the file first, then compute the profile, then consult the Profiler.
- Before applying a rule that looks like it will change a large share of the rows, call
  preview_changes on it and check the examples are what you expect.
- Use apply_plan to apply the Profiler's rules; use apply_rule only for a single extra rule.
- Save the cleaned dataset, then call write_report with a short paragraph describing what
  was cleaned. Do not put statistics in that paragraph — the report fills in every number
  from the recorded change log.

When you are finished, reply with a short summary for the operator.`;

export interface RunCleaningOptions {
  csvPath: string;
  profilerUrl: string;
  outDir: string;
  onUpdate?: (text: string) => void;
  onQuestion?: (question: string) => Promise<string>;
  /** See CleanSessionOptions.automaticAnswer. */
  automaticAnswer?: boolean;
}

export async function runCleaning(options: RunCleaningOptions): Promise<{
  narrative: string;
  rowsBefore: number;
  rowsAfter: number;
}> {
  const { csvPath, profilerUrl, outDir, onUpdate, onQuestion, automaticAnswer } = options;
  mkdirSync(outDir, { recursive: true });

  const session = new CleanSession({ profilerUrl, onUpdate, onQuestion, automaticAnswer });
  const llm = getLLM('cleaner');

  const narrative = await llm.run({
    system: SYSTEM_PROMPT,
    user: [
      `Clean the dataset at ${csvPath}.`,
      `Save the cleaned CSV to ${join(outDir, 'cleaned.csv')}.`,
      `Write the report to ${join(outDir, 'report.md')}.`,
    ].join('\n'),
    tools: session.tools(),
    maxTurns: 30,
    onProgress: (text) => onUpdate?.(`[cleaner] ${text}`),
  });

  if (session.plan) {
    writeFileSync(
      join(outDir, 'cleaning-plan.json'),
      JSON.stringify(session.plan, null, 2),
      'utf8',
    );
  }

  return { narrative, rowsBefore: session.rowsBefore, rowsAfter: session.rowsAfter };
}

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

/**
 * Default answer given to the Profiler's `input-required` question when this
 * task was delegated over A2A rather than driven by the interactive CLI —
 * there is no human to ask. Relaying the pause as this delegated task's own
 * `input-required` (so the delegating agent or its human can answer) is the
 * protocol-correct fix and is out of scope here; this keeps the advertised
 * `clean-dataset` skill from failing outright in the meantime.
 */
const DELEGATED_RUN_DEFAULT_ANSWER = 'b';

/** Lets another agent delegate a cleaning job to this one over A2A. */
export class CleanerExecutor implements AgentExecutor {
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
      const csvPath = ctx.userMessage.parts
        .map((p) => (p.content?.$case === 'text' ? p.content.value : ''))
        .join('')
        .trim();

      if (!csvPath) throw new Error('Send the path to a CSV file as the message text.');

      status(TaskState.TASK_STATE_WORKING, `cleaning ${csvPath}`);

      const result = await runCleaning({
        csvPath,
        profilerUrl: process.env.PROFILER_URL ?? 'http://localhost:4002',
        outDir: process.env.OUT_DIR ?? 'out',
        onUpdate: (text) => status(TaskState.TASK_STATE_WORKING, text),
        onQuestion: async () => DELEGATED_RUN_DEFAULT_ANSWER,
        automaticAnswer: true,
      });

      status(
        TaskState.TASK_STATE_COMPLETED,
        `${result.narrative}\n(${result.rowsBefore} rows in, ${result.rowsAfter} rows out)`,
      );
    } catch (error) {
      status(TaskState.TASK_STATE_FAILED, error instanceof Error ? error.message : String(error));
    } finally {
      bus.finished();
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
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
