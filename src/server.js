import { config, validateConfig } from './config.js';
import { createApp } from './app.js';

validateConfig();
const app = createApp(config);
app.startTimers();
app.housekeeping();
app.server.listen(config.port, () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), ev: 'listening', port: config.port, domain: config.domain, mock: config.opennodeMock }));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(JSON.stringify({ ev: 'shutdown', sig }));
    app.close();
    process.exit(0);
  });
}
