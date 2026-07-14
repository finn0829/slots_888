import Fastify from 'fastify';
import { ENGINE_VERSION } from '@slots/engine';

const app = Fastify({ logger: true });

app.get('/healthz', async () => ({ ok: true, engine: ENGINE_VERSION }));

// 不读全局 PORT（本机被其他项目占用），用项目专属变量
const port = Number(process.env.SLOTS_SERVER_PORT ?? 8788);
// Docker 内需听 0.0.0.0 端口映射才通；本机直跑保持 127.0.0.1
const host = process.env.SLOTS_DOCKER ? '0.0.0.0' : '127.0.0.1';
app.listen({ port, host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
