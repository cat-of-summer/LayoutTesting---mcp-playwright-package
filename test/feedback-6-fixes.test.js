/**
 * Правки по шестому отзыву — вёрстка UI kit на Astro: места, где агент обходил стенд руками.
 * Подсказка к action: 'key', путь выгрузки при относительном EXPORTS_DIR, нарезка кадра на куски
 * в натуральную величину, именованные скрипты и сравнение снимков геометрии. Здесь всё, что
 * считается без браузера; страница — в feedback-6-e2e.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { ACTIONS, suggestAction } from '../src/browser/act.js';
import { runSteps } from '../src/browser/batch.js';
import { diffBoxes } from '../src/browser/boxes.js';
import { downloadCommand, exportFile, hostFromMount, parseMountinfo, setMountedRoot } from '../src/exports.js';
import { TILE_MAX_PIXELS, TILE_MAX_SIDE, tileImage } from '../src/checks/visual.js';
import { getScript, listScripts, removeScript, resetScripts, saveScript } from '../src/browser/scripts.js';
import { diffTrees } from '../src/checks/layout-diff.js';

test('suggestAction: привычное имя, другой инструмент и опечатка', () => {
  assert.equal(suggestAction('key'), 'возможно, вы имели в виду press');
  assert.equal(suggestAction('Sleep'), 'возможно, вы имели в виду wait');
  assert.match(suggestAction('goto'), /browser_goto/);
  assert.equal(suggestAction('clik'), 'возможно, вы имели в виду click');
  assert.equal(suggestAction('qwertyuiop'), null);
  /* eval и screenshot есть только в пакете: вне его синоним не подсказывается. */
  assert.equal(suggestAction('js'), null);
  assert.equal(suggestAction('js', [...ACTIONS, 'screenshot', 'eval']), 'возможно, вы имели в виду eval');
});

test('steps: action key — ошибка с подсказкой press до первого действия', async () => {
  await assert.rejects(runSteps({}, [{ action: 'key', value: 'Escape' }]), /Шаг 0: action: .*возможно, вы имели в виду press/);
  await assert.rejects(runSteps({}, [{ action: 'click', selector: 'a' }, { action: 'evaluate', expression: '1' }]), /Шаг 1: .*eval/);
});

test('steps: шаг screenshot принимает clip — ошибки разбора нет, лишнее поле по-прежнему ошибка', async () => {
  const clip = { x: 0, y: 0, width: 10, height: 10 };
  /* Разбор проходит, и пакет падает уже на выполнении шага: сессии-то нет. */
  const res = await runSteps({ page: null, key: 'k' }, [{ action: 'screenshot', clip, hide: ['.x'], mask: ['.y'] }]);
  assert.equal(res.failed.i, 0);
  assert.doesNotMatch(res.failed.error, /Unrecognized key/);
  await assert.rejects(runSteps({}, [{ action: 'screenshot', clipp: clip }]), /Unrecognized key/);
});

test('parseMountinfo и hostFromMount: стенд в WSL, Docker Desktop, том Docker, пробел в пути', () => {
  const info = [
    '1539 1498 8:48 /data/docker/volumes/layouttesting_artifacts/_data /var/www/html/artifacts rw,relatime master:30 - ext4 /dev/sdd rw',
    '1541 1498 8:80 /root/Containers/mcp/LayoutTesting/exports /var/www/html/exports rw,relatime - ext4 /dev/sdf rw,discard',
    '2281 2268 0:71 /Projects/My\\040Game/exports /mnt/desktop rw,noatime - 9p O:\\134 rw,aname=drvfs;path=O:\\',
  ].join('\n');

  const wsl = parseMountinfo(info, '/var/www/html/exports');
  assert.deepEqual(wsl, { root: '/root/Containers/mcp/LayoutTesting/exports', fstype: 'ext4', source: '/dev/sdf' });
  assert.deepEqual(hostFromMount(wsl), { root: '/root/Containers/mcp/LayoutTesting/exports', windows: null });
  assert.deepEqual(hostFromMount(wsl, 'Ubuntu'), {
    root: '/root/Containers/mcp/LayoutTesting/exports',
    windows: '//wsl.localhost/Ubuntu/root/Containers/mcp/LayoutTesting/exports',
  });

  const desktop = parseMountinfo(info, '/mnt/desktop');
  assert.equal(desktop.root, '/Projects/My Game/exports');
  assert.deepEqual(hostFromMount(desktop), { root: 'O:/Projects/My Game/exports', windows: 'O:/Projects/My Game/exports' });

  assert.equal(hostFromMount(parseMountinfo(info, '/var/www/html/artifacts')), null, 'том Docker снаружи бесполезен');
  assert.equal(parseMountinfo(info, '/nowhere'), null);
});

