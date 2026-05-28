import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import fastify from 'fastify';
import { registerRoutes, createDeps } from './index';
import { prisma } from '../services';

describe('Events API', () => {
  const app = fastify();
  const deps = createDeps();

  beforeAll(async () => {
    deps.workerService.stop(); // Stop the worker so it doesn't consume the tasks we are trying to inspect
    await registerRoutes(app, deps);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    deps.taskQueue.clear();
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  afterEach(async () => {
    deps.taskQueue.clear();
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  describe('POST /api/events', () => {
    it('should return 202 and queue tasks when endpoints match', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'secret123',
          eventTypes: 'order.*'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: '123' }
        }
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      
      expect(body.message).toBe('Event accepted and queued for delivery');
      expect(body.event.eventType).toBe('order.created');
      expect(body.matchedEndpoints).toBe(1);

      // Verify task is in the queue
      expect(deps.taskQueue.size()).toBe(1);
      const task = deps.taskQueue.poll();
      expect(task).toBeDefined();
      expect(task?.endpointId).toBe(endpoint.id);
      expect(task?.attemptNumber).toBe(1);
    });

    it('should return 202 and queue nothing if no endpoints match', async () => {
      await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'secret123',
          eventTypes: 'payment.*'
        }
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/events',
        payload: {
          eventType: 'order.created',
          payload: { orderId: '123' }
        }
      });

      expect(response.statusCode).toBe(202);
      const body = JSON.parse(response.body);
      
      expect(body.message).toBe('Event accepted, no matching endpoints found');
      expect(body.matchedEndpoints).toBe(0);

      // Verify task queue is empty
      expect(deps.taskQueue.size()).toBe(0);
    });
  });
});
