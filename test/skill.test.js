/**
 * SKILL.md собирается из guide/, а не лежит файлом — и здесь сторожится, что сборка полна и
 * годна: без frontmatter клиент скилл не подхватит, фаза без чек-листа из него выпадает, ссылка
 * на несуществующий раздел уводит в тупик. Те же проверки гоняет генератор документации.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { buildSkill, checkSkill, SKILL_MAX_CHARS, SKILL_NAME } from '../src/skill.js';
import { ORDER, PHASES } from '../src/guide.js';
import { handleGuideRoute } from '../src/guide-http.js';

test('скилл собирается на обоих языках и проходит свои же проверки', async () => {
  for (const lang of ['ru', 'en']) {
    const skill = await buildSkill(lang);
    assert.deepEqual(skill.missing, [], `${lang}: у фаз нет чек-листов`);
    assert.deepEqual(checkSkill(skill), [], `${lang}: скилл не проходит проверки`);
    assert.match(skill.text, new RegExp(`^---\\nname: ${SKILL_NAME}\\ndescription: .+\\n---\\n`));
    for (const slug of PHASES) assert.ok(skill.text.includes(`· ${slug} —`), `${lang}: в скилле нет фазы ${slug}`);
    assert.ok(skill.text.length <= SKILL_MAX_CHARS);
    /* Правила и запреты — из rules, карта фаз — из index: скилл не пересказывает, а склеивает. */
    assert.match(skill.text, lang === 'en' ? /### Prohibitions/ : /### Запреты/);
    assert.match(skill.text, /\| `setup` \| 0 \|/);
  }
});

test('проверка ловит скилл без frontmatter, без чек-листа и с битой ссылкой', () => {
  const problems = checkSkill({ text: '# нет frontmatter\n\nhelp(guide: "nowhere")', missing: ['block'] });
  assert.equal(problems.length, 3, problems.join('; '));
  assert.ok(problems.some((p) => p.includes('frontmatter')));
  assert.ok(problems.some((p) => p.includes('block')));
  assert.ok(problems.some((p) => p.includes('nowhere')));
  /* Подстановка «<раздел>» — не ссылка. */
  assert.deepEqual(checkSkill({ text: '---\nname: x\ndescription: y\n---\nhelp(guide: "<раздел>")', missing: [] }), []);
});

test('маршруты /skill и /guide отдают markdown и объясняют 404', async () => {
  const server = http.createServer((req, res) => handleGuideRoute(req, res, new URL(req.url, 'http://stand')));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const skill = await fetch(`${base}/skill/${SKILL_NAME}/SKILL.md?lang=en`);
    assert.equal(skill.status, 200);
    assert.match(skill.headers.get('content-type'), /text\/markdown/);
    assert.match(await skill.text(), /^---\nname: layout-by-figma/);

    const section = await fetch(`${base}/guide/ru/rules.md`);
    assert.equal(section.status, 200);
    assert.match(await section.text(), /^# Правила и запреты/);

    const missing = await fetch(`${base}/guide/en/nope.md`);
    assert.equal(missing.status, 404);
    assert.ok((await missing.text()).includes(ORDER.join(', ')), '404 перечисляет разделы');

    const escape = await fetch(`${base}/guide/ru/..%2Fi18n.md`);
    assert.equal(escape.status, 404);
  } finally {
    server.close();
  }
});
