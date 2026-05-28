import { randomUUID } from 'crypto';

export interface QueueDeliveryInput {
  eventId: string;
  endpointId: string;
  attemptNumber?: number;
  delayMs?: number;
}

export interface DeliveryQueueJob {
  id: string;
  eventId: string;
  endpointId: string;
  attemptNumber: number;
  availableAt: Date;
  createdAt: Date;
}

export class DeliveryQueueService {
  private readonly jobs: DeliveryQueueJob[] = [];
  private readonly now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  enqueue(input: QueueDeliveryInput): DeliveryQueueJob {
    const existingJob = this.jobs.find((job) => (
      job.eventId === input.eventId &&
      job.endpointId === input.endpointId &&
      job.attemptNumber === (input.attemptNumber ?? 1)
    ));

    if (existingJob) {
      return existingJob;
    }

    const createdAt = this.now();
    const delayMs = Math.max(0, input.delayMs ?? 0);
    const job: DeliveryQueueJob = {
      id: randomUUID(),
      eventId: input.eventId,
      endpointId: input.endpointId,
      attemptNumber: input.attemptNumber ?? 1,
      createdAt,
      availableAt: new Date(createdAt.getTime() + delayMs)
    };

    this.jobs.push(job);
    this.jobs.sort((left, right) => (
      left.availableAt.getTime() - right.availableAt.getTime() ||
      left.createdAt.getTime() - right.createdAt.getTime()
    ));

    return job;
  }

  enqueueMany(inputs: QueueDeliveryInput[]): DeliveryQueueJob[] {
    return inputs.map((input) => this.enqueue(input));
  }

  dequeueDueJobs(limit: number = Number.POSITIVE_INFINITY): DeliveryQueueJob[] {
    const dueJobs: DeliveryQueueJob[] = [];
    const remainingJobs: DeliveryQueueJob[] = [];
    const nowMs = this.now().getTime();

    for (const job of this.jobs) {
      if (dueJobs.length < limit && job.availableAt.getTime() <= nowMs) {
        dueJobs.push(job);
        continue;
      }

      remainingJobs.push(job);
    }

    this.jobs.length = 0;
    this.jobs.push(...remainingJobs);

    return dueJobs;
  }

  getPendingCount(): number {
    return this.jobs.length;
  }

  getJobs(): DeliveryQueueJob[] {
    return [...this.jobs];
  }

  clear(): void {
    this.jobs.length = 0;
  }
}
