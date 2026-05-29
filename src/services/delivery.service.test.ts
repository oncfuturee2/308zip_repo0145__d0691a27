import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from './prisma-client';
import { DeliveryService, MaxAttemptsExceededError } from './delivery.service';
import { DeliveryExecutor, MockHttpClient, RetryStrategy, SignatureGenerator } from '../core';

describe('DeliveryService', () => {
  let signatureGenerator: SignatureGenerator;
  let mockHttpClient: MockHttpClient;
  let deliveryExecutor: DeliveryExecutor;
  let retryStrategy: RetryStrategy;
  let deliveryService: DeliveryService;

  beforeEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});

    signatureGenerator = new SignatureGenerator();
    mockHttpClient = new MockHttpClient(1.0, 200, 5);
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

  describe('executeDelivery', () => {
    it('should execute delivery and record a successful attempt', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const attempt = await deliveryService.executeDelivery(event, endpoint, 1);

      expect(attempt).toBeDefined();
      expect(attempt.eventId).toBe(event.id);
      expect(attempt.endpointId).toBe(endpoint.id);
      expect(attempt.attemptNumber).toBe(1);
      expect(attempt.statusCode).toBe(200);
      expect(attempt.isSuccess).toBe(true);

      const dbAttempt = await prisma.deliveryAttempt.findUnique({
        where: { id: attempt.id }
      });
      expect(dbAttempt).not.toBeNull();
    });

    it('should execute delivery and record a failed attempt', async () => {
      mockHttpClient.forceError(500, 'Internal Server Error');

      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const attempt = await deliveryService.executeDelivery(event, endpoint, 1);

      expect(attempt.statusCode).toBe(500);
      expect(attempt.isSuccess).toBe(false);
      expect(attempt.errorMessage).toBe('Internal Server Error');
      expect(attempt.attemptNumber).toBe(1);
    });

    it('should record attempt with incrementing attempt numbers', async () => {
      mockHttpClient.forceError(500, 'Error');

      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const attempt1 = await deliveryService.executeDelivery(event, endpoint, 1);
      expect(attempt1.attemptNumber).toBe(1);

      const attempt2 = await deliveryService.executeDelivery(event, endpoint, 2);
      expect(attempt2.attemptNumber).toBe(2);

      const count = await deliveryService.getAttemptCount(event.id, endpoint.id);
      expect(count).toBe(2);
    });
  });

  describe('recordAttempt', () => {
    it('should create a delivery attempt record in the database', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const result = {
        statusCode: 200,
        durationMs: 50,
        isSuccess: true
      };

      const attempt = await deliveryService.recordAttempt(
        event.id,
        endpoint.id,
        result,
        1
      );

      expect(attempt.id).toBeDefined();
      expect(attempt.eventId).toBe(event.id);
      expect(attempt.endpointId).toBe(endpoint.id);
      expect(attempt.statusCode).toBe(200);
      expect(attempt.durationMs).toBe(50);
      expect(attempt.isSuccess).toBe(true);
      expect(attempt.attemptNumber).toBe(1);
      expect(attempt.errorMessage).toBeNull();

      const dbCount = await prisma.deliveryAttempt.count();
      expect(dbCount).toBe(1);
    });

    it('should record attempt with error details', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const result = {
        statusCode: 503,
        durationMs: 1000,
        isSuccess: false,
        errorMessage: 'Service Unavailable'
      };

      const attempt = await deliveryService.recordAttempt(
        event.id,
        endpoint.id,
        result,
        3
      );

      expect(attempt.isSuccess).toBe(false);
      expect(attempt.statusCode).toBe(503);
      expect(attempt.durationMs).toBe(1000);
      expect(attempt.errorMessage).toBe('Service Unavailable');
      expect(attempt.attemptNumber).toBe(3);
    });
  });

  describe('getAttemptCount', () => {
    it('should return 0 when no attempts exist', async () => {
      const count = await deliveryService.getAttemptCount('non-existent-event', 'non-existent-endpoint');
      expect(count).toBe(0);
    });

    it('should return correct count of attempts', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 150,
          isSuccess: false,
          attemptNumber: 2
        }
      });

      const count = await deliveryService.getAttemptCount(event.id, endpoint.id);
      expect(count).toBe(2);
    });
  });

  describe('canRetryByAttemptCount', () => {
    it('should return true when attempt count is below maxAttempts', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const canRetry = await deliveryService.canRetryByAttemptCount(event.id, endpoint.id);
      expect(canRetry).toBe(true);
    });

    it('should return false when attempt count reaches maxAttempts', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
            durationMs: 100,
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
    it('should return max attempts when no attempts exist', async () => {
      const remaining = await deliveryService.getRemainingAttempts('non-existent-event', 'non-existent-endpoint');
      expect(remaining).toBe(3);
    });

    it('should return remaining attempts count', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const remaining = await deliveryService.getRemainingAttempts(event.id, endpoint.id);
      expect(remaining).toBe(2);
    });
  });

  describe('isMaxAttemptsReached', () => {
    it('should return false when max attempts not reached', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          durationMs: 100,
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
          secret: 'test-secret',
          eventTypes: 'order.created'
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
            durationMs: 100,
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
    it('should delegate to retryStrategy for status code check', () => {
      expect(deliveryService.canRetry(500)).toBe(true);
      expect(deliveryService.canRetry(503)).toBe(true);
      expect(deliveryService.canRetry(400)).toBe(false);
      expect(deliveryService.canRetry(404)).toBe(false);
      expect(deliveryService.canRetry(200)).toBe(false);
      expect(deliveryService.canRetry(null)).toBe(true);
      expect(deliveryService.canRetry(undefined)).toBe(true);
      expect(deliveryService.canRetry(0)).toBe(true);
    });
  });

  describe('getNextAttemptNumber', () => {
    it('should return next attempt number', () => {
      expect(deliveryService.getNextAttemptNumber(0)).toBe(1);
      expect(deliveryService.getNextAttemptNumber(1)).toBe(2);
      expect(deliveryService.getNextAttemptNumber(5)).toBe(6);
    });
  });

  describe('findByEndpointId', () => {
    it('should return empty array when no attempts exist for endpoint', async () => {
      const results = await deliveryService.findByEndpointId('non-existent');
      expect(results).toEqual([]);
    });

    it('should return attempts for a specific endpoint', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          statusCode: 200,
          durationMs: 50,
          isSuccess: true,
          attemptNumber: 1
        }
      });

      const results = await deliveryService.findByEndpointId(endpoint.id);
      expect(results.length).toBe(1);
      expect(results[0].endpointId).toBe(endpoint.id);
      expect(results[0].event).toBeDefined();
      expect(results[0].endpoint).toBeDefined();
    });
  });

  describe('findByEventId', () => {
    it('should return attempts for a specific event', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          statusCode: 200,
          durationMs: 50,
          isSuccess: true,
          attemptNumber: 1
        }
      });

      const results = await deliveryService.findByEventId(event.id);
      expect(results.length).toBe(1);
      expect(results[0].eventId).toBe(event.id);
      expect(results[0].event).toBeDefined();
      expect(results[0].endpoint).toBeDefined();
    });
  });

  describe('findById', () => {
    it('should return null for non-existent attempt', async () => {
      const result = await deliveryService.findById('non-existent-id');
      expect(result).toBeNull();
    });

    it('should return attempt with details', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const created = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 200,
          durationMs: 50,
          isSuccess: true,
          attemptNumber: 1
        }
      });

      const result = await deliveryService.findById(created.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(created.id);
      expect(result!.event).toBeDefined();
      expect(result!.endpoint).toBeDefined();
    });
  });

  describe('findAll', () => {
    it('should return empty array when no attempts exist', async () => {
      const results = await deliveryService.findAll();
      expect(results).toEqual([]);
    });

    it('should return all attempts with details', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          statusCode: 200,
          durationMs: 50,
          isSuccess: true,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 2
        }
      });

      const results = await deliveryService.findAll();
      expect(results.length).toBe(2);
      expect(results[0].event).toBeDefined();
      expect(results[0].endpoint).toBeDefined();
    });
  });

  describe('findFailedAttempts', () => {
    it('should return empty array when no failed attempts exist', async () => {
      const results = await deliveryService.findFailedAttempts();
      expect(results).toEqual([]);
    });

    it('should return only failed attempts', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          statusCode: 200,
          durationMs: 50,
          isSuccess: true,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 2
        }
      });

      const results = await deliveryService.findFailedAttempts();
      expect(results.length).toBe(1);
      expect(results[0].isSuccess).toBe(false);
    });

    it('should filter failed attempts by endpointId', async () => {
      const endpoint1 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret1',
          eventTypes: 'order.created'
        }
      });

      const endpoint2 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook2',
          secret: 'secret2',
          eventTypes: 'order.created'
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
          endpointId: endpoint1.id,
          statusCode: 500,
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint2.id,
          statusCode: 503,
          durationMs: 200,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const results = await deliveryService.findFailedAttempts(endpoint1.id);
      expect(results.length).toBe(1);
      expect(results[0].endpointId).toBe(endpoint1.id);
    });
  });

  describe('retryDelivery', () => {
    it('should throw error when attemptId does not exist', async () => {
      await expect(
        deliveryService.retryDelivery('00000000-0000-0000-0000-000000000000')
      ).rejects.toThrow('Delivery attempt not found');
    });

    it('should throw error when status code is not retryable (400 Bad Request)', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const existingAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 400,
          durationMs: 50,
          isSuccess: false,
          errorMessage: 'Bad Request',
          attemptNumber: 1
        }
      });

      await expect(
        deliveryService.retryDelivery(existingAttempt.id)
      ).rejects.toThrow('Cannot retry delivery with status code: 400');
    });

    it('should throw MaxAttemptsExceededError when max attempts reached', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          statusCode: 503,
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 503,
          durationMs: 120,
          isSuccess: false,
          attemptNumber: 2
        }
      });

      const existingAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 503,
          durationMs: 150,
          isSuccess: false,
          attemptNumber: 3
        }
      });

      await expect(
        deliveryService.retryDelivery(existingAttempt.id)
      ).rejects.toThrow(MaxAttemptsExceededError);

      try {
        await deliveryService.retryDelivery(existingAttempt.id);
      } catch (error) {
        expect(error).toBeInstanceOf(MaxAttemptsExceededError);
        expect((error as MaxAttemptsExceededError).name).toBe('MaxAttemptsExceededError');
        expect((error as MaxAttemptsExceededError).message).toContain('Maximum attempts (3) exceeded');
      }
    });

    it('should successfully retry and create a new attempt with incremented attemptNumber', async () => {
      mockHttpClient.forceError(500, 'Internal Server Error');

      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const existingAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 100,
          isSuccess: false,
          errorMessage: 'Internal Server Error',
          attemptNumber: 1
        }
      });

      const attemptCountBeforeRetry = await deliveryService.getAttemptCount(
        event.id,
        endpoint.id
      );
      expect(attemptCountBeforeRetry).toBe(1);

      mockHttpClient.clearForcedError();

      const retriedAttempt = await deliveryService.retryDelivery(existingAttempt.id);

      expect(retriedAttempt).toBeDefined();
      expect(retriedAttempt.attemptNumber).toBe(2);
      expect(retriedAttempt.eventId).toBe(event.id);
      expect(retriedAttempt.endpointId).toBe(endpoint.id);
      expect(retriedAttempt.statusCode).toBe(200);
      expect(retriedAttempt.isSuccess).toBe(true);

      const attemptCountAfterRetry = await deliveryService.getAttemptCount(
        event.id,
        endpoint.id
      );
      expect(attemptCountAfterRetry).toBe(2);

      const dbAttempt = await prisma.deliveryAttempt.findUnique({
        where: { id: retriedAttempt.id }
      });
      expect(dbAttempt).not.toBeNull();
      expect(dbAttempt!.attemptNumber).toBe(2);
    });

    it('should correctly increment attemptNumber to 3 on second retry', async () => {
      mockHttpClient.forceError(502, 'Bad Gateway');

      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
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
          statusCode: 503,
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const existingAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 502,
          durationMs: 120,
          isSuccess: false,
          attemptNumber: 2
        }
      });

      mockHttpClient.clearForcedError();

      const retriedAttempt = await deliveryService.retryDelivery(existingAttempt.id);

      expect(retriedAttempt.attemptNumber).toBe(3);

      const attemptCount = await deliveryService.getAttemptCount(
        event.id,
        endpoint.id
      );
      expect(attemptCount).toBe(3);

      const allAttempts = await prisma.deliveryAttempt.findMany({
        where: { eventId: event.id, endpointId: endpoint.id },
        orderBy: { attemptNumber: 'asc' }
      });
      expect(allAttempts.map(a => a.attemptNumber)).toEqual([1, 2, 3]);
    });

    it('should throw MaxAttemptsExceededError with correct maxAttempts from custom retry config', async () => {
      const customRetryStrategy = new RetryStrategy({
        maxAttempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 60000,
        backoffMultiplier: 2
      });
      const customDeliveryService = new DeliveryService(deliveryExecutor, customRetryStrategy);

      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      for (let i = 1; i <= 5; i++) {
        await prisma.deliveryAttempt.create({
          data: {
            eventId: event.id,
            endpointId: endpoint.id,
            statusCode: 503,
            durationMs: 100,
            isSuccess: false,
            attemptNumber: i
          }
        });
      }

      const existingAttempt = await prisma.deliveryAttempt.findFirst({
        where: { eventId: event.id, endpointId: endpoint.id },
        orderBy: { attemptNumber: 'desc' }
      });

      try {
        await customDeliveryService.retryDelivery(existingAttempt!.id);
        expect.unreachable('Expected MaxAttemptsExceededError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(MaxAttemptsExceededError);
        expect((error as MaxAttemptsExceededError).message).toContain('Maximum attempts (5) exceeded');
      }
    });

    it('should verify the new attempt is persisted in the database with correct fields', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'order.created'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const existingAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 503,
          durationMs: 100,
          isSuccess: false,
          attemptNumber: 1
        }
      });

      const retriedAttempt = await deliveryService.retryDelivery(existingAttempt.id);

      const persistedAttempt = await prisma.deliveryAttempt.findUnique({
        where: { id: retriedAttempt.id }
      });
      expect(persistedAttempt).not.toBeNull();
      expect(persistedAttempt!.eventId).toBe(event.id);
      expect(persistedAttempt!.endpointId).toBe(endpoint.id);
      expect(persistedAttempt!.attemptNumber).toBe(2);
      expect(persistedAttempt!.statusCode).toBe(200);
      expect(persistedAttempt!.isSuccess).toBe(true);
      expect(persistedAttempt!.id).not.toBe(existingAttempt.id);
      expect(persistedAttempt!.createdAt).toBeDefined();
    });
  });
});