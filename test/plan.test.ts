import { describe, it, expect } from 'vitest';
import { parsePlan, ACTIONS } from '../src/shared/plan.js';

const validPlan = {
  summary: 'Normalise city names and clamp marks.',
  rules: [
    {
      id: 'r1',
      column: 'city',
      action: 'normalize',
      params: { map: { lahore: 'Lahore', LHR: 'Lahore' } },
      reason: 'Same city written several ways',
      severity: 'medium',
    },
    {
      id: 'r2',
      action: 'dedupe',
      params: { keys: ['roll_no'], keep: 'first' },
      reason: 'roll_no must be unique',
      severity: 'high',
    },
  ],
};

describe('ACTIONS', () => {
  it('is a closed set of exactly 10 actions', () => {
    expect(ACTIONS).toHaveLength(10);
    expect(ACTIONS).toContain('normalize');
    expect(ACTIONS).toContain('dedupe');
  });
});

describe('parsePlan', () => {
  it('accepts a valid plan', () => {
    const result = parsePlan(validPlan);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.rules).toHaveLength(2);
  });

  it('rejects an action outside the closed set', () => {
    const bad = { ...validPlan, rules: [{ ...validPlan.rules[0], action: 'run_shell' }] };
    const result = parsePlan(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('action');
  });

  it('rejects a rule with no reason', () => {
    const rule = { ...validPlan.rules[0] } as Record<string, unknown>;
    delete rule.reason;
    const result = parsePlan({ ...validPlan, rules: [rule] });
    expect(result.ok).toBe(false);
  });

  it('rejects a plan with no rules', () => {
    expect(parsePlan({ summary: 'x', rules: [] }).ok).toBe(false);
  });

  it('rejects non-object input without throwing', () => {
    expect(parsePlan('not a plan').ok).toBe(false);
  });

  it('defaults severity to medium when omitted', () => {
    const rule = { ...validPlan.rules[0] } as Record<string, unknown>;
    delete rule.severity;
    const result = parsePlan({ ...validPlan, rules: [rule] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.rules[0].severity).toBe('medium');
  });
});
