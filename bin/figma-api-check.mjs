#!/usr/bin/env node
/**
 * Проверка версии Figma API для сборки.
 *
 * Запускается при сборке образа, при старте стенда из исходников и перед npm test. Предупреждает,
 * но сборку не валит: отставание спецификации — повод запланировать обновление, а не остановить
 * выпуск. --strict возвращает код 1 тем, кому нужен жёсткий режим; --force пропускает кэш.
 */
import { checkFigmaApi, figmaApiNotice, githubAnnotation } from '../src/figma/api-check.js';

const strict = process.argv.includes('--strict');
const force = process.argv.includes('--force');

try {
  const result = await checkFigmaApi({ force });
  const { rest, plugin } = result.pinned;

  if (result.disabled) {
    console.log('[figma-api] проверка выключена: LT_UPDATE_CHECK=0');
  } else if (result.outdated === null) {
    console.log(`[figma-api] последнюю версию узнать не удалось (${result.unavailable}); закреплены rest-api-spec ${rest}, plugin-typings ${plugin}`);
  } else if (!result.outdated) {
    console.log(`[figma-api] актуально: rest-api-spec ${rest}, plugin-typings ${plugin}`);
  } else {
    console.error(`[figma-api] ${figmaApiNotice(result)}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(githubAnnotation(result));
    if (strict) process.exitCode = 1;
  }
} catch (err) {
  console.error(`[figma-api] проверка не удалась: ${err.message}`);
}
