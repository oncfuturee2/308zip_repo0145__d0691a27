import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fastify from 'fastify';
import { DeliveryExecutor, EventMatcher, RetryStrategy } from '../core';
import {
  DeliveryQueueService,
  DeliveryService,
  DeliveryWorkerService,
  StatisticsService,
  WebhookEndpointService,
  WebhookEventService,
  prisma
} from '../services';
import { registerRoutes, RouteDeps } from './index';

async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs: number = 1000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('Condition not met within timeout');
}

function createTestDeps(
  execute: DeliveryExecutor['execute'],
  retryStrategy: RetryStrategy = new RetryStrategy({
    maxAttempts: 3,
    baseDelayMs: 0,
    maxDelayMs: 0,
    backoffMultiplier: 2
  })
): RouteDeps {
  const eventMatcher = new EventMatcher();
  const endpointService = new WebhookEndpointService();
  const eventService = new WebhookEventService(eventMatcher);
  const deliveryQueue = new DeliveryQueueService();
  const deliveryService = new DeliveryService(
    { execute } as unknown as DeliveryExecutor,
    retryStrategy
  );
  const deliveryWorker = new DeliveryWorkerService(
    deliveryQueue,
    eventService,
    endpointService,
    deliveryService,
    retryStrategy,
    {
      pollIntervalMs: 5,
      batchSize: 10
    }
  );
  const statisticsService = new StatisticsService();

  return {
    endpointService,
    eventService,
    deliveryService,
    deliveryQueue,
    deliveryWorker,
    statisticsService,
    eventMatcher
  };
}

describe('Events API', () => {
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

  it('should accept an event and deliver it asynchronously', async () => {
    const execute = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        statusCode: 200,
        durationMs: 50,
        isSuccess: true
      };
    });

    const deps = createTestDeps(execute);
    const app = fastify();

    await registerRoutes(app, deps);
    await app.ready();

    try {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook/orders',
          eventTypes: 'order.*',
          secret: 'endpoint-secret'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: 'ORD-001' }
        }
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);

      expect(body.message).toBe('Event accepted for asynchronous delivery');
      expect(body.matchedEndpoints).toBe(1);
      expect(body.queuedDeliveries).toHaveLength(1);
      expect(body.queuedDeliveries[0].endpointId).toBe(endpoint.id);
      expect(body.queuedDeliveries[0].attemptNumber).toBe(1);
      expect(await prisma.deliveryAttempt.count()).toBe(0);

      await waitForCondition(async () => {
        return (await prisma.deliveryAttempt.count()) === 1;
      });

      const attempts = await prisma.deliveryAttempt.findMany({
        orderBy: { attemptNumber: 'asc' }
      });

      expect(attempts).toHaveLength(1);
      expect(attempts[0].attemptNumber).toBe(1);
      expect(attempts[0].isSuccess).toBe(true);
      expect(execute).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it('should accept an event without matching endpoints and keep the queue empty', async () => {
    const execute = vi.fn().mockResolvedValue({
      statusCode: 200,
      durationMs: 1,
      isSuccess: true
    });

    const deps = createTestDeps(execute);
    const app = fastify();

    await registerRoutes(app, deps);
    await app.ready();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'payment.failed',
          payload: { paymentId: 'PAY-001' }
        }
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);

      expect(body.message).toBe('Event accepted, no matching endpoints found');
      expect(body.matchedEndpoints).toBe(0);
      expect(body.queuedDeliveries).toEqual([]);
      expect(deps.deliveryQueue.getPendingCount()).toBe(0);
      expect(await prisma.deliveryAttempt.count()).toBe(0);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
