import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CONFIG } from './config.js';
import { createServer } from './server.js';
import { resolveSelection, vocabulary } from './tools/groups.js';
import { closeAll } from './browser/pool.js';
import { ensureDirs } from './artifacts.js';

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : fallback;
};

/** Что можно назвать в адресе или в --tools. Одной строкой: это сообщение об ошибке. */
function vocabularyLine() {
  const vocab = vocabulary();
  const aliases = Object.entries(vocab.aliases).map(([name, spec]) => `${name} = ${spec}`);
  return [
    `Группы: ${vocab.groups.join(', ')}.`,
    `Складываются через +, например seo+crawl. Всё сразу — all или адрес без хвоста.`,
    `Псевдонимы: ${aliases.join('; ')}.`,
    `Всегда подняты: ${vocab.always.join(', ')}.`,
  ].join('\n');
}

async function startStdio() {
  const selection = resolveSelection(arg('tools', 'all'));
  /* В stdio адреса нет, и набор называют флагом. Опечатка здесь стоит дороже, чем в HTTP:
     ответить по протоколу некому, клиент увидит только молчащий процесс. Поэтому выходим сразу
     и с объяснением в stderr. */
  if (selection.unknown.length) {
    process.stderr.write(`[mcp] --tools: не знаю групп ${selection.unknown.join(', ')}\n${vocabularyLine()}\n`);
    process.exit(1);
  }

  const server = await createServer({ selection });
  await server.connect(new StdioServerTransport());
  // В stdio-режиме stdout занят протоколом: любой лишний вывод ломает сессию.
  process.stderr.write(`[mcp] stdio-транспорт готов, набор ${selection.key}\n`);
}

async function startHttp() {
  // Каталоги нужны сразу: nginx отдаёт artifacts/ и без первого прогона отвечал бы 404.
  await ensureDirs();
  const port = Number(arg('port', CONFIG.mcpPort));
  /**
   * Сессия MCP -> транспорт и подпись набора, под которым она открыта. Браузеры переживают
   * переподключение агента.
   */
  const sessions = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const plain = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
    };

    if (url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: sessions.size, at: new Date().toISOString() }));
      return;
    }

    /*
     * Набор инструментов выбирает тот, кто подключается, а не тот, кто поднял стенд: /mcp отдаёт
     * всё, /mcp/seo+crawl — названное. Процесс при этом один, поэтому браузеры, артефакты и
     * эталоны у всех адресов общие: сессия, открытая на одном, видна с другого.
     */
    if (url.pathname !== '/mcp' && !url.pathname.startsWith('/mcp/')) {
      plain(404, 'Есть только /mcp, /mcp/<группы> и /health\n');
      return;
    }

    /* Хвост декодируется, потому что клиент вправе прислать %2B вместо +. Битая
       процентная последовательность — не повод уронить запрос необъяснимым 500. */
    let spec = url.pathname.slice('/mcp/'.length);
    try {
      spec = decodeURIComponent(spec);
    } catch {
      plain(400, `Адрес не разбирается как текст: ${spec}\n\n${vocabularyLine()}\n`);
      return;
    }

    const selection = resolveSelection(spec);
    if (selection.unknown.length) {
      /* Не 404: адрес существует, неверно названы группы. Ответ со словарём попадает прямо в лог
         клиента — единственное место, где человек его действительно увидит. */
      plain(400, `Не знаю групп: ${selection.unknown.join(', ')}\n\n${vocabularyLine()}\n`);
      return;
    }

    try {
      const sessionId = req.headers['mcp-session-id'];
      const known = sessionId ? sessions.get(sessionId) : null;

      /* Сессия принадлежит тому набору, на котором открыта. Без этой проверки запрос с чужим
         mcp-session-id молча получил бы сервер другого адреса — и агент, спрашивавший figma,
         увидел бы в ответ seo-инструменты, не поняв, почему. */
      if (known && known.key !== selection.key) {
        plain(400, `Сессия открыта на наборе ${known.key}, а запрос пришёл на ${selection.key}. Откройте новую сессию на этом адресе.\n`);
        return;
      }

      let transport = known?.transport ?? null;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => sessions.set(id, { transport, key: selection.key }),
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const server = await createServer({ selection });
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
    process.stderr.write(
      `[mcp] streamable http на 0.0.0.0:${port}/mcp, здоровье на /health\n` +
        `[mcp] набор выбирается адресом: /mcp — всё, /mcp/<группы через +> — названное\n` +
        `${vocabularyLine()}\n`,
    );
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
