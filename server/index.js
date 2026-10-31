'use strict';

const http = require('node:http');
const config = require('./config');
const db = require('./db');
const log = require('./lib/log');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');
const socket = require('./realtime/socket');
const presence = require('./services/presence');
const maintenance = require('./services/maintenance');

async function main() {
  await migrate(db.pool, log);
  await presence.warmUp();

  const server = http.createServer(createApp());
  // Keep idle keep-alive sockets around a little longer than the proxy's.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  socket.create(server);
  presence.start();
  maintenance.start();

  server.listen(config.port, config.host, () => {
    log.info('2WaY listening', { port: config.port, env: config.env, origin: config.appOrigin });
  });

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    log.info('shutting down', { signal });
    maintenance.stop();
    server.close();
    await presence.stop().catch(() => {});
    await db.pool.end().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

process.on('unhandledRejection', (err) => log.error('unhandled rejection', { err: err?.message }));

main().catch((err) => {
  log.error('startup failed', { err: err.message });
  process.exit(1);
});
