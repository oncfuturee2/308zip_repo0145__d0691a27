import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DeliveryWorker, WorkerDependencies } from './delivery-worker';
import { QueueService } from '../services/queue.service';
import { DeliveryService } from '../services/delivery.service';
import { RetryStrategy } from '../core';
import { prisma } from '../services/prisma-client';
import { WebhookEndpoint, WebhookEvent, DeliveryAttempt } from '@prisma/client';

describe('DeliveryWorker', () => {
  let worker: DeliveryWorker;
  let queueService: QueueService;
  let deliveryService: DeliveryService;
  let retryStrategy: RetryStrategy;
  let mockDeps: WorkerDependencies;

  beforeEach(() => {
    queueService = new QueueService(new RetryStrategy());
    deliveryService = {
      executeDelivery: vi.fn(),
      canRetryByAttemptCount: vi.fn(),
    } as unknown as DeliveryService;
    retryStrategy = new RetryStrategy();

    mockDeps = {
      queueService,
      deliveryService,
      retryStrategy
    };

    worker = new DeliveryWorker(mockDeps, 100);
  });

  afterEach(async () => {
    worker.stop();
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  describe('start/stop', () => {
    it('should start worker and set isRunning to true', () => {
      worker.start();

      const status = worker.getStatus();
      expect(status.isRunning).toBe(true);
    });

    it('should stop worker and set isRunning to false', () => {
      worker.start();
      worker.stop();

      const status = worker.getStatus();
      expect(status.isRunning).toBe(false);
    });

    it('should not start if already running', () => {
      worker.start();
      worker.start();

      const status = worker.getStatus();
      expect(status.isRunning).toBe(true);
    });
  });

  describe('processTask - successful delivery', () => {
    it('should mark task as completed on successful delivery', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook', secret: 'test-secret' }
      });
      const event = await prisma.webhookEvent.create({
        data: { eventType: 'test.event', payload: '{}' }
      });
      const task = await queueService.enqueueTask(event.id, endpoint.id, 1);

      (deliveryService.executeDelivery as any).mockResolvedValue({
        isSuccess: true,
        statusCode: 200,
        durationMs: 100
      } as DeliveryAttempt);

      await worker.processNextTask();

      const updatedTask = await prisma.deliveryTask.findUnique({ where: { id: task.id } });
      expect(updatedTask!.status).toBe('completed');
    });

    it('should call executeDelivery with correct parameters', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook', secret: 'test-secret' }
      });
      const event = await prisma.webhookEvent.create({
        data: { eventType: 'test.event', payload: '{"key":"value"}' }
      });
      await queueService.enqueueTask(event.id, endpoint.id, 2);

      (deliveryService.executeDelivery as any).mockResolvedValue({
        isSuccess: true,
        statusCode: 200,
        durationMs: 100
      } as DeliveryAttempt);

      await worker.processNextTask();

      expect(deliveryService.executeDelivery).toHaveBeenCalledWith(
        expect.objectContaining({ id: event.id }),
        expect.objectContaining({ id: endpoint.id }),
        2
      );
    });
  });

  describe('processTask - failed delivery with retry', () => {
    it('should schedule retry when delivery fails with retryable status', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook', secret: 'test-secret' }
      });
      const event = await prisma.webhookEvent.create({
        data: { eventType: 'test.event', payload: '{}' }
      });
      const task = await queueService.enqueueTask(event.id, endpoint.id, 1);

      (deliveryService.executeDelivery as any).mockResolvedValue({
        isSuccess: false,
        statusCode: 500,
        durationMs: 100,
        errorMessage: 'Internal Server Error'
      } as DeliveryAttempt);

      (deliveryService.canRetryByAttemptCount as any).mockResolvedValue(true);

      await worker.processNextTask();

      const updatedTask = await prisma.deliveryTask.findUnique({ where: { id: task.id } });
      expect(updatedTask!.status).toBe('pending');
      expect(updatedTask!.lastError).toBe('Internal Server Error');
      expect(updatedTask!.nextRetryAt).not.toBeNull();
      expect(updatedTask!.attemptNumber).toBe(2);
    });

    it('should not retry when max attempts reached', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook', secret: 'test-secret' }
      });
      const event = await prisma.webhookEvent.create({
        data: { eventType: 'test.event', payload: '{}' }
      });
      const task = await queueService.enqueueTask(event.id, endpoint.id, 5);

      (deliveryService.executeDelivery as any).mockResolvedValue({
        isSuccess: false,
        statusCode: 500,
        durationMs: 100,
        errorMessage: 'Internal Server Error'
      } as DeliveryAttempt);

      (deliveryService.canRetryByAttemptCount as any).mockResolvedValue(false);

      await worker.processNextTask();

      const updatedTask = await prisma.deliveryTask.findUnique({ where: { id: task.id } });
      expect(updatedTask!.status).toBe('failed');
      expect(updatedTask!.lastError).toBe('Internal Server Error');
      expect(updatedTask!.nextRetryAt).toBeNull();
    });
  });

  describe('processTask - non-retryable status', () => {
    it('should mark as failed when status is non-retryable', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook', secret: 'test-secret' }
      });
      const event = await prisma.webhookEvent.create({
        data: { eventType: 'test.event', payload: '{}' }
      });
      const task = await queueService.enqueueTask(event.id, endpoint.id, 1);

      (deliveryService.executeDelivery as any).mockResolvedValue({
        isSuccess: false,
        statusCode: 404,
        durationMs: 50,
        errorMessage: 'Not Found'
      } as DeliveryAttempt);

      await worker.processNextTask();

      const updatedTask = await prisma.deliveryTask.findUnique({ where: { id: task.id } });
      expect(updatedTask!.status).toBe('failed');
      expect(updatedTask!.lastError).toBe('Not Found');
    });
  });

  describe('processAllPendingTasks', () => {
    it('should process all pending tasks', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook', secret: 'test-secret' }
      });
      const event = await prisma.webhookEvent.create({
        data: { eventType: 'test.event', payload: '{}' }
      });

      await queueService.enqueueTask(event.id, endpoint.id, 1);
      await queueService.enqueueTask(event.id, endpoint.id, 2);

      (deliveryService.executeDelivery as any).mockResolvedValue({
        isSuccess: true,
        statusCode: 200,
        durationMs: 100
      } as DeliveryAttempt);

      const processedCount = await worker.processAllPendingTasks();

      expect(processedCount).toBe(2);

      const pendingCount = await queueService.getPendingTasksCount();
      expect(pendingCount).toBe(0);
    });

    it('should return 0 when no tasks to process', async () => {
      const processedCount = await worker.processAllPendingTasks();

      expect(processedCount).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('should return correct status', () => {
      const status = worker.getStatus();

      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('pollIntervalMs');
      expect(status.pollIntervalMs).toBe(100);
    });
  });
});

describe('createAndStartWorker / getGlobalWorker / stopGlobalWorker', () => {
  let queueService: QueueService;
  let deliveryService: DeliveryService;
  let retryStrategy: RetryStrategy;
  let mockDeps: WorkerDependencies;

  beforeEach(() => {
    queueService = new QueueService(new RetryStrategy());
    deliveryService = {} as DeliveryService;
    retryStrategy = new RetryStrategy();

    mockDeps = {
      queueService,
      deliveryService,
      retryStrategy
    };
  });

  afterEach(async () => {
    const { stopGlobalWorker } = await import('./delivery-worker');
    stopGlobalWorker();
    await prisma.deliveryTask.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  it('should create and start a global worker', async () => {
    const { createAndStartWorker, getGlobalWorker, stopGlobalWorker } = await import('./delivery-worker');

    const worker = createAndStartWorker(mockDeps);

    expect(getGlobalWorker()).toBe(worker);
    expect(worker.getStatus().isRunning).toBe(true);

    stopGlobalWorker();
    expect(getGlobalWorker()).toBeNull();
  });
});