#!/usr/bin/env node
/**
 * Справочник инструментов из самого сервера.
 *
 * Пишется генератором, а не руками, по одной причине: рукописный список описаний уже был — в
 * README, — и он разъехался с кодом. Половина README пересказывала описания инструментов, при
 * этом шестнадцать инструментов в нём не упоминались вовсе, а шесть разделов показывали
 * несуществующие команды. Сгенерированный файл разъехаться не может.
 *
 *   node bin/gen-tools-doc.mjs            # docs/tools.md по-русски
 *   LT_LANG=en node bin/gen-tools-doc.mjs # то же по-английски
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { closeAll } from '../src/browser/pool.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lang = (process.env.LT_LANG || 'ru').toLowerCase().startsWith('en') ? 'en' : 'ru';

const words = {
  ru: {
    title: 'Инструменты стенда',
    intro:
      'Файл собран генератором из самого сервера: `node bin/gen-tools-doc.mjs`. Править его руками\nне нужно — правьте описания в `src/tools/` и пересоберите.',
    total: 'Всего инструментов',
    manifest: 'Размер манифеста',
    chars: 'символов',
    params: 'Параметры',
    none: 'без параметров',
    required: 'обязателен',
    readOnly: 'только чтение',
    destructive: 'удаляет данные',
    generated: 'Собрано',
  },
  en: {
    title: 'Stand tools',
    intro:
      'Generated from the server itself: `node bin/gen-tools-doc.mjs`. Do not edit by hand —\nedit the descriptions in `src/tools/` and regenerate.',
    total: 'Tools in total',
    manifest: 'Manifest size',
    chars: 'characters',
    params: 'Parameters',
    none: 'no parameters',
    required: 'required',
    readOnly: 'read-only',
    destructive: 'removes data',
    generated: 'Generated',
  },
}[lang];

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
const server = await createServer();
await server.connect(serverSide);
const client = new Client({ name: 'gen-tools-doc', version: '1' });
await client.connect(clientSide);

const { tools } = await client.listTools();
const { prompts } = await client.listPrompts().catch(() => ({ prompts: [] }));
const { resourceTemplates } = await client.listResourceTemplates().catch(() => ({ resourceTemplates: [] }));

const lines = [];
lines.push(`# ${words.title}`, '');
lines.push(words.intro, '');
lines.push(`${words.total}: **${tools.length}**. ${words.manifest}: **${JSON.stringify(tools).length}** ${words.chars}.`, '');

for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
  const hints = [];
  if (tool.annotations?.readOnlyHint) hints.push(words.readOnly);
  if (tool.annotations?.destructiveHint) hints.push(words.destructive);
  lines.push(`## \`${tool.name}\``, '');
  lines.push(`**${tool.title}**${hints.length ? ` — _${hints.join(', ')}_` : ''}`, '');
  lines.push(tool.description, '');

  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const names = Object.keys(props);
  if (!names.length) {
    lines.push(`_${words.none}_`, '');
    continue;
  }
  lines.push(`| ${words.params} | | |`, '|---|---|---|');
  /*
   * Вертикальная черта внутри ячейки рвёт таблицу: перечисление из четырёх значений превращает
   * строку в пять лишних столбцов. В JS «\|» — это просто «|», поэтому экранировать нужно
   * настоящим обратным слешем, и не только у перечислений: черта попадается и в описаниях.
   */
  const cell = (value) => String(value ?? '').replace(/\|/g, '\\|');
  for (const name of names) {
    const spec = props[name];
    const type = spec.enum ? spec.enum.map((v) => `\`${cell(v)}\``).join(' \\| ') : spec.type || '';
    const note = [spec.description, required.has(name) ? words.required : ''].filter(Boolean).join('. ');
    lines.push(`| \`${name}\` | ${type} | ${cell(note)} |`);
  }
  lines.push('');
}

if (prompts.length) {
  lines.push('---', '', `# ${lang === 'ru' ? 'Сценарии' : 'Prompts'}`, '');
  for (const prompt of prompts) lines.push(`- **\`${prompt.name}\`** — ${prompt.description}`);
  lines.push('');
}

if (resourceTemplates.length) {
  lines.push('---', '', `# ${lang === 'ru' ? 'Ресурсы' : 'Resources'}`, '');
  for (const tpl of resourceTemplates) lines.push(`- \`${tpl.uriTemplate}\` — ${tpl.description}`);
  lines.push('');
}

lines.push('---', '', `_${words.generated}: ${new Date().toISOString().slice(0, 10)}_`, '');

const out = path.join(root, 'docs', lang === 'ru' ? 'tools.md' : 'tools.en.md');
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, lines.join('\n'), 'utf8');
console.log(`${out}: ${tools.length} инструментов, ${lines.join('\n').length} символов`);

await closeAll();
process.exit(0);
