import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fastify from 'fastify';
import { registerRoutes, createDeps } from './index';
import { prisma } from '../services';

describe('Statistics API', () => {
  const app = fastify();
  const deps = createDeps();

  beforeAll(async () => {
    await registerRoutes(app, deps);
    await app.ready();
  });

  afterAll(async () => {
    deps.workerService.stop();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  afterEach(async () => {
    await prisma.deliveryAttempt.deleteMany({});
    await prisma.webhookEvent.deleteMany({});
    await prisma.webhookEndpoint.deleteMany({});
  });

  describe('GET /api/statistics', () => {
    it('should return correct structure with summary and breakdown when no data exists', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('summary');
      expect(body).toHaveProperty('breakdown');

      expect(body.summary).toHaveProperty('totalEvents');
      expect(body.summary).toHaveProperty('totalDeliveries');
      expect(body.summary).toHaveProperty('totalSuccesses');
      expect(body.summary).toHaveProperty('totalFailures');
      expect(body.summary).toHaveProperty('failureRate');
      expect(body.summary).toHaveProperty('avgDurationMs');

      expect(body.breakdown).toHaveProperty('byEndpoint');
      expect(body.breakdown).toHaveProperty('byEventType');

      expect(body.breakdown.byEndpoint).toBeInstanceOf(Array);
      expect(body.breakdown.byEventType).toBeInstanceOf(Array);

      expect(body.summary.totalEvents).toBe(0);
      expect(body.summary.totalDeliveries).toBe(0);
      expect(body.summary.totalSuccesses).toBe(0);
      expect(body.summary.totalFailures).toBe(0);
      expect(body.summary.failureRate).toBe(0);
      expect(body.summary.avgDurationMs).toBe(0);
      expect(body.breakdown.byEndpoint).toHaveLength(0);
      expect(body.breakdown.byEventType).toHaveLength(0);
    });

    it('should return correct summary structure with data', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
        },
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 100,
          errorMessage: 'Internal Server Error',
          attemptNumber: 2,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.summary.totalEvents).toBe(1);
      expect(body.summary.totalDeliveries).toBe(2);
      expect(body.summary.totalSuccesses).toBe(1);
      expect(body.summary.totalFailures).toBe(1);
      expect(body.summary.failureRate).toBe(50);
      expect(body.summary.avgDurationMs).toBe(75);
    });

    it('should return correct breakdown.byEndpoint structure', async () => {
      const endpoint1 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook/orders',
          secret: 'test-secret-123',
        },
      });

      const endpoint2 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook/payments',
          secret: 'test-secret-456',
        },
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint1.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint2.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 100,
          errorMessage: 'Error',
          attemptNumber: 1,
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint2.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 60,
          attemptNumber: 2,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.breakdown.byEndpoint).toHaveLength(2);

      const ordersEndpoint = body.breakdown.byEndpoint.find(
        (ep: Record<string, unknown>) => ep.endpointUrl === 'https://example.com/webhook/orders'
      );
      const paymentsEndpoint = body.breakdown.byEndpoint.find(
        (ep: Record<string, unknown>) => ep.endpointUrl === 'https://example.com/webhook/payments'
      );

      expect(ordersEndpoint).toBeDefined();
      expect(ordersEndpoint.endpointId).toBe(endpoint1.id);
      expect(ordersEndpoint.totalDeliveries).toBe(1);
      expect(ordersEndpoint.successCount).toBe(1);
      expect(ordersEndpoint.failureCount).toBe(0);
      expect(ordersEndpoint.failureRate).toBe(0);
      expect(ordersEndpoint.avgDurationMs).toBe(50);

      expect(paymentsEndpoint).toBeDefined();
      expect(paymentsEndpoint.endpointId).toBe(endpoint2.id);
      expect(paymentsEndpoint.totalDeliveries).toBe(2);
      expect(paymentsEndpoint.successCount).toBe(1);
      expect(paymentsEndpoint.failureCount).toBe(1);
      expect(paymentsEndpoint.failureRate).toBe(50);
      expect(paymentsEndpoint.avgDurationMs).toBe(80);
    });

    it('should return correct breakdown.byEventType structure', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
        },
      });

      const event1 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
        },
      });

      const event2 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'ORD-002' }),
        },
      });

      const event3 = await prisma.webhookEvent.create({
        data: {
          eventType: 'payment.failed',
          payload: JSON.stringify({ paymentId: 'PAY-001' }),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 2,
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event2.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.breakdown.byEventType).toHaveLength(2);

      const orderCreated = body.breakdown.byEventType.find(
        (et: Record<string, unknown>) => et.eventType === 'order.created'
      );
      const orderUpdated = body.breakdown.byEventType.find(
        (et: Record<string, unknown>) => et.eventType === 'order.updated'
      );

      expect(orderCreated).toBeDefined();
      expect(orderCreated.count).toBe(2);
      expect(orderCreated.percentage).toBeCloseTo(66.67);

      expect(orderUpdated).toBeDefined();
      expect(orderUpdated.count).toBe(1);
      expect(orderUpdated.percentage).toBeCloseTo(33.33);
    });
  });

  describe('Time range filtering', () => {
    it('should filter by startTime parameter', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
        },
      });

      const oldEvent = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'OLD-001' }),
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      });

      const newEvent = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'NEW-001' }),
          createdAt: new Date('2024-03-15T10:00:00Z'),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: oldEvent.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: newEvent.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 60,
          attemptNumber: 1,
          createdAt: new Date('2024-03-15T10:00:00Z'),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics?startTime=2024-03-01T00:00:00Z',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.summary.totalEvents).toBe(1);
      expect(body.summary.totalDeliveries).toBe(1);
      expect(body.breakdown.byEventType).toHaveLength(1);
      expect(body.breakdown.byEventType[0].eventType).toBe('order.updated');
    });

    it('should filter by endTime parameter', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
        },
      });

      const oldEvent = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'OLD-001' }),
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      });

      const newEvent = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'NEW-001' }),
          createdAt: new Date('2024-03-15T10:00:00Z'),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: oldEvent.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: newEvent.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 60,
          attemptNumber: 1,
          createdAt: new Date('2024-03-15T10:00:00Z'),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics?endTime=2024-02-28T23:59:59Z',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.summary.totalEvents).toBe(1);
      expect(body.summary.totalDeliveries).toBe(1);
      expect(body.breakdown.byEventType).toHaveLength(1);
      expect(body.breakdown.byEventType[0].eventType).toBe('order.created');
    });

    it('should filter by both startTime and endTime parameters', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
        },
      });

      const event1 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'JAN-001' }),
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      });

      const event2 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'FEB-001' }),
          createdAt: new Date('2024-02-15T10:00:00Z'),
        },
      });

      const event3 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.cancelled',
          payload: JSON.stringify({ orderId: 'MAR-001' }),
          createdAt: new Date('2024-03-15T10:00:00Z'),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
          createdAt: new Date('2024-01-15T10:00:00Z'),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event2.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 60,
          attemptNumber: 1,
          createdAt: new Date('2024-02-15T10:00:00Z'),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event3.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 70,
          attemptNumber: 1,
          createdAt: new Date('2024-03-15T10:00:00Z'),
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics?startTime=2024-02-01T00:00:00Z&endTime=2024-02-29T23:59:59Z',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.summary.totalEvents).toBe(1);
      expect(body.summary.totalDeliveries).toBe(1);
      expect(body.breakdown.byEventType).toHaveLength(1);
      expect(body.breakdown.byEventType[0].eventType).toBe('order.updated');
    });

    it('should return 400 for invalid datetime format', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics?startTime=invalid-date',
      });

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBe('Invalid query parameters');
      expect(body.details).toBeDefined();
    });
  });

  describe('GET /api/statistics/summary', () => {
    it('should return only summary without breakdown', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
        },
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics/summary',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('totalEvents');
      expect(body).toHaveProperty('totalDeliveries');
      expect(body).toHaveProperty('totalSuccesses');
      expect(body).toHaveProperty('totalFailures');
      expect(body).toHaveProperty('failureRate');
      expect(body).toHaveProperty('avgDurationMs');
      expect(body).not.toHaveProperty('breakdown');
    });
  });

  describe('GET /api/statistics/breakdown/endpoint', () => {
    it('should return only endpoint breakdown', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
        },
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics/breakdown/endpoint',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toBeInstanceOf(Array);
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('endpointId');
      expect(body[0]).toHaveProperty('endpointUrl');
      expect(body[0]).toHaveProperty('totalDeliveries');
      expect(body[0]).toHaveProperty('successCount');
      expect(body[0]).toHaveProperty('failureCount');
      expect(body[0]).toHaveProperty('failureRate');
      expect(body[0]).toHaveProperty('avgDurationMs');
    });
  });

  describe('GET /api/statistics/breakdown/event-type', () => {
    it('should return only event type breakdown', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook',
          secret: 'test-secret-123',
        },
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
        },
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/api/statistics/breakdown/event-type',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body).toBeInstanceOf(Array);
      expect(body).toHaveLength(1);
      expect(body[0]).toHaveProperty('eventType');
      expect(body[0]).toHaveProperty('count');
      expect(body[0]).toHaveProperty('percentage');
    });
  });
});
