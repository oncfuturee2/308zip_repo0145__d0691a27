import { prisma } from './prisma-client';
import { DeliveryTask, WebhookEvent, WebhookEndpoint } from '@prisma/client';
import { RetryStrategy } from '../core';

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface QueueTask {
  eventId: string;
  endpointId: string;
  attemptNumber: number;
  status: TaskStatus;
  nextRetryAt: Date | null;
  lastError: string | null;
}

export class QueueService {
  private readonly retryStrategy: RetryStrategy;

  constructor(retryStrategy: RetryStrategy) {
    this.retryStrategy = retryStrategy;
  }

  async enqueueTask(
    eventId: string,
    endpointId: string,
    attemptNumber: number = 1
  ): Promise<DeliveryTask> {
    return prisma.deliveryTask.create({
      data: {
        eventId,
        endpointId,
        attemptNumber,
        status: 'pending',
        nextRetryAt: null,
        lastError: null
      }
    });
  }

  async enqueueTasksForEvent(
    eventId: string,
    endpointIds: string[]
  ): Promise<DeliveryTask[]> {
    const tasks = endpointIds.map(endpointId => ({
      eventId,
      endpointId,
      attemptNumber: 1,
      status: 'pending' as const,
      nextRetryAt: null,
      lastError: null
    }));

    return prisma.deliveryTask.createManyAndReturn({
      data: tasks
    });
  }

  async getNextPendingTask(): Promise<(DeliveryTask & { event: WebhookEvent; endpoint: WebhookEndpoint }) | null> {
    const now = new Date();

    const task = await prisma.deliveryTask.findFirst({
      where: {
        status: 'pending',
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } }
        ]
      },
      include: {
        event: true,
        endpoint: true
      },
      orderBy: [
        { nextRetryAt: 'asc' },
        { createdAt: 'asc' }
      ]
    });

    return task;
  }

  async markAsProcessing(taskId: string): Promise<DeliveryTask> {
    return prisma.deliveryTask.update({
      where: { id: taskId },
      data: { status: 'processing' }
    });
  }

  async markAsCompleted(taskId: string): Promise<DeliveryTask> {
    return prisma.deliveryTask.update({
      where: { id: taskId },
      data: {
        status: 'completed',
        nextRetryAt: null
      }
    });
  }

  async markAsFailed(
    taskId: string,
    errorMessage: string,
    nextRetryAt: Date | null
  ): Promise<DeliveryTask> {
    return prisma.deliveryTask.update({
      where: { id: taskId },
      data: {
        status: 'pending',
        lastError: errorMessage,
        nextRetryAt
      }
    });
  }

  async scheduleRetry(
    taskId: string,
    currentAttemptNumber: number,
    errorMessage: string
  ): Promise<{ task: DeliveryTask; shouldRetry: boolean }> {
    const canRetry = this.retryStrategy.canRetryByAttempt(currentAttemptNumber);

    if (!canRetry) {
      const task = await prisma.deliveryTask.update({
        where: { id: taskId },
        data: {
          status: 'failed',
          lastError: errorMessage,
          nextRetryAt: null
        }
      });
      return { task, shouldRetry: false };
    }

    const delayMs = this.retryStrategy.getNextDelayMs(currentAttemptNumber);
    const nextRetryAt = new Date(Date.now() + delayMs);

    const task = await prisma.deliveryTask.update({
      where: { id: taskId },
      data: {
        status: 'pending',
        lastError: errorMessage,
        nextRetryAt,
        attemptNumber: currentAttemptNumber + 1
      }
    });

    return { task, shouldRetry: true };
  }

  async getPendingTasksCount(): Promise<number> {
    const now = new Date();
    return prisma.deliveryTask.count({
      where: {
        status: 'pending',
        OR: [
          { nextRetryAt: null },
          { nextRetryAt: { lte: now } }
        ]
      }
    });
  }

  async getTasksByEventId(eventId: string): Promise<DeliveryTask[]> {
    return prisma.deliveryTask.findMany({
      where: { eventId },
      orderBy: { createdAt: 'asc' }
    });
  }

  async getTasksByEndpointId(endpointId: string): Promise<DeliveryTask[]> {
    return prisma.deliveryTask.findMany({
      where: { endpointId },
      orderBy: { createdAt: 'desc' }
    });
  }

  async deleteTask(taskId: string): Promise<DeliveryTask> {
    return prisma.deliveryTask.delete({
      where: { id: taskId }
    });
  }

  async clearCompletedTasks(): Promise<number> {
    const result = await prisma.deliveryTask.deleteMany({
      where: { status: 'completed' }
    });
    return result.count;
  }
}