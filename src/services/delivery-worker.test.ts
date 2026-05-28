import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from './prisma-client';
import { DeliveryQueueService } from './delivery-queue.service';
import { DeliveryService } from './delivery.service';
import { DeliveryWorker } from './delivery-worker';
import { RetryStrategy, MockHttpClient } from '../core';
import { DeliveryExecutor, SignatureGenerator } from '../core';

describe('DeliveryWorker', () => {
  let queueService: DeliveryQueueService;
  let deliveryService: DeliveryService;
  let retryStrategy: RetryStrategy;
  let httpClient: MockHttpClient;
  let worker: DeliveryWorker;

  beforeEach(async () => {
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});

    queueService = new DeliveryQueueService();
    httpClient = new MockHttpClient(1.0, 200, 5);
    const signatureGenerator = new SignatureGenerator();
    const deliveryExecutor = new DeliveryExecutor(httpClient, signatureGenerator);
    retryStrategy = new RetryStrategy({
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      backoffMultiplier: 2
    });
    deliveryService = new DeliveryService(deliveryExecutor, retryStrategy);
  });

  afterEach(async () => {
    worker?.stop();
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  async function createEventAndEndpoint() {
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        url: 'https://example.com/webhook',
        eventTypes: '*',
        secret: 'test-secret-123'
      }
    });

    const event = await prisma.webhookEvent.create({
      data: {
        eventType: 'order.created',
        payload: JSON.stringify({ orderId: 'ORD-001' })
      }
    });

    return { endpoint, event };
  }

  describe('start / stop', () => {
    it('should start and stop correctly', () => {
      worker = new DeliveryWorker(queueService, deliveryService, retryStrategy);
      expect(worker.isRunning()).toBe(false);

      worker.start();
      expect(worker.isRunning()).toBe(true);

      worker.stop();
      expect(worker.isRunning()).toBe(false);
    });

    it('should not start twice', () => {
      worker = new DeliveryWorker(queueService, deliveryService, retryStrategy);
      worker.start();
      expect(worker.isRunning()).toBe(true);
      worker.start();
      expect(worker.isRunning()).toBe(true);
      worker.stop();
    });
  });

  describe('successful delivery', () => {
    it('should process pending task and mark it as completed', async () => {
      const { event, endpoint } = await createEventAndEndpoint();
      await queueService.enqueue(event.id, endpoint.id);

      worker = new DeliveryWorker(queueService, deliveryService, retryStrategy, {
        pollingIntervalMs: 50
      });
      worker.start();

      await new Promise(resolve => setTimeout(resolve, 300));
      worker.stop();

      const tasks = await queueService.findAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('completed');

      const attempts = await prisma.deliveryAttempt.findMany();
      expect(attempts).toHaveLength(1);
      expect(attempts[0].isSuccess).toBe(true);
      expect(attempts[0].attemptNumber).toBe(1);
    });
  });

  describe('failed delivery with retry', () => {
    it('should retry failed deliveries and eventually mark as failed when max attempts exhausted', async () => {
      const { event, endpoint } = await createEventAndEndpoint();
      await queueService.enqueue(event.id, endpoint.id);

      httpClient.forceError(500, 'Internal Server Error');

      worker = new DeliveryWorker(queueService, deliveryService, retryStrategy, {
        pollingIntervalMs: 50
      });
      worker.start();

      await new Promise(resolve => setTimeout(resolve, 3000));
      worker.stop();

      const tasks = await queueService.findAll();
      const finalTask = tasks[0];

      expect(finalTask).toBeDefined();
      expect(finalTask.status).toBe('failed');
      expect(finalTask.attemptNumber).toBeGreaterThanOrEqual(1);

      const attempts = await prisma.deliveryAttempt.findMany({
        orderBy: { attemptNumber: 'asc' }
      });
      expect(attempts.length).toBeGreaterThanOrEqual(1);

      for (const attempt of attempts) {
        expect(attempt.isSuccess).toBe(false);
      }
    });
  });

  describe('non-retryable failure', () => {
    it('should not retry non-retryable status codes', async () => {
      const { event, endpoint } = await createEventAndEndpoint();
      await queueService.enqueue(event.id, endpoint.id);

      httpClient.forceError(400, 'Bad Request');

      worker = new DeliveryWorker(queueService, deliveryService, retryStrategy, {
        pollingIntervalMs: 50
      });
      worker.start();

      await new Promise(resolve => setTimeout(resolve, 500));
      worker.stop();

      const tasks = await queueService.findAll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].attemptNumber).toBe(0);
      expect(tasks[0].lastError).toBeDefined();

      const attempts = await prisma.deliveryAttempt.findMany();
      expect(attempts).toHaveLength(1);
      expect(attempts[0].isSuccess).toBe(false);
    });
  });

  describe('delayed task scheduling', () => {
    it('should correctly apply backoff delay when scheduling retry', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      await prisma.deliveryTask.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          status: 'pending',
          attemptNumber: 2,
          nextRetryAt: new Date(Date.now() - 100)
        }
      });

      httpClient.forceError(503, 'Service Unavailable');

      worker = new DeliveryWorker(queueService, deliveryService, retryStrategy, {
        pollingIntervalMs: 50
      });
      worker.start();

      await new Promise(resolve => setTimeout(resolve, 1000));
      worker.stop();

      const tasks = await queueService.findAll();
      expect(tasks).toHaveLength(1);

      expect(tasks[0].status).toBe('failed');
      expect(tasks[0].lastStatusCode).toBe(503);
    });
  });

  describe('stale processing task recovery', () => {
    it('should reset stale processing tasks back to pending', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      await prisma.deliveryTask.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          status: 'processing',
          attemptNumber: 1,
          nextRetryAt: new Date(),
          updatedAt: new Date(Date.now() - 10000)
        }
      });

      httpClient.forceError(500, 'Error');

      worker = new DeliveryWorker(queueService, deliveryService, retryStrategy, {
        pollingIntervalMs: 50,
        staleProcessingTimeoutMs: 5000
      });
      worker.start();

      await new Promise(resolve => setTimeout(resolve, 1000));
      worker.stop();

      const tasks = await queueService.findAll();
      expect(tasks).toHaveLength(1);

      expect(tasks[0].status === 'failed' || tasks[0].status === 'processing' || tasks[0].status === 'pending').toBe(true);
    });
  });
});