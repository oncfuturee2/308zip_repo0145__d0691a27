import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RouteDeps } from './index';

const attemptIdSchema = z.object({
  id: z.string().uuid()
});

const endpointIdParamSchema = z.object({
  endpointId: z.string().uuid()
});

export function registerDeliveryRoutes(
  fastify: FastifyInstance,
  deps: RouteDeps
): void {
  fastify.get(
    '/deliveries',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const attempts = await deps.deliveryService.findAll();
      return reply.send(attempts);
    }
  );

  fastify.get(
    '/deliveries/failed',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const attempts = await deps.deliveryService.findFailedAttempts();
      return reply.send(attempts);
    }
  );

  fastify.get(
    '/deliveries/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = attemptIdSchema.parse(request.params);
      const attempt = await deps.deliveryService.findById(params.id);
      
      if (!attempt) {
        return reply.status(404).send({ error: 'Delivery attempt not found' });
      }
      
      return reply.send(attempt);
    }
  );

  fastify.post(
    '/deliveries/:id/retry',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = attemptIdSchema.parse(request.params);
      
      const existingAttempt = await deps.deliveryService.findById(params.id);
      if (!existingAttempt) {
        return reply.status(404).send({ error: 'Delivery attempt not found' });
      }

      if (!deps.deliveryService.canRetry(existingAttempt.statusCode)) {
        return reply.status(400).send({ 
          error: 'Cannot retry this delivery',
          reason: `Status code ${existingAttempt.statusCode} is not retryable`
        });
      }

      try {
        const newAttempt = await deps.deliveryService.retryDelivery(params.id);
        return reply.status(201).send(newAttempt);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return reply.status(400).send({ error: errorMessage });
      }
    }
  );

  fastify.get(
    '/endpoints/:endpointId/deliveries',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = endpointIdParamSchema.parse(request.params);
      
      const endpoint = await deps.endpointService.findById(params.endpointId);
      if (!endpoint) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }
      
      const attempts = await deps.deliveryService.findByEndpointId(params.endpointId);
      return reply.send(attempts);
    }
  );

  fastify.get(
    '/endpoints/:endpointId/deliveries/failed',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = endpointIdParamSchema.parse(request.params);
      
      const endpoint = await deps.endpointService.findById(params.endpointId);
      if (!endpoint) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }
      
      const attempts = await deps.deliveryService.findFailedAttempts(params.endpointId);
      return reply.send(attempts);
    }
  );
}
