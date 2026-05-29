import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from './prisma-client';
import { DeliveryService, MaxAttemptsExceededError } from './delivery.service';
import { 
  DeliveryExecutor, 
  MockHttpClient, 
  SignatureGenerator, 
  RetryStrategy 
} from '../core';

describe('DeliveryService', () => {
  let deliveryService: DeliveryService;
  let mockHttpClient: MockHttpClient;
  let signatureGenerator: SignatureGenerator;
  let deliveryExecutor: DeliveryExecutor;
  let retryStrategy: RetryStrategy;

  beforeEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});

    mockHttpClient = new MockHttpClient(1.0, 200, 0);
    signatureGenerator = new SignatureGenerator();
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
    it('should throw error when attemptId does not exist', async () => {
      const nonExistentId = 'non-existent-id-12345';

      await expect(deliveryService.retryDelivery(nonExistentId)).rejects.toThrow(
        `Delivery attempt not found: ${nonExistentId}`
      );
    });

    it('should throw error when status code is not retryable (e.g., 400)', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'test.event',
          payload: JSON.stringify({ test: 'data' })
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

      await expect(deliveryService.retryDelivery(existingAttempt.id)).rejects.toThrow(
        'Cannot retry delivery with status code: 400'
      );
    });

    it('should throw MaxAttemptsExceededError when max attempts reached', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'test.event',
          payload: JSON.stringify({ test: 'data' })
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
            errorMessage: 'Internal Server Error',
            attemptNumber: i
          }
        });
      }

      const existingAttempt = await prisma.deliveryAttempt.findFirst({
        where: { eventId: event.id, endpointId: endpoint.id }
      });

      await expect(deliveryService.retryDelivery(existingAttempt!.id)).rejects.toThrow(
        MaxAttemptsExceededError
      );
    });

    it('should successfully retry delivery when all conditions are met', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'test.event',
          payload: JSON.stringify({ test: 'data' })
        }
      });

      const existingAttempt = await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: 500,
          durationMs: 50,
          isSuccess: false,
          errorMessage: 'Internal Server Error',
          attemptNumber: 1
        }
      });

      const result = await deliveryService.retryDelivery(existingAttempt.id);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(event.id);
      expect(result.endpointId).toBe(endpoint.id);
      expect(result.attemptNumber).toBe(2);
      expect(result.statusCode).toBe(200);
      expect(result.isSuccess).toBe(true);

      const attempts = await prisma.deliveryAttempt.findMany({
        where: { eventId: event.id, endpointId: endpoint.id },
        orderBy: { attemptNumber: 'asc' }
      });

      expect(attempts.length).toBe(2);
      expect(attempts[0].attemptNumber).toBe(1);
      expect(attempts[1].attemptNumber).toBe(2);
    });
  });

  describe('other methods', () => {
    it('should correctly get attempt count', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'test.event',
          payload: JSON.stringify({ test: 'data' })
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

      const count = await deliveryService.getAttemptCount(event.id, endpoint.id);
      expect(count).toBe(1);
    });

    it('should correctly check if can retry by attempt count', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'test.event',
          payload: JSON.stringify({ test: 'data' })
        }
      });

      for (let i = 1; i <= 2; i++) {
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
      expect(canRetry).toBe(true);
    });
  });
});
