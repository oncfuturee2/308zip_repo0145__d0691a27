import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from './prisma-client';
import { DeliveryService, MaxAttemptsExceededError } from './delivery.service';
import { MockHttpClient, SignatureGenerator, DeliveryExecutor, RetryStrategy } from '../core';

describe('DeliveryService', () => {
  let mockHttpClient: MockHttpClient;
  let signatureGenerator: SignatureGenerator;
  let deliveryExecutor: DeliveryExecutor;
  let retryStrategy: RetryStrategy;
  let deliveryService: DeliveryService;

  beforeEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});

    signatureGenerator = new SignatureGenerator();
    mockHttpClient = new MockHttpClient(1.0, 200, 10);
    deliveryExecutor = new DeliveryExecutor(mockHttpClient, signatureGenerator);
    retryStrategy = new RetryStrategy({
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 60000,
      backoffMultiplier: 2
    });
    deliveryService = new DeliveryService(deliveryExecutor, retryStrategy);
  });

  afterEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  describe('retryDelivery', () => {
    async function createTestAttempt(statusCode: number, isSuccess: boolean) {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      return prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode,
          durationMs: 50,
          isSuccess,
          attemptNumber: 1
        }
      });
    }

    it('should throw error when attemptId does not exist', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      await expect(deliveryService.retryDelivery(nonExistentId)).rejects.toThrow(
        `Delivery attempt not found: ${nonExistentId}`
      );
    });

    it('should throw error when status code is non-retryable (400)', async () => {
      const attempt = await createTestAttempt(400, false);

      await expect(deliveryService.retryDelivery(attempt.id)).rejects.toThrow(
        `Cannot retry delivery with status code: 400`
      );
    });

    it('should throw error when status code is non-retryable (404)', async () => {
      const attempt = await createTestAttempt(404, false);

      await expect(deliveryService.retryDelivery(attempt.id)).rejects.toThrow(
        `Cannot retry delivery with status code: 404`
      );
    });

    it('should throw error when status code is non-retryable (401)', async () => {
      const attempt = await createTestAttempt(401, false);

      await expect(deliveryService.retryDelivery(attempt.id)).rejects.toThrow(
        `Cannot retry delivery with status code: 401`
      );
    });

    it('should throw error when status code is non-retryable (403)', async () => {
      const attempt = await createTestAttempt(403, false);

      await expect(deliveryService.retryDelivery(attempt.id)).rejects.toThrow(
        `Cannot retry delivery with status code: 403`
      );
    });

    it('should throw MaxAttemptsExceededError when max retry attempts reached', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 50,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 50,
          isSuccess: false,
          attemptNumber: 2
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 50,
          isSuccess: false,
          attemptNumber: 3
        }
      });

      const lastAttempt = await prisma.deliveryAttempt.findFirst({
        where: { eventId: event.id, endpointId: endpoint.id },
        orderBy: { attemptNumber: 'desc' }
      });

      await expect(deliveryService.retryDelivery(lastAttempt!.id)).rejects.toThrow(MaxAttemptsExceededError);
    });

    it('should throw MaxAttemptsExceededError with correct message when max attempts exceeded', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      for (let i = 1; i <= 3; i++) {
        await prisma.deliveryAttempt.create({
          data: {
            eventId: event.id,
            endpointId: endpoint.id,
            statusCode: 500,
            durationMs: 50,
            isSuccess: false,
            attemptNumber: i
          }
        });
      }

      const lastAttempt = await prisma.deliveryAttempt.findFirst({
        where: { eventId: event.id, endpointId: endpoint.id },
        orderBy: { attemptNumber: 'desc' }
      });

      try {
        await deliveryService.retryDelivery(lastAttempt!.id);
        expect.fail('Expected MaxAttemptsExceededError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MaxAttemptsExceededError);
        expect((error as MaxAttemptsExceededError).message).toContain(
          `Maximum attempts (3) exceeded for event ${event.id} to endpoint ${endpoint.id}`
        );
        expect((error as MaxAttemptsExceededError).message).toContain('Current attempts: 3');
      }
    });

    it('should successfully retry and create new DeliveryAttempt with incremented attemptNumber', async () => {
      const attempt = await createTestAttempt(500, false);

      const beforeCount = await prisma.deliveryAttempt.count({
        where: { eventId: attempt.eventId, endpointId: attempt.endpointId }
      });
      expect(beforeCount).toBe(1);

      const result = await deliveryService.retryDelivery(attempt.id);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(attempt.eventId);
      expect(result.endpointId).toBe(attempt.endpointId);
      expect(result.attemptNumber).toBe(2);
      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);

      const afterCount = await prisma.deliveryAttempt.count({
        where: { eventId: attempt.eventId, endpointId: attempt.endpointId }
      });
      expect(afterCount).toBe(2);
    });

    it('should correctly increment attemptNumber across multiple retries', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const firstAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 50,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const retryResult1 = await deliveryService.retryDelivery(firstAttempt.id);
      expect(retryResult1.attemptNumber).toBe(2);

      await prisma.deliveryAttempt.update({
        where: { id: retryResult1.id },
        data: { statusCode: 503, isSuccess: false }
      });

      const retryResult2 = await deliveryService.retryDelivery(retryResult1.id);
      expect(retryResult2.attemptNumber).toBe(3);

      const totalAttempts = await prisma.deliveryAttempt.count({
        where: { eventId: event.id, endpointId: endpoint.id }
      });
      expect(totalAttempts).toBe(3);
    });

    it('should retry when status code is retryable 500', async () => {
      const attempt = await createTestAttempt(500, false);

      const result = await deliveryService.retryDelivery(attempt.id);

      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attemptNumber).toBe(2);
    });

    it('should retry when status code is retryable 502', async () => {
      const attempt = await createTestAttempt(502, false);

      const result = await deliveryService.retryDelivery(attempt.id);

      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attemptNumber).toBe(2);
    });

    it('should retry when status code is retryable 503', async () => {
      const attempt = await createTestAttempt(503, false);

      const result = await deliveryService.retryDelivery(attempt.id);

      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attemptNumber).toBe(2);
    });

    it('should retry when status code is retryable 504', async () => {
      const attempt = await createTestAttempt(504, false);

      const result = await deliveryService.retryDelivery(attempt.id);

      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attemptNumber).toBe(2);
    });

    it('should retry when status code is retryable 408', async () => {
      const attempt = await createTestAttempt(408, false);

      const result = await deliveryService.retryDelivery(attempt.id);

      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attemptNumber).toBe(2);
    });

    it('should retry when status code is retryable 429', async () => {
      const attempt = await createTestAttempt(429, false);

      const result = await deliveryService.retryDelivery(attempt.id);

      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attemptNumber).toBe(2);
    });

    it('should retry when status code is null (network error)', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const attempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: null,
          durationMs: 0,
          isSuccess: false,
          errorMessage: 'Network error',
          attemptNumber: 1
        }
      });

      const result = await deliveryService.retryDelivery(attempt.id);

      expect(result.isSuccess).toBe(true);
      expect(result.statusCode).toBe(200);
      expect(result.attemptNumber).toBe(2);
    });

    it('should persist the new attempt record in database with all fields', async () => {
      const attempt = await createTestAttempt(500, false);

      const result = await deliveryService.retryDelivery(attempt.id);

      const persistedAttempt = await prisma.deliveryAttempt.findUnique({
        where: { id: result.id }
      });

      expect(persistedAttempt).not.toBeNull();
      expect(persistedAttempt!.eventId).toBe(attempt.eventId);
      expect(persistedAttempt!.endpointId).toBe(attempt.endpointId);
      expect(persistedAttempt!.statusCode).toBe(200);
      expect(persistedAttempt!.isSuccess).toBe(true);
      expect(persistedAttempt!.attemptNumber).toBe(2);
      expect(persistedAttempt!.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getAttemptCount', () => {
    it('should return 0 when no attempts exist', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const count = await deliveryService.getAttemptCount(event.id, endpoint.id);
      expect(count).toBe(0);
    });

    it('should return correct count of attempts for event and endpoint', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      for (let i = 1; i <= 3; i++) {
        await prisma.deliveryAttempt.create({
          data: {
            eventId: event.id,
            endpointId: endpoint.id,
            statusCode: 500,
            durationMs: 50,
            isSuccess: false,
            attemptNumber: i
          }
        });
      }

      const count = await deliveryService.getAttemptCount(event.id, endpoint.id);
      expect(count).toBe(3);
    });
  });

  describe('canRetryByAttemptCount', () => {
    it('should return true when attempts are below max', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 50,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const canRetry = await deliveryService.canRetryByAttemptCount(event.id, endpoint.id);
      expect(canRetry).toBe(true);
    });

    it('should return false when attempts reach max', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      for (let i = 1; i <= 3; i++) {
        await prisma.deliveryAttempt.create({
          data: {
            eventId: event.id,
            endpointId: endpoint.id,
            statusCode: 500,
            durationMs: 50,
            isSuccess: false,
            attemptNumber: i
          }
        });
      }

      const canRetry = await deliveryService.canRetryByAttemptCount(event.id, endpoint.id);
      expect(canRetry).toBe(false);
    });
  });

  describe('getRemainingAttempts', () => {
    it('should return remaining attempts count', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 50,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const remaining = await deliveryService.getRemainingAttempts(event.id, endpoint.id);
      expect(remaining).toBe(2);
    });

    it('should return 0 when no attempts remaining', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      for (let i = 1; i <= 3; i++) {
        await prisma.deliveryAttempt.create({
          data: {
            eventId: event.id,
            endpointId: endpoint.id,
            statusCode: 500,
            durationMs: 50,
            isSuccess: false,
            attemptNumber: i
          }
        });
      }

      const remaining = await deliveryService.getRemainingAttempts(event.id, endpoint.id);
      expect(remaining).toBe(0);
    });
  });

  describe('isMaxAttemptsReached', () => {
    it('should return false when max attempts not reached', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 50,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const isReached = await deliveryService.isMaxAttemptsReached(event.id, endpoint.id);
      expect(isReached).toBe(false);
    });

    it('should return true when max attempts reached', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      for (let i = 1; i <= 3; i++) {
        await prisma.deliveryAttempt.create({
          data: {
            eventId: event.id,
            endpointId: endpoint.id,
            statusCode: 500,
            durationMs: 50,
            isSuccess: false,
            attemptNumber: i
          }
        });
      }

      const isReached = await deliveryService.isMaxAttemptsReached(event.id, endpoint.id);
      expect(isReached).toBe(true);
    });
  });

  describe('canRetry', () => {
    it('should return true for retryable status code', () => {
      expect(deliveryService.canRetry(500)).toBe(true);
    });

    it('should return false for non-retryable status code', () => {
      expect(deliveryService.canRetry(400)).toBe(false);
    });

    it('should return true for null status code', () => {
      expect(deliveryService.canRetry(null)).toBe(true);
    });
  });

  describe('getNextAttemptNumber', () => {
    it('should return next attempt number', () => {
      expect(deliveryService.getNextAttemptNumber(0)).toBe(1);
      expect(deliveryService.getNextAttemptNumber(1)).toBe(2);
      expect(deliveryService.getNextAttemptNumber(5)).toBe(6);
    });
  });
});
