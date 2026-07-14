import Fastify from 'fastify';
import { ENGINE_VERSION } from '@slots/engine';

const app = Fastify({ logger: true });

app.get('/healthz', async () => ({ ok: true, engine: ENGINE_VERSION }));

// 不读全局 PORT（本机被其他项目占用），用项目专属变量
const port = Number(process.env.SLOTS_SERVER_PORT ?? 8788);
app.listen({ port, host: '127.0.0.1' }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
