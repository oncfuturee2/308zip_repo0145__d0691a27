import { DeliveryQueueService, DeliveryTaskWithDetails } from './delivery-queue.service';
import { DeliveryService } from './delivery.service';
import { RetryStrategy } from '../core';

export interface DeliveryWorkerConfig {
  pollingIntervalMs: number;
  staleProcessingTimeoutMs: number;
}

const DEFAULT_CONFIG: DeliveryWorkerConfig = {
  pollingIntervalMs: 5000,
  staleProcessingTimeoutMs: 300000
};

export class DeliveryWorker {
  private readonly queueService: DeliveryQueueService;
  private readonly deliveryService: DeliveryService;
  private readonly retryStrategy: RetryStrategy;
  private readonly config: DeliveryWorkerConfig;
  private intervalHandle: ReturnType<typeof setInterval> | null;
  private running: boolean;

  constructor(
    queueService: DeliveryQueueService,
    deliveryService: DeliveryService,
    retryStrategy: RetryStrategy,
    config: Partial<DeliveryWorkerConfig> = {}
  ) {
    this.queueService = queueService;
    this.deliveryService = deliveryService;
    this.retryStrategy = retryStrategy;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.intervalHandle = null;
    this.running = false;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.intervalHandle = setInterval(
      () => this.poll(),
      this.config.pollingIntervalMs
    );
  }

  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async poll(): Promise<void> {
    try {
      await this.queueService.resetStaleProcessing(
        this.config.staleProcessingTimeoutMs
      );

      const task = await this.queueService.dequeuePending();
      if (!task) {
        return;
      }

      await this.processTask(task);
    } catch (error) {
      console.error('DeliveryWorker poll error:', error);
    }
  }

  private async processTask(task: DeliveryTaskWithDetails): Promise<void> {
    const attemptNumber = task.attemptNumber + 1;

    try {
      const attempt = await this.deliveryService.executeDelivery(
        task.event,
        task.endpoint,
        attemptNumber
      );

      if (attempt.isSuccess) {
        await this.queueService.markCompleted(task.id);
        return;
      }

      await this.handleFailedDelivery(task.id, attemptNumber, attempt.statusCode, attempt.errorMessage);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.handleFailedDelivery(task.id, attemptNumber, null, errorMessage);
    }
  }

  private async handleFailedDelivery(
    taskId: string,
    attemptNumber: number,
    statusCode: number | null,
    errorMessage: string | undefined
  ): Promise<void> {
    const canRetryStatus = this.retryStrategy.canRetry(statusCode);
    const canRetryAttempt = this.retryStrategy.canRetryByAttempt(attemptNumber);

    if (canRetryStatus && canRetryAttempt) {
      const delayMs = this.retryStrategy.getNextDelayMs(attemptNumber);
      const nextRetryAt = new Date(Date.now() + delayMs);

      await this.queueService.markFailed(taskId, errorMessage || 'Delivery failed', statusCode);
      await this.queueService.scheduleRetry(taskId, attemptNumber, nextRetryAt);
    } else {
      await this.queueService.markFailed(taskId, errorMessage || 'Delivery failed', statusCode);
    }
  }
}