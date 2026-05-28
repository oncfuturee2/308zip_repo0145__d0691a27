import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RouteDeps } from './index';

const createEndpointSchema = z.object({
  url: z.string().url(),
  eventTypes: z.string().default('*'),
  isActive: z.boolean().optional(),
  secret: z.string().min(8).optional()
});

const updateEndpointSchema = z.object({
  url: z.string().url().optional(),
  eventTypes: z.string().optional(),
  isActive: z.boolean().optional()
});

const endpointIdSchema = z.object({
  id: z.string().uuid()
});

export function registerEndpointRoutes(
  fastify: FastifyInstance,
  deps: RouteDeps
): void {
  fastify.post(
    '/endpoints',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = createEndpointSchema.parse(request.body);
      const endpoint = await deps.endpointService.create(body);
      return reply.status(201).send(endpoint);
    }
  );

  fastify.get(
    '/endpoints',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = request.query as { includeInactive?: string };
      const includeInactive = query.includeInactive === 'true';
      const endpoints = await deps.endpointService.findAll(includeInactive);
      return reply.send(endpoints);
    }
  );

  fastify.get(
    '/endpoints/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = endpointIdSchema.parse(request.params);
      const endpoint = await deps.endpointService.findById(params.id);
      
      if (!endpoint) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }
      
      return reply.send(endpoint);
    }
  );

  fastify.put(
    '/endpoints/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = endpointIdSchema.parse(request.params);
      const body = updateEndpointSchema.parse(request.body);
      
      const existingEndpoint = await deps.endpointService.findById(params.id);
      if (!existingEndpoint) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }
      
      const endpoint = await deps.endpointService.update(params.id, body);
      return reply.send(endpoint);
    }
  );

  fastify.post(
    '/endpoints/:id/regenerate-secret',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = endpointIdSchema.parse(request.params);
      
      const existingEndpoint = await deps.endpointService.findById(params.id);
      if (!existingEndpoint) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }
      
      const secret = await deps.endpointService.regenerateSecret(params.id);
      return reply.send({ secret });
    }
  );

  fastify.delete(
    '/endpoints/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = endpointIdSchema.parse(request.params);
      
      const existingEndpoint = await deps.endpointService.findById(params.id);
      if (!existingEndpoint) {
        return reply.status(404).send({ error: 'Endpoint not found' });
      }
      
      await deps.endpointService.delete(params.id);
      return reply.status(204).send();
    }
  );
}
