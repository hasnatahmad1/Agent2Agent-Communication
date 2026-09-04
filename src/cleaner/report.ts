import type { CleaningPlan } from '../shared/plan.js';
import type { RuleOutcome } from './apply.js';

export interface ReportInput {
  /** Written by Claude. Prose only — every number below comes from the change log. */
  narrative: string;
  rowsBefore: number;
  rowsAfter: number;
  plan: CleaningPlan | null;
  outcomes: RuleOutcome[];
  humanDecision?: { question: string; answer: string };
}

export function buildReport(input: ReportInput): string {
  const { narrative, rowsBefore, rowsAfter, plan, outcomes, humanDecision } = input;
  const reasons = new Map(plan?.rules.map((r) => [r.id, r.reason]) ?? []);
  const applied = outcomes.filter((o) => !o.skipped);
  const skipped = outcomes.filter((o) => o.skipped);

  const lines: string[] = [
    '# Data Cleaning Report',
    '',
    narrative.trim(),
    '',
    '## Rows',
    '',
    `| | Count |`,
    `|---|---|`,
    `| Before | ${rowsBefore} |`,
    `| After | ${rowsAfter} |`,
    `| Removed | ${rowsBefore - rowsAfter} |`,
    '',
  ];

  if (!plan) {
    lines.push('## Plan', '', 'No cleaning plan was obtained from the Profiler agent.', '');
  } else {
    lines.push('## Plan summary', '', plan.summary.trim(), '');
  }

  lines.push('## Rules applied', '');
  if (applied.length === 0) {
    lines.push('None.', '');
  } else {
    lines.push('| Rule | Action | Column | Rows changed | Rows removed | Reason |');
    lines.push('|---|---|---|---|---|---|');
    for (const o of applied) {
      lines.push(
        `| ${o.ruleId} | ${o.action} | ${o.column ?? '—'} | ${o.rowsChanged} | ${o.rowsRemoved} | ${reasons.get(o.ruleId) ?? '—'} |`,
      );
    }
    lines.push('');
  }

  if (skipped.length > 0) {
    lines.push('## Skipped rules', '');
    lines.push('| Rule | Action | Why |');
    lines.push('|---|---|---|');
    for (const o of skipped) {
      lines.push(`| ${o.ruleId} | ${o.action} | ${o.skipped} |`);
    }
    lines.push('');
  }

  if (humanDecision) {
    lines.push(
      '## Human decision',
      '',
      `The Profiler agent paused in \`input-required\` and asked:`,
      '',
      `> ${humanDecision.question.replace(/\n/g, '\n> ')}`,
      '',
      `Answer given: **${humanDecision.answer}**`,
      '',
    );
  }

  return lines.join('\n');
}
