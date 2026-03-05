require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const { parseArticle } = require('./scraper');
const { translateContent } = require('./translator');
const { takeScreenshotWithComputerUse, loadPortalAuth, openBrowserSession, closeBrowserSession } = require('./computer-use-screenshot');
const { generateZip } = require('./generator');

const app = express();
const PORT = process.env.PORT || 3000;
const PORTAL_URL = process.env.PORTAL_URL || '';

// Pre-load portal auth once at startup
const portalCookies = loadPortalAuth();

// In-memory job store
const jobs = new Map();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({
  status: 'ok',
  version: '5.0.0',
  portalConfigured: !!PORTAL_URL && portalCookies.length > 0,
}));

// Start localization job
app.post('/api/localize', (req, res) => {
  const { articleUrl, languages } = req.body;

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

  processJob(job, { articleUrl, languages });

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

// ─── Main pipeline ────────────────────────────────────────────────────────────

async function processJob(job, { articleUrl, languages }) {
  job.status = 'running';

  try {
    // Step 1: Parse article
    emit(job, 'progress', { step: 'scraping', message: '🔍 Парсинг статьи с helpdesk.bitrix24.ru...', progress: 5 });
    const article = await parseArticle(articleUrl);

    emit(job, 'progress', {
      step: 'scraped',
      message: `✅ Статья: "${article.title}". Скриншотов: ${article.screenshots.length}`,
      progress: 15,
    });

    // Step 2: Translate
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
    emit(job, 'progress', { step: 'translated', message: `✅ Переводы готовы`, progress: 40 });

    // Step 3: Computer Use screenshots
    // portalScreenshots: { [src]: { [lang]: Buffer } }
    const portalScreenshots = {};
    const screenshots = article.screenshots;

    if (screenshots.length > 0 && PORTAL_URL && portalCookies.length > 0) {
      emit(job, 'progress', {
        step: 'screenshots',
        message: `📸 Computer Use: ${screenshots.length} скриншот(ов), открываю браузер...`,
        progress: 42,
      });

      const axios = require('axios');
      const sharp = require('sharp');
      const totalOps = screenshots.length * languages.length;
      let doneOps = 0;
      let session = null;

      try {
        // One browser session for all screenshots in this job
        session = await openBrowserSession(PORTAL_URL, portalCookies);

        for (let si = 0; si < screenshots.length; si++) {
          const img = screenshots[si];
          portalScreenshots[img.src] = {};
          portalScreenshots[img.absoluteUrl] = portalScreenshots[img.src];

          // Download + compress original Russian screenshot as visual context for Claude
          let origBase64 = null;
          try {
            const resp = await axios.get(img.absoluteUrl, {
              responseType: 'arraybuffer', timeout: 20000,
              headers: { 'User-Agent': 'Mozilla/5.0' },
            });
            const compressed = await sharp(Buffer.from(resp.data))
              .resize({ width: 1280, withoutEnlargement: true })
              .jpeg({ quality: 75 })
              .toBuffer();
            origBase64 = compressed.toString('base64');
          } catch (e) {
            emit(job, 'progress', { step: 'warn', message: `⚠️ Оригинал ${si + 1} недоступен: ${e.message}`, progress: 0 });
          }

          const description = img.alt || img.context || `Screenshot ${si + 1} from Bitrix24 article`;

          // Same screenshot works for all languages (portal language is fixed)
          emit(job, 'progress', {
            step: 'screenshot',
            message: `📸 ${si + 1}/${screenshots.length}: Computer Use...`,
            progress: 42 + (doneOps / totalOps) * 43,
          });

          let buffer = null;
          try {
            buffer = await takeScreenshotWithComputerUse(session.page, PORTAL_URL, description, origBase64 || '');
          } catch (err) {
            emit(job, 'progress', { step: 'warn', message: `⚠️ Скрин ${si + 1}: ${err.message}`, progress: 0 });
          }

          // Assign same buffer to all requested languages
          for (const lang of languages) {
            portalScreenshots[img.src][lang] = buffer;
            doneOps++;
          }

          emit(job, 'progress', {
            step: 'screenshot',
            message: `✅ ${si + 1}/${screenshots.length}: готово`,
            progress: 42 + (doneOps / totalOps) * 43,
          });
        }

        emit(job, 'progress', { step: 'screenshots_done', message: '✅ Все скриншоты сделаны', progress: 85 });

      } finally {
        if (session) await closeBrowserSession(session);
      }

    } else if (screenshots.length > 0) {
      const reason = !PORTAL_URL ? 'PORTAL_URL не настроен' : 'PORTAL_AUTH_JSON не настроен';
      emit(job, 'progress', { step: 'warn', message: `⚠️ Скриншоты пропущены: ${reason}`, progress: 85 });
    }

    // Step 4: Generate ZIP
    emit(job, 'progress', { step: 'generating', message: '📦 Генерация HTML файлов...', progress: 90 });
    const zipBuffer = await generateZip(article, translations, screenshots, portalScreenshots);
    job.zipBuffer = zipBuffer;

    emit(job, 'progress', { step: 'done', message: '✅ Готово! Скачивайте архив.', progress: 100 });
    emit(job, 'complete', { jobId: job.id, downloadUrl: `/api/download/${job.id}` });
    job.status = 'done';

  } catch (err) {
    console.error('[processJob] Error:', err);
    emit(job, 'error', { message: err.message });
    job.status = 'error';
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

app.listen(PORT, () => console.log(`Bitrix Localizer Backend v5 running on port ${PORT}`));
