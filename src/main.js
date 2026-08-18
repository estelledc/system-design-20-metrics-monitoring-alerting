import process from 'node:process';
import pg from 'pg';
import { createMonitorServer } from './http.js';
import { NotificationWorker } from './notifier.js';
import { createProviderServer } from './provider.js';
import { initializeDatabase, MonitorRepository } from './repository.js';
import { MonitorService } from './service.js';

const { Pool } = pg;

function log(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function databasePool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString: process.env.DATABASE_URL, max: 10, statement_timeout: 10_000 });
}

async function listen(server, port, readyEvent) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not expose a TCP listening address');
  log({ event: readyEvent, port: address.port });
}

async function runServer(kind) {
  const pool = databasePool();
  let server;
  try {
    await initializeDatabase(pool);
    const repository = new MonitorRepository(pool);
    if (kind === 'serve') {
      const service = new MonitorService(repository, log);
      server = createMonitorServer({
        service,
        repository,
        apiToken: process.env.MON_API_TOKEN,
        logger: log,
      });
      await listen(server, Number(process.env.PORT ?? 3000), 'monitor_ready');
    } else {
      server = createProviderServer({
        repository,
        providerToken: process.env.MON_PROVIDER_TOKEN,
        logger: log,
      });
      await listen(server, Number(process.env.PROVIDER_PORT ?? 3001), 'provider_ready');
    }
  } catch (error) {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    await pool.end().catch(() => {});
    throw error;
  }

  let closePromise;
  const close = async () => {
    closePromise ??= (async () => {
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    })();
    return closePromise;
  };
  process.once('SIGTERM', () => close().then(() => process.exit(0)));
  process.once('SIGINT', () => close().then(() => process.exit(0)));
}

async function notifyOnce() {
  const pool = databasePool();
  try {
    await initializeDatabase(pool);
    const repository = new MonitorRepository(pool);
    const worker = new NotificationWorker(repository, {
      providerUrl: process.env.MON_PROVIDER_URL,
      providerToken: process.env.MON_PROVIDER_TOKEN,
      logger: log,
    });
    const result = await worker.runOnce({
      workerId: process.env.MON_NOTIFICATION_WORKER_ID,
      workerEpoch: Number(process.env.MON_NOTIFICATION_WORKER_EPOCH),
      leaseSeconds: Number(process.env.MON_NOTIFICATION_LEASE_SECONDS ?? 2),
    });
    log({ event: 'notify_once_complete', phase: result.phase, attempt: result.attempt ?? 0 });
  } finally {
    await pool.end();
  }
}

const command = process.argv[2];
const operation = command === 'notify-once' ? notifyOnce() : (
  command === 'serve' || command === 'provider' ? runServer(command) : Promise.reject(
    new Error('usage: node src/main.js <serve|provider|notify-once>'),
  )
);
operation.catch((error) => {
  log({ event: 'process_failed', errorCode: error?.code ?? 'startup_error' });
  process.exitCode = 1;
});
