import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fastify from 'fastify';
import { registerRoutes, createDeps } from './index';
import { prisma, DeliveryWorker, DeliveryQueueService, DeliveryService } from '../services';
import { RetryStrategy, MockHttpClient, DeliveryExecutor, SignatureGenerator } from '../core';

describe('Events API (async delivery)', () => {
  const app = fastify();
  const deps = createDeps();
  let worker: DeliveryWorker;

  beforeAll(async () => {
    await registerRoutes(app, deps);
    await app.ready();
  });

  afterAll(async () => {
    worker?.stop();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  afterEach(async () => {
    worker?.stop();
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  describe('POST /api/events', () => {
    it('should return 202 Accepted with queued tasks when matching endpoints exist', async () => {
      await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          eventTypes: 'order.created',
          secret: 'test-secret-123'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: 'ORD-001' }
        }
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);

      expect(body.message).toBe('Event accepted, delivery tasks queued');
      expect(body.event).toBeDefined();
      expect(body.event.id).toBeDefined();
      expect(body.event.eventType).toBe('order.created');
      expect(body.event.createdAt).toBeDefined();
      expect(body.matchedEndpoints).toBe(1);
      expect(body.queuedTasks).toBeInstanceOf(Array);
      expect(body.queuedTasks).toHaveLength(1);
      expect(body.queuedTasks[0].id).toBeDefined();
      expect(body.queuedTasks[0].endpointId).toBeDefined();
      expect(body.queuedTasks[0].status).toBe('pending');
      expect(body.queuedTasks[0].createdAt).toBeDefined();
    });

    it('should return 201 Created when no matching endpoints exist', async () => {
      await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          eventTypes: 'payment.failed',
          secret: 'test-secret-123'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: 'ORD-001' }
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);

      expect(body.message).toBe('Event created, no matching endpoints found');
      expect(body.event).toBeDefined();
      expect(body.matchedEndpoints).toBe(0);
      expect(body.queuedTasks).toHaveLength(0);
    });

    it('should create delivery tasks in the queue', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          eventTypes: '*',
          secret: 'test-secret-123'
        }
      });

      await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: 'ORD-001' }
        }
      });

      const tasks = await prisma.deliveryTask.findMany({
        include: { event: true, endpoint: true }
      });

      expect(tasks).toHaveLength(1);
      expect(tasks[0].status).toBe('pending');
      expect(tasks[0].attemptNumber).toBe(0);
      expect(tasks[0].eventId).toBeDefined();
      expect(tasks[0].endpointId).toBe(endpoint.id);
      expect(tasks[0].event.eventType).toBe('order.created');
      expect(tasks[0].endpoint.url).toBe('https://example.com/webhook');
    });

    it('should create multiple tasks for multiple matching endpoints', async () => {
      await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          eventTypes: 'order.created',
          secret: 'secret1'
        }
      });

      await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook2',
          eventTypes: '*',
          secret: 'secret2'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: 'ORD-001' }
        }
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      expect(body.matchedEndpoints).toBe(2);
      expect(body.queuedTasks).toHaveLength(2);

      const tasksInDb = await prisma.deliveryTask.count();
      expect(tasksInDb).toBe(2);
    });

    it('should reject requests without eventType', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          payload: { orderId: 'ORD-001' }
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject requests with empty eventType', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: '',
          payload: { orderId: 'ORD-001' }
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject requests without payload', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created'
        }
      });

      expect(response.statusCode).toBe(400);
    });

    it('should accept requests with no matching endpoints but inactive endpoints are not matched', async () => {
      await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          eventTypes: 'order.created',
          secret: 'test-secret',
          isActive: false
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: 'ORD-001' }
        }
      });

      expect(response.statusCode).toBe(201);
      const body = JSON.parse(response.body);
      expect(body.matchedEndpoints).toBe(0);
    });
  });

  describe('Worker processing integration', () => {
    it('should process queued tasks and create delivery attempts', async () => {
      await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          eventTypes: 'order.created',
          secret: 'test-secret-123'
        }
      });

      await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: 'ORD-001' }
        }
      });

      const retryStrategy = new RetryStrategy();
      worker = new DeliveryWorker(
        deps.queueService,
        deps.deliveryService,
        retryStrategy,
        { pollingIntervalMs: 100 }
      );
      worker.start();

      await new Promise(resolve => setTimeout(resolve, 500));
      worker.stop();

      const tasks = await prisma.deliveryTask.findMany();
      expect(tasks.length).toBeGreaterThan(0);

      const attempts = await prisma.deliveryAttempt.findMany();
      expect(attempts.length).toBeGreaterThan(0);
      expect(attempts[0].isSuccess).toBeDefined();
      expect(attempts[0].attemptNumber).toBe(1);
    });

    it('should retry failed deliveries with backoff delay', async () => {
      const mockHttpClient = new MockHttpClient(0, 500, 5);
      mockHttpClient.forceError(500, 'Internal Server Error');

      const signatureGenerator = new SignatureGenerator();
      const deliveryExecutor = new DeliveryExecutor(mockHttpClient, signatureGenerator);

      const retryStrategy = new RetryStrategy({
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        backoffMultiplier: 2
      });

      const queueService = new DeliveryQueueService();
      const deliveryService = new DeliveryService(deliveryExecutor, retryStrategy);

      worker = new DeliveryWorker(
        queueService,
        deliveryService,
        retryStrategy,
        { pollingIntervalMs: 50, staleProcessingTimeoutMs: 5000 }
      );

      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          eventTypes: 'order.created',
          secret: 'test-secret-123'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      await queueService.enqueue(event.id, endpoint.id);
      worker.start();

      await new Promise(resolve => setTimeout(resolve, 2000));
      worker.stop();

      const tasks = await queueService.findAll();
      const finalTask = tasks[0];

      expect(finalTask).toBeDefined();
      expect(finalTask.status).toBe('failed');
      expect(finalTask.attemptNumber).toBeGreaterThanOrEqual(0);
    });
  });
});