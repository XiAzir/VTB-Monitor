import { createServer } from 'node:http';

const webHost = process.env.HOST ?? '127.0.0.1';
const webPort = Number(process.env.PORT ?? 4311);
process.env.ORIGIN ??= `http://${webHost}:${webPort}`;
const { handler } = await import('../build/handler.js');
const managementHost = process.env.MANAGEMENT_HOST ?? '127.0.0.1';
const managementPort = Number(process.env.MANAGEMENT_PORT ?? 4312);

const web = createServer((request, response) => {
  delete request.headers['x-vtbm-management-listener'];
  handler(request, response);
});

const management = createServer((request, response) => {
  request.headers['x-vtbm-management-listener'] = 'internal-v1';
  const url = new URL(request.url ?? '/', 'http://localhost');
  request.url = `/agent-api${url.pathname}${url.search}`;
  handler(request, response);
});

web.listen(webPort, webHost, () => console.log(JSON.stringify({ level: 'info', event: 'web-listening', host: webHost, port: webPort })));
management.listen(managementPort, managementHost, () => console.log(JSON.stringify({ level: 'info', event: 'management-listening', host: managementHost, port: managementPort })));

function shutdown() {
  web.close();
  management.close();
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
