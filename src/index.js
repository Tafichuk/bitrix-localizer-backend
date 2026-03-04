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
  const { articleUrl, portalUrl, login, password, languages } = req.body;

  if (!articleUrl || !portalUrl || !login || !password || !languages?.length) {
    return res.status(400).json({ error: 'Все поля обязательны' });
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
  processJob(job, { articleUrl, portalUrl, login, password, languages });

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

async function processJob(job, { articleUrl, portalUrl, login, password, languages }) {
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

    // Step 2+3: Перевод и анализ скриншотов — ПАРАЛЛЕЛЬНО
    emit(job, 'progress', {
      step: 'translating',
      message: `🌐 Параллельный перевод на ${languages.length} языков + анализ ${article.images.length} скриншотов...`,
      progress: 16,
    });

    const [translationResults, visionResults] = await Promise.all([
      // Все языки параллельно
      Promise.allSettled(
        languages.map(lang => translateContent(article, lang).then(t => ({ lang, t })))
      ),
      // Все скриншоты параллельно (передаём целевой язык для перевода контента)
      Promise.allSettled(
        article.images.map(img => analyzeScreenshot(img.absoluteUrl, languages[0]).then(analysis => ({ img, analysis })))
      ),
    ]);

    const translations = {};
    for (const res of translationResults) {
      if (res.status === 'fulfilled') {
        translations[res.value.lang] = res.value.t;
        emit(job, 'progress', { step: 'translated', message: `✅ ${LANGUAGE_NAMES[res.value.lang]} готов`, progress: 0 });
      } else {
        emit(job, 'progress', { step: 'warn', message: `⚠️ Ошибка перевода: ${res.reason?.message}`, progress: 0 });
      }
    }
    emit(job, 'progress', { step: 'translated', message: `✅ Переводы готовы: ${Object.keys(translations).length} языков`, progress: 60 });

    const screenshotAnalyses = [];
    for (const res of visionResults) {
      if (res.status === 'fulfilled') {
        screenshotAnalyses.push({ ...res.value.img, analysis: res.value.analysis });
        emit(job, 'progress', { step: 'analyzed', message: `🔎 ${res.value.analysis.description} → ${res.value.analysis.path}`, progress: 0 });
      } else {
        const img = article.images[screenshotAnalyses.length];
        screenshotAnalyses.push({ ...img, analysis: null });
        emit(job, 'progress', { step: 'warn', message: `⚠️ Скриншот пропущен: ${res.reason?.message}`, progress: 0 });
      }
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
        const shots = await takePortalScreenshots(portalUrl, login, password, toShoot, (i, total, desc) => {
          emit(job, 'progress', {
            step: 'screenshot',
            message: `📸 Скриншот ${i + 1}/${total}: ${desc}`,
            progress: 60 + (i / total) * 25,
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
