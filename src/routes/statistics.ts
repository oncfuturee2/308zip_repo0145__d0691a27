import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RouteDeps } from './index';

const statisticsQuerySchema = z.object({
  startTime: z.string().datetime().optional(),
  endTime: z.string().datetime().optional(),
});

export function registerStatisticsRoutes(
  fastify: FastifyInstance,
  deps: RouteDeps
): void {
  fastify.get(
    '/statistics',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = statisticsQuerySchema.safeParse(request.query);
      
      if (!query.success) {
        return reply.status(400).send({ 
          error: 'Invalid query parameters',
          details: query.error.issues 
        });
      }

      const { startTime, endTime } = query.data;
      
      const timeRange = {
        startTime: startTime ? new Date(startTime) : undefined,
        endTime: endTime ? new Date(endTime) : undefined,
      };

      const statistics = await deps.statisticsService.getStatistics(timeRange);
      return reply.send(statistics);
    }
  );

  fastify.get(
    '/statistics/summary',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = statisticsQuerySchema.safeParse(request.query);
      
      if (!query.success) {
        return reply.status(400).send({ 
          error: 'Invalid query parameters',
          details: query.error.issues 
        });
      }

      const { startTime, endTime } = query.data;
      
      const timeRange = {
        startTime: startTime ? new Date(startTime) : undefined,
        endTime: endTime ? new Date(endTime) : undefined,
      };

      const summary = await deps.statisticsService.getSummary(timeRange);
      return reply.send(summary);
    }
  );

  fastify.get(
    '/statistics/breakdown/endpoint',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = statisticsQuerySchema.safeParse(request.query);
      
      if (!query.success) {
        return reply.status(400).send({ 
          error: 'Invalid query parameters',
          details: query.error.issues 
        });
      }

      const { startTime, endTime } = query.data;
      
      const timeRange = {
        startTime: startTime ? new Date(startTime) : undefined,
        endTime: endTime ? new Date(endTime) : undefined,
      };

      const breakdown = await deps.statisticsService.getEndpointBreakdown(timeRange);
      return reply.send(breakdown);
    }
  );

  fastify.get(
    '/statistics/breakdown/event-type',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = statisticsQuerySchema.safeParse(request.query);
      
      if (!query.success) {
        return reply.status(400).send({ 
          error: 'Invalid query parameters',
          details: query.error.issues 
        });
      }

      const { startTime, endTime } = query.data;
      
      const timeRange = {
        startTime: startTime ? new Date(startTime) : undefined,
        endTime: endTime ? new Date(endTime) : undefined,
      };

      const breakdown = await deps.statisticsService.getEventTypeBreakdown(timeRange);
      return reply.send(breakdown);
    }
  );
}
