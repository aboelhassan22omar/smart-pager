import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await buildApp(config);

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  });
}
