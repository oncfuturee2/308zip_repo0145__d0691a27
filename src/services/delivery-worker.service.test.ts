import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DeliveryWorkerService } from './delivery-worker.service';
import { TaskQueue, DeliveryTask } from '../core/task-queue';
import { DeliveryService } from './delivery.service';
import { WebhookEventService } from './webhook-event.service';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { EventMatcher, SignatureGenerator, MockHttpClient, DeliveryExecutor, RetryStrategy } from '../core';
import { prisma } from './prisma-client';

describe('DeliveryWorkerService', () => {
  let queue: TaskQueue;
  let deliveryService: DeliveryService;
  let eventService: WebhookEventService;
  let endpointService: WebhookEndpointService;
  let worker: DeliveryWorkerService;

  beforeEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});

    queue = new TaskQueue();
    const eventMatcher = new EventMatcher();
    const signatureGenerator = new SignatureGenerator();
    const httpClient = new MockHttpClient(1.0, 200, 10);
    const deliveryExecutor = new DeliveryExecutor(httpClient, signatureGenerator);
    const retryStrategy = new RetryStrategy();

    endpointService = new WebhookEndpointService();
    eventService = new WebhookEventService(eventMatcher);
    deliveryService = new DeliveryService(deliveryExecutor, retryStrategy);

    worker = new DeliveryWorkerService(
      queue,
      deliveryService,
      eventService,
      endpointService,
      100
    );
  });

  afterEach(async () => {
    worker.stop();
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  it('should process a task and execute delivery successfully', async () => {
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

    queue.push({
      id: 'task-1',
      eventId: event.id,
      endpointId: endpoint.id,
      attemptNumber: 1,
      executeAt: Date.now()
    });

    worker.start();

    // Wait for worker to process task
    await new Promise(resolve => setTimeout(resolve, 300));

    expect(queue.size()).toBe(0);

    const attempts = await prisma.deliveryAttempt.findMany({
      where: { eventId: event.id, endpointId: endpoint.id }
    });

    expect(attempts).toHaveLength(1);
    expect(attempts[0].isSuccess).toBe(true);
    expect(attempts[0].attemptNumber).toBe(1);
  });

  it('should requeue a task if delivery fails and is retryable', async () => {
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

    // Mock DeliveryService to always fail with a retryable status (500)
    vi.spyOn(deliveryService, 'executeDelivery').mockImplementation(async () => {
      return await deliveryService.recordAttempt(event.id, endpoint.id, {
        statusCode: 500,
        durationMs: 50,
        isSuccess: false,
        errorMessage: 'Internal Server Error'
      }, 1);
    });

    queue.push({
      id: 'task-1',
      eventId: event.id,
      endpointId: endpoint.id,
      attemptNumber: 1,
      executeAt: Date.now()
    });

    worker.start();

    // Wait for worker to process task
    await new Promise(resolve => setTimeout(resolve, 300));

    // A new task should be pushed to the queue for retry
    expect(queue.size()).toBe(1);

    const nextTask = queue.poll();
    expect(nextTask).toBeDefined();
    expect(nextTask?.attemptNumber).toBe(2);
    expect(nextTask?.executeAt).toBeGreaterThan(Date.now());
  });
});
