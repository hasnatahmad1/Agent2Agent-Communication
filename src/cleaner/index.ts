import { createInterface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express';
import { cleanerCard } from './card.js';
import { CleanerExecutor, runCleaning } from './executor.js';

export async function startCleaner(
  port: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const card = cleanerCard(actualPort);

  const requestHandler = new DefaultRequestHandler(
    card,
    new InMemoryTaskStore(),
    new CleanerExecutor(),
  );

  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: async () => card }));
  app.use(jsonRpcHandler({ requestHandler, userBuilder: UserBuilder.noAuthentication }));

  return {
    url: `http://localhost:${actualPort}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function cli(csvPath: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const outDir = process.env.OUT_DIR ?? 'out';

  try {
    const result = await runCleaning({
      csvPath,
      profilerUrl: process.env.PROFILER_URL ?? 'http://localhost:4002',
      outDir,
      onUpdate: (text) => console.log(text),
      onQuestion: async (question) => {
        console.log(`\n${question}\n`);
        const answer = await rl.question('Your answer: ');
        return answer.trim();
      },
    });

    console.log(`\n${result.narrative}`);
    console.log(`Rows: ${result.rowsBefore} -> ${result.rowsAfter}`);

    const expected = ['cleaned.csv', 'report.md', 'cleaning-plan.json'];
    const written = expected.filter((name) => existsSync(join(outDir, name)));
    const missing = expected.filter((name) => !written.includes(name));

    if (written.length) {
      console.log(`Wrote ${written.map((name) => join(outDir, name)).join(', ')}`);
    }
    if (missing.length) {
      console.log(`Did NOT write ${missing.map((name) => join(outDir, name)).join(', ')}`);
    }
  } finally {
    rl.close();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('cleaner/index.ts')) {
  const args = process.argv.slice(2);
  const cliIndex = args.indexOf('--cli');

  if (cliIndex !== -1) {
    const csvPath = args[cliIndex + 1] ?? args.find((a) => a.endsWith('.csv'));
    if (!csvPath) {
      console.error('Usage: npm run clean <path-to-csv>');
      process.exit(1);
    }
    cli(csvPath).catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  } else {
    const port = Number(process.env.PORT ?? 4001);
    startCleaner(port).then(({ url }) => {
      console.log(`Cleaner Agent listening on ${url}`);
      console.log(`Agent card: ${url}/.well-known/agent-card.json`);
    });
  }
}
