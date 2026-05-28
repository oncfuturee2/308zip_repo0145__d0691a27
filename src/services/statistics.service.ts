import { prisma } from './prisma-client';

export interface StatisticsSummary {
  totalEvents: number;
  totalDeliveries: number;
  totalSuccesses: number;
  totalFailures: number;
  failureRate: number;
  avgDurationMs: number;
}

export interface EndpointStatistics {
  endpointId: string;
  endpointUrl: string;
  totalDeliveries: number;
  successCount: number;
  failureCount: number;
  failureRate: number;
  avgDurationMs: number;
}

export interface EventTypeStatistics {
  eventType: string;
  count: number;
  percentage: number;
}

export interface DeliveryBreakdown {
  byEndpoint: EndpointStatistics[];
  byEventType: EventTypeStatistics[];
}

export interface StatisticsResult {
  summary: StatisticsSummary;
  breakdown: DeliveryBreakdown;
}

export interface TimeRangeFilter {
  startTime?: Date;
  endTime?: Date;
}

export class StatisticsService {
  buildWhereClause(timeRange?: TimeRangeFilter): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    
    if (timeRange?.startTime || timeRange?.endTime) {
      where.createdAt = {};
      if (timeRange.startTime) {
        (where.createdAt as Record<string, unknown>).gte = timeRange.startTime;
      }
      if (timeRange.endTime) {
        (where.createdAt as Record<string, unknown>).lte = timeRange.endTime;
      }
    }
    
    return where;
  }

  async getSummary(timeRange?: TimeRangeFilter): Promise<StatisticsSummary> {
    const deliveryWhere = this.buildWhereClause(timeRange);
    const eventWhere = this.buildWhereClause(timeRange);

    const [eventCount, deliveryStats] = await Promise.all([
      prisma.webhookEvent.count({ where: eventWhere }),
      prisma.deliveryAttempt.aggregate({
        where: deliveryWhere,
        _count: {
          id: true,
        },
        _sum: {
          durationMs: true,
        },
      }),
    ]);

    const successCount = await prisma.deliveryAttempt.count({
      where: { ...deliveryWhere, isSuccess: true },
    });

    const failureCount = await prisma.deliveryAttempt.count({
      where: { ...deliveryWhere, isSuccess: false },
    });

    const totalDeliveries = deliveryStats._count.id || 0;
    const totalDuration = deliveryStats._sum.durationMs || 0;

    return {
      totalEvents: eventCount,
      totalDeliveries,
      totalSuccesses: successCount,
      totalFailures: failureCount,
      failureRate: totalDeliveries > 0 ? (failureCount / totalDeliveries) * 100 : 0,
      avgDurationMs: totalDeliveries > 0 ? Math.round(totalDuration / totalDeliveries) : 0,
    };
  }

  async getEndpointBreakdown(timeRange?: TimeRangeFilter): Promise<EndpointStatistics[]> {
    const deliveryWhere = this.buildWhereClause(timeRange);

    const deliveries = await prisma.deliveryAttempt.findMany({
      where: deliveryWhere,
      select: {
        endpointId: true,
        isSuccess: true,
        durationMs: true,
      },
    });

    const endpointIds = [...new Set(deliveries.map(d => d.endpointId))];

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { id: { in: endpointIds } },
      select: { id: true, url: true },
    });

    const endpointMap = new Map(endpoints.map(e => [e.id, e.url]));

    const grouped = new Map<string, { total: number; success: number; duration: number }>();

    for (const d of deliveries) {
      const stat = grouped.get(d.endpointId) || { total: 0, success: 0, duration: 0 };
      stat.total++;
      if (d.isSuccess) stat.success++;
      stat.duration += d.durationMs;
      grouped.set(d.endpointId, stat);
    }

    const result: EndpointStatistics[] = [];
    for (const [endpointId, stat] of grouped) {
      const failureCount = stat.total - stat.success;
      result.push({
        endpointId,
        endpointUrl: endpointMap.get(endpointId) || '',
        totalDeliveries: stat.total,
        successCount: stat.success,
        failureCount,
        failureRate: stat.total > 0 ? (failureCount / stat.total) * 100 : 0,
        avgDurationMs: stat.total > 0 ? Math.round(stat.duration / stat.total) : 0,
      });
    }

    return result.sort((a, b) => b.totalDeliveries - a.totalDeliveries);
  }

  async getEventTypeBreakdown(timeRange?: TimeRangeFilter): Promise<EventTypeStatistics[]> {
    const deliveryWhere = this.buildWhereClause(timeRange);

    const eventTypeStats = await prisma.deliveryAttempt.groupBy({
      by: ['eventId'],
      where: deliveryWhere,
      _count: {
        id: true,
      },
    });

    const eventIds = eventTypeStats.map(stat => stat.eventId);
    
    const events = await prisma.webhookEvent.findMany({
      where: { id: { in: eventIds } },
      select: { id: true, eventType: true },
    });

    const eventMap = new Map(events.map(e => [e.id, e.eventType]));

    const eventTypeCounts = new Map<string, number>();
    let totalDeliveries = 0;

    for (const stat of eventTypeStats) {
      const eventType = eventMap.get(stat.eventId);
      if (eventType) {
        const current = eventTypeCounts.get(eventType) || 0;
        eventTypeCounts.set(eventType, current + stat._count.id);
        totalDeliveries += stat._count.id;
      }
    }

    const result: EventTypeStatistics[] = [];
    for (const [eventType, count] of eventTypeCounts) {
      result.push({
        eventType,
        count,
        percentage: totalDeliveries > 0 ? (count / totalDeliveries) * 100 : 0,
      });
    }

    return result.sort((a, b) => b.count - a.count);
  }

  async getStatistics(timeRange?: TimeRangeFilter): Promise<StatisticsResult> {
    const [summary, byEndpoint, byEventType] = await Promise.all([
      this.getSummary(timeRange),
      this.getEndpointBreakdown(timeRange),
      this.getEventTypeBreakdown(timeRange),
    ]);

    return {
      summary,
      breakdown: {
        byEndpoint,
        byEventType,
      },
    };
  }
}
