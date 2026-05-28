import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RouteDeps } from './index';

const createEventSchema = z.object({
  eventType: z.string().min(1),
  payload: z.record(z.unknown())
});

const eventIdSchema = z.object({
  id: z.string().uuid()
});

export function registerEventRoutes(
  fastify: FastifyInstance,
  deps: RouteDeps
): void {
  fastify.post(
    '/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createEventSchema.parse(request.body);
      
      const event = await deps.eventService.create(body);
      
      const allEndpoints = await deps.endpointService.findMatchingEndpoints(body.eventType);
      const matchingEndpoints = deps.eventService.filterMatchingEndpoints(
        allEndpoints,
        body.eventType
      );

      for (const endpoint of matchingEndpoints) {
        await deps.deliveryQueueService.enqueue(event.id, endpoint.id, 1);
      }

      return reply.status(202).send({
        message: 'Event created and queued for delivery',
        event: {
          id: event.id,
          eventType: event.eventType,
          createdAt: event.createdAt
        },
        matchedEndpoints: matchingEndpoints.length
      });
    }
  );

  fastify.get(
    '/events',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const events = await deps.eventService.findAll();
      return reply.send(events);
    }
  );

  fastify.get(
    '/events/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = eventIdSchema.parse(request.params);
      const event = await deps.eventService.findById(params.id);
      
      if (!event) {
        return reply.status(404).send({ error: 'Event not found' });
      }
      
      return reply.send(event);
    }
  );

  fastify.get(
    '/events/:id/attempts',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = eventIdSchema.parse(request.params);
      
      const event = await deps.eventService.findById(params.id);
      if (!event) {
        return reply.status(404).send({ error: 'Event not found' });
      }
      
      const attempts = await deps.deliveryService.findByEventId(params.id);
      return reply.send(attempts);
    }
  );
}
