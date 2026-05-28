import { prisma } from './prisma-client';
import { DeliveryQueue, WebhookEvent, WebhookEndpoint } from '@prisma/client';

export interface DeliveryQueueWithDetails extends DeliveryQueue {
  event: WebhookEvent;
  endpoint: WebhookEndpoint;
}

export class DeliveryQueueService {
  async enqueue(
    eventId: string,
    endpointId: string,
    attemptNumber: number = 1,
    nextRunAt: Date = new Date()
  ): Promise<DeliveryQueue> {
    return prisma.deliveryQueue.upsert({
      where: {
        eventId_endpointId: {
          eventId,
          endpointId
        }
      },
      update: {
        status: 'pending',
        attemptNumber,
        nextRunAt,
        updatedAt: new Date()
      },
      create: {
        eventId,
        endpointId,
        status: 'pending',
        attemptNumber,
        nextRunAt
      }
    });
  }

  async dequeue(batchSize: number = 10): Promise<DeliveryQueueWithDetails[]> {
    const now = new Date();
    
    const tasks = await prisma.deliveryQueue.findMany({
      where: {
        status: 'pending',
        nextRunAt: {
          lte: now
        }
      },
      include: {
        event: true,
        endpoint: true
      },
      orderBy: {
        nextRunAt: 'asc'
      },
      take: batchSize
    });

    if (tasks.length === 0) {
      return [];
    }

    const taskIds = tasks.map(task => task.id);
    
    await prisma.deliveryQueue.updateMany({
      where: {
        id: {
          in: taskIds
        }
      },
      data: {
        status: 'processing'
      }
    });

    return tasks;
  }

  async markAsCompleted(taskId: string): Promise<DeliveryQueue> {
    return prisma.deliveryQueue.delete({
      where: { id: taskId }
    });
  }

  async markForRetry(
    taskId: string,
    nextRunAt: Date,
    newAttemptNumber: number
  ): Promise<DeliveryQueue> {
    return prisma.deliveryQueue.update({
      where: { id: taskId },
      data: {
        status: 'pending',
        attemptNumber: newAttemptNumber,
        nextRunAt,
        updatedAt: new Date()
      }
    });
  }

  async markAsFailed(taskId: string): Promise<DeliveryQueue> {
    return prisma.deliveryQueue.delete({
      where: { id: taskId }
    });
  }

  async findById(taskId: string): Promise<DeliveryQueueWithDetails | null> {
    return prisma.deliveryQueue.findUnique({
      where: { id: taskId },
      include: {
        event: true,
        endpoint: true
      }
    });
  }

  async findPending(): Promise<DeliveryQueueWithDetails[]> {
    return prisma.deliveryQueue.findMany({
      where: { status: 'pending' },
      include: {
        event: true,
        endpoint: true
      },
      orderBy: {
        nextRunAt: 'asc'
      }
    });
  }

  async countByStatus(): Promise<{ [key: string]: number }> {
    const counts = await prisma.deliveryQueue.groupBy({
      by: ['status'],
      _count: {
        id: true
      }
    });

    const result: { [key: string]: number } = {};
    for (const item of counts) {
      result[item.status] = item._count.id;
    }
    return result;
  }
}