test('exportFile: относительный EXPORTS_DIR раскрыт по монтированию, путь Windows в saveTo принят', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-export-'));
  const source = path.join(dir, 'shot.png');
  await fs.writeFile(source, 'png');
  const exportsDir = path.join(dir, 'exports');
  await fs.mkdir(exportsDir);
  const before = process.env.EXPORTS_DIR;
  process.env.EXPORTS_DIR = './exports';
  setMountedRoot({ root: '/root/stand/exports', windows: '//wsl.localhost/Ubuntu/root/stand/exports' });
  try {
    const out = await exportFile(source, 'game/a.png', { dir: exportsDir, url: 'http://127.0.0.1:8089/run/shot.png' });
    assert.equal(out.hostPath, '/root/stand/exports/game/a.png');
    assert.equal(out.windowsPath, '//wsl.localhost/Ubuntu/root/stand/exports/game/a.png');
    assert.equal(out.note, undefined, 'путь абсолютный — оговорка не нужна');

    const unc = await exportFile(source, '\\\\wsl.localhost\\Ubuntu\\root\\stand\\exports\\b.png', { dir: exportsDir });
    assert.equal(unc.path, 'b.png');
    const linux = await exportFile(source, '/root/stand/exports/c.png', { dir: exportsDir });
    assert.equal(linux.path, 'c.png');

    /* Монтирование не определилось — прежняя оговорка, теперь с готовой командой. */
    setMountedRoot(null);
    const relative = await exportFile(source, 'd.png', { dir: exportsDir, url: 'http://127.0.0.1:8089/run/shot.png' });
    assert.equal(relative.hostPath, './exports/d.png');
    assert.match(relative.note, /относительно каталога.*curl -fsSL -o d\.png http:\/\/127\.0\.0\.1:8089\/run\/shot\.png/);
  } finally {
    setMountedRoot(undefined);
    if (before === undefined) delete process.env.EXPORTS_DIR;
    else process.env.EXPORTS_DIR = before;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('downloadCommand: имя файла из url или заданное', () => {
  assert.equal(downloadCommand('http://127.0.0.1:8089/2026-10-24_ab/shot__k.png'), 'curl -fsSL -o shot__k.png http://127.0.0.1:8089/2026-10-24_ab/shot__k.png');
  assert.equal(downloadCommand('http://x/a.png', 'b.png'), 'curl -fsSL -o b.png http://x/a.png');
});

test('tileImage: кадр 1425×3413 — куски в натуральную ширину, без уменьшения клиентом, до конца кадра', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lt-tiles-'));
  try {
    const file = path.join(dir, 'page.png');
    await sharp({ create: { width: 1425, height: 3413, channels: 3, background: '#fff' } }).png().toFile(file);
    const res = await tileImage(file);
    assert.equal(res.width, 1425);
    assert.equal(res.scale, 1);
    assert.ok(res.tiles.length >= 4, `кусков ${res.tiles.length}`);
    for (const tile of res.tiles) {
      const meta = await sharp(tile.file).metadata();
      assert.equal(meta.width, 1425, 'ширина натуральная');
      assert.ok(meta.height <= TILE_MAX_SIDE && meta.width * meta.height <= TILE_MAX_PIXELS, `${meta.width}×${meta.height}`);
      assert.equal(meta.height, tile.y1 - tile.y0);
    }
    assert.equal(res.tiles[0].y0, 0);
    assert.equal(res.tiles.at(-1).y1, 3413, 'нарезано до конца');
    assert.equal(res.tiles[1].y0, res.tiles[0].y1 - 40, 'соседние куски перекрываются на 40px');
    assert.equal(res.rest, undefined);

    /* Бюджет кончился — нарезка остановлена, rest говорит, откуда продолжать. */
    const capped = await tileImage(file, { maxBytes: res.tiles[0].bytes + 1 });
    assert.equal(capped.tiles.length, 1);
    assert.deepEqual(capped.rest, { from: capped.tiles[0].y1, to: 3413 });

    /* Шире порога — ужимается до него, координаты всё равно в пикселях исходника. */
    const wide = path.join(dir, 'wide.png');
    await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#fff' } }).png().toFile(wide);
    const w = await tileImage(wide);
    assert.equal(w.width, TILE_MAX_SIDE);
    assert.equal(w.tiles.at(-1).y1, 1000);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('скрипты browser_eval: сохранение, вызов по имени, список, замена и удаление', async () => {
  const name = `feedback6-${process.pid}`;
  try {
    assert.deepEqual(await saveScript(name, 'document.title'), { name, replaced: false });
    assert.equal(await getScript(name), 'document.title');
    /* Новый процесс читает тот же файл: скрипт переживает перезапуск. */
    resetScripts();
    assert.equal(await getScript(name), 'document.title');
    assert.equal((await saveScript(name, 'location.href')).replaced, true);
    assert.ok((await listScripts()).some((s) => s.name === name && s.preview === 'location.href'));
    await assert.rejects(getScript('нет такого'), /Имя скрипта/);
    await assert.rejects(getScript(`${name}-missing`), /Скрипта .* нет/);
  } finally {
    assert.equal((await removeScript(name)).removed, true);
  }
  await assert.rejects(getScript(name), /нет/);
});

test('diffBoxes: ключ только во втором замере — appeared', () => {
  const res = diffBoxes({ a: { x: 0, y: 0, w: 10, h: 10 } }, { a: { x: 0, y: 0, w: 10, h: 10 }, b: { x: 0, y: 20, w: 10, h: 10 } });
  assert.deepEqual(res.appeared, ['b']);
  assert.equal(res.stable, 1);
});

test('diffTrees: правка отступа — одна находка, сдвиг потомков вместе с родителем свёрнут', () => {
  const node = (x, y, w, h, styles = {}, text) => ({ x, y, w, h, fixed: false, viewport: { x, y }, ...(text ? { text } : {}), styles: { padding: '0px', ...styles } });
  const before = {
    selector: '.card',
    nodes: {
      ':root': node(0, 0, 300, 200),
      'h2.title': node(0, 0, 300, 40, {}, 'Заголовок'),
      'div.body': node(0, 40, 300, 100),
      'div.body > p': node(0, 40, 300, 20, {}, 'Текст'),
      'ul > li[1]': node(0, 140, 300, 20, {}, 'Первый'),
      'ul > li[2]': node(0, 160, 300, 20, {}, 'Второй'),
    },
  };
  const after = {
    selector: '.card',
    nodes: {
      ':root': node(0, 0, 300, 216),
      'h2.title': node(0, 0, 300, 56, { padding: '8px 0px' }, 'Заголовок'),
      'div.body': node(0, 56, 300, 100),
      'div.body > p': node(0, 56, 300, 20, {}, 'Текст'),
      'ul > li[1]': node(0, 156, 300, 20, {}, 'Новый'),
      'ul > li[2]': node(0, 176, 300, 20, {}, 'Первый'),
      'ul > li[3]': node(0, 196, 300, 20, {}, 'Второй'),
    },
  };
  const res = diffTrees(before, after);
  assert.equal(res.unchanged, false);
  const moved = Object.fromEntries(res.moved.map((m) => [m.node, m]));
  assert.equal(moved['h2.title'].dh, 16, 'заголовок вырос');
  assert.equal(moved[':root'].dh, 16);
  assert.equal(moved['div.body'].dy, 16);
  assert.equal(moved['div.body > p'], undefined, 'абзац сдвинулся вместе с блоком');
  assert.ok(res.counts.movedWithParent >= 1);
  assert.deepEqual(res.styles, [{ node: 'h2.title', prop: 'padding', before: '0px', after: '8px 0px' }]);
  /* Вставленная строка не делает "новыми" все строки после неё. */
  assert.equal(res.renumbered, 2);
  assert.deepEqual(res.appeared, [{ node: 'ul > li[1]', text: 'Новый' }]);
  assert.equal(res.vanished, undefined);

  const same = diffTrees(before, before);
  assert.equal(same.unchanged, true);
});
