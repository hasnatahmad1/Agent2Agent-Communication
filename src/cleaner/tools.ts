import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { parseCsv, toCsv, type Row } from '../shared/csv.js';
import { computeProfile, type DatasetProfile } from '../shared/profile.js';
import { CleaningRuleSchema, type CleaningPlan, type CleaningRule } from '../shared/plan.js';
import type { LlmTool } from '../shared/llm.js';
import { applyRule, previewRule, type RuleOutcome } from './apply.js';
import { buildReport } from './report.js';
import { askProfiler } from './ask-profiler.js';

export interface CleanSessionOptions {
  profilerUrl: string;
  onUpdate?: (text: string) => void;
  onQuestion?: (question: string) => Promise<string>;
  /** See AskProfilerOptions.automaticAnswer — set when onQuestion answers without a human present. */
  automaticAnswer?: boolean;
}

/**
 * Holds the working dataset and exposes it to Claude as tools. Claude decides
 * which tool to call and in what order; this class only guarantees that each
 * tool is safe and that every change is recorded.
 */
export class CleanSession {
  private headers: string[] = [];
  private rows: Row[] = [];
  private initialRowCount = 0;
  private profile: DatasetProfile | null = null;

  private _plan: CleaningPlan | null = null;
  private _outcomes: RuleOutcome[] = [];
  private _humanDecision?: { question: string; answer: string; automatic?: boolean };

  constructor(private readonly options: CleanSessionOptions) {}

  get plan(): CleaningPlan | null { return this._plan; }
  get outcomes(): RuleOutcome[] { return this._outcomes; }
  get humanDecision() { return this._humanDecision; }
  get rowsBefore(): number { return this.initialRowCount; }
  get rowsAfter(): number { return this.rows.length; }

  private requireLoaded(): void {
    if (this.headers.length === 0) {
      throw new Error('No dataset loaded. Call load_csv first.');
    }
  }

  private validateRule(input: unknown): CleaningRule {
    const parsed = CleaningRuleSchema.safeParse(input);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new Error(`Invalid rule — the action must be one of the allowed set. ${detail}`);
    }
    return parsed.data;
  }

  tools(): LlmTool[] {
    return [
      {
        name: 'load_csv',
        description: 'Load a CSV file into the working dataset. Must be called first.',
        schema: { path: z.string().describe('Path to the CSV file') },
        handler: async ({ path }) => {
          const parsed = parseCsv(readFileSync(path, 'utf8'));
          this.headers = parsed.headers;
          this.rows = parsed.rows;
          this.initialRowCount = parsed.rows.length;
          // A loaded dataset starts a new run — clear everything recorded
          // against whatever was loaded before, or the report's numbers and
          // its rule list would describe two different datasets.
          this.profile = null;
          this._plan = null;
          this._outcomes = [];
          this._humanDecision = undefined;
          return `Loaded ${parsed.rows.length} rows with columns: ${parsed.headers.join(', ')}`;
        },
      },
      {
        name: 'profile_columns',
        description:
          'Compute a statistical profile of the loaded dataset: per-column types, missing counts, distinct values, ranges, and 15 sample rows.',
        schema: {},
        handler: async () => {
          this.requireLoaded();
          this.profile = computeProfile(this.headers, this.rows);
          return JSON.stringify(this.profile);
        },
      },
      {
        name: 'ask_profiler',
        description:
          'Ask the specialist Profiler agent, over the A2A protocol, for a cleaning plan based on the computed profile. Returns the plan as JSON.',
        schema: {},
        handler: async () => {
          this.requireLoaded();
          if (!this.profile) this.profile = computeProfile(this.headers, this.rows);

          const result = await askProfiler({
            profilerUrl: this.options.profilerUrl,
            profile: this.profile,
            onUpdate: (t) => this.options.onUpdate?.(`[profiler] ${t}`),
            onQuestion: this.options.onQuestion,
            automaticAnswer: this.options.automaticAnswer,
          });

          this._plan = result.plan;
          this._humanDecision = result.humanDecision;
          return JSON.stringify(result.plan);
        },
      },
      {
        name: 'preview_changes',
        description:
          'Show how many rows a rule would change, with up to 5 before/after examples. Does not modify the dataset.',
        // z.record(...) here breaks MCP tool discovery entirely (the whole
        // server's tool list comes back empty) when converted to a JSON
        // schema for the CLI subprocess. z.object({}).passthrough() accepts
        // the same free-form object shape and survives that conversion.
        schema: { rule: z.object({}).passthrough().describe('A single cleaning rule') },
        handler: async ({ rule }) => {
          this.requireLoaded();
          const validated = this.validateRule(rule);
          const preview = previewRule(this.headers, this.rows, validated);
          const examples = preview.examples
            .map((e) => `  "${e.before}" -> "${e.after}"`)
            .join('\n');
          return `${preview.rowsAffected} rows of ${this.rows.length} would change.\n${examples}`;
        },
      },
      {
        name: 'apply_rule',
        description: 'Apply one cleaning rule to the working dataset.',
        // z.record(...) here breaks MCP tool discovery entirely (the whole
        // server's tool list comes back empty) when converted to a JSON
        // schema for the CLI subprocess. z.object({}).passthrough() accepts
        // the same free-form object shape and survives that conversion.
        schema: { rule: z.object({}).passthrough().describe('A single cleaning rule') },
        handler: async ({ rule }) => {
          this.requireLoaded();
          const validated = this.validateRule(rule);
          return this.runRule(validated);
        },
      },
      {
        name: 'apply_plan',
        description:
          'Apply every rule from the plan returned by ask_profiler, in order. Use this instead of calling apply_rule once per rule.',
        schema: {},
        handler: async () => {
          this.requireLoaded();
          if (!this._plan) throw new Error('No plan available. Call ask_profiler first.');
          const lines = this._plan.rules.map((rule) => this.runRule(rule));
          return `Applied ${this._plan.rules.length} rules.\n${lines.join('\n')}`;
        },
      },
      {
        name: 'save_csv',
        description: 'Write the cleaned dataset to a CSV file.',
        schema: { path: z.string().describe('Output path, e.g. out/cleaned.csv') },
        handler: async ({ path }) => {
          this.requireLoaded();
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, toCsv(this.headers, this.rows), 'utf8');
          return `Wrote ${this.rows.length} rows to ${path}`;
        },
      },
      {
        name: 'write_report',
        description:
          'Write out/report.md. Supply a short narrative paragraph; every number in the report is filled in from the recorded change log, not from your summary.',
        schema: {
          summary: z.string().describe('One short paragraph describing what was cleaned'),
          path: z.string().optional().describe('Output path, default out/report.md'),
        },
        handler: async ({ summary, path }) => {
          this.requireLoaded();
          const target = path ?? 'out/report.md';
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(
            target,
            buildReport({
              narrative: summary,
              rowsBefore: this.initialRowCount,
              rowsAfter: this.rows.length,
              plan: this._plan,
              outcomes: this._outcomes,
              humanDecision: this._humanDecision,
            }),
            'utf8',
          );
          return `Wrote ${target}`;
        },
      },
    ];
  }

  private runRule(rule: CleaningRule): string {
    const result = applyRule(this.headers, this.rows, rule);
    this.headers = result.headers;
    this.rows = result.rows;
    this._outcomes.push(result.outcome);

    if (result.outcome.skipped) return `  ${rule.id} skipped: ${result.outcome.skipped}`;
    return `  ${rule.id} (${rule.action}): ${result.outcome.rowsChanged} changed, ${result.outcome.rowsRemoved} removed`;
  }
}
