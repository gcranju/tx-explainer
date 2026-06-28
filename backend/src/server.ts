import './engine/env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { analyzeTx } from './engine/analyze.js';
import { DEFAULT_CHAIN_ID, CHAINS } from './engine/rpc.js';

// Ensure any stray bigint serializes cleanly to JSON.
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

app.get('/health', async () => ({ ok: true, chains: Object.values(CHAINS).map((c) => ({ id: c.id, name: c.name })) }));

// Streaming analyze: emits SSE progress events then a final `report` event.
app.get('/analyze', async (req, reply) => {
  const { hash, chainId } = req.query as { hash?: string; chainId?: string };
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    reply.code(400).send({ error: 'provide ?hash=0x<64 hex>' });
    return;
  }
  const chain = chainId ? Number(chainId) : DEFAULT_CHAIN_ID;

  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const send = (event: string, data: unknown) => {
    reply.raw.write(`event: ${event}\n`);
    reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const report = await analyzeTx(hash, chain, (msg) => send('progress', { msg }));
    send('report', report);
  } catch (e: any) {
    send('error', { message: e?.message ?? String(e) });
  } finally {
    reply.raw.end();
  }
});

// Non-streaming variant for scripting/CI.
app.post('/analyze', async (req, reply) => {
  const { hash, chainId } = (req.body ?? {}) as { hash?: string; chainId?: number };
  if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    reply.code(400).send({ error: 'provide { hash: 0x<64 hex> }' });
    return;
  }
  const report = await analyzeTx(hash, chainId ?? DEFAULT_CHAIN_ID);
  return report;
});

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: '0.0.0.0' });
console.log(`tx-explainer backend listening on http://localhost:${port}`);
