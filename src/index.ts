import fastify from 'fastify';
import { registerRoutes, createDeps } from './routes';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';

async function startServer() {
  const app = fastify({ 
    logger: true 
  });

  const deps = createDeps();
  await registerRoutes(app, deps);
  
  deps.deliveryWorker.start();

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    console.log(`Server is running at ${address}`);
    console.log(`Health check: ${address}/health`);
    console.log(`API prefix: ${address}/api`);
    console.log('Delivery worker started');
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { startServer };
