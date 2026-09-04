import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { profilerCard } from './card.js';
import { ProfilerExecutor } from './executor.js';

export async function startProfiler(
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const card = profilerCard(actualPort);

  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new ProfilerExecutor(),
  );

  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: async () => card }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return {
    url: `http://localhost:${actualPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('profiler/index.ts')) {
  const port = Number(process.env.PORT ?? 4002);
  startProfiler(port).then(({ url }) => {
    console.log(`Profiler Agent listening on ${url}`);
    console.log(`Agent card: ${url}/.well-known/agent-card.json`);
  });
}
