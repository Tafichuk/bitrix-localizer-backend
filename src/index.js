require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const { parseArticle } = require('./scraper');
const { translateContentBatch, LANGUAGE_NAMES, LANGUAGE_LABELS } = require('./translator');
const { takeScreenshotWithComputerUse, loadPortalAuth, openBrowserSession, closeBrowserSession } = require('./computer-use-screenshot');
const { generateZip } = require('./generator');
const { getKBStats } = require('./knowledge-lookup');

const app = express();
const PORT = process.env.PORT || 3000;
const PORTAL_URL = process.env.PORTAL_URL || '';

// Pre-load portal auth from env once at startup
const envPortalCookies = loadPortalAuth();

// Auth cache: avoid re-injecting env cookies for every job
let cachedAuthState = null;
let authExpiry = null;

// In-memory job store
const jobs = new Map();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '6.0.0',
  portalConfigured: !!PORTAL_URL && envPortalCookies.length > 0,
}));

app.get('/api/kb-stats', (req, res) => {
  try {
    const stats = getKBStats();
    res.json({ status: 'ok', ...stats });
  } catch (e) {
    res.json({ status: 'no_kb', total: 0, bySection: {} });
  }
});

// Start localization job
app.post('/api/localize', (req, res) => {
  const { articleUrl, portalUrl, cookies, languages } = req.body;

  if (!articleUrl || !languages?.length) {
    return res.status(400).json({ error: 'Укажите URL статьи и язык' });
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

  // Resolve portal config: prefer request body, fallback to env
  const effectivePortalUrl = portalUrl || PORTAL_URL;
  const effectiveCookies = resolveCookies(cookies);

  processJob(job, { articleUrl, portalUrl: effectivePortalUrl, cookies: effectiveCookies, languages });

  res.json({ jobId });
});

function resolveCookies(requestCookies) {
  if (requestCookies) {
    if (Array.isArray(requestCookies) && requestCookies.length > 0) return requestCookies;
    if (typeof requestCookies === 'string' && requestCookies.trim()) {
      // Parse "name=value; name2=value2" cookie string
      return requestCookies.split(';').map(pair => {
        const [name, ...rest] = pair.trim().split('=');
        return { name: name.trim(), value: rest.join('=').trim(), domain: '' };
      }).filter(c => c.name);
    }
  }
  return envPortalCookies;
}

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

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function processJob(job, { articleUrl, portalUrl, cookies, languages }) {
  job.status = 'running';
  console.time('total');

  try {
    // Step 1: Parse article
    emit(job, 'progress', { step: 'scraping', message: '🔍 Парсинг статьи с helpdesk.bitrix24.ru...', progress: 5 });
    console.time('parsing');
    const article = await parseArticle(articleUrl);
    console.timeEnd('parsing');

    emit(job, 'progress', {
      step: 'scraped',
      message: `✅ Статья: "${article.title}". Скриншотов: ${article.screenshots.length}`,
      progress: 15,
    });

    // Step 2: Translate all languages in ONE OpenAI call
    emit(job, 'progress', { step: 'translating', message: `🌐 Перевод на ${languages.length} язык(ов) через OpenAI...`, progress: 16 });
    console.time('translation');

    const translations = {};
    try {
      const batchResult = await translateContentBatch(article, languages);
      Object.assign(translations, batchResult);
      for (const lang of languages) {
        if (translations[lang]) {
          emit(job, 'progress', { step: 'translated', message: `✅ ${LANGUAGE_LABELS[lang] || lang} переведён`, progress: 0 });
        } else {
          emit(job, 'progress', { step: 'warn', message: `⚠️ Нет перевода для ${lang}`, progress: 0 });
        }
      }
    } catch (err) {
      emit(job, 'progress', { step: 'warn', message: `⚠️ Ошибка batch-перевода: ${err.message}`, progress: 0 });
    }
    console.timeEnd('translation');
    emit(job, 'progress', { step: 'translated', message: '✅ Переводы готовы', progress: 40 });

    // Step 3: Computer Use screenshots
    const portalScreenshots = {};
    const screenshots = article.screenshots;

    if (screenshots.length > 0 && portalUrl && cookies.length > 0) {
      emit(job, 'progress', {
        step: 'screenshots',
        message: `📸 Computer Use: ${screenshots.length} скриншот(ов), открываю браузер...`,
        progress: 42,
      });

      console.time('screenshots');
      const axios = require('axios');
      const sharp = require('sharp');
      let session = null;

      try {
        // Open browser + download all originals in parallel
        const [sessionResult, originals] = await Promise.all([
          openBrowserSession(portalUrl, cookies),
          Promise.all(screenshots.map(async (img, si) => {
            try {
              const resp = await axios.get(img.absoluteUrl, {
                responseType: 'arraybuffer', timeout: 20000,
                headers: { 'User-Agent': 'Mozilla/5.0' },
              });
              return (await sharp(Buffer.from(resp.data))
                .resize({ width: 1280, withoutEnlargement: true })
                .jpeg({ quality: 75 })
                .toBuffer()).toString('base64');
            } catch (e) {
              emit(job, 'progress', { step: 'warn', message: `⚠️ Оригинал ${si + 1} недоступен: ${e.message}`, progress: 0 });
              return null;
            }
          })),
        ]);
        session = sessionResult;

        emit(job, 'progress', {
          step: 'screenshots',
          message: `📸 Computer Use: ${screenshots.length} скриншот(ов)...`,
          progress: 44,
        });

        // Раздел статьи из хлебных крошек (предпоследний элемент)
        const articleSection = article.breadcrumbs?.[article.breadcrumbs.length - 2]
          || article.breadcrumbs?.[article.breadcrumbs.length - 1]
          || 'Feed';
        console.log(`[index] articleSection: "${articleSection}"`);

        const shotBuffers = [];
        for (let si = 0; si < screenshots.length; si++) {
          const img = screenshots[si];
          console.log(`📸 Скрин ${si + 1}: ${img.src}`);
          console.log(`📝 Контекст: ${img.context || img.alt || '—'}`);
          console.log(`🖼️ Оригинал загружен: ${originals[si] ? originals[si].length : 'EMPTY'} chars`);
          const description = img.alt || img.context || `Screenshot ${si + 1} from Bitrix24 article`;
          emit(job, 'progress', {
            step: 'screenshot',
            message: `📸 ${si + 1}/${screenshots.length}: Computer Use...`,
            progress: 44 + (si / screenshots.length) * 40,
          });
          console.log(`🤖 Запускаю Computer Use для скрина ${si + 1}...`);
          try {
            const buf = await takeScreenshotWithComputerUse(session.context, portalUrl, description, originals[si] || '', articleSection, img.context, img.alt);
            emit(job, 'progress', { step: 'screenshot', message: `✅ ${si + 1}/${screenshots.length}: готово`, progress: 44 + ((si + 1) / screenshots.length) * 40 });
            shotBuffers.push(buf);
          } catch (err) {
            emit(job, 'progress', { step: 'warn', message: `⚠️ Скрин ${si + 1}: ${err.message}`, progress: 0 });
            shotBuffers.push(null);
          }
          if (si < screenshots.length - 1) await sleep(5000);
        }

        screenshots.forEach((img, si) => {
          portalScreenshots[img.src] = {};
          portalScreenshots[img.absoluteUrl] = portalScreenshots[img.src];
          for (const lang of languages) {
            portalScreenshots[img.src][lang] = shotBuffers[si];
          }
        });

        emit(job, 'progress', { step: 'screenshots_done', message: '✅ Все скриншоты сделаны', progress: 85 });

      } finally {
        if (session) await closeBrowserSession(session);
        console.timeEnd('screenshots');
      }

    } else if (screenshots.length > 0) {
      const reason = !portalUrl ? 'Portal URL не указан' : 'Cookies не настроены';
      emit(job, 'progress', { step: 'warn', message: `⚠️ Скриншоты пропущены: ${reason}`, progress: 85 });
    }

    // Step 4: Generate ZIP
    emit(job, 'progress', { step: 'generating', message: '📦 Генерация HTML файлов...', progress: 90 });
    const zipBuffer = await generateZip(article, translations, screenshots, portalScreenshots);
    job.zipBuffer = zipBuffer;

    console.timeEnd('total');
    emit(job, 'progress', { step: 'done', message: '✅ Готово! Скачивайте архив.', progress: 100 });
    emit(job, 'complete', { jobId: job.id, downloadUrl: `/api/download/${job.id}` });
    job.status = 'done';

  } catch (err) {
    console.error('[processJob] Error:', err);
    console.timeEnd('total');
    emit(job, 'error', { message: err.message });
    job.status = 'error';
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Cleanup old jobs after 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of jobs.entries()) {
    if (job.createdAt && job.createdAt < cutoff) jobs.delete(id);
  }
}, 30 * 60 * 1000);

app.listen(PORT, () => console.log(`Bitrix Localizer Backend v6 running on port ${PORT}`));
