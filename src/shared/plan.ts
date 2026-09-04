import { z } from 'zod';

/**
 * The closed action set. The rule engine executes nothing outside this list,
 * so a plan — however it was produced — cannot request an arbitrary transformation.
 */
export const ACTIONS = [
  'trim_whitespace',
  'normalize',
  'title_case',
  'clip',
  'coerce_number',
  'parse_date',
  'fill',
  'drop_rows_where',
  'flag_invalid',
  'dedupe',
] as const;

export type Action = (typeof ACTIONS)[number];

export const CleaningRuleSchema = z.object({
  id: z.string().min(1),
  column: z.string().min(1).optional(),
  action: z.enum(ACTIONS),
  params: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high']).default('medium'),
});

export const CleaningPlanSchema = z.object({
  summary: z.string().min(1),
  rules: z.array(CleaningRuleSchema).min(1),
});

export type CleaningRule = z.infer<typeof CleaningRuleSchema>;
export type CleaningPlan = z.infer<typeof CleaningPlanSchema>;

export function parsePlan(
  json: unknown,
): { ok: true; plan: CleaningPlan } | { ok: false; error: string } {
  const result = CleaningPlanSchema.safeParse(json);
  if (result.success) return { ok: true, plan: result.data };
  const error = result.error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return { ok: false, error };
}
