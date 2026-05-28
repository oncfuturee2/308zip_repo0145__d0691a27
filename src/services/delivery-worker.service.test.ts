import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeliveryExecutor, EventMatcher, RetryStrategy } from '../core';
import { prisma } from './prisma-client';
import { DeliveryQueueService } from './delivery-queue.service';
import { DeliveryService } from './delivery.service';
import { DeliveryWorkerService } from './delivery-worker.service';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookEventService } from './webhook-event.service';

describe('DeliveryWorkerService', () => {
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

  it('should requeue retryable failures with the next attempt number', async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        url: 'https://example.com/webhook/orders',
        eventTypes: 'order.*',
        secret: 'endpoint-secret'
      }
    });

    const event = await prisma.webhookEvent.create({
      data: {
        eventType: 'order.created',
        payload: JSON.stringify({ orderId: 'ORD-001' })
      }
    });

    const retryStrategy = new RetryStrategy({
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 2
    });
    const execute = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 500,
        durationMs: 12,
        isSuccess: false,
        errorMessage: 'Server Error'
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        durationMs: 8,
        isSuccess: true
      });
    const eventService = new WebhookEventService(new EventMatcher());
    const endpointService = new WebhookEndpointService();
    const deliveryQueue = new DeliveryQueueService();
    const deliveryService = new DeliveryService(
      { execute } as unknown as DeliveryExecutor,
      retryStrategy
    );
    const worker = new DeliveryWorkerService(
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

    deliveryQueue.enqueue({
      eventId: event.id,
      endpointId: endpoint.id,
      attemptNumber: 1
    });

    expect(await worker.processDueJobs()).toBe(1);

    const attemptsAfterFirstRun = await prisma.deliveryAttempt.findMany({
      orderBy: { attemptNumber: 'asc' }
    });

    expect(attemptsAfterFirstRun).toHaveLength(1);
    expect(attemptsAfterFirstRun[0].attemptNumber).toBe(1);
    expect(attemptsAfterFirstRun[0].isSuccess).toBe(false);
    expect(deliveryQueue.getJobs()).toHaveLength(1);
    expect(deliveryQueue.getJobs()[0].attemptNumber).toBe(2);

    expect(await worker.processDueJobs()).toBe(1);

    const attemptsAfterSecondRun = await prisma.deliveryAttempt.findMany({
      orderBy: { attemptNumber: 'asc' }
    });

    expect(attemptsAfterSecondRun).toHaveLength(2);
    expect(attemptsAfterSecondRun[1].attemptNumber).toBe(2);
    expect(attemptsAfterSecondRun[1].isSuccess).toBe(true);
    expect(deliveryQueue.getPendingCount()).toBe(0);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('should not requeue when the status code is not retryable', async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        url: 'https://example.com/webhook/payments',
        eventTypes: 'payment.*',
        secret: 'endpoint-secret'
      }
    });

    const event = await prisma.webhookEvent.create({
      data: {
        eventType: 'payment.failed',
        payload: JSON.stringify({ paymentId: 'PAY-001' })
      }
    });

    const retryStrategy = new RetryStrategy({
      maxAttempts: 3,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 2
    });
    const execute = vi.fn().mockResolvedValue({
      statusCode: 400,
      durationMs: 10,
      isSuccess: false,
      errorMessage: 'Bad Request'
    });
    const eventService = new WebhookEventService(new EventMatcher());
    const endpointService = new WebhookEndpointService();
    const deliveryQueue = new DeliveryQueueService();
    const deliveryService = new DeliveryService(
      { execute } as unknown as DeliveryExecutor,
      retryStrategy
    );
    const worker = new DeliveryWorkerService(
      deliveryQueue,
      eventService,
      endpointService,
      deliveryService,
      retryStrategy
    );

    deliveryQueue.enqueue({
      eventId: event.id,
      endpointId: endpoint.id,
      attemptNumber: 1
    });

    await worker.processDueJobs();

    const attempts = await prisma.deliveryAttempt.findMany();

    expect(attempts).toHaveLength(1);
    expect(attempts[0].statusCode).toBe(400);
    expect(deliveryQueue.getPendingCount()).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
  });

  it('should not requeue when the max attempt limit has been reached', async () => {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        url: 'https://example.com/webhook/customers',
        eventTypes: 'customer.*',
        secret: 'endpoint-secret'
      }
    });

    const event = await prisma.webhookEvent.create({
      data: {
        eventType: 'customer.updated',
        payload: JSON.stringify({ customerId: 'CUS-001' })
      }
    });

    const retryStrategy = new RetryStrategy({
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      backoffMultiplier: 2
    });
    const execute = vi.fn().mockResolvedValue({
      statusCode: 500,
      durationMs: 10,
      isSuccess: false,
      errorMessage: 'Server Error'
    });
    const eventService = new WebhookEventService(new EventMatcher());
    const endpointService = new WebhookEndpointService();
    const deliveryQueue = new DeliveryQueueService();
    const deliveryService = new DeliveryService(
      { execute } as unknown as DeliveryExecutor,
      retryStrategy
    );
    const worker = new DeliveryWorkerService(
      deliveryQueue,
      eventService,
      endpointService,
      deliveryService,
      retryStrategy
    );

    deliveryQueue.enqueue({
      eventId: event.id,
      endpointId: endpoint.id,
      attemptNumber: 1
    });

    await worker.processDueJobs();

    const attempts = await prisma.deliveryAttempt.findMany();

    expect(attempts).toHaveLength(1);
    expect(attempts[0].statusCode).toBe(500);
    expect(deliveryQueue.getPendingCount()).toBe(0);
    expect(execute).toHaveBeenCalledOnce();
  });
});
