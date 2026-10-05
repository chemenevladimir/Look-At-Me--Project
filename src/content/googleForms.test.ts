import { describe, expect, it } from 'vitest';
import { isConfirmedGoogleFormsSubmission, isFreshIntent, isGoogleFormsUrl } from './googleForms';

describe('Google Forms completion detector', () => {
  it('requires the Google Forms origin and formResponse path', () => {
    expect(isGoogleFormsUrl('https://docs.google.com/forms/d/e/abc/viewform')).toBe(true);
    expect(isConfirmedGoogleFormsSubmission(
      'https://docs.google.com/forms/d/e/abc/viewform',
      'Your response has been recorded.',
      false,
      true,
    )).toBe(false);
    expect(isConfirmedGoogleFormsSubmission(
      'https://example.com/forms/formResponse',
      'Your response has been recorded.',
      false,
      true,
    )).toBe(false);
  });

  it('accepts a confirmation page, not a random button click', () => {
    expect(isConfirmedGoogleFormsSubmission(
      'https://docs.google.com/forms/d/e/abc/formResponse',
      'Your response has been recorded.',
      false,
      true,
    )).toBe(true);
    expect(isConfirmedGoogleFormsSubmission(
      'https://docs.google.com/forms/d/e/abc/formResponse',
      'Question 1',
      true,
      false,
    )).toBe(false);
  });

  it('requires a recent submit intent for the same proctoring session', () => {
    const now = 1_000_000;
    expect(isFreshIntent({ sessionId: 'session-a', timestamp: now - 1_000 }, 'session-a', now)).toBe(true);
    expect(isFreshIntent({ sessionId: 'session-b', timestamp: now - 1_000 }, 'session-a', now)).toBe(false);
    expect(isFreshIntent({ sessionId: 'session-a', timestamp: now - 600_000 }, 'session-a', now)).toBe(false);
  });
});
