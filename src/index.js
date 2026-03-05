require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { scrapeArticle } = require('./scraper');
const { translateContent } = require('./translator');
const { analyzeScreenshot } = require('./vision');
const { takePortalScreenshots } = require('./screenshotter');
const { generateZip } = require('./generator');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory job store
const jobs = new Map();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '2.0.0' }));

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
    events: [],
    zipBuffer: null,
    listeners: new Set(),
  };
  jobs.set(jobId, job);

  // Start background processing
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

  // Send all past events
  for (const ev of job.events) {
    res.write(`event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`);
  }

  // If already done, close
  if (job.status === 'done' || job.status === 'error') {
    res.end();
    return;
  }

  // Listen for new events
  const listener = (event, data) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    if (event === 'complete' || event === 'error') {
      res.end();
      job.listeners.delete(listener);
    }
  };
  job.listeners.add(listener);

  req.on('close', () => {
    job.listeners.delete(listener);
  });
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
  for (const listener of job.listeners) {
    listener(event, data);
  }
}

async function processJob(job, { articleUrl, portalUrl, login, password, sessionCookies, languages }) {
  job.status = 'running';

  try {
    // Step 1: Scrape article
    emit(job, 'progress', { step: 'scraping', message: '🔍 Парсинг статьи с helpdesk.bitrix24.ru...', progress: 5 });
    const article = await scrapeArticle(articleUrl);
    emit(job, 'progress', {
      step: 'scraped',
      message: `✅ Статья получена: "${article.title}". Найдено ${article.images.length} скриншотов`,
      progress: 15,
    });

    // Step 2: Перевод — последовательно по языкам
    emit(job, 'progress', {
      step: 'translating',
      message: `🌐 Перевод на ${languages.length} язык(ов)...`,
      progress: 16,
    });

    const translations = {};
    for (let li = 0; li < languages.length; li++) {
      const lang = languages[li];
      try {
        const t = await translateContent(article, lang);
        translations[lang] = t;
        emit(job, 'progress', {
          step: 'translated',
          message: `✅ ${LANGUAGE_NAMES[lang]} готов`,
          progress: 16 + ((li + 1) / languages.length) * 24,
        });
      } catch (err) {
        emit(job, 'progress', { step: 'warn', message: `⚠️ Ошибка перевода ${lang}: ${err.message}`, progress: 0 });
      }
      if (li < languages.length - 1) await sleep(1000);
    }
    emit(job, 'progress', { step: 'translated', message: `✅ Переводы готовы: ${Object.keys(translations).length} языков`, progress: 40 });

    // Step 3: Пауза перед Vision — снижаем нагрузку на API
    await sleep(3000);

    // Step 3: Анализ скриншотов — ПОСЛЕДОВАТЕЛЬНО с паузами
    emit(job, 'progress', {
      step: 'analyzing',
      message: `🤖 Анализирую ${article.images.length} скриншотов (последовательно)...`,
      progress: 42,
    });

    const screenshotAnalyses = [];
    for (let si = 0; si < article.images.length; si++) {
      const img = article.images[si];
      const analyzeProgress = 42 + ((si + 1) / article.images.length) * 18;
      try {
        const analysis = await analyzeScreenshot(img.absoluteUrl, languages[0]);
        screenshotAnalyses.push({ ...img, analysis });
        emit(job, 'progress', {
          step: 'analyzed',
          message: `🔎 ${si + 1}/${article.images.length}: ${analysis.description}`,
          progress: analyzeProgress,
        });
      } catch (err) {
        screenshotAnalyses.push({ ...img, analysis: null });
        emit(job, 'progress', { step: 'warn', message: `⚠️ Скриншот ${si + 1} пропущен: ${err.message}`, progress: analyzeProgress });
      }
      // 2s pause between vision calls to avoid 429
      if (si < article.images.length - 1) await sleep(2000);
    }

    // Step 4: Take portal screenshots
    const newScreenshots = {};
    const toShoot = screenshotAnalyses.filter(s => s.analysis && s.analysis.path);

    if (toShoot.length > 0) {
      emit(job, 'progress', {
        step: 'screenshots',
        message: `📸 Делаю ${toShoot.length} скриншотов на западном портале...`,
        progress: 60,
      });
      try {
        const shots = await takePortalScreenshots(portalUrl, { sessionCookies, login, password }, toShoot, (i, total, desc) => {
          emit(job, 'progress', {
            step: 'screenshot',
            message: `📸 Скриншот ${i + 1}/${total}: ${desc}`,
            progress: 62 + (i / total) * 23,
          });
        });
        Object.assign(newScreenshots, shots);
        emit(job, 'progress', {
          step: 'screenshots_done',
          message: `✅ Сделано ${Object.keys(newScreenshots).length} скриншотов`,
          progress: 85,
        });
      } catch (err) {
        emit(job, 'progress', { step: 'warn', message: `⚠️ Ошибка скриншотов портала: ${err.message}`, progress: 85 });
      }
    }

    // Step 5: Generate ZIP
    emit(job, 'progress', { step: 'generating', message: '📦 Генерация HTML файлов...', progress: 90 });
    const zipBuffer = await generateZip(article, translations, screenshotAnalyses, newScreenshots);
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

app.listen(PORT, () => console.log(`Bitrix Localizer Backend v2 running on port ${PORT}`));
