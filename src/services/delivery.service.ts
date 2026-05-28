import { prisma } from './prisma-client';
import { DeliveryAttempt, WebhookEvent, WebhookEndpoint } from '@prisma/client';
import { 
  DeliveryExecutor, 
  DeliveryRequest, 
  DeliveryResult,
  RetryStrategy
} from '../core';

export interface DeliveryAttemptWithDetails extends DeliveryAttempt {
  event: WebhookEvent;
  endpoint: WebhookEndpoint;
}

export class MaxAttemptsExceededError extends Error {
  constructor(eventId: string, endpointId: string, currentAttempts: number, maxAttempts: number) {
    super(`Maximum attempts (${maxAttempts}) exceeded for event ${eventId} to endpoint ${endpointId}. Current attempts: ${currentAttempts}`);
    this.name = 'MaxAttemptsExceededError';
  }
}

export class DeliveryService {
  private readonly deliveryExecutor: DeliveryExecutor;
  private readonly retryStrategy: RetryStrategy;

  constructor(
    deliveryExecutor: DeliveryExecutor,
    retryStrategy: RetryStrategy
  ) {
    this.deliveryExecutor = deliveryExecutor;
    this.retryStrategy = retryStrategy;
  }

  async getAttemptCount(eventId: string, endpointId: string): Promise<number> {
    return prisma.deliveryAttempt.count({
      where: { eventId, endpointId }
    });
  }

  async getMaxAttemptNumber(eventId: string, endpointId: string): Promise<number> {
    const result = await prisma.deliveryAttempt.aggregate({
      where: { eventId, endpointId },
      _max: { attemptNumber: true }
    });
    return result._max.attemptNumber ?? 0;
  }

  async canRetryByAttemptCount(eventId: string, endpointId: string): Promise<boolean> {
    const maxAttemptNumber = await this.getMaxAttemptNumber(eventId, endpointId);
    return this.retryStrategy.canRetryByAttempt(maxAttemptNumber);
  }

  async getRemainingAttempts(eventId: string, endpointId: string): Promise<number> {
    const maxAttemptNumber = await this.getMaxAttemptNumber(eventId, endpointId);
    return this.retryStrategy.getTotalAttemptsAvailable(maxAttemptNumber);
  }

  async isMaxAttemptsReached(eventId: string, endpointId: string): Promise<boolean> {
    const maxAttemptNumber = await this.getMaxAttemptNumber(eventId, endpointId);
    return this.retryStrategy.isExhausted(maxAttemptNumber);
  }

  async executeDelivery(
    event: WebhookEvent,
    endpoint: WebhookEndpoint,
    attemptNumber: number = 1
  ): Promise<DeliveryAttempt> {
    const deliveryRequest: DeliveryRequest = {
      eventId: event.id,
      eventType: event.eventType,
      payload: event.payload,
      endpointId: endpoint.id,
      endpointUrl: endpoint.url,
      endpointSecret: endpoint.secret,
      attemptNumber
    };

    const deliveryResult = await this.deliveryExecutor.execute(deliveryRequest);

    return this.recordAttempt(
      event.id,
      endpoint.id,
      deliveryResult,
      attemptNumber
    );
  }

  async recordAttempt(
    eventId: string,
    endpointId: string,
    result: DeliveryResult,
    attemptNumber: number
  ): Promise<DeliveryAttempt> {
    return prisma.deliveryAttempt.create({
      data: {
        eventId,
        endpointId,
        statusCode: result.statusCode,
        durationMs: result.durationMs,
        isSuccess: result.isSuccess,
        errorMessage: result.errorMessage,
        attemptNumber
      }
    });
  }

  async retryDelivery(attemptId: string): Promise<DeliveryAttempt> {
    const existingAttempt = await prisma.deliveryAttempt.findUnique({
      where: { id: attemptId },
      include: { event: true, endpoint: true }
    });

    if (!existingAttempt) {
      throw new Error(`Delivery attempt not found: ${attemptId}`);
    }

    if (!this.retryStrategy.canRetry(existingAttempt.statusCode)) {
      throw new Error(`Cannot retry delivery with status code: ${existingAttempt.statusCode}`);
    }

    const maxAttemptNumber = await this.getMaxAttemptNumber(
      existingAttempt.eventId,
      existingAttempt.endpointId
    );

    if (!this.retryStrategy.canRetryByAttempt(maxAttemptNumber)) {
      throw new MaxAttemptsExceededError(
        existingAttempt.eventId,
        existingAttempt.endpointId,
        maxAttemptNumber,
        this.retryStrategy.getMaxAttempts()
      );
    }

    const newAttemptNumber = maxAttemptNumber + 1;

    return this.executeDelivery(
      existingAttempt.event,
      existingAttempt.endpoint,
      newAttemptNumber
    );
  }

  async findByEndpointId(endpointId: string): Promise<DeliveryAttemptWithDetails[]> {
    return prisma.deliveryAttempt.findMany({
      where: { endpointId },
      include: { event: true, endpoint: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  async findByEventId(eventId: string): Promise<DeliveryAttemptWithDetails[]> {
    return prisma.deliveryAttempt.findMany({
      where: { eventId },
      include: { event: true, endpoint: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  async findById(attemptId: string): Promise<DeliveryAttemptWithDetails | null> {
    return prisma.deliveryAttempt.findUnique({
      where: { id: attemptId },
      include: { event: true, endpoint: true }
    });
  }

  async findAll(): Promise<DeliveryAttemptWithDetails[]> {
    return prisma.deliveryAttempt.findMany({
      include: { event: true, endpoint: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  async findFailedAttempts(endpointId?: string): Promise<DeliveryAttemptWithDetails[]> {
    const where: Record<string, unknown> = { isSuccess: false };
    if (endpointId) {
      where.endpointId = endpointId;
    }

    return prisma.deliveryAttempt.findMany({
      where,
      include: { event: true, endpoint: true },
      orderBy: { createdAt: 'desc' }
    });
  }

  canRetry(statusCode: number | null | undefined): boolean {
    return this.retryStrategy.canRetry(statusCode);
  }

  getNextAttemptNumber(existingAttempts: number): number {
    return existingAttempts + 1;
  }
}
