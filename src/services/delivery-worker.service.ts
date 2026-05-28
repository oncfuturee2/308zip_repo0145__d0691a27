import { RetryStrategy } from '../core';
import { DeliveryService } from './delivery.service';
import { DeliveryQueueJob, DeliveryQueueService } from './delivery-queue.service';
import { WebhookEndpointService } from './webhook-endpoint.service';
import { WebhookEventService } from './webhook-event.service';

export interface DeliveryWorkerConfig {
  pollIntervalMs: number;
  batchSize: number;
}

export class DeliveryWorkerService {
  private readonly config: DeliveryWorkerConfig;
  private timer: NodeJS.Timeout | null = null;
  private isProcessing = false;

  constructor(
    private readonly deliveryQueue: DeliveryQueueService,
    private readonly eventService: WebhookEventService,
    private readonly endpointService: WebhookEndpointService,
    private readonly deliveryService: DeliveryService,
    private readonly retryStrategy: RetryStrategy,
    config: Partial<DeliveryWorkerConfig> = {}
  ) {
    this.config = {
      pollIntervalMs: config.pollIntervalMs ?? 100,
      batchSize: config.batchSize ?? 10
    };
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.processDueJobs();
    }, this.config.pollIntervalMs);

    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  async processDueJobs(): Promise<number> {
    if (this.isProcessing) {
      return 0;
    }

    this.isProcessing = true;

    try {
      const jobs = this.deliveryQueue.dequeueDueJobs(this.config.batchSize);

      for (const job of jobs) {
        await this.processJob(job);
      }

      return jobs.length;
    } finally {
      this.isProcessing = false;
    }
  }

  private async processJob(job: DeliveryQueueJob): Promise<void> {
    const event = await this.eventService.findById(job.eventId);
    const endpoint = await this.endpointService.findById(job.endpointId);

    if (!event || !endpoint) {
      return;
    }

    const attempt = await this.deliveryService.executeDelivery(event, endpoint, job.attemptNumber);

    if (attempt.isSuccess) {
      return;
    }

    if (!this.retryStrategy.canRetry(attempt.statusCode)) {
      return;
    }

    if (!this.retryStrategy.canRetryByAttempt(job.attemptNumber)) {
      return;
    }

    this.deliveryQueue.enqueue({
      eventId: job.eventId,
      endpointId: job.endpointId,
      attemptNumber: job.attemptNumber + 1,
      delayMs: this.retryStrategy.getNextDelayMs(job.attemptNumber)
    });
  }
}
