import { DeliveryAttempt } from '@prisma/client';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from './prisma-client';
import { DeliveryService, MaxAttemptsExceededError } from './delivery.service';
import {
  DeliveryExecutor,
  MockHttpClient,
  RetryStrategy,
  SignatureGenerator
} from '../core';

async function clearTables(): Promise<void> {
  await prisma.deliveryAttempt.deleteMany({});
  await prisma.webhookEvent.deleteMany({});
  await prisma.webhookEndpoint.deleteMany({});
}

type AttemptSeed = {
  statusCode: number;
  attemptNumber: number;
  durationMs?: number;
  errorMessage?: string;
};

async function createDeliveryFixture(attempts: AttemptSeed[] = []): Promise<{
  endpoint: Awaited<ReturnType<typeof prisma.webhookEndpoint.create>>;
  event: Awaited<ReturnType<typeof prisma.webhookEvent.create>>;
  attempts: DeliveryAttempt[];
}> {
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

  const createdAttempts: DeliveryAttempt[] = [];

  for (const attempt of attempts) {
    createdAttempts.push(
      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          statusCode: attempt.statusCode,
          durationMs: attempt.durationMs ?? 25,
          isSuccess: attempt.statusCode >= 200 && attempt.statusCode < 300,
          errorMessage:
            attempt.errorMessage ??
            (attempt.statusCode >= 200 && attempt.statusCode < 300
              ? undefined
              : `HTTP ${attempt.statusCode}`),
          attemptNumber: attempt.attemptNumber
        }
      })
    );
  }

  return {
    endpoint,
    event,
    attempts: createdAttempts
  };
}

describe('DeliveryService', () => {
  let deliveryService: DeliveryService;
  let deliveryExecutor: DeliveryExecutor;
  let mockHttpClient: MockHttpClient;
  let retryStrategy: RetryStrategy;

  beforeEach(async () => {
    await clearTables();

    mockHttpClient = new MockHttpClient(1.0, 202, 1);
    const signatureGenerator = new SignatureGenerator();
    deliveryExecutor = new DeliveryExecutor(mockHttpClient, signatureGenerator);
    retryStrategy = new RetryStrategy({
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
      backoffMultiplier: 2
    });
    deliveryService = new DeliveryService(deliveryExecutor, retryStrategy);
  });

  afterEach(async () => {
    await clearTables();
  });

  describe('retryDelivery', () => {
    it('should throw when the delivery attempt does not exist', async () => {
      await expect(deliveryService.retryDelivery('missing-attempt-id')).rejects.toThrow(
        'Delivery attempt not found: missing-attempt-id'
      );
    });

    it('should reject retry when the stored status code is non-retryable', async () => {
      const { attempts, event, endpoint } = await createDeliveryFixture([
        { statusCode: 400, attemptNumber: 1, errorMessage: 'Bad Request' }
      ]);
      const executeSpy = vi.spyOn(deliveryExecutor, 'execute');

      await expect(deliveryService.retryDelivery(attempts[0].id)).rejects.toThrow(
        'Cannot retry delivery with status code: 400'
      );

      expect(executeSpy).not.toHaveBeenCalled();
      expect(
        await prisma.deliveryAttempt.count({
          where: { eventId: event.id, endpointId: endpoint.id }
        })
      ).toBe(1);
    });

    it('should throw MaxAttemptsExceededError when the configured retry limit is reached', async () => {
      const { attempts, event, endpoint } = await createDeliveryFixture([
        { statusCode: 500, attemptNumber: 1, errorMessage: 'Internal Server Error' },
        { statusCode: 502, attemptNumber: 2, errorMessage: 'Bad Gateway' },
        { statusCode: 503, attemptNumber: 3, errorMessage: 'Service Unavailable' }
      ]);
      const executeSpy = vi.spyOn(deliveryExecutor, 'execute');

      const error = await deliveryService.retryDelivery(attempts[2].id).catch(caughtError => caughtError);

      expect(error).toBeInstanceOf(MaxAttemptsExceededError);
      expect(error).toHaveProperty(
        'message',
        `Maximum attempts (3) exceeded for event ${event.id} to endpoint ${endpoint.id}. Current attempts: 3`
      );
      expect(executeSpy).not.toHaveBeenCalled();
      expect(
        await prisma.deliveryAttempt.count({
          where: { eventId: event.id, endpointId: endpoint.id }
        })
      ).toBe(3);
    });

    it('should execute the retry flow and persist a new incremented delivery attempt', async () => {
      const { attempts, event, endpoint } = await createDeliveryFixture([
        { statusCode: 500, attemptNumber: 1, errorMessage: 'Internal Server Error' },
        { statusCode: 502, attemptNumber: 2, errorMessage: 'Bad Gateway' }
      ]);
      const executeSpy = vi.spyOn(deliveryExecutor, 'execute');

      const newAttempt = await deliveryService.retryDelivery(attempts[1].id);
      const attemptsInDatabase = await prisma.deliveryAttempt.findMany({
        where: { eventId: event.id, endpointId: endpoint.id },
        orderBy: { attemptNumber: 'asc' }
      });

      expect(executeSpy).toHaveBeenCalledTimes(1);
      expect(executeSpy).toHaveBeenCalledWith({
        eventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
        endpointId: endpoint.id,
        endpointUrl: endpoint.url,
        endpointSecret: endpoint.secret,
        attemptNumber: 3
      });

      expect(newAttempt.eventId).toBe(event.id);
      expect(newAttempt.endpointId).toBe(endpoint.id);
      expect(newAttempt.attemptNumber).toBe(3);
      expect(newAttempt.statusCode).toBe(202);
      expect(newAttempt.isSuccess).toBe(true);
      expect(newAttempt.errorMessage).toBeUndefined();

      expect(attemptsInDatabase).toHaveLength(3);
      expect(attemptsInDatabase.map(attempt => attempt.attemptNumber)).toEqual([1, 2, 3]);
      expect(attemptsInDatabase[2].id).toBe(newAttempt.id);
      expect(attemptsInDatabase[2].statusCode).toBe(202);
      expect(attemptsInDatabase[2].isSuccess).toBe(true);
    });
  });
});
