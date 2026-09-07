/**
 * Куки и сохранённые состояния сессии.
 *
 * Каталог state/ закрыт для read_project_file и browser_route: там лежат живые логины. Но
 * browser/storage.js обязан в него ходить — значит у него своя проверка имени, и именно её надо
 * закрепить. Дыра здесь тише всех: имя с ../ просто запишет файл не туда, ничего не сломав.
 *
 * Второе, что проверяется, — что storageState не протёк в ключ профиля. Ключ идёт в имена
 * эталонов визуальной регрессии, и логин в имени файла означает разъехавшиеся эталоны.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DIRS } from '../src/config.js';
import { statePath } from '../src/browser/storage.js';
import { contextOptions, normalizeProfile, profileKey } from '../src/browser/profile.js';

test('имя состояния разворачивается в файл внутри state/', () => {
  const abs = statePath('prod-login');
  assert.equal(path.dirname(abs), DIRS.state);
  assert.equal(path.basename(abs), 'prod-login.json');
});

test('выйти из state/ через имя нельзя', () => {
  /* slug() схлопывает разделители пути, поэтому такие имена не выходят за каталог,
     а превращаются в обычный файл. Проверяем именно результат, а не способ. */
  for (const evil of ['../secret', '../../etc/passwd', 'a/b/c', './..']) {
    const abs = statePath(evil);
    assert.equal(path.dirname(abs), DIRS.state, `имя ${evil} увело за пределы state/`);
  }
});

test('пустое имя отвергается, а не превращается в .json', () => {
  assert.throws(() => statePath(''), /Нужно имя/);
  assert.throws(() => statePath('///'), /Нужно имя/);
});

test('storageState принимается именем и разворачивается в путь', () => {
  const p = normalizeProfile({ storageState: 'prod-login' });
  assert.equal(p.storageState, path.join(DIRS.state, 'prod-login.json'));
  assert.equal(contextOptions({ storageState: 'prod-login' }).storageState, p.storageState);
});

/*
 * Ровно та причина, что записана в profile.js про httpCredentials: доступ на пиксели не влияет,
 * а в имена baseline попадать не должен.
 */
test('storageState не попадает в ключ профиля', () => {
  const bare = profileKey({ browser: 'chromium', viewport: 'desktop' });
  const withState = profileKey({ browser: 'chromium', viewport: 'desktop', storageState: 'prod-login' });

  assert.equal(withState, bare);
  assert.ok(!withState.includes('prod'));
});

test('serviceWorkers прокидывается в контекст и тоже не влияет на ключ', () => {
  assert.equal(contextOptions({ serviceWorkers: 'block' }).serviceWorkers, 'block');
  assert.equal(profileKey({ serviceWorkers: 'block' }), profileKey({}));
});

/* Без явного значения опции в контекст не уезжают: undefined в storageState Playwright не любит. */
test('незаданные опции не появляются в контексте', () => {
  const opts = contextOptions({});
  assert.ok(!('storageState' in opts));
  assert.ok(!('serviceWorkers' in opts));
});
