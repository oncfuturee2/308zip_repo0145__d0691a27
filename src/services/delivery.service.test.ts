import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from './prisma-client';
import { DeliveryService, MaxAttemptsExceededError } from './delivery.service';
import {
  DeliveryExecutor,
  MockHttpClient,
  RetryStrategy,
  SignatureGenerator
} from '../core';

function createDeliveryService(maxAttempts: number = 5): {
  deliveryService: DeliveryService;
  httpClient: MockHttpClient;
} {
  const httpClient = new MockHttpClient(1, 200, 0);
  const deliveryExecutor = new DeliveryExecutor(httpClient, new SignatureGenerator());
  const retryStrategy = new RetryStrategy({
    maxAttempts,
    baseDelayMs: 1000,
    maxDelayMs: 60000,
    backoffMultiplier: 2
  });

  return {
    deliveryService: new DeliveryService(deliveryExecutor, retryStrategy),
    httpClient
  };
}

describe('DeliveryService', () => {
  beforeEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  afterEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  it('should retry with the next max attempt number when historical attempts have gaps', async () => {
    const { deliveryService } = createDeliveryService();

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        url: 'https://example.com/webhook',
        secret: 'secret123'
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
        isSuccess: false,
        statusCode: 500,
        durationMs: 50,
        errorMessage: 'First failure',
        attemptNumber: 1
      }
    });

    const latestAttempt = await prisma.deliveryAttempt.create({
      data: {
        eventId: event.id,
        endpointId: endpoint.id,
        isSuccess: false,
        statusCode: 500,
        durationMs: 75,
        errorMessage: 'Third failure',
        attemptNumber: 3
      }
    });

    const retriedAttempt = await deliveryService.retryDelivery(latestAttempt.id);

    expect(retriedAttempt.attemptNumber).toBe(4);

    const attempts = await prisma.deliveryAttempt.findMany({
      where: { eventId: event.id, endpointId: endpoint.id },
      orderBy: { attemptNumber: 'asc' }
    });

    expect(attempts.map(attempt => attempt.attemptNumber)).toEqual([1, 3, 4]);
  });

  it('should stop retrying when the maximum recorded attempt number has reached the retry limit', async () => {
    const { deliveryService } = createDeliveryService(3);

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        url: 'https://example.com/webhook',
        secret: 'secret123'
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
        isSuccess: false,
        statusCode: 500,
        durationMs: 50,
        errorMessage: 'First failure',
        attemptNumber: 1
      }
    });

    const latestAttempt = await prisma.deliveryAttempt.create({
      data: {
        eventId: event.id,
        endpointId: endpoint.id,
        isSuccess: false,
        statusCode: 500,
        durationMs: 75,
        errorMessage: 'Third failure',
        attemptNumber: 3
      }
    });

    await expect(deliveryService.retryDelivery(latestAttempt.id)).rejects.toBeInstanceOf(MaxAttemptsExceededError);
  });
});
