import test from 'node:test';
import assert from 'node:assert/strict';
import {
  contextOptions,
  hostResolverRules,
  normalizeProfile,
  parseAuth,
  profileKey,
  resolveViewport,
} from '../src/browser/profile.js';

test('viewport берётся из пресета и из строки WxH', () => {
  assert.deepEqual(resolveViewport('mobile'), { width: 375, height: 812 });
  assert.deepEqual(resolveViewport('375x812'), { width: 375, height: 812 });
  assert.throws(() => resolveViewport('огромный'), /Неизвестный viewport/);
});

test('zoom сжимает область просмотра', () => {
  const p = normalizeProfile({ viewport: 'desktop', zoom: 200 });
  assert.deepEqual(p.viewport, { width: 720, height: 450 });
});

/*
 * Повторная нормализация — не выдуманный случай: createSession нормализует профиль и хранит
 * его, а contextOptions и profileKey нормализуют этот же объект ещё раз. Пока zoom применялся
 * при каждом проходе, сессия с zoom: 200 открывалась вдвое уже, чем просили.
 */
test('повторная нормализация не сжимает viewport второй раз', () => {
  const once = normalizeProfile({ viewport: 'desktop', zoom: 200 });
  const twice = normalizeProfile(once);
  assert.deepEqual(twice.viewport, { width: 720, height: 450 });
  assert.deepEqual(contextOptions(once).viewport, { width: 720, height: 450 });
  assert.equal(profileKey(once), 'chromium_720x450_zoom200');
});

test('метка нормализации не протекает в имена и ответы', () => {
  const p = normalizeProfile({ viewport: 'desktop', zoom: 200 });
  assert.equal(Object.keys(p).includes('NORMALIZED'), false);
  assert.equal(JSON.stringify(p).includes('normalized'), false);
});

test('auth принимает строку и объект', () => {
  assert.deepEqual(parseAuth('user:pass'), { username: 'user', password: 'pass' });
  // Двоеточие в пароле — не редкость, делить надо по первому.
  assert.deepEqual(parseAuth('user:a:b'), { username: 'user', password: 'a:b' });
  assert.deepEqual(parseAuth({ username: 'u', password: 'p' }), { username: 'u', password: 'p' });
  assert.throws(() => parseAuth(':nouser'), /пользователь:пароль/);
});

test('auth раскрывается в httpCredentials и попадает в опции контекста', () => {
  const p = normalizeProfile({ auth: 'hevel:hevel' });
  assert.deepEqual(p.httpCredentials, { username: 'hevel', password: 'hevel' });
  assert.deepEqual(contextOptions(p).httpCredentials, { username: 'hevel', password: 'hevel' });
});

test('доступ и заголовки не влияют на ключ профиля — иначе поедут имена эталонов', () => {
  const base = profileKey({ viewport: 'mobile' });
  const withAccess = profileKey({
    viewport: 'mobile',
    auth: 'user:pass',
    extraHTTPHeaders: { 'Accept-Language': 'ru' },
    hostMap: { 'site.local': '10.0.0.1' },
  });
  assert.equal(withAccess, base);
  assert.equal(base, 'chromium_375x812');
});

test('условия просмотра в ключе профиля остаются', () => {
  assert.equal(
    profileKey({ viewport: 'desktop', colorScheme: 'dark', rtl: true, deviceScaleFactor: 2 }),
    'chromium_1440x900_dpr2_dark_rtl',
  );
});

test('пустые заголовки не попадают в опции контекста', () => {
  const opts = contextOptions(normalizeProfile({}));
  assert.equal('httpCredentials' in opts, false);
  assert.equal('extraHTTPHeaders' in opts, false);
});

test('hostMap разворачивается в аргумент запуска chromium', () => {
  assert.equal(hostResolverRules(null), null);
  assert.equal(hostResolverRules({}), null);
  assert.equal(
    hostResolverRules({ 'www.site.local': '10.0.0.1', 'api.site.local': '10.0.0.2' }),
    '--host-resolver-rules=MAP www.site.local 10.0.0.1,MAP api.site.local 10.0.0.2',
  );
});
