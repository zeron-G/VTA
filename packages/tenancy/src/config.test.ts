/**
 * Unit tests for the pure tenancy config defaults + zod default-merge logic.
 *
 * Pure logic only: these exercise `DEFAULT_CONTENT_RULES` and the
 * `contentRulesSchema` default-application directly. They deliberately do NOT
 * call `loadCourseConfig` (which needs a `Db`); the merge semantics under test
 * live entirely in the schema and the default objects.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONTENT_RULES,
  contentRulesSchema,
  DEFAULT_LOCALE_CONFIG,
  localeConfigSchema,
} from './types.js';

describe('DEFAULT_CONTENT_RULES', () => {
  it('has the expected conservative guardrail flags', () => {
    expect(DEFAULT_CONTENT_RULES.refuseGrades).toBe(true);
    expect(DEFAULT_CONTENT_RULES.refuseHomeworkSolutions).toBe(true);
    expect(DEFAULT_CONTENT_RULES.refuseOffTopic).toBe(true);
    expect(DEFAULT_CONTENT_RULES.requireCitations).toBe(true);
    // Phase-1 hard lock: unreleased material can never be surfaced.
    expect(DEFAULT_CONTENT_RULES.allowUnreleasedMaterial).toBe(false);
    // Refusal/redirect messages are present and non-empty.
    expect(DEFAULT_CONTENT_RULES.gradeRedirectMessage.length).toBeGreaterThan(0);
    expect(DEFAULT_CONTENT_RULES.offTopicMessage.length).toBeGreaterThan(0);
  });
});

describe('contentRulesSchema default-merge', () => {
  it('fills every field from defaults when given an empty object', () => {
    const parsed = contentRulesSchema.parse({});
    expect(parsed).toEqual(DEFAULT_CONTENT_RULES);
  });

  it('keeps explicitly-provided fields and defaults only the missing ones', () => {
    const parsed = contentRulesSchema.parse({
      refuseOffTopic: false,
      requireCitations: false,
    });

    // Provided overrides win.
    expect(parsed.refuseOffTopic).toBe(false);
    expect(parsed.requireCitations).toBe(false);
    // Everything else falls back to the conservative defaults.
    expect(parsed.refuseGrades).toBe(DEFAULT_CONTENT_RULES.refuseGrades);
    expect(parsed.refuseHomeworkSolutions).toBe(
      DEFAULT_CONTENT_RULES.refuseHomeworkSolutions,
    );
    expect(parsed.gradeRedirectMessage).toBe(
      DEFAULT_CONTENT_RULES.gradeRedirectMessage,
    );
  });

  it('coerces allowUnreleasedMaterial to the locked-off literal false', () => {
    const parsed = contentRulesSchema.parse({});
    expect(parsed.allowUnreleasedMaterial).toBe(false);
  });

  it('strips unknown keys rather than rejecting them', () => {
    const parsed = contentRulesSchema.parse({ bogusKey: 'ignored' } as unknown);
    expect('bogusKey' in parsed).toBe(false);
    expect(parsed).toEqual(DEFAULT_CONTENT_RULES);
  });
});

describe('localeConfigSchema default-merge', () => {
  it('produces the default locale config from an empty object', () => {
    const parsed = localeConfigSchema.parse({});
    expect(parsed).toEqual(DEFAULT_LOCALE_CONFIG);
  });
});
