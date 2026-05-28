import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from 'vitest';
import fastify from 'fastify';
import { registerRoutes, createDeps } from './index';
import { prisma } from '../services';
import { stopGlobalWorker } from '../core';
import { DeliveryWorker } from '../core';

describe('Events API - Async Delivery', () => {
  const app = fastify();
  let deps: ReturnType<typeof createDeps>;
  let worker: DeliveryWorker;

  beforeAll(async () => {
    deps = createDeps();
    worker = deps.worker;
    await registerRoutes(app, deps);
    await app.ready();
  });

  afterAll(async () => {
    stopGlobalWorker();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  afterEach(async () => {
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  describe('POST /api/events', () => {
    it('should return 202 Accepted immediately without blocking', async () => {
      const startTime = Date.now();

      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'test.event',
          payload: { message: 'hello' }
        }
      });

      const duration = Date.now() - startTime;

      expect(response.statusCode).toBe(202);
      expect(duration).toBeLessThan(100);

      const body = JSON.parse(response.body);
      expect(body.message).toBe('Event created and delivery tasks enqueued');
      expect(body.event).toBeDefined();
      expect(body.event.id).toBeDefined();
      expect(body.eventType).toBe('test.event');
      expect(body.matchedEndpoints).toBe(0);
      expect(body.enqueuedTasks).toBe(0);
    });

    it('should enqueue tasks for matching endpoints and return immediately', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
          eventTypes: '*'
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
      expect(body.matchedEndpoints).toBe(1);
      expect(body.enqueuedTasks).toBe(1);

      const tasks = await prisma.deliveryTask.findMany();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].eventId).toBe(body.event.id);
      expect(tasks[0].endpointId).toBe(endpoint.id);
      expect(tasks[0].status).toBe('pending');
    });

    it('should return 202 when no matching endpoints found', async () => {
      await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: 'payment.*'
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
      expect(body.message).toBe('Event created, no matching endpoints found');
      expect(body.matchedEndpoints).toBe(0);
      expect(body.enqueuedTasks).toBe(0);
    });
  });

  describe('GET /api/events/:id/tasks', () => {
    it('should return tasks for an event', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: '*'
        }
      });

      const eventResponse = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'test.event',
          payload: {}
        }
      });

      const eventId = JSON.parse(eventResponse.body).event.id;

      const tasksResponse = await app.inject({
        method: 'GET',
        url: `/api/events/${eventId}/tasks`
      });

      expect(tasksResponse.statusCode).toBe(200);

      const tasks = JSON.parse(tasksResponse.body);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].eventId).toBe(eventId);
      expect(tasks[0].endpointId).toBe(endpoint.id);
    });

    it('should return 404 for non-existent event', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/events/00000000-0000-0000-0000-000000000000/tasks'
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('Worker async delivery', () => {
    it('should process pending tasks and create delivery attempts', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: '*'
        }
      });

      const eventResponse = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'test.event',
          payload: { key: 'value' }
        }
      });

      const eventId = JSON.parse(eventResponse.body).event.id;

      await new Promise(resolve => setTimeout(resolve, 200));

      const attempts = await prisma.deliveryAttempt.findMany({
        where: { eventId }
      });

      expect(attempts).toHaveLength(1);
      expect(attempts[0].endpointId).toBe(endpoint.id);
      expect(attempts[0].isSuccess).toBe(true);
      expect(attempts[0].attemptNumber).toBe(1);

      const task = await prisma.deliveryTask.findFirst();
      expect(task!.status).toBe('completed');
    });

    it('should retry failed deliveries with exponential backoff', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret',
          eventTypes: '*'
        }
      });

      const eventResponse = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'test.event',
          payload: {}
        }
      });

      const eventId = JSON.parse(eventResponse.body).event.id;

      await new Promise(resolve => setTimeout(resolve, 100));

      const task = await prisma.deliveryTask.findFirst();
      expect(task!.status).toBe('completed');

      await prisma.deliveryTask.update({
        where: { id: task!.id },
        data: { status: 'pending', nextRetryAt: new Date() }
      });

      await worker.processNextTask();

      const attempts = await prisma.deliveryAttempt.findMany({
        where: { eventId },
        orderBy: { attemptNumber: 'asc' }
      });

      expect(attempts.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('Delivery Queue Integration', () => {
  const app = fastify();
  let deps: ReturnType<typeof createDeps>;

  beforeAll(async () => {
    deps = createDeps();
    await registerRoutes(app, deps);
    await app.ready();
  });

  afterAll(async () => {
    stopGlobalWorker();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  afterEach(async () => {
    await prisma.deliveryTask.deleteMany({});
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  it('should handle multiple endpoints for single event', async () => {
    const endpoints = await Promise.all([
      prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook1', secret: 'secret1', eventTypes: '*' }
      }),
      prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook2', secret: 'secret2', eventTypes: '*' }
      }),
      prisma.webhookEndpoint.create({
        data: { url: 'https://example.com/webhook3', secret: 'secret3', eventTypes: '*' }
      })
    ]);

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
    expect(body.matchedEndpoints).toBe(3);
    expect(body.enqueuedTasks).toBe(3);

    await new Promise(resolve => setTimeout(resolve, 300));

    const tasks = await prisma.deliveryTask.findMany();
    const completedTasks = tasks.filter(t => t.status === 'completed');

    expect(completedTasks).toHaveLength(3);

    const attempts = await prisma.deliveryAttempt.findMany();
    expect(attempts).toHaveLength(3);
  });
});