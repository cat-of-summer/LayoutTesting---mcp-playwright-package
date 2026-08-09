import path from 'node:path';
import { createSession, closeSession, gotoAndSettle } from '../browser/pool.js';
import { profileKey } from '../browser/profile.js';
import { layoutAudit } from './layout.js';
import { runAxe } from './a11y.js';
import { takeScreenshot, compareWithBaseline } from './visual.js';
import { newRunId, runDir, writeJson, slug } from '../artifacts.js';

/**
 * Индекс историй Storybook. С 7-й версии это index.json, раньше — stories.json.
 * Обходим их своим пулом браузеров, а не test-runner'ом: так истории попадают
 * в те же артефакты и ту же визуальную регрессию, что и обычные страницы.
 */
async function fetchIndex(storybookUrl) {
  const base = storybookUrl.replace(/\/+$/, '');
  for (const file of ['index.json', 'stories.json']) {
    const res = await fetch(`${base}/${file}`).catch(() => null);
    if (res?.ok) {
      const data = await res.json();
      const entries = Object.values(data.entries || data.stories || {});
      return entries.filter((e) => (e.type ? e.type === 'story' : true));
    }
  }
  throw new Error(
    `Не удалось получить index.json у Storybook (${base}). Проверьте URL и что Storybook собран или запущен.`,
  );
}

export async function auditStorybook({
  storybookUrl,
  profile = {},
  include = null,
  limit = 100,
  checks = ['layout', 'axe', 'screenshot'],
  visual = false,
  runId = newRunId('storybook'),
} = {}) {
  const entries = await fetchIndex(storybookUrl);
  const filtered = (include ? entries.filter((e) => new RegExp(include, 'i').test(e.id + ' ' + (e.title || ''))) : entries)
    .slice(0, limit);

  const base = storybookUrl.replace(/\/+$/, '');
  const key = profileKey(profile);
  const session = await createSession(profile);
  const stories = [];

  try {
    for (const entry of filtered) {
      const url = `${base}/iframe.html?id=${encodeURIComponent(entry.id)}&viewMode=story`;
      const story = { id: entry.id, title: entry.title, name: entry.name, url };
      try {
        await gotoAndSettle(session, url, { waitUntil: 'load' });
        if (checks.includes('layout')) story.layout = await layoutAudit(session.page);
        if (checks.includes('axe')) story.axe = await runAxe(session.page);
        if (checks.includes('screenshot')) {
          story.screenshot = await takeScreenshot(session.page, {
            runId,
            name: `story__${slug(entry.id)}__${slug(key)}`,
            fullPage: false,
          });
          if (visual) {
            story.visual = await compareWithBaseline({
              runId,
              name: `story__${entry.id}`,
              profileKey: key,
              actualPath: story.screenshot.path,
            });
          }
        }
        story.problems = [
          story.layout?.total ? `вёрстка: ${story.layout.total}` : null,
          story.axe?.total ? `axe: ${story.axe.total}` : null,
          story.visual?.status === 'diff' ? `визуально: ${story.visual.diffPercentage}%` : null,
        ].filter(Boolean);
      } catch (err) {
        story.error = err.message;
      }
      stories.push(story);
    }
  } finally {
    await closeSession(session.id);
  }

  const dir = await runDir(runId);
  const jsonFile = path.join(dir, 'storybook.json');
  await writeJson(jsonFile, { runId, storybookUrl, profileKey: key, stories });

  return {
    runId,
    storybookUrl,
    profileKey: key,
    total: stories.length,
    withProblems: stories.filter((s) => s.problems?.length || s.error).length,
    report: jsonFile,
    stories: stories.map((s) => ({
      id: s.id,
      title: s.title,
      problems: s.error ? [`ошибка: ${s.error}`] : s.problems,
      screenshot: s.screenshot?.url || null,
    })),
  };
}
