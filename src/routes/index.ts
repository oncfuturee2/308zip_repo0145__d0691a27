import { FastifyInstance } from 'fastify';
import { registerEndpointRoutes } from './endpoints';
import { registerEventRoutes } from './events';
import { registerDeliveryRoutes } from './deliveries';
import { registerStatisticsRoutes } from './statistics';
import { prisma } from '../services/prisma-client';
import {
  WebhookEndpointService,
  WebhookEventService,
  DeliveryService,
  StatisticsService
} from '../services';
import {
  EventMatcher,
  SignatureGenerator,
  MockHttpClient,
  DeliveryExecutor,
  RetryStrategy
} from '../core';

export interface RouteDeps {
  endpointService: WebhookEndpointService;
  eventService: WebhookEventService;
  deliveryService: DeliveryService;
  statisticsService: StatisticsService;
  eventMatcher: EventMatcher;
}

export function createDeps(): RouteDeps {
  const eventMatcher = new EventMatcher();
  const signatureGenerator = new SignatureGenerator();
  const httpClient = new MockHttpClient(1.0, 200, 50);
  const deliveryExecutor = new DeliveryExecutor(httpClient, signatureGenerator);
  const retryStrategy = new RetryStrategy();

  const endpointService = new WebhookEndpointService();
  const eventService = new WebhookEventService(eventMatcher);
  const deliveryService = new DeliveryService(deliveryExecutor, retryStrategy);
  const statisticsService = new StatisticsService();

  return {
    endpointService,
    eventService,
    deliveryService,
    statisticsService,
    eventMatcher
  };
}

export async function registerRoutes(
  fastify: FastifyInstance,
  deps: RouteDeps
): Promise<void> {
  await fastify.register(async (instance) => {
    registerEndpointRoutes(instance, deps);
    registerEventRoutes(instance, deps);
    registerDeliveryRoutes(instance, deps);
    registerStatisticsRoutes(instance, deps);
  }, { prefix: '/api' });

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });

  fastify.get('/health/detailed', async () => {
    const [activeEndpoints, totalEvents, failedDeliveries] = await Promise.all([
      prisma.webhookEndpoint.count({ where: { isActive: true } }),
      prisma.webhookEvent.count(),
      prisma.deliveryAttempt.count({ where: { isSuccess: false } }),
    ]);

    return {
      status: 'ok',
      activeEndpoints,
      totalEvents,
      failedDeliveries,
      timestamp: new Date().toISOString()
    };
  });
}
