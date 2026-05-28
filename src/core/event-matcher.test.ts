import { describe, it, expect } from 'vitest';
import { EventMatcher } from './event-matcher';

describe('EventMatcher', () => {
  const matcher = new EventMatcher();

  describe('isMatch - exact matches', () => {
    it('should match when event type is exactly the same', () => {
      expect(matcher.isMatch('order.created', 'order.created')).toBe(true);
      expect(matcher.isMatch('payment.failed', 'payment.failed')).toBe(true);
      expect(matcher.isMatch('user.updated', 'user.updated')).toBe(true);
    });

    it('should not match when event type is different', () => {
      expect(matcher.isMatch('order.created', 'payment.failed')).toBe(false);
      expect(matcher.isMatch('user.updated', 'user.created')).toBe(false);
      expect(matcher.isMatch('order.created', 'order.created.v2')).toBe(false);
    });
  });

  describe('isMatch - wildcard (*) matches', () => {
    it('should match all event types with single wildcard', () => {
      expect(matcher.isMatch('*', 'order.created')).toBe(true);
      expect(matcher.isMatch('*', 'payment.failed')).toBe(true);
      expect(matcher.isMatch('*', 'user.updated')).toBe(true);
      expect(matcher.isMatch('*', 'any.event.type.you.can.think.of')).toBe(true);
    });

    it('should match with prefix wildcard', () => {
      expect(matcher.isMatch('order.*', 'order.created')).toBe(true);
      expect(matcher.isMatch('order.*', 'order.updated')).toBe(true);
      expect(matcher.isMatch('order.*', 'order.cancelled')).toBe(true);
      expect(matcher.isMatch('order.*', 'order.created.v2')).toBe(true);
    });

    it('should match with suffix wildcard', () => {
      expect(matcher.isMatch('*.created', 'order.created')).toBe(true);
      expect(matcher.isMatch('*.created', 'payment.created')).toBe(true);
      expect(matcher.isMatch('*.created', 'user.created')).toBe(true);
    });

    it('should match with middle wildcard', () => {
      expect(matcher.isMatch('order.*.v2', 'order.created.v2')).toBe(true);
      expect(matcher.isMatch('order.*.v2', 'order.updated.v2')).toBe(true);
      expect(matcher.isMatch('order.*.v2', 'order.deleted.v2')).toBe(true);
    });

    it('should match with multiple wildcards', () => {
      expect(matcher.isMatch('*.event.*', 'user.event.created')).toBe(true);
      expect(matcher.isMatch('*.event.*', 'payment.event.failed')).toBe(true);
      expect(matcher.isMatch('*.*.v2', 'order.created.v2')).toBe(true);
    });
  });

  describe('isMatch - wildcard edge cases', () => {
    it('should not match when wildcard pattern does not fit', () => {
      expect(matcher.isMatch('order.*', 'payment.created')).toBe(false);
      expect(matcher.isMatch('*.created', 'order.updated')).toBe(false);
      expect(matcher.isMatch('order.*.v2', 'order.created.v3')).toBe(false);
      expect(matcher.isMatch('order.*.v2', 'order.created')).toBe(false);
    });

    it('should handle special characters in patterns', () => {
      expect(matcher.isMatch('order.*', 'order.updated+test')).toBe(true);
      expect(matcher.isMatch('*', 'special.characters.here!@#$')).toBe(true);
    });
  });

  describe('isMatch - multiple event types (comma-separated)', () => {
    it('should match when at least one type matches', () => {
      expect(matcher.isMatch('order.created, payment.failed', 'order.created')).toBe(true);
      expect(matcher.isMatch('order.created, payment.failed', 'payment.failed')).toBe(true);
    });

    it('should not match when none of the types match', () => {
      expect(matcher.isMatch('order.created, payment.failed', 'user.updated')).toBe(false);
    });

    it('should handle wildcards in comma-separated list', () => {
      expect(matcher.isMatch('order.*, payment.failed', 'order.created')).toBe(true);
      expect(matcher.isMatch('order.*, payment.failed', 'order.updated')).toBe(true);
      expect(matcher.isMatch('order.*, payment.failed', 'payment.failed')).toBe(true);
      expect(matcher.isMatch('order.*, payment.failed', 'payment.created')).toBe(false);
    });

    it('should handle wildcard mixed with exact matches', () => {
      expect(matcher.isMatch('*, order.created', 'any.event')).toBe(true);
      expect(matcher.isMatch('user.*, payment.*', 'user.created')).toBe(true);
      expect(matcher.isMatch('user.*, payment.*', 'payment.failed')).toBe(true);
      expect(matcher.isMatch('user.*, payment.*', 'order.created')).toBe(false);
    });
  });

  describe('isMatch - whitespace handling', () => {
    it('should trim whitespace around event types', () => {
      expect(matcher.isMatch('  order.created  ', 'order.created')).toBe(true);
      expect(matcher.isMatch('order.created,  payment.failed  , user.updated', 'payment.failed')).toBe(true);
      expect(matcher.isMatch('  order.* , payment.*  ', 'order.created')).toBe(true);
    });
  });

  describe('matchEndpoints', () => {
    it('should return only matching endpoint IDs', () => {
      const endpoints = [
        { id: 'ep-1', eventTypes: 'order.*' },
        { id: 'ep-2', eventTypes: 'payment.failed' },
        { id: 'ep-3', eventTypes: '*' },
        { id: 'ep-4', eventTypes: 'user.*' }
      ];

      expect(matcher.matchEndpoints(endpoints, 'order.created')).toEqual(['ep-1', 'ep-3']);
      expect(matcher.matchEndpoints(endpoints, 'payment.failed')).toEqual(['ep-2', 'ep-3']);
      expect(matcher.matchEndpoints(endpoints, 'user.created')).toEqual(['ep-3', 'ep-4']);
      expect(matcher.matchEndpoints(endpoints, 'payment.created')).toEqual(['ep-3']);
    });

    it('should return empty array when no endpoints match', () => {
      const endpoints = [
        { id: 'ep-1', eventTypes: 'order.*' },
        { id: 'ep-2', eventTypes: 'payment.*' }
      ];

      expect(matcher.matchEndpoints(endpoints, 'user.created')).toEqual([]);
    });

    it('should return all endpoint IDs when all match', () => {
      const endpoints = [
        { id: 'ep-1', eventTypes: '*' },
        { id: 'ep-2', eventTypes: '*' },
        { id: 'ep-3', eventTypes: '*' }
      ];

      expect(matcher.matchEndpoints(endpoints, 'any.event')).toEqual(['ep-1', 'ep-2', 'ep-3']);
    });

    it('should handle empty endpoints array', () => {
      expect(matcher.matchEndpoints([], 'order.created')).toEqual([]);
    });
  });

  describe('integration: complex matching scenarios', () => {
    it('should handle complex real-world patterns', () => {
      const testCases = [
        { pattern: 'stripe.*', event: 'stripe.payment_intent.succeeded', expected: true },
        { pattern: 'stripe.*', event: 'stripe.invoice.payment_failed', expected: true },
        { pattern: 'stripe.payment_intent.*', event: 'stripe.payment_intent.succeeded', expected: true },
        { pattern: 'stripe.payment_intent.*', event: 'stripe.invoice.payment_failed', expected: false },
        { pattern: '*.payment_intent.succeeded', event: 'stripe.payment_intent.succeeded', expected: true },
        { pattern: '*.payment_intent.succeeded', event: 'paypal.payment_intent.succeeded', expected: true },
        { pattern: '*.payment_intent.succeeded', event: 'stripe.invoice.payment_failed', expected: false },
        { pattern: 'stripe.*.succeeded', event: 'stripe.payment_intent.succeeded', expected: true },
        { pattern: 'stripe.*.succeeded', event: 'stripe.invoice.payment_succeeded', expected: false },
        { pattern: 'stripe.*.succeeded', event: 'stripe.invoice.payment_failed', expected: false }
      ];

      for (const tc of testCases) {
        expect(matcher.isMatch(tc.pattern, tc.event)).toBe(tc.expected);
      }
    });
  });
});
