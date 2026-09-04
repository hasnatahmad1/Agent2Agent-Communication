import type { z } from 'zod';
import { MockLLM, mockScriptFor } from './llm-mock.js';
import { AgentSdkLLM } from './llm-agent-sdk.js';

export interface LlmTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: any) => Promise<string>;
}

export interface LlmRequest {
  system: string;
  user: string;
  tools?: LlmTool[];
  maxTurns?: number;
  /** Called with short human-readable progress lines as the model works. */
  onProgress?: (text: string) => void;
}

export interface LLM {
  run(request: LlmRequest): Promise<string>;
}

/**
 * Chooses the backend. `USE_MOCK=1` selects the deterministic mock — used by
 * every test and by development runs, so the protocol can be exercised without
 * consuming Claude quota.
 */
export function getLLM(role: 'profiler' | 'cleaner'): LLM {
  return process.env.USE_MOCK === '1'
    ? new MockLLM(mockScriptFor(role))
    : new AgentSdkLLM();
}
