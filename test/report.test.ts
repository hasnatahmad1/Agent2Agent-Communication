import { describe, it, expect } from 'vitest';
import { buildReport } from '../src/cleaner/report.js';
import type { CleaningPlan } from '../src/shared/plan.js';

const plan: CleaningPlan = {
  summary: 'Normalise cities and clamp marks.',
  rules: [
    { id: 'r1', column: 'city', action: 'normalize', params: {}, reason: 'Variants of one city', severity: 'medium' },
    { id: 'r2', column: 'zzz', action: 'clip', params: {}, reason: 'Range', severity: 'low' },
  ],
};

const report = buildReport({
  narrative: 'The dataset is now consistent.',
  rowsBefore: 400,
  rowsAfter: 383,
  plan,
  outcomes: [
    { ruleId: 'r1', action: 'normalize', column: 'city', rowsChanged: 72, rowsRemoved: 0 },
    { ruleId: 'r2', action: 'clip', column: 'zzz', rowsChanged: 0, rowsRemoved: 0, skipped: 'unknown column "zzz"' },
  ],
  humanDecision: { question: 'How should implausible ages be handled?', answer: 'b' },
});

describe('buildReport', () => {
  it('includes the narrative supplied by Claude', () => {
    expect(report).toContain('The dataset is now consistent.');
  });

  it('reports the row counts from the change log, not from the narrative', () => {
    expect(report).toContain('400');
    expect(report).toContain('383');
    expect(report).toContain('17');
  });

  it('lists each applied rule with its reason and count', () => {
    expect(report).toContain('Variants of one city');
    expect(report).toContain('72');
  });

  it('lists skipped rules in their own section', () => {
    expect(report).toContain('Skipped rules');
    expect(report).toContain('unknown column "zzz"');
  });

  it('records the human decision made at the input-required gate', () => {
    expect(report).toContain('How should implausible ages be handled?');
    expect(report).toContain('b');
  });

  it('works when no plan was obtained', () => {
    const bare = buildReport({
      narrative: 'n', rowsBefore: 10, rowsAfter: 10, plan: null, outcomes: [],
    });
    expect(bare).toContain('No cleaning plan');
  });
});
