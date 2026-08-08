import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CONFIG } from './config.js';
import { createServer } from './server.js';
import { closeAll } from './browser/pool.js';
import { ensureDirs } from './artifacts.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

async function startStdio() {
  const server = await createServer();
  await server.connect(new StdioServerTransport());
  // В stdio-режиме stdout занят протоколом: любой лишний вывод ломает сессию.
  process.stderr.write('[mcp] stdio-транспорт готов\n');
}

async function startHttp() {
  // Каталоги нужны сразу: nginx отдаёт artifacts/ и без первого прогона отвечал бы 404.
  await ensureDirs();
  const port = Number(arg('port', CONFIG.mcpPort));
  /** Сессия MCP -> транспорт. Браузеры переживают переподключение агента. */
  const transports = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: transports.size, at: new Date().toISOString() }));
      return;
    }

    if (url.pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Есть только /mcp и /health\n');
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'];
      let transport = sessionId ? transports.get(sessionId) : null;

      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => transports.set(id, transport),
        });
        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };
        const server = await createServer();
        await server.connect(transport);
      }

      await transport.handleRequest(req, res);
    } catch (err) {
      process.stderr.write(`[mcp] ошибка запроса: ${err.stack || err.message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  });

  httpServer.listen(port, '0.0.0.0', () => {
    process.stderr.write(`[mcp] streamable http на 0.0.0.0:${port}/mcp, здоровье на /health\n`);
  });

  const shutdown = async () => {
    process.stderr.write('[mcp] остановка, закрываю браузеры\n');
    httpServer.close();
    await closeAll();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

const transport = arg('transport', 'http');
if (transport === 'stdio') await startStdio();
else await startHttp();
