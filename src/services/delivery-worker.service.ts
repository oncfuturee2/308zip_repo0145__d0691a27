import { TaskQueue, DeliveryTask } from '../core/task-queue';
import { DeliveryService } from './delivery.service';
import { WebhookEventService } from './webhook-event.service';
import { WebhookEndpointService } from './webhook-endpoint.service';

export class DeliveryWorkerService {
  private queue: TaskQueue;
  private deliveryService: DeliveryService;
  private eventService: WebhookEventService;
  private endpointService: WebhookEndpointService;
  private isRunning: boolean = false;
  private pollIntervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    queue: TaskQueue,
    deliveryService: DeliveryService,
    eventService: WebhookEventService,
    endpointService: WebhookEndpointService,
    pollIntervalMs: number = 1000
  ) {
    this.queue = queue;
    this.deliveryService = deliveryService;
    this.eventService = eventService;
    this.endpointService = endpointService;
    this.pollIntervalMs = pollIntervalMs;
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.poll();
  }

  stop(): void {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const task = this.queue.poll();
      if (task) {
        await this.processTask(task);
        // 继续处理下一个任务
        this.poll();
        return;
      }
    } catch (error) {
      console.error('Worker encountered an error while processing a task:', error);
    }

    if (this.isRunning) {
      this.timer = setTimeout(() => this.poll(), this.pollIntervalMs);
    }
  }

  private async processTask(task: DeliveryTask): Promise<void> {
    try {
      const event = await this.eventService.findById(task.eventId);
      const endpoint = await this.endpointService.findById(task.endpointId);

      if (!event || !endpoint) {
        console.warn(`Task ${task.id}: Event or Endpoint not found.`);
        return;
      }

      const attempt = await this.deliveryService.executeDelivery(
        event,
        endpoint,
        task.attemptNumber
      );

      if (!attempt.isSuccess) {
        const canRetryByStatus = this.deliveryService.canRetry(attempt.statusCode);
        const canRetryByAttempt = await this.deliveryService.canRetryByAttemptCount(task.eventId, task.endpointId);

        if (canRetryByStatus && canRetryByAttempt) {
          const delayMs = this.deliveryService.getNextDelayMs(task.attemptNumber);
          const nextAttemptNumber = task.attemptNumber + 1;
          
          this.queue.push({
            id: `${task.eventId}-${task.endpointId}-${nextAttemptNumber}`,
            eventId: task.eventId,
            endpointId: task.endpointId,
            attemptNumber: nextAttemptNumber,
            executeAt: Date.now() + delayMs
          });
        }
      }
    } catch (error) {
      console.error(`Task ${task.id}: Execution failed`, error);
    }
  }
}
