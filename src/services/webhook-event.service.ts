import { prisma } from './prisma-client';
import { WebhookEvent, WebhookEndpoint } from '@prisma/client';
import { EventMatcher } from '../core';

export interface CreateWebhookEventInput {
  eventType: string;
  payload: Record<string, unknown>;
}

export class WebhookEventService {
  private readonly eventMatcher: EventMatcher;

  constructor(eventMatcher: EventMatcher) {
    this.eventMatcher = eventMatcher;
  }

  async create(input: CreateWebhookEventInput): Promise<WebhookEvent> {
    return prisma.webhookEvent.create({
      data: {
        eventType: input.eventType,
        payload: JSON.stringify(input.payload)
      }
    });
  }

  async findById(id: string): Promise<WebhookEvent | null> {
    return prisma.webhookEvent.findUnique({
      where: { id },
      include: { deliveryAttempts: true }
    });
  }

  async findAll(): Promise<WebhookEvent[]> {
    return prisma.webhookEvent.findMany({
      orderBy: { createdAt: 'desc' },
      include: { deliveryAttempts: true }
    });
  }

  filterMatchingEndpoints(
    endpoints: WebhookEndpoint[],
    eventType: string
  ): WebhookEndpoint[] {
    return endpoints.filter(endpoint => 
      this.eventMatcher.isMatch(endpoint.eventTypes, eventType)
    );
  }
}
