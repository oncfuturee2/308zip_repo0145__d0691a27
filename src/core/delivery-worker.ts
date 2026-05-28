import { QueueService } from '../services/queue.service';
import { DeliveryService } from '../services/delivery.service';
import { RetryStrategy } from '../core';
import { prisma } from '../services/prisma-client';
import { DeliveryTask, WebhookEvent, WebhookEndpoint } from '@prisma/client';

export interface WorkerDependencies {
  queueService: QueueService;
  deliveryService: DeliveryService;
  retryStrategy: RetryStrategy;
}

export class DeliveryWorker {
  private readonly queueService: QueueService;
  private readonly deliveryService: DeliveryService;
  private readonly retryStrategy: RetryStrategy;
  private isRunning: boolean = false;
  private pollIntervalMs: number;
  private workerLoop: ReturnType<typeof setInterval> | null = null;

  constructor(deps: WorkerDependencies, pollIntervalMs: number = 1000) {
    this.queueService = deps.queueService;
    this.deliveryService = deps.deliveryService;
    this.retryStrategy = deps.retryStrategy;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.scheduleNextPoll();
  }

  stop(): void {
    this.isRunning = false;
    if (this.workerLoop) {
      clearTimeout(this.workerLoop);
      this.workerLoop = null;
    }
  }

  private scheduleNextPoll(): void {
    if (!this.isRunning) {
      return;
    }

    this.workerLoop = setTimeout(async () => {
      await this.processNextTask();
      this.scheduleNextPoll();
    }, this.pollIntervalMs);
  }

  async processNextTask(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    const task = await this.queueService.getNextPendingTask();

    if (!task) {
      return;
    }

    await this.processTask(task);
  }

  private async processTask(
    task: DeliveryTask & { event: WebhookEvent; endpoint: WebhookEndpoint }
  ): Promise<void> {
    let markedProcessing = false;

    try {
      await this.queueService.markAsProcessing(task.id);
      markedProcessing = true;

      const attempt = await this.deliveryService.executeDelivery(
        task.event,
        task.endpoint,
        task.attemptNumber
      );

      if (attempt.isSuccess) {
        await this.queueService.markAsCompleted(task.id);
        return;
      }

      const errorMessage = attempt.errorMessage || `HTTP ${attempt.statusCode}`;
      const canRetry = this.retryStrategy.canRetry(attempt.statusCode);
      const canRetryByAttempt = await this.deliveryService.canRetryByAttemptCount(
        task.eventId,
        task.endpointId
      );

      if (canRetry && canRetryByAttempt) {
        const delayMs = this.retryStrategy.getNextDelayMs(task.attemptNumber);
        const nextRetryAt = new Date(Date.now() + delayMs);

        await this.queueService.markAsFailed(task.id, errorMessage, nextRetryAt);
      } else {
        await this.queueService.markAsFailed(task.id, errorMessage, null);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      if (markedProcessing) {
        const canRetryByAttempt = await this.deliveryService.canRetryByAttemptCount(
          task.eventId,
          task.endpointId
        );

        if (canRetryByAttempt) {
          const delayMs = this.retryStrategy.getNextDelayMs(task.attemptNumber);
          const nextRetryAt = new Date(Date.now() + delayMs);

          await this.queueService.markAsFailed(task.id, errorMessage, nextRetryAt);
        } else {
          await this.queueService.markAsFailed(task.id, errorMessage, null);
        }
      }
    }
  }

  async processAllPendingTasks(): Promise<number> {
    let processedCount = 0;

    while (this.isRunning) {
      const task = await this.queueService.getNextPendingTask();
      if (!task) {
        break;
      }

      await this.processTask(task);
      processedCount++;
    }

    return processedCount;
  }

  getStatus(): { isRunning: boolean; pollIntervalMs: number } {
    return {
      isRunning: this.isRunning,
      pollIntervalMs: this.pollIntervalMs
    };
  }
}

let globalWorker: DeliveryWorker | null = null;

export function createAndStartWorker(deps: WorkerDependencies): DeliveryWorker {
  if (globalWorker) {
    globalWorker.stop();
  }

  globalWorker = new DeliveryWorker(deps);
  globalWorker.start();

  return globalWorker;
}

export function getGlobalWorker(): DeliveryWorker | null {
  return globalWorker;
}

export function stopGlobalWorker(): void {
  if (globalWorker) {
    globalWorker.stop();
    globalWorker = null;
  }
}