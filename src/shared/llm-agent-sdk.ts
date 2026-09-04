import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import type { LLM, LlmRequest } from './llm.js';

const MODEL = process.env.CLAUDE_MODEL ?? 'claude-opus-5';
const SERVER_NAME = 'agent-tools';

/**
 * Drives Claude through the Claude Agent SDK, which authenticates using the
 * machine's existing Claude Code login. No ANTHROPIC_API_KEY is required.
 */
export class AgentSdkLLM implements LLM {
  async run(request: LlmRequest): Promise<string> {
    const sdkTools = (request.tools ?? []).map((t) =>
      tool(t.name, t.description, t.schema, async (args) => {
        const text = await t.handler(args);
        return { content: [{ type: 'text' as const, text }] };
      }),
    );

    const mcpServers = sdkTools.length
      ? {
          [SERVER_NAME]: createSdkMcpServer({
            name: SERVER_NAME,
            version: '1.0.0',
            tools: sdkTools,
          }),
        }
      : undefined;

    const allowedTools = sdkTools.length
      ? (request.tools ?? []).map((t) => `mcp__${SERVER_NAME}__${t.name}`)
      : [];

    const response = query({
      prompt: request.user,
      options: {
        model: MODEL,
        systemPrompt: { type: 'custom', prompt: request.system },
        mcpServers,
        allowedTools,
        // The tools are ours and touch only this project's files.
        permissionMode: 'bypassPermissions',
        // Do not inherit the developer's CLAUDE.md, settings, or plugins.
        settingSources: [],
        maxTurns: request.maxTurns ?? 30,
      },
    });

    let finalText = '';
    for await (const message of response) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text' && block.text.trim()) {
            request.onProgress?.(firstLine(block.text));
          } else if (block.type === 'tool_use') {
            request.onProgress?.(`calling ${String(block.name).split('__').pop()}`);
          }
        }
      } else if (message.type === 'result') {
        if (message.subtype !== 'success') {
          throw new Error(`Claude run failed: ${message.subtype}`);
        }
        finalText = message.result;
      }
    }

    if (!finalText) throw new Error('Claude returned no final result');
    return finalText;
  }
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0];
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
