import { ACTIONS } from '../shared/plan.js';
import type { DatasetProfile } from '../shared/profile.js';

export const AMBIGUITY_QUESTION = [
  'The age column contains values outside the plausible range 5-100.',
  'How should these rows be handled?',
  '  (a) drop those rows',
  '  (b) replace with the column median',
  '  (c) leave as-is and flag them in the report',
].join('\n');

/** Returns true when the profile contains a defect the agent must not resolve alone. */
export function needsHumanDecision(profile: DatasetProfile): boolean {
  const age = profile.columns.find((c) => c.name === 'age');
  if (!age || age.inferredType !== 'number') return false;
  return (age.min !== undefined && age.min < 5) || (age.max !== undefined && age.max > 100);
}

export const SYSTEM_PROMPT = `You are a data quality expert.

You receive a statistical profile of a CSV dataset — never the raw rows. Identify the
data quality problems it reveals and propose a cleaning rule for each one.

Reply with JSON only. No prose, no markdown fence. The shape is:

{
  "summary": "one paragraph in plain English",
  "rules": [
    {
      "id": "r1",
      "column": "<column name, omit for row-scoped rules>",
      "action": "<one of the allowed actions>",
      "params": { },
      "reason": "<why this rule is needed, for a human reader>",
      "severity": "low" | "medium" | "high"
    }
  ]
}

The allowed actions are exactly: ${ACTIONS.join(', ')}.
Using any other action is an error.

Rules:
- Only reference columns that appear in the profile. Never invent one.
- Every rule needs a reason a human can read.
- "normalize" takes params.map — an explicit mapping of the exact variant strings
  found in the profile to their canonical value.
- "clip" takes params.min and params.max.
- "coerce_number" may take params.wordMap, e.g. {"twenty": 20}.
- "parse_date" takes params.targetFormat, always "YYYY-MM-DD".
- "fill" takes params.strategy ("median" | "mode" | "constant") and params.value for constant.
- "flag_invalid" takes params.pattern, a JavaScript regular expression source string.
- "dedupe" is row-scoped: omit "column", pass params.keys (array) and params.keep ("first" | "last").
- "drop_rows_where" takes params.predicate, e.g. {"op": "lt", "value": 0}.`;

export function buildUserPrompt(profile: DatasetProfile, humanAnswer?: string): string {
  const parts = [
    'Here is the column profile of the dataset:',
    '',
    JSON.stringify(profile, null, 2),
  ];

  if (humanAnswer) {
    parts.push(
      '',
      'The human operator was asked:',
      '',
      AMBIGUITY_QUESTION,
      '',
      `They answered: ${humanAnswer}`,
      '',
      'Your plan must follow that decision.',
    );
  }

  return parts.join('\n');
}
