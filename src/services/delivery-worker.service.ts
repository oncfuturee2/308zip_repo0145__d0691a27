import { DeliveryQueueService } from './delivery-queue.service';
import { DeliveryService } from './delivery.service';
import { RetryStrategy } from '../core';
import { Logger } from 'fastify';

export class DeliveryWorker {
  private readonly queueService: DeliveryQueueService;
  private readonly deliveryService: DeliveryService;
  private readonly retryStrategy: RetryStrategy;
  private readonly logger?: Logger;
  private isRunning: boolean = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs: number = 1000;
  private readonly batchSize: number = 10;

  constructor(
    queueService: DeliveryQueueService,
    deliveryService: DeliveryService,
    retryStrategy: RetryStrategy,
    logger?: Logger
  ) {
    this.queueService = queueService;
    this.deliveryService = deliveryService;
    this.retryStrategy = retryStrategy;
    this.logger = logger;
  }

  start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.logger?.info('Delivery worker started');
    this.poll();
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollInterval) {
      clearTimeout(this.pollInterval);
      this.pollInterval = null;
    }
    this.logger?.info('Delivery worker stopped');
  }

  private poll(): void {
    if (!this.isRunning) {
      return;
    }

    this.processBatch()
      .catch((err) => {
        this.logger?.error('Error processing batch:', err);
      })
      .finally(() => {
        if (this.isRunning) {
          this.pollInterval = setTimeout(() => this.poll(), this.pollIntervalMs);
        }
      });
  }

  private async processBatch(): Promise<void> {
    const tasks = await this.queueService.dequeue(this.batchSize);
    
    if (tasks.length === 0) {
      return;
    }

    this.logger?.info(`Processing ${tasks.length} delivery tasks`);

    await Promise.all(tasks.map(task => this.processTask(task)));
  }

  private async processTask(task: any): Promise<void> {
    try {
      const attempt = await this.deliveryService.executeDelivery(
        task.event,
        task.endpoint,
        task.attemptNumber
      );

      if (attempt.isSuccess) {
        await this.queueService.markAsCompleted(task.id);
        this.logger?.info(`Delivery successful: ${task.eventId} to ${task.endpointId}`);
      } else {
        await this.handleFailedDelivery(task, attempt.statusCode);
      }
    } catch (err) {
      this.logger?.error(`Error processing task ${task.id}:`, err);
      await this.handleFailedDelivery(task, null);
    }
  }

  private async handleFailedDelivery(
    task: any,
    statusCode: number | null | undefined
  ): Promise<void> {
    const canRetry = this.deliveryService.canRetry(statusCode);
    const canRetryByAttempt = this.retryStrategy.canRetryByAttempt(task.attemptNumber);

    if (canRetry && canRetryByAttempt) {
      const nextDelay = this.retryStrategy.getNextDelayMs(task.attemptNumber);
      const nextRunAt = new Date(Date.now() + nextDelay);
      const newAttemptNumber = task.attemptNumber + 1;

      await this.queueService.markForRetry(task.id, nextRunAt, newAttemptNumber);
      this.logger?.info(
        `Delivery failed, will retry in ${nextDelay}ms: ${task.eventId} to ${task.endpointId} (attempt ${task.attemptNumber})`
      );
    } else {
      await this.queueService.markAsFailed(task.id);
      this.logger?.warn(
        `Delivery failed and will not be retried: ${task.eventId} to ${task.endpointId}`
      );
    }
  }
}
