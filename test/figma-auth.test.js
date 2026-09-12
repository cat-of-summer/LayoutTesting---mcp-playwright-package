/**
 * Источники токена Figma и самостоятельный выпуск.
 *
 * Выпуск — запись в чужом аккаунте, поэтому проверяется прежде всего, когда его НЕ бывает:
 * при заданном FIGMA_TOKEN, при живом выпущенном токене, при простой проверке «есть ли токен» и
 * при выключенном FIGMA_TOKEN_AUTOISSUE. Сам интерфейс Figma здесь не трогается — выпуск подменён.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { issueTokenNow, lastTokenIssue, readIssuedToken, redact, registerTokenIssuer, resolveToken } from '../src/figma/auth.js';

delete process.env.FIGMA_TOKEN;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'figma-auth-'));
let fileNo = 0;
const tokenFile = () => path.join(tmp, `token-${(fileNo += 1)}.json`);
const DAY = 24 * 60 * 60 * 1000;
const now = Date.parse('2026-09-11T10:00:00Z');

let calls = [];
function issuer(result) {
  calls = [];
  registerTokenIssuer(async (args) => {
    calls.push(args);
    if (result instanceof Error) throw result;
    return result;
  });
}
const fresh = (days = 90) => ({
  token: 'figd_issued_token_value_1234567890',
  name: 'layout-stand 2026-09-11 10:00',
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + days * DAY).toISOString(),
});

test('FIGMA_TOKEN сильнее всего, и выпуск при нём не зовётся', async () => {
  issuer(fresh());
  process.env.FIGMA_TOKEN = 'figd_env_token_value_000000000000';
  try {
    assert.deepEqual(await resolveToken({ issue: true, file: tokenFile(), now, autoIssue: true }), {
      token: 'figd_env_token_value_000000000000',
      source: 'env',
    });
    assert.equal(calls.length, 0);
    await assert.rejects(issueTokenNow({ file: tokenFile(), now }), /сильнее выпущенного/);
  } finally {
    delete process.env.FIGMA_TOKEN;
  }
});

test('проверка «есть ли токен» ничего не выпускает; выпуск — только когда нужен запрос', async () => {
  issuer(fresh());
  const file = tokenFile();
  assert.deepEqual(await resolveToken({ file, now, autoIssue: true }), { token: null, source: null });
  assert.equal(calls.length, 0);

  const issued = await resolveToken({ issue: true, file, now, autoIssue: true });
  assert.equal(issued.issuedNow, true);
  assert.equal(issued.source, 'issued');
  assert.equal(calls.length, 1);
  assert.equal((await readIssuedToken({ file })).name, 'layout-stand 2026-09-11 10:00');

  const reused = await resolveToken({ issue: true, file, now: now + DAY, autoIssue: true });
  assert.equal(reused.issuedNow, undefined);
  assert.equal(calls.length, 1, 'живой токен не перевыпускается');
});

test('за два дня до срока токен перевыпускается, при неудаче остаётся прежний', async () => {
  const file = tokenFile();
  await fs.writeFile(file, JSON.stringify(fresh(1)));
  issuer(new Error('интерфейс Figma изменился'));
  const result = await resolveToken({ issue: true, file, now, autoIssue: true });
  assert.equal(result.token, 'figd_issued_token_value_1234567890');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].previous.name, 'layout-stand 2026-09-11 10:00', 'выпуску передаётся прежний токен — чтобы его отозвать');
  assert.equal(lastTokenIssue().ok, false);
  assert.match(lastTokenIssue().error, /интерфейс Figma изменился/);
});

test('истёкший токен не отдаётся, выключенный автовыпуск не выпускает', async () => {
  const file = tokenFile();
  await fs.writeFile(file, JSON.stringify(fresh(-1)));
  issuer(fresh());
  assert.deepEqual(await resolveToken({ issue: true, file, now, autoIssue: false }), { token: null, source: null });
  assert.equal(calls.length, 0);
});

test('redact прячет выпущенный токен и любой figd_ по префиксу', async () => {
  const file = tokenFile();
  await fs.writeFile(file, JSON.stringify(fresh()));
  await readIssuedToken({ file });
  assert.equal(redact('Invalid token figd_issued_token_value_1234567890'), 'Invalid token ***');
  assert.equal(redact('echo figd_someone_else_token_abcdef'), 'echo figd_***');
});
