import { prisma } from './prisma-client';
import { WebhookEndpoint } from '@prisma/client';
import * as crypto from 'crypto';

export interface CreateWebhookEndpointInput {
  url: string;
  eventTypes: string;
  isActive?: boolean;
  secret?: string;
}

export interface UpdateWebhookEndpointInput {
  url?: string;
  eventTypes?: string;
  isActive?: boolean;
  secret?: string;
}

export class WebhookEndpointService {
  generateSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  async create(input: CreateWebhookEndpointInput): Promise<WebhookEndpoint> {
    const secret = input.secret ?? this.generateSecret();
    return prisma.webhookEndpoint.create({
      data: {
        url: input.url,
        eventTypes: input.eventTypes,
        secret,
        isActive: input.isActive ?? true
      }
    });
  }

  async findById(id: string): Promise<WebhookEndpoint | null> {
    return prisma.webhookEndpoint.findUnique({
      where: { id }
    });
  }

  async findAll(includeInactive: boolean = false): Promise<WebhookEndpoint[]> {
    const where = includeInactive ? {} : { isActive: true };
    return prisma.webhookEndpoint.findMany({
      where,
      orderBy: { createdAt: 'desc' }
    });
  }

  async update(
    id: string,
    input: UpdateWebhookEndpointInput
  ): Promise<WebhookEndpoint> {
    const data: Partial<WebhookEndpoint> = {};
    
    if (input.url !== undefined) data.url = input.url;
    if (input.eventTypes !== undefined) data.eventTypes = input.eventTypes;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.secret !== undefined) data.secret = input.secret;

    return prisma.webhookEndpoint.update({
      where: { id },
      data
    });
  }

  async regenerateSecret(id: string): Promise<string> {
    const secret = this.generateSecret();
    await prisma.webhookEndpoint.update({
      where: { id },
      data: { secret }
    });
    return secret;
  }

  async delete(id: string): Promise<WebhookEndpoint> {
    return prisma.webhookEndpoint.delete({
      where: { id }
    });
  }

  async findMatchingEndpoints(eventType: string): Promise<WebhookEndpoint[]> {
    return prisma.webhookEndpoint.findMany({
      where: { isActive: true }
    });
  }
}
