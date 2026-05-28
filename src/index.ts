import fastify from 'fastify';
import { registerRoutes, createDeps } from './routes';
import { DeliveryWorker } from './services';
import { RetryStrategy } from './core';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  const app = fastify({ 
    logger: true 
  });

  const deps = createDeps();
  await registerRoutes(app, deps);

  const retryStrategy = new RetryStrategy();
  const worker = new DeliveryWorker(
    deps.queueService,
    deps.deliveryService,
    retryStrategy
  );

  worker.start();

  app.addHook('onClose', async () => {
    worker.stop();
  });

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    console.log(`Server is running at ${address}`);
    console.log(`Health check: ${address}/health`);
    console.log(`API prefix: ${address}/api`);
    console.log(`Delivery worker started with ${retryStrategy.getConfig().maxAttempts} max attempts`);
  } catch (err) {
    app.log.error(err);
    worker.stop();
    process.exit(1);
  }
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { startServer };
