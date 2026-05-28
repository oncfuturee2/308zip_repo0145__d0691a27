import { prisma } from './prisma-client';
import { DeliveryTask, WebhookEvent, WebhookEndpoint } from '@prisma/client';

export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface DeliveryTaskWithDetails extends DeliveryTask {
  event: WebhookEvent;
  endpoint: WebhookEndpoint;
}

export class DeliveryQueueService {
  async enqueue(eventId: string, endpointId: string): Promise<DeliveryTask> {
    return prisma.deliveryTask.create({
      data: {
        eventId,
        endpointId,
        status: 'pending',
        attemptNumber: 0,
        nextRetryAt: new Date()
      }
    });
  }

  async enqueueBatch(tasks: Array<{ eventId: string; endpointId: string }>): Promise<DeliveryTask[]> {
    const created: DeliveryTask[] = [];
    for (const task of tasks) {
      const createdTask = await this.enqueue(task.eventId, task.endpointId);
      created.push(createdTask);
    }
    return created;
  }

  async dequeuePending(): Promise<DeliveryTaskWithDetails | null> {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const task = await tx.deliveryTask.findFirst({
        where: {
          status: 'pending',
          nextRetryAt: { lte: now }
        },
        orderBy: { nextRetryAt: 'asc' },
        include: {
          event: true,
          endpoint: true
        }
      });

      if (!task) {
        return null;
      }

      return tx.deliveryTask.update({
        where: { id: task.id },
        data: { status: 'processing' },
        include: {
          event: true,
          endpoint: true
        }
      });
    });
  }

  async markCompleted(taskId: string): Promise<DeliveryTask> {
    return prisma.deliveryTask.update({
      where: { id: taskId },
      data: { status: 'completed' }
    });
  }

  async markFailed(
    taskId: string,
    errorMessage: string,
    statusCode: number | null
  ): Promise<DeliveryTask> {
    return prisma.deliveryTask.update({
      where: { id: taskId },
      data: {
        status: 'failed',
        lastError: errorMessage,
        lastStatusCode: statusCode
      }
    });
  }

  async scheduleRetry(
    taskId: string,
    attemptNumber: number,
    nextRetryAt: Date
  ): Promise<DeliveryTask> {
    return prisma.deliveryTask.update({
      where: { id: taskId },
      data: {
        status: 'pending',
        attemptNumber,
        nextRetryAt
      }
    });
  }

  async findById(taskId: string): Promise<DeliveryTaskWithDetails | null> {
    return prisma.deliveryTask.findUnique({
      where: { id: taskId },
      include: {
        event: true,
        endpoint: true
      }
    });
  }

  async findByEventId(eventId: string): Promise<DeliveryTaskWithDetails[]> {
    return prisma.deliveryTask.findMany({
      where: { eventId },
      include: {
        event: true,
        endpoint: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async getPendingCount(): Promise<number> {
    return prisma.deliveryTask.count({
      where: {
        status: 'pending',
        nextRetryAt: { lte: new Date() }
      }
    });
  }

  async getProcessingCount(): Promise<number> {
    return prisma.deliveryTask.count({
      where: { status: 'processing' }
    });
  }

  async resetStaleProcessing(maxProcessingAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.now() - maxProcessingAgeMs);

    const result = await prisma.deliveryTask.updateMany({
      where: {
        status: 'processing',
        updatedAt: { lt: cutoff }
      },
      data: {
        status: 'pending',
        nextRetryAt: new Date()
      }
    });

    return result.count;
  }

  async findByStatus(status: TaskStatus): Promise<DeliveryTaskWithDetails[]> {
    return prisma.deliveryTask.findMany({
      where: { status },
      include: {
        event: true,
        endpoint: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async findAll(): Promise<DeliveryTaskWithDetails[]> {
    return prisma.deliveryTask.findMany({
      include: {
        event: true,
        endpoint: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }
}