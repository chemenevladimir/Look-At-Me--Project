import { describe, expect, it } from 'vitest';
import { normalizeSecurityEvent } from './securityEvents';

describe('normalizeSecurityEvent', () => {
  it('accepts allow-listed browser events and clamps untrusted fields', () => {
    expect(normalizeSecurityEvent({
      eventType: 'TAB_SWITCH',
      source: 'system',
      confidence: 5,
      explanation: 'Changed tab',
      metadata: { tabId: 4, nested: { unsafe: true }, title: 'A'.repeat(400) },
    })).toMatchObject({
      type: 'TAB_SWITCH',
      source: 'browser',
      confidence: 1,
      explanation: 'Changed tab',
      metadata: { tabId: 4 },
    });
  });

  it('accepts allow-listed local-agent events as system observations', () => {
    expect(normalizeSecurityEvent({
      eventType: 'ALT_TAB_ATTEMPT',
      source: 'system',
      metadata: { shortcut: 'alt+tab' },
    })).toMatchObject({
      type: 'ALT_TAB_ATTEMPT',
      source: 'system',
      metadata: { shortcut: 'alt+tab' },
    });
  });

  it('preserves system source for clipboard shortcuts observed by the agent', () => {
    expect(normalizeSecurityEvent({ eventType: 'COPY_ATTEMPT', source: 'system' })).toMatchObject({
      type: 'COPY_ATTEMPT',
      source: 'system',
    });
  });

  it('rejects unknown and malformed events', () => {
    expect(normalizeSecurityEvent({ eventType: 'KEY_LOGGED', key: 'secret' })).toBeNull();
    expect(normalizeSecurityEvent('TAB_SWITCH')).toBeNull();
  });
});
