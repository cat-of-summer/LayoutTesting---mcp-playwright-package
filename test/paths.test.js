/**
 * Граница пути — единственное, что отделяет агента от чужих файлов стенда.
 *
 * Тест написан на отказ, а не на успех. Пропущенный запрет не проявляется ничем: инструмент
 * продолжает работать, просто отдаёт лишнее. Поймать это глазами на ревью нельзя, поэтому
 * каждый способ выйти за границу закреплён отдельным случаем.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DIRS } from '../src/config.js';
import { DENIED_DIRS, resolveInArtifacts, resolveInRoot, resolveInside } from '../src/paths.js';

test('обычный путь внутри каталога разрешён', () => {
  assert.equal(resolveInRoot('fixtures/broken.html'), path.join(DIRS.root, 'fixtures/broken.html'));
  assert.equal(resolveInArtifacts('run/shot.png'), path.join(DIRS.artifacts, 'run/shot.png'));
});

test('выход через .. закрыт', () => {
  assert.throws(() => resolveInRoot('../../etc/passwd'), /выходит за пределы/);
  assert.throws(() => resolveInArtifacts('../baselines/x.png'), /выходит за пределы/);
});

test('абсолютный путь наружу закрыт', () => {
  assert.throws(() => resolveInRoot('/etc/passwd'), /выходит за пределы/);
});

/*
 * Прежняя проверка сравнивала через abs.startsWith(base). Каталог-сосед, имя которого начинается
 * с имени базового, ей удовлетворял: /var/www/html-evil начинается с /var/www/html. Через
 * path.relative такой путь даёт ../html-evil и отсекается.
 */
test('каталог-сосед с похожим именем не считается вложенным', () => {
  const base = path.join(DIRS.root, 'sites');
  assert.throws(() => resolveInside(base, path.join(DIRS.root, 'sites-evil', 'x')), /выходит за пределы/);
});

test('state закрыт: там куки живых сессий', () => {
  assert.ok(DENIED_DIRS.includes('state'));
  assert.throws(() => resolveInRoot('state/prod.json'), /закрыт/);
  assert.throws(() => resolveInRoot('state'), /закрыт/);
  assert.throws(() => resolveInRoot('./state/nested/deep.json'), /закрыт/);
});

/* Обход запрета возвратом: путь нормализуется до state/ уже после resolve. */
test('state не открывается кружным путём', () => {
  assert.throws(() => resolveInRoot('fixtures/../state/prod.json'), /закрыт/);
});
