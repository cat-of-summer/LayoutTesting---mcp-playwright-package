import test from 'node:test';
import assert from 'node:assert/strict';
import { toMatcher, rewriteUrl, describeRequestBody } from '../src/browser/routes.js';

test('glob остаётся строкой — его разбирает сам playwright', () => {
  assert.equal(toMatcher('**/analytics/**'), '**/analytics/**');
  assert.equal(toMatcher('https://site/style.css'), 'https://site/style.css');
});

test('строка вида /…/flags превращается в регулярное выражение', () => {
  const re = toMatcher('/loaded\\/.*\\.jpg$/i');
  assert.ok(re instanceof RegExp);
  assert.equal(re.flags, 'i');
  assert.ok(re.test('https://site/loaded/about/PHOTO.JPG'));
  assert.equal(re.test('https://site/loaded/about/photo.png'), false);
});

test('одиночный слэш в середине не делает из glob регулярное выражение', () => {
  assert.equal(typeof toMatcher('/loaded/**'), 'string');
});

test('rewrite меняет хост и сохраняет путь — то, чего не умеет redirect', () => {
  assert.equal(
    rewriteUrl('http://site.ru/storage/112/photo.jpg', '/^https?:\\/\\/site\\.ru/', 'http://nginx_local'),
    'http://nginx_local/storage/112/photo.jpg',
  );
});

test('rewrite подстрокой заменяет все вхождения', () => {
  assert.equal(
    rewriteUrl('http://cdn.site.ru/a/site.ru/b.jpg', 'site.ru', 'local'),
    'http://cdn.local/a/local/b.jpg',
  );
});

test('в замене работают группы регулярного выражения', () => {
  assert.equal(
    rewriteUrl('http://site.ru/img/1.jpg', '/^https?:\\/\\/site\\.ru\\/img\\/(.+)$/', 'http://local/media/$1'),
    'http://local/media/1.jpg',
  );
});

test('несовпавший адрес остаётся прежним', () => {
  assert.equal(rewriteUrl('http://other.ru/x.jpg', 'site.ru', 'local'), 'http://other.ru/x.jpg');
});

/*
 * Разбор тела запроса.
 *
 * Настоящий запрос здесь не нужен: из объекта playwright читаются ровно два метода, а вся
 * работа — в разборе буфера. Браузер ради этого не поднимаем, зато проверяем те случаи,
 * которые в живом прогоне попадаются по одному и разбираются долго.
 */
const fakeRequest = (body, headers = {}) => ({
  postDataBuffer: () => (body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body)),
  headers: () => headers,
});

const multipart = [
  '--X',
  'Content-Disposition: form-data; name="vacancy"',
  '',
  'Фронтендер',
  '--X',
  'Content-Disposition: form-data; name="files[]"; filename="resume.pdf"',
  'Content-Type: application/pdf',
  '',
  '%PDF-1.4 тело файла',
  '--X--',
  '',
].join('\r\n');

test('multipart разбирается на поля и файлы', () => {
  const body = describeRequestBody(
    fakeRequest(multipart, { 'content-type': 'multipart/form-data; boundary=X' }),
  );

  assert.equal(body.kind, 'multipart');
  assert.equal(body.fields.length, 2);

  assert.deepEqual(
    { name: body.fields[0].name, value: body.fields[0].value },
    { name: 'vacancy', value: 'Фронтендер' },
  );

  // У файла показываем имя, тип и размер: содержимое читать незачем, а весит оно сколько угодно.
  assert.equal(body.fields[1].name, 'files[]');
  assert.equal(body.fields[1].filename, 'resume.pdf');
  assert.equal(body.fields[1].contentType, 'application/pdf');
  assert.ok(body.fields[1].bytes > 0);
  assert.equal(body.fields[1].value, undefined);
});

test('пустой input[type=file] остаётся файлом, а не текстовым полем', () => {
  const empty = ['--X', 'Content-Disposition: form-data; name="scan"; filename=""', '', '', '--X--', ''].join('\r\n');
  const body = describeRequestBody(fakeRequest(empty, { 'content-type': 'multipart/form-data; boundary=X' }));

  assert.equal(body.fields[0].filename, '');
  assert.equal(body.fields[0].bytes, 0);
});

test('форма без файлов разбирается на пары', () => {
  const body = describeRequestBody(
    fakeRequest('name=Иван&consent=on', { 'content-type': 'application/x-www-form-urlencoded' }),
  );
  assert.equal(body.kind, 'form');
  assert.deepEqual(body.fields, [
    { name: 'name', value: 'Иван' },
    { name: 'consent', value: 'on' },
  ]);
});

test('json приходит текстом, картинка — одним размером', () => {
  const json = describeRequestBody(fakeRequest('{"a":1}', { 'content-type': 'application/json' }));
  assert.equal(json.kind, 'text');
  assert.equal(json.text, '{"a":1}');

  const binary = describeRequestBody(fakeRequest(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { 'content-type': 'image/png' }));
  assert.equal(binary.kind, 'binary');
  assert.equal(binary.bytes, 4);
  assert.equal(binary.text, undefined);
});

test('запрос без тела не выдумывает пустую запись', () => {
  assert.equal(describeRequestBody(fakeRequest(null)), null);
});

test('boundary без кавычек и с кавычками разбираются одинаково', () => {
  const quoted = describeRequestBody(
    fakeRequest(multipart, { 'content-type': 'multipart/form-data; boundary="X"' }),
  );
  assert.equal(quoted.fields.length, 2);
});
