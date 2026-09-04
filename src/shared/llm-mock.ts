import type { LLM, LlmRequest } from './llm.js';

export interface MockScript {
  finalText: string;
  toolCalls?: { name: string; args: any }[];
}

/**
 * Placeholders the cleaner script uses instead of hardcoded paths. They are
 * resolved from the prompt at run time, so a test using a temporary output
 * directory gets its files where it expects them.
 */
const PATH_PATTERNS: Record<string, RegExp> = {
  '{{csvPath}}': /Clean the dataset at (.+?)\.?$/m,
  '{{cleanedPath}}': /Save the cleaned CSV to (.+?)\.?$/m,
  '{{reportPath}}': /Write the report to (.+?)\.?$/m,
};

function resolvePlaceholders(args: any, prompt: string): any {
  if (typeof args !== 'object' || args === null) return args;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === 'string' && value in PATH_PATTERNS) {
      const match = PATH_PATTERNS[value].exec(prompt);
      if (!match) throw new Error(`MockLLM: could not resolve ${value} from the prompt`);
      out[key] = match[1].trim();
    } else {
      out[key] = value;
    }
  }
  return out;
}

export class MockLLM implements LLM {
  constructor(private readonly script: MockScript) {}

  async run(request: LlmRequest): Promise<string> {
    const tools = new Map((request.tools ?? []).map((t) => [t.name, t]));

    for (const call of this.script.toolCalls ?? []) {
      const tool = tools.get(call.name);
      if (!tool) {
        throw new Error(`MockLLM: scripted tool "${call.name}" is not registered`);
      }
      request.onProgress?.(`calling ${call.name}`);
      await tool.handler(resolvePlaceholders(call.args, request.user));
    }

    request.onProgress?.('writing final answer');
    return this.script.finalText;
  }
}

/** The default script each agent's mock follows. */
export function mockScriptFor(role: 'profiler' | 'cleaner'): MockScript {
  if (role === 'profiler') {
    return { finalText: JSON.stringify(MOCK_PLAN) };
  }
  return {
    finalText: 'Cleaned the dataset using the plan from the Profiler agent.',
    toolCalls: [
      { name: 'load_csv', args: { path: '{{csvPath}}' } },
      { name: 'profile_columns', args: {} },
      { name: 'ask_profiler', args: {} },
      { name: 'apply_plan', args: {} },
      { name: 'save_csv', args: { path: '{{cleanedPath}}' } },
      {
        name: 'write_report',
        args: { summary: 'Cleaned with the Profiler plan.', path: '{{reportPath}}' },
      },
    ],
  };
}

/** The plan the mocked Profiler returns. Mirrors what Claude produces for this dataset. */
export const MOCK_PLAN = {
  summary: 'Normalise city spellings and names, unify dates, and bound numeric ranges.',
  rules: [
    { id: 'r1', column: 'name', action: 'trim_whitespace', params: {}, reason: 'Stray leading and trailing spaces', severity: 'low' },
    { id: 'r2', column: 'name', action: 'title_case', params: {}, reason: 'Mixed upper and lower case', severity: 'low' },
    { id: 'r3', column: 'city', action: 'trim_whitespace', params: {}, reason: 'Padded values such as " Lahore "', severity: 'low' },
    {
      id: 'r4', column: 'city', action: 'normalize',
      params: { map: { lahore: 'Lahore', LHR: 'Lahore', khi: 'Karachi', karachi: 'Karachi', ISB: 'Islamabad' } },
      reason: 'One city written several ways', severity: 'medium',
    },
    { id: 'r5', column: 'age', action: 'coerce_number', params: { wordMap: { twenty: 20 } }, reason: 'Ages written as words', severity: 'medium' },
    { id: 'r6', column: 'age', action: 'fill', params: { strategy: 'median' }, reason: 'Missing ages, imputed per the human decision', severity: 'medium' },
    { id: 'r7', column: 'marks', action: 'clip', params: { min: 0, max: 100 }, reason: 'Marks must lie between 0 and 100', severity: 'high' },
    { id: 'r8', column: 'enrolled_date', action: 'parse_date', params: { targetFormat: 'YYYY-MM-DD' }, reason: 'Three different date formats', severity: 'medium' },
    { id: 'r9', column: 'email', action: 'flag_invalid', params: { pattern: '^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$' }, reason: 'Malformed addresses are flagged, not deleted', severity: 'low' },
    { id: 'r10', action: 'dedupe', params: { keys: ['roll_no'], keep: 'first' }, reason: 'roll_no must be unique', severity: 'high' },
  ],
};
