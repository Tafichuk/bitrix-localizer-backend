require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const { parseArticle } = require('./scraper');
const { translateContent } = require('./translator');
const { getStepForScreenshot, downloadAndCompress } = require('./vision');
const { loginToPortal, takeScreenshot } = require('./screenshotter');
const { generateZip } = require('./generator');

// ─── Section map ──────────────────────────────────────────────────────────────
let sectionMap = {};
try {
  sectionMap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'section-map.json'), 'utf8'));
  console.log(`[index] Section map loaded: ${Object.keys(sectionMap).length} sections`);
} catch (err) {
  console.warn('[index] section-map.json not found:', err.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory job store
const jobs = new Map();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '3.0.0' }));

// Start localization job
app.post('/api/localize', (req, res) => {
  const { articleUrl, portalUrl, login, password, sessionCookies, languages } = req.body;

  if (!articleUrl || !portalUrl || !languages?.length) {
    return res.status(400).json({ error: 'Укажите URL статьи, URL портала и язык' });
  }
  if (!sessionCookies?.trim() && (!login?.trim() || !password?.trim())) {
    return res.status(400).json({ error: 'Укажите Session Cookies или логин и пароль' });
  }

  const jobId = uuidv4();
  const job = {
    id: jobId,
    status: 'pending',
    createdAt: Date.now(),
    events: [],
    zipBuffer: null,
    listeners: new Set(),
  };
  jobs.set(jobId, job);

  processJob(job, { articleUrl, portalUrl, login, password, sessionCookies, languages });

  res.json({ jobId });
});

// SSE stream for job progress
app.get('/api/stream/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  for (const ev of job.events) {
    res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  }

  if (job.status === 'done' || job.status === 'error') {
    res.end();
    return;
  }

  const listener = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'complete' || event === 'error') {
      res.end();
      job.listeners.delete(listener);
    }
  };
  job.listeners.add(listener);
  req.on('close', () => job.listeners.delete(listener));
});

// Download ZIP
app.get('/api/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.zipBuffer) {
    return res.status(404).json({ error: 'Файл не найден или обработка не завершена' });
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', 'attachment; filename="localized-articles.zip"');
  res.send(job.zipBuffer);
});

function emit(job, event, data) {
  job.events.push({ event, data });
  for (const listener of job.listeners) listener(event, data);
}

// ─── Section detection ────────────────────────────────────────────────────────

