import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueueService } from './queue.service';
import { RetryStrategy } from '../core';
import { prisma } from '../services/prisma-client';

describe('QueueService', () => {
  let queueService: QueueService;
  let retryStrategy: RetryStrategy;

  beforeEach(() => {
    retryStrategy = new RetryStrategy();
    queueService = new QueueService(retryStrategy);
  });

  afterEach(async () => {
    await prisma.deliveryTask.deleteMany({});
  });

  describe('enqueueTask', () => {
    it('should create a new delivery task with pending status', async () => {
      const eventId = 'evt-123';
      const endpointId = 'ep-456';
      const attemptNumber = 1;

      const task = await queueService.enqueueTask(eventId, endpointId, attemptNumber);

      expect(task.eventId).toBe(eventId);
      expect(task.endpointId).toBe(endpointId);
      expect(task.attemptNumber).toBe(attemptNumber);
      expect(task.status).toBe('pending');
      expect(task.nextRetryAt).toBeNull();
      expect(task.lastError).toBeNull();
    });

    it('should create task with default attempt number of 1', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456');

      expect(task.attemptNumber).toBe(1);
    });
  });

  describe('enqueueTasksForEvent', () => {
    it('should create multiple tasks for different endpoints', async () => {
      const eventId = 'evt-123';
      const endpointIds = ['ep-1', 'ep-2', 'ep-3'];

      const tasks = await queueService.enqueueTasksForEvent(eventId, endpointIds);

      expect(tasks).toHaveLength(3);
      tasks.forEach((task, index) => {
        expect(task.eventId).toBe(eventId);
        expect(task.endpointId).toBe(endpointIds[index]);
        expect(task.status).toBe('pending');
        expect(task.attemptNumber).toBe(1);
      });
    });

    it('should return empty array when no endpoints provided', async () => {
      const tasks = await queueService.enqueueTasksForEvent('evt-123', []);

      expect(tasks).toHaveLength(0);
    });
  });

  describe('getNextPendingTask', () => {
    it('should return null when no pending tasks', async () => {
      const task = await queueService.getNextPendingTask();

      expect(task).toBeNull();
    });

    it('should return pending task with no nextRetryAt', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 1);

      const nextTask = await queueService.getNextPendingTask();

      expect(nextTask).not.toBeNull();
      expect(nextTask!.id).toBe(task.id);
    });

    it('should return task when nextRetryAt is in the past', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 1);

      await prisma.deliveryTask.update({
        where: { id: task.id },
        data: { nextRetryAt: new Date(Date.now() - 1000) }
      });

      const nextTask = await queueService.getNextPendingTask();

      expect(nextTask).not.toBeNull();
      expect(nextTask!.id).toBe(task.id);
    });

    it('should not return task when nextRetryAt is in the future', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 1);

      await prisma.deliveryTask.update({
        where: { id: task.id },
        data: { nextRetryAt: new Date(Date.now() + 60000) }
      });

      const nextTask = await queueService.getNextPendingTask();

      expect(nextTask).toBeNull();
    });

    it('should return oldest pending task first', async () => {
      const task1 = await queueService.enqueueTask('evt-1', 'ep-1', 1);
      const task2 = await queueService.enqueueTask('evt-2', 'ep-2', 1);

      const nextTask = await queueService.getNextPendingTask();

      expect(nextTask!.id).toBe(task1.id);
    });
  });

  describe('markAsProcessing', () => {
    it('should update task status to processing', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 1);

      const updatedTask = await queueService.markAsProcessing(task.id);

      expect(updatedTask.status).toBe('processing');
    });
  });

  describe('markAsCompleted', () => {
    it('should update task status to completed and clear nextRetryAt', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 1);

      await prisma.deliveryTask.update({
        where: { id: task.id },
        data: { nextRetryAt: new Date() }
      });

      const updatedTask = await queueService.markAsCompleted(task.id);

      expect(updatedTask.status).toBe('completed');
      expect(updatedTask.nextRetryAt).toBeNull();
    });
  });

  describe('markAsFailed', () => {
    it('should update task with error message and next retry time', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 1);
      const nextRetryAt = new Date(Date.now() + 5000);
      const errorMessage = 'Connection timeout';

      const updatedTask = await queueService.markAsFailed(task.id, errorMessage, nextRetryAt);

      expect(updatedTask.status).toBe('pending');
      expect(updatedTask.lastError).toBe(errorMessage);
      expect(updatedTask.nextRetryAt).toEqual(nextRetryAt);
    });
  });

  describe('scheduleRetry', () => {
    it('should schedule retry when canRetryByAttempt is true', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 1);
      const errorMessage = 'HTTP 500';

      const result = await queueService.scheduleRetry(task.id, 1, errorMessage);

      expect(result.shouldRetry).toBe(true);
      expect(result.task.status).toBe('pending');
      expect(result.task.attemptNumber).toBe(2);
      expect(result.task.lastError).toBe(errorMessage);
      expect(result.task.nextRetryAt).not.toBeNull();
    });

    it('should not retry when max attempts reached', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 5);
      const errorMessage = 'HTTP 500';

      const result = await queueService.scheduleRetry(task.id, 5, errorMessage);

      expect(result.shouldRetry).toBe(false);
      expect(result.task.status).toBe('failed');
      expect(result.task.lastError).toBe(errorMessage);
    });

    it('should calculate correct delay using retryStrategy', async () => {
      const task = await queueService.enqueueTask('evt-123', 'ep-456', 1);
      const errorMessage = 'HTTP 500';

      const result = await queueService.scheduleRetry(task.id, 1, errorMessage);

      const expectedDelayMs = retryStrategy.getNextDelayMs(1);
      const actualDelayMs = result.task.nextRetryAt!.getTime() - Date.now();

      expect(Math.abs(actualDelayMs - expectedDelayMs)).toBeLessThan(100);
    });
  });

  describe('getPendingTasksCount', () => {
    it('should return 0 when no pending tasks', async () => {
      const count = await queueService.getPendingTasksCount();

      expect(count).toBe(0);
    });

    it('should return correct count of pending tasks', async () => {
      await queueService.enqueueTask('evt-1', 'ep-1', 1);
      await queueService.enqueueTask('evt-2', 'ep-2', 1);
      await queueService.enqueueTask('evt-3', 'ep-3', 1);

      const count = await queueService.getPendingTasksCount();

      expect(count).toBe(3);
    });

    it('should not count tasks with future nextRetryAt', async () => {
      const task1 = await queueService.enqueueTask('evt-1', 'ep-1', 1);
      await queueService.enqueueTask('evt-2', 'ep-2', 1);

      await prisma.deliveryTask.update({
        where: { id: task1.id },
        data: { nextRetryAt: new Date(Date.now() + 60000) }
      });

      const count = await queueService.getPendingTasksCount();

      expect(count).toBe(1);
    });
  });

  describe('getTasksByEventId', () => {
    it('should return all tasks for a given event', async () => {
      await queueService.enqueueTask('evt-1', 'ep-1', 1);
      await queueService.enqueueTask('evt-1', 'ep-2', 1);
      await queueService.enqueueTask('evt-2', 'ep-1', 1);

      const tasks = await queueService.getTasksByEventId('evt-1');

      expect(tasks).toHaveLength(2);
      tasks.forEach(task => {
        expect(task.eventId).toBe('evt-1');
      });
    });
  });

  describe('clearCompletedTasks', () => {
    it('should delete all completed tasks', async () => {
      const task1 = await queueService.enqueueTask('evt-1', 'ep-1', 1);
      const task2 = await queueService.enqueueTask('evt-2', 'ep-2', 1);

      await queueService.markAsCompleted(task1.id);

      const deletedCount = await queueService.clearCompletedTasks();

      expect(deletedCount).toBe(1);

      const remainingTasks = await prisma.deliveryTask.findMany();
      expect(remainingTasks).toHaveLength(1);
      expect(remainingTasks[0].id).toBe(task2.id);
    });
  });
});