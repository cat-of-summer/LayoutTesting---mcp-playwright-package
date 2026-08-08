import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { compare as odiffCompare } from 'odiff-bin';
import { CONFIG } from '../config.js';
import { artifactRef, baselinePath, runDir, slug } from '../artifacts.js';

/**
 * Снимок страницы. Маска закрывает заведомо нестабильные зоны (часы, баннеры),
 * иначе они краснят каждый прогон визуальной регрессии.
 */
export async function takeScreenshot(page, {
  runId,
  name = 'screenshot',
  fullPage = true,
  selector = null,
  clip = null,
  mask = [],
  omitBackground = false,
} = {}) {
  const dir = await runDir(runId);
  const file = path.join(dir, `${slug(name)}.png`);

  const maskLocators = (mask || []).map((sel) => page.locator(sel));
  const common = { path: file, mask: maskLocators, maskColor: '#FF00FF', omitBackground };

  if (selector) {
    await page.locator(selector).first().screenshot(common);
  } else if (clip) {
    await page.screenshot({ ...common, clip });
  } else {
    await page.screenshot({ ...common, fullPage });
  }

  const meta = await sharp(file).metadata();
  return { ...artifactRef(file), name, width: meta.width, height: meta.height };
}

/** Уменьшенная копия для инлайн-отдачи агенту: полный PNG съедает контекст. */
export async function inlineImage(absPath, maxWidth = 900) {
  const buf = await sharp(absPath)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return { data: buf.toString('base64'), mimeType: 'image/png', bytes: buf.length };
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Сравнение с эталоном. Если эталона нет — снимок становится эталоном,
 * и это честно сообщается: первый прогон никогда не «проходит» молча.
 */
export async function compareWithBaseline({
  runId,
  name,
  profileKey: key = '',
  actualPath,
  threshold = CONFIG.visualThreshold,
  updateBaseline = false,
}) {
  const base = baselinePath(name, key);
  const dir = await runDir(runId);
  const diffFile = path.join(dir, `${slug(name)}${key ? `__${slug(key)}` : ''}.diff.png`);

  await fs.mkdir(path.dirname(base), { recursive: true });

  if (updateBaseline || !(await exists(base))) {
    await fs.copyFile(actualPath, base);
    return {
      status: updateBaseline ? 'baseline-updated' : 'baseline-created',
      match: null,
      baseline: { path: base },
      actual: artifactRef(actualPath),
      note: updateBaseline
        ? 'Эталон перезаписан текущим снимком.'
        : 'Эталона не было — снимок принят как эталон. Сравнивать будет следующий прогон.',
    };
  }

  const result = await odiffCompare(base, actualPath, diffFile, {
    threshold: 0.1,
    antialiasing: true,
    outputDiffMask: false,
  });

  if (result.match) {
    await fs.rm(diffFile, { force: true });
    return {
      status: 'match',
      match: true,
      diffPercentage: 0,
      threshold,
      baseline: { path: base },
      actual: artifactRef(actualPath),
    };
  }

  if (result.reason === 'layout-diff') {
    return {
      status: 'size-mismatch',
      match: false,
      threshold,
      baseline: { path: base },
      actual: artifactRef(actualPath),
      note: 'Размеры снимка и эталона не совпали — сравнение по пикселям невозможно.',
    };
  }

  const diffPercentage = Number(result.diffPercentage || 0);
  return {
    status: diffPercentage > threshold ? 'diff' : 'within-threshold',
    match: diffPercentage <= threshold,
    diffPercentage: Math.round(diffPercentage * 1000) / 1000,
    diffCount: result.diffCount,
    threshold,
    baseline: { path: base },
    actual: artifactRef(actualPath),
    diff: (await exists(diffFile)) ? artifactRef(diffFile) : null,
  };
}

export async function listBaselines(dirPath) {
  const dir = dirPath;
  try {
    const files = await fs.readdir(dir);
    const out = [];
    for (const f of files.filter((x) => x.endsWith('.png'))) {
      const st = await fs.stat(path.join(dir, f));
      out.push({ name: f.replace(/\.png$/, ''), path: path.join(dir, f), bytes: st.size, mtime: st.mtime.toISOString() });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}