function findSectionKey(breadcrumbs) {
  if (!breadcrumbs || breadcrumbs.length === 0) return null;

  const normalized = breadcrumbs.map(b => b.toLowerCase().trim());

  for (const [key, cfg] of Object.entries(sectionMap)) {
    // Check direct name match
    if (normalized.some(b => b === key.toLowerCase())) return key;

    // Check aliases
    const aliases = (cfg.aliases || []).map(a => a.toLowerCase());
    if (normalized.some(b => aliases.some(a => b.includes(a) || a.includes(b)))) return key;
  }

  return null;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function processJob(job, { articleUrl, portalUrl, login, password, sessionCookies, languages }) {
  job.status = 'running';
  let browser = null;
  let context = null;

  try {
    // Step 1: Parse article
    emit(job, 'progress', { step: 'scraping', message: '🔍 Парсинг статьи с helpdesk.bitrix24.ru...', progress: 5 });
    const article = await parseArticle(articleUrl);

    const sectionKey = findSectionKey(article.breadcrumbs);
    const sectionConfig = sectionKey ? sectionMap[sectionKey] : null;
    const availableSteps = sectionConfig ? Object.keys(sectionConfig.steps || {}) : ['default'];

    emit(job, 'progress', {
      step: 'scraped',
      message: `✅ Статья: "${article.title}". Раздел: ${sectionKey || 'неизвестен'}. Скриншотов: ${article.screenshots.length}`,
      progress: 15,
    });

    // Step 2: Translate sequentially
    emit(job, 'progress', { step: 'translating', message: `🌐 Перевод на ${languages.length} язык(ов)...`, progress: 16 });

    const translations = {};
    for (let li = 0; li < languages.length; li++) {
      const lang = languages[li];
      try {
        translations[lang] = await translateContent(article, lang);
        emit(job, 'progress', {
          step: 'translated',
          message: `✅ ${LANGUAGE_NAMES[lang] || lang} переведён`,
          progress: 16 + ((li + 1) / languages.length) * 24,
        });
      } catch (err) {
        emit(job, 'progress', { step: 'warn', message: `⚠️ Ошибка перевода ${lang}: ${err.message}`, progress: 0 });
      }
      if (li < languages.length - 1) await sleep(1000);
    }
    emit(job, 'progress', { step: 'translated', message: `✅ Переводы готовы: ${Object.keys(translations).length} языков`, progress: 40 });

    // Step 3: Vision — pick step for each screenshot
    const screenshots = [...article.screenshots];

    if (screenshots.length > 0 && sectionKey) {
      emit(job, 'progress', {
        step: 'analyzing',
        message: `🤖 Определяю шаг для ${screenshots.length} скриншотов (раздел: ${sectionKey})...`,
        progress: 42,
      });

      await sleep(2000);

      for (let si = 0; si < screenshots.length; si++) {
        const img = screenshots[si];
        const analyzeProgress = 42 + ((si + 1) / screenshots.length) * 16;
        try {
          const compressed = await downloadAndCompress(img.absoluteUrl);
          if (compressed) {
            const step = await getStepForScreenshot(compressed.base64, sectionKey, availableSteps);
            screenshots[si] = { ...img, step };
            emit(job, 'progress', {
              step: 'analyzed',
              message: `🔎 ${si + 1}/${screenshots.length}: step="${step}"`,
              progress: analyzeProgress,
            });
          } else {
            screenshots[si] = { ...img, step: 'default' };
          }
        } catch (err) {
          screenshots[si] = { ...img, step: 'default' };
          emit(job, 'progress', { step: 'warn', message: `⚠️ Vision ${si + 1} пропущен: ${err.message}`, progress: analyzeProgress });
        }
        if (si < screenshots.length - 1) await sleep(2000);
      }
    } else {
      // No section detected or no screenshots — use default step
      for (let si = 0; si < screenshots.length; si++) {
        screenshots[si] = { ...screenshots[si], step: 'default' };
      }
      emit(job, 'progress', { step: 'analyzed', message: '⚠️ Раздел не определён — используется шаг по умолчанию', progress: 58 });
    }

    // Step 4: Portal screenshots
    const newScreenshots = {};

    if (screenshots.length > 0) {
      emit(job, 'progress', {
        step: 'screenshots',
        message: `📸 Запускаю браузер и делаю ${screenshots.length} скриншотов на портале...`,
        progress: 60,
      });

      try {
        browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
        context = await loginToPortal(browser, portalUrl, sessionCookies, login, password);
        emit(job, 'progress', { step: 'logged_in', message: '✅ Авторизация на портале успешна', progress: 63 });

        for (let si = 0; si < screenshots.length; si++) {
          const img = screenshots[si];
          const step = img.step || 'default';
          try {
            const buffer = await takeScreenshot(context, portalUrl, sectionKey || 'Лента Новостей', step);
            const b64 = buffer.toString('base64');
            newScreenshots[img.src] = { data: b64, mimeType: 'image/png' };
            newScreenshots[img.absoluteUrl] = { data: b64, mimeType: 'image/png' };
            emit(job, 'progress', {
              step: 'screenshot',
              message: `📸 ${si + 1}/${screenshots.length}: ${sectionKey || 'Feed'} / ${step}`,
              progress: 63 + ((si + 1) / screenshots.length) * 22,
            });
          } catch (err) {
            emit(job, 'progress', { step: 'warn', message: `⚠️ Скриншот ${si + 1} не удался: ${err.message}`, progress: 0 });
          }
        }

        emit(job, 'progress', {
          step: 'screenshots_done',
          message: `✅ Сделано ${Object.keys(newScreenshots).length / 2} скриншотов портала`,
          progress: 85,
        });
      } catch (err) {
        emit(job, 'progress', { step: 'warn', message: `⚠️ Ошибка браузера: ${err.message}`, progress: 85 });
      } finally {
        if (context) await context.close().catch(() => {});
        if (browser) await browser.close().catch(() => {});
        context = null;
        browser = null;
      }
    }

    // Step 5: Generate ZIP
    emit(job, 'progress', { step: 'generating', message: '📦 Генерация HTML файлов...', progress: 90 });
    const zipBuffer = await generateZip(article, translations, screenshots, newScreenshots);
    job.zipBuffer = zipBuffer;

    emit(job, 'progress', { step: 'done', message: '✅ Готово! Скачивайте архив.', progress: 100 });
    emit(job, 'complete', { jobId: job.id, downloadUrl: `/api/download/${job.id}` });
    job.status = 'done';

  } catch (err) {
    console.error('[processJob] Error:', err);
    emit(job, 'error', { message: err.message });
    job.status = 'error';
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const LANGUAGE_NAMES = {
  en: 'English', de: 'Deutsch', fr: 'Français',
  es: 'Español', pt: 'Português', pl: 'Polski', it: 'Italiano',
};

// Cleanup old jobs after 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt && job.createdAt < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

app.listen(PORT, () => console.log(`Bitrix Localizer Backend v3 running on port ${PORT}`));
