import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from './prisma-client';
import { DeliveryQueueService } from './delivery-queue.service';

describe('DeliveryQueueService', () => {
  const queueService = new DeliveryQueueService();

  beforeEach(async () => {
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  afterEach(async () => {
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

  describe('enqueue', () => {
    it('should create a task with pending status', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      const task = await queueService.enqueue(event.id, endpoint.id);

      expect(task).toBeDefined();
      expect(task.id).toBeDefined();
      expect(task.eventId).toBe(event.id);
      expect(task.endpointId).toBe(endpoint.id);
      expect(task.status).toBe('pending');
      expect(task.attemptNumber).toBe(0);
    });
  });

  describe('enqueueBatch', () => {
    it('should create multiple tasks for different endpoints', async () => {
      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const endpoint1 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          eventTypes: 'order.created',
          secret: 'secret1'
        }
      });

      const endpoint2 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook2',
          eventTypes: 'order.created',
          secret: 'secret2'
        }
      });

      const tasks = await queueService.enqueueBatch([
        { eventId: event.id, endpointId: endpoint1.id },
        { eventId: event.id, endpointId: endpoint2.id }
      ]);

      expect(tasks).toHaveLength(2);
      expect(tasks[0].eventId).toBe(event.id);
      expect(tasks[1].eventId).toBe(event.id);
      expect(tasks[0].status).toBe('pending');
      expect(tasks[1].status).toBe('pending');
    });

    it('should return empty array when given empty input', async () => {
      const tasks = await queueService.enqueueBatch([]);
      expect(tasks).toHaveLength(0);
    });
  });

  describe('dequeuePending', () => {
    it('should return the earliest pending task and mark it as processing', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      const task = await queueService.enqueue(event.id, endpoint.id);

      const dequeued = await queueService.dequeuePending();

      expect(dequeued).toBeDefined();
      expect(dequeued!.id).toBe(task.id);
      expect(dequeued!.status).toBe('processing');
      expect(dequeued!.event).toBeDefined();
      expect(dequeued!.endpoint).toBeDefined();
    });

    it('should return null when no pending tasks exist', async () => {
      const dequeued = await queueService.dequeuePending();
      expect(dequeued).toBeNull();
    });

    it('should not return tasks with future nextRetryAt', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      await prisma.deliveryTask.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          status: 'pending',
          attemptNumber: 1,
          nextRetryAt: new Date(Date.now() + 3600000)
        }
      });

      const dequeued = await queueService.dequeuePending();
      expect(dequeued).toBeNull();
    });

    it('should return tasks with past nextRetryAt', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      const createdTask = await prisma.deliveryTask.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          status: 'pending',
          attemptNumber: 0,
          nextRetryAt: new Date(Date.now() - 1000)
        }
      });

      const dequeued = await queueService.dequeuePending();
      expect(dequeued).toBeDefined();
      expect(dequeued!.id).toBe(createdTask.id);
      expect(dequeued!.status).toBe('processing');
    });
  });

  describe('markCompleted', () => {
    it('should update task status to completed', async () => {
      const { event, endpoint } = await createEventAndEndpoint();
      const task = await queueService.enqueue(event.id, endpoint.id);

      const updated = await queueService.markCompleted(task.id);

      expect(updated.status).toBe('completed');
    });
  });

  describe('markFailed', () => {
    it('should update task status to failed with error info', async () => {
      const { event, endpoint } = await createEventAndEndpoint();
      const task = await queueService.enqueue(event.id, endpoint.id);

      const updated = await queueService.markFailed(
        task.id,
        'Connection refused',
        500
      );

      expect(updated.status).toBe('failed');
      expect(updated.lastError).toBe('Connection refused');
      expect(updated.lastStatusCode).toBe(500);
    });

    it('should accept null statusCode for network errors', async () => {
      const { event, endpoint } = await createEventAndEndpoint();
      const task = await queueService.enqueue(event.id, endpoint.id);

      const updated = await queueService.markFailed(
        task.id,
        'Network error',
        null
      );

      expect(updated.status).toBe('failed');
      expect(updated.lastError).toBe('Network error');
      expect(updated.lastStatusCode).toBeNull();
    });
  });

  describe('scheduleRetry', () => {
    it('should reset task to pending with new attempt number and retry time', async () => {
      const { event, endpoint } = await createEventAndEndpoint();
      const task = await queueService.enqueue(event.id, endpoint.id);

      await queueService.markFailed(task.id, 'Server error', 500);

      const nextAttempt = 2;
      const nextRetryAt = new Date(Date.now() + 5000);

      const scheduled = await queueService.scheduleRetry(
        task.id,
        nextAttempt,
        nextRetryAt
      );

      expect(scheduled.status).toBe('pending');
      expect(scheduled.attemptNumber).toBe(2);
      expect(scheduled.nextRetryAt.getTime()).toBe(nextRetryAt.getTime());
    });
  });

  describe('findByEventId', () => {
    it('should return tasks for a specific event', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      const event2 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'ORD-002' })
        }
      });

      await queueService.enqueue(event.id, endpoint.id);
      await queueService.enqueue(event.id, endpoint.id);
      await queueService.enqueue(event2.id, endpoint.id);

      const tasks = await queueService.findByEventId(event.id);
      expect(tasks).toHaveLength(2);

      const otherTasks = await queueService.findByEventId(event2.id);
      expect(otherTasks).toHaveLength(1);
    });

    it('should return empty array for unknown event id', async () => {
      const tasks = await queueService.findByEventId('non-existent-id');
      expect(tasks).toHaveLength(0);
    });
  });

  describe('getPendingCount', () => {
    it('should return count of ready pending tasks', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      await queueService.enqueue(event.id, endpoint.id);
      await queueService.enqueue(event.id, endpoint.id);

      const count = await queueService.getPendingCount();
      expect(count).toBe(2);
    });

    it('should not count future-scheduled tasks', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      await prisma.deliveryTask.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          status: 'pending',
          attemptNumber: 0,
          nextRetryAt: new Date(Date.now() + 3600000)
        }
      });

      const count = await queueService.getPendingCount();
      expect(count).toBe(0);
    });
  });

  describe('resetStaleProcessing', () => {
    it('should reset stale processing tasks back to pending', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      const task = await prisma.deliveryTask.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          status: 'processing',
          attemptNumber: 1,
          nextRetryAt: new Date(),
          updatedAt: new Date(Date.now() - 600000)
        }
      });

      const resetCount = await queueService.resetStaleProcessing(300000);
      expect(resetCount).toBe(1);

      const updated = await queueService.findById(task.id);
      expect(updated!.status).toBe('pending');
    });

    it('should not reset tasks that are not stale', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      const task = await prisma.deliveryTask.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          status: 'processing',
          attemptNumber: 1,
          nextRetryAt: new Date()
        }
      });

      const resetCount = await queueService.resetStaleProcessing(300000);
      expect(resetCount).toBe(0);

      const current = await queueService.findById(task.id);
      expect(current!.status).toBe('processing');
    });
  });

  describe('findByStatus', () => {
    it('should filter tasks by status', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      await queueService.enqueue(event.id, endpoint.id);
      const task2 = await queueService.enqueue(event.id, endpoint.id);
      await queueService.markCompleted(task2.id);

      const pending = await queueService.findByStatus('pending');
      expect(pending).toHaveLength(1);

      const completed = await queueService.findByStatus('completed');
      expect(completed).toHaveLength(1);
    });
  });

  describe('findAll', () => {
    it('should return all tasks ordered by createdAt desc', async () => {
      const { event, endpoint } = await createEventAndEndpoint();

      await queueService.enqueue(event.id, endpoint.id);
      await queueService.enqueue(event.id, endpoint.id);

      const all = await queueService.findAll();
      expect(all).toHaveLength(2);
      expect(all[0].createdAt.getTime()).toBeGreaterThanOrEqual(all[1].createdAt.getTime());
    });
  });

  describe('findById', () => {
    it('should find task by id with event and endpoint included', async () => {
      const { event, endpoint } = await createEventAndEndpoint();
      const task = await queueService.enqueue(event.id, endpoint.id);

      const found = await queueService.findById(task.id);

      expect(found).toBeDefined();
      expect(found!.id).toBe(task.id);
      expect(found!.event).toBeDefined();
      expect(found!.endpoint).toBeDefined();
      expect(found!.event.eventType).toBe('order.created');
      expect(found!.endpoint.url).toBe('https://example.com/webhook');
    });

    it('should return null for non-existent id', async () => {
      const found = await queueService.findById('non-existent-id');
      expect(found).toBeNull();
    });
  });
});