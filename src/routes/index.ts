import { FastifyInstance } from 'fastify';
import { registerEndpointRoutes } from './endpoints';
import { registerEventRoutes } from './events';
import { registerDeliveryRoutes } from './deliveries';
import { registerStatisticsRoutes } from './statistics';
import {
  WebhookEndpointService,
  WebhookEventService,
  DeliveryService,
  DeliveryQueueService,
  DeliveryWorkerService,
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
  deliveryQueue: DeliveryQueueService;
  deliveryWorker: DeliveryWorkerService;
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
  const deliveryQueue = new DeliveryQueueService();
  const deliveryWorker = new DeliveryWorkerService(
    deliveryQueue,
    eventService,
    endpointService,
    deliveryService,
    retryStrategy
  );
  const statisticsService = new StatisticsService();

  return {
    endpointService,
    eventService,
    deliveryService,
    deliveryQueue,
    deliveryWorker,
    statisticsService,
    eventMatcher
  };
}

export async function registerRoutes(
  fastify: FastifyInstance,
  deps: RouteDeps
): Promise<void> {
  deps.deliveryWorker.start();

  fastify.addHook('onClose', async () => {
    deps.deliveryWorker.stop();
  });

  await fastify.register(async (instance) => {
    registerEndpointRoutes(instance, deps);
    registerEventRoutes(instance, deps);
    registerDeliveryRoutes(instance, deps);
    registerStatisticsRoutes(instance, deps);
  }, { prefix: '/api' });

  fastify.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() };
  });
}
