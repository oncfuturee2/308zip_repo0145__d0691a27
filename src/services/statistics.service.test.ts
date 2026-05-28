import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { prisma } from './prisma-client';
import { StatisticsService, TimeRangeFilter } from './statistics.service';

describe('StatisticsService', () => {
  const statisticsService = new StatisticsService();

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

  describe('buildWhereClause', () => {
    it('should return empty object when no time range is provided', () => {
      const result = statisticsService.buildWhereClause();
      expect(result).toEqual({});
    });

    it('should return where clause with startTime when only startTime is provided', () => {
      const startTime = new Date('2024-01-01T00:00:00Z');
      const filter: TimeRangeFilter = { startTime };
      const result = statisticsService.buildWhereClause(filter);
      expect(result).toEqual({
        createdAt: { gte: startTime }
      });
    });

    it('should return where clause with endTime when only endTime is provided', () => {
      const endTime = new Date('2024-01-31T23:59:59Z');
      const filter: TimeRangeFilter = { endTime };
      const result = statisticsService.buildWhereClause(filter);
      expect(result).toEqual({
        createdAt: { lte: endTime }
      });
    });

    it('should return where clause with both startTime and endTime when both are provided', () => {
      const startTime = new Date('2024-01-01T00:00:00Z');
      const endTime = new Date('2024-01-31T23:59:59Z');
      const filter: TimeRangeFilter = { startTime, endTime };
      const result = statisticsService.buildWhereClause(filter);
      expect(result).toEqual({
        createdAt: { gte: startTime, lte: endTime }
      });
    });
  });

  describe('getSummary', () => {
    it('should return zeroed summary when there is no data', async () => {
      const summary = await statisticsService.getSummary();
      
      expect(summary.totalEvents).toBe(0);
      expect(summary.totalDeliveries).toBe(0);
      expect(summary.totalSuccesses).toBe(0);
      expect(summary.totalFailures).toBe(0);
      expect(summary.failureRate).toBe(0);
      expect(summary.avgDurationMs).toBe(0);
    });

    it('should return correct summary with successful deliveries', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret123'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      const summary = await statisticsService.getSummary();
      
      expect(summary.totalEvents).toBe(1);
      expect(summary.totalDeliveries).toBe(1);
      expect(summary.totalSuccesses).toBe(1);
      expect(summary.totalFailures).toBe(0);
      expect(summary.failureRate).toBe(0);
      expect(summary.avgDurationMs).toBe(50);
    });

    it('should return correct summary with mixed success and failure deliveries', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret123'
        }
      });

      const event1 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const event2 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'ORD-002' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event2.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 100,
          errorMessage: 'Internal Server Error',
          attemptNumber: 1
        }
      });

      const summary = await statisticsService.getSummary();
      
      expect(summary.totalEvents).toBe(2);
      expect(summary.totalDeliveries).toBe(2);
      expect(summary.totalSuccesses).toBe(1);
      expect(summary.totalFailures).toBe(1);
      expect(summary.failureRate).toBe(50);
      expect(summary.avgDurationMs).toBe(75);
    });

    it('should filter by time range', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret123'
        }
      });

      const event1 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' }),
          createdAt: new Date('2024-01-15T10:00:00Z')
        }
      });

      const event2 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'ORD-002' }),
          createdAt: new Date('2024-02-15T10:00:00Z')
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1,
          createdAt: new Date('2024-01-15T10:00:00Z')
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event2.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 60,
          attemptNumber: 1,
          createdAt: new Date('2024-02-15T10:00:00Z')
        }
      });

      const januaryFilter: TimeRangeFilter = {
        startTime: new Date('2024-01-01T00:00:00Z'),
        endTime: new Date('2024-01-31T23:59:59Z')
      };

      const januarySummary = await statisticsService.getSummary(januaryFilter);
      
      expect(januarySummary.totalEvents).toBe(1);
      expect(januarySummary.totalDeliveries).toBe(1);
    });
  });

  describe('getEndpointBreakdown', () => {
    it('should return empty array when there is no data', async () => {
      const breakdown = await statisticsService.getEndpointBreakdown();
      expect(breakdown).toEqual([]);
    });

    it('should return correct breakdown for single endpoint', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret123'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 100,
          errorMessage: 'Error',
          attemptNumber: 2
        }
      });

      const breakdown = await statisticsService.getEndpointBreakdown();
      
      expect(breakdown.length).toBe(1);
      expect(breakdown[0].endpointId).toBe(endpoint.id);
      expect(breakdown[0].endpointUrl).toBe('https://example.com/webhook1');
      expect(breakdown[0].totalDeliveries).toBe(2);
      expect(breakdown[0].successCount).toBe(1);
      expect(breakdown[0].failureCount).toBe(1);
      expect(breakdown[0].failureRate).toBe(50);
      expect(breakdown[0].avgDurationMs).toBe(75);
    });

    it('should return breakdown ordered by total deliveries descending', async () => {
      const endpoint1 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret123'
        }
      });

      const endpoint2 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook2',
          secret: 'secret123'
        }
      });

      const event = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint1.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint2.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event.id,
          endpointId: endpoint2.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 2
        }
      });

      const breakdown = await statisticsService.getEndpointBreakdown();
      
      expect(breakdown.length).toBe(2);
      expect(breakdown[0].endpointUrl).toBe('https://example.com/webhook2');
      expect(breakdown[0].totalDeliveries).toBe(2);
      expect(breakdown[1].endpointUrl).toBe('https://example.com/webhook1');
      expect(breakdown[1].totalDeliveries).toBe(1);
    });
  });

  describe('getEventTypeBreakdown', () => {
    it('should return empty array when there is no data', async () => {
      const breakdown = await statisticsService.getEventTypeBreakdown();
      expect(breakdown).toEqual([]);
    });

    it('should return correct breakdown for multiple event types', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret123'
        }
      });

      const event1 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const event2 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'ORD-002' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 100,
          errorMessage: 'Error',
          attemptNumber: 2
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event2.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      const breakdown = await statisticsService.getEventTypeBreakdown();
      
      expect(breakdown.length).toBe(2);
      
      const orderCreated = breakdown.find(b => b.eventType === 'order.created');
      const orderUpdated = breakdown.find(b => b.eventType === 'order.updated');
      
      expect(orderCreated?.count).toBe(2);
      expect(orderCreated?.percentage).toBeCloseTo(66.67);
      expect(orderUpdated?.count).toBe(1);
      expect(orderUpdated?.percentage).toBeCloseTo(33.33);
    });

    it('should return breakdown ordered by count descending', async () => {
      const endpoint = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret123'
        }
      });

      const event1 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const event2 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'ORD-002' })
        }
      });

      const event3 = await prisma.webhookEvent.create({
        data: {
          eventType: 'payment.failed',
          payload: JSON.stringify({ paymentId: 'PAY-001' })
        }
      });

      for (let i = 0; i < 3; i++) {
        await prisma.deliveryAttempt.create({
          data: {
            eventId: event1.id,
            endpointId: endpoint.id,
            isSuccess: true,
            statusCode: 200,
            durationMs: 50,
            attemptNumber: i + 1
          }
        });
      }

      for (let i = 0; i < 5; i++) {
        await prisma.deliveryAttempt.create({
          data: {
            eventId: event2.id,
            endpointId: endpoint.id,
            isSuccess: true,
            statusCode: 200,
            durationMs: 50,
            attemptNumber: i + 1
          }
        });
      }

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event3.id,
          endpointId: endpoint.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      const breakdown = await statisticsService.getEventTypeBreakdown();
      
      expect(breakdown.length).toBe(3);
      expect(breakdown[0].eventType).toBe('order.updated');
      expect(breakdown[0].count).toBe(5);
      expect(breakdown[1].eventType).toBe('order.created');
      expect(breakdown[1].count).toBe(3);
      expect(breakdown[2].eventType).toBe('payment.failed');
      expect(breakdown[2].count).toBe(1);
    });
  });

  describe('getStatistics', () => {
    it('should return complete statistics with summary and breakdown', async () => {
      const endpoint1 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook1',
          secret: 'secret123'
        }
      });

      const endpoint2 = await prisma.webhookEndpoint.create({
        data: {
          url: 'https://example.com/webhook2',
          secret: 'secret123'
        }
      });

      const event1 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.created',
          payload: JSON.stringify({ orderId: 'ORD-001' })
        }
      });

      const event2 = await prisma.webhookEvent.create({
        data: {
          eventType: 'order.updated',
          payload: JSON.stringify({ orderId: 'ORD-002' })
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint1.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 50,
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event1.id,
          endpointId: endpoint2.id,
          isSuccess: false,
          statusCode: 500,
          durationMs: 100,
          errorMessage: 'Error',
          attemptNumber: 1
        }
      });

      await prisma.deliveryAttempt.create({
        data: {
          eventId: event2.id,
          endpointId: endpoint1.id,
          isSuccess: true,
          statusCode: 200,
          durationMs: 60,
          attemptNumber: 1
        }
      });

      const statistics = await statisticsService.getStatistics();
      
      expect(statistics.summary.totalEvents).toBe(2);
      expect(statistics.summary.totalDeliveries).toBe(3);
      expect(statistics.summary.totalSuccesses).toBe(2);
      expect(statistics.summary.totalFailures).toBe(1);
      
      expect(statistics.breakdown.byEndpoint.length).toBe(2);
      expect(statistics.breakdown.byEventType.length).toBe(2);
    });
  });
});
