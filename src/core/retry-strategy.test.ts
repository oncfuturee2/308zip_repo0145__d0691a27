import { describe, it, expect } from 'vitest';
import { RetryStrategy, RetryConfig } from './retry-strategy';

describe('RetryStrategy', () => {
  describe('default configuration', () => {
    it('should use default config when none provided', () => {
      const strategy = new RetryStrategy();
      expect(strategy.canRetryByAttempt(0)).toBe(true);
      expect(strategy.canRetryByAttempt(4)).toBe(true);
      expect(strategy.canRetryByAttempt(5)).toBe(false);
    });

    it('should use custom config when provided', () => {
      const customConfig: RetryConfig = {
        maxAttempts: 3,
        baseDelayMs: 2000,
        maxDelayMs: 30000,
        backoffMultiplier: 3
      };

      const strategy = new RetryStrategy(customConfig);
      expect(strategy.canRetryByAttempt(0)).toBe(true);
      expect(strategy.canRetryByAttempt(2)).toBe(true);
      expect(strategy.canRetryByAttempt(3)).toBe(false);
    });
  });

  describe('canRetry - by status code', () => {
    const strategy = new RetryStrategy();

    it('should return true for retryable 4xx status codes', () => {
      expect(strategy.canRetry(408)).toBe(true);
      expect(strategy.canRetry(429)).toBe(true);
    });

    it('should return true for retryable 5xx status codes', () => {
      expect(strategy.canRetry(500)).toBe(true);
      expect(strategy.canRetry(502)).toBe(true);
      expect(strategy.canRetry(503)).toBe(true);
      expect(strategy.canRetry(504)).toBe(true);
    });

    it('should return true for null/undefined/0 status codes (network errors)', () => {
      expect(strategy.canRetry(null)).toBe(true);
      expect(strategy.canRetry(undefined)).toBe(true);
      expect(strategy.canRetry(0)).toBe(true);
    });

    it('should return false for non-retryable 4xx status codes', () => {
      expect(strategy.canRetry(400)).toBe(false);
      expect(strategy.canRetry(401)).toBe(false);
      expect(strategy.canRetry(403)).toBe(false);
      expect(strategy.canRetry(404)).toBe(false);
      expect(strategy.canRetry(405)).toBe(false);
      expect(strategy.canRetry(406)).toBe(false);
      expect(strategy.canRetry(409)).toBe(false);
      expect(strategy.canRetry(410)).toBe(false);
      expect(strategy.canRetry(422)).toBe(false);
    });

    it('should return true for any other 5xx status codes', () => {
      expect(strategy.canRetry(501)).toBe(true);
      expect(strategy.canRetry(505)).toBe(true);
      expect(strategy.canRetry(511)).toBe(true);
      expect(strategy.canRetry(599)).toBe(true);
    });

    it('should return false for 1xx and 2xx status codes (already successful)', () => {
      expect(strategy.canRetry(100)).toBe(false);
      expect(strategy.canRetry(101)).toBe(false);
      expect(strategy.canRetry(200)).toBe(false);
      expect(strategy.canRetry(201)).toBe(false);
      expect(strategy.canRetry(204)).toBe(false);
    });

    it('should return false for 3xx redirect status codes', () => {
      expect(strategy.canRetry(301)).toBe(false);
      expect(strategy.canRetry(302)).toBe(false);
      expect(strategy.canRetry(304)).toBe(false);
    });
  });

  describe('canRetryByAttempt', () => {
    const strategy = new RetryStrategy({
      maxAttempts: 5,
      baseDelayMs: 1000,
      maxDelayMs: 60000,
      backoffMultiplier: 2
    });

    it('should return true when attempts remaining', () => {
      expect(strategy.canRetryByAttempt(0)).toBe(true);
      expect(strategy.canRetryByAttempt(1)).toBe(true);
      expect(strategy.canRetryByAttempt(2)).toBe(true);
      expect(strategy.canRetryByAttempt(3)).toBe(true);
      expect(strategy.canRetryByAttempt(4)).toBe(true);
    });

    it('should return false when max attempts reached', () => {
      expect(strategy.canRetryByAttempt(5)).toBe(false);
      expect(strategy.canRetryByAttempt(6)).toBe(false);
      expect(strategy.canRetryByAttempt(10)).toBe(false);
    });
  });

  describe('getNextDelayMs', () => {
    it('should calculate exponential backoff delay', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2
      });

      expect(strategy.getNextDelayMs(1)).toBe(1000);
      expect(strategy.getNextDelayMs(2)).toBe(2000);
      expect(strategy.getNextDelayMs(3)).toBe(4000);
      expect(strategy.getNextDelayMs(4)).toBe(8000);
      expect(strategy.getNextDelayMs(5)).toBe(16000);
    });

    it('should use different backoff multipliers', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 3
      });

      expect(strategy.getNextDelayMs(1)).toBe(1000);
      expect(strategy.getNextDelayMs(2)).toBe(3000);
      expect(strategy.getNextDelayMs(3)).toBe(9000);
      expect(strategy.getNextDelayMs(4)).toBe(27000);
    });

    it('should cap delay at maxDelayMs', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 10,
        baseDelayMs: 1000,
        maxDelayMs: 10000,
        backoffMultiplier: 2
      });

      expect(strategy.getNextDelayMs(1)).toBe(1000);
      expect(strategy.getNextDelayMs(2)).toBe(2000);
      expect(strategy.getNextDelayMs(3)).toBe(4000);
      expect(strategy.getNextDelayMs(4)).toBe(8000);
      expect(strategy.getNextDelayMs(5)).toBe(10000);
      expect(strategy.getNextDelayMs(6)).toBe(10000);
      expect(strategy.getNextDelayMs(10)).toBe(10000);
    });

    it('should return 0 for attempt number 0 or less', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2
      });

      expect(strategy.getNextDelayMs(0)).toBe(0);
      expect(strategy.getNextDelayMs(-1)).toBe(0);
    });
  });

  describe('getTotalAttemptsAvailable', () => {
    it('should calculate remaining attempts', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2
      });

      expect(strategy.getTotalAttemptsAvailable(0)).toBe(5);
      expect(strategy.getTotalAttemptsAvailable(1)).toBe(4);
      expect(strategy.getTotalAttemptsAvailable(2)).toBe(3);
      expect(strategy.getTotalAttemptsAvailable(3)).toBe(2);
      expect(strategy.getTotalAttemptsAvailable(4)).toBe(1);
    });

    it('should return 0 when attempts exhausted', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2
      });

      expect(strategy.getTotalAttemptsAvailable(5)).toBe(0);
      expect(strategy.getTotalAttemptsAvailable(6)).toBe(0);
      expect(strategy.getTotalAttemptsAvailable(10)).toBe(0);
    });
  });

  describe('isExhausted', () => {
    it('should return false when attempts remaining', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2
      });

      expect(strategy.isExhausted(0)).toBe(false);
      expect(strategy.isExhausted(1)).toBe(false);
      expect(strategy.isExhausted(2)).toBe(false);
      expect(strategy.isExhausted(3)).toBe(false);
      expect(strategy.isExhausted(4)).toBe(false);
    });

    it('should return true when max attempts reached', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2
      });

      expect(strategy.isExhausted(5)).toBe(true);
      expect(strategy.isExhausted(6)).toBe(true);
      expect(strategy.isExhausted(10)).toBe(true);
    });
  });

  describe('integration: full retry workflow', () => {
    it('should support typical retry workflow', () => {
      const strategy = new RetryStrategy({
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 5000,
        backoffMultiplier: 2
      });

      let attemptNumber = 1;
      const statusCodes = [500, 503, 200];

      for (const statusCode of statusCodes) {
        if (strategy.isExhausted(attemptNumber)) {
          break;
        }

        const canRetryStatusCode = strategy.canRetry(statusCode);
        const canRetryAttempt = strategy.canRetryByAttempt(attemptNumber);
        const remaining = strategy.getTotalAttemptsAvailable(attemptNumber);

        if (statusCode === 200) {
          expect(canRetryStatusCode).toBe(false);
          break;
        } else {
          expect(canRetryStatusCode).toBe(true);
          expect(canRetryAttempt).toBe(attemptNumber < 3);
          expect(remaining).toBe(3 - attemptNumber);
        }

        attemptNumber++;
      }

      expect(attemptNumber).toBe(3);
    });
  });
});
