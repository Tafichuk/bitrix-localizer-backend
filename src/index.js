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

    // Step 2: Translate for each language
    const translations = {};
    const totalLangs = languages.length;
    for (let i = 0; i < totalLangs; i++) {
      const lang = languages[i];
      emit(job, 'progress', {
        step: 'translating',
        message: `🌐 Перевод на ${LANGUAGE_NAMES[lang]}... (${i + 1}/${totalLangs})`,
        progress: 15 + (i / totalLangs) * 30,
      });
      try {
        translations[lang] = await translateContent(article, lang);
      } catch (err) {
        emit(job, 'progress', { step: 'warn', message: `⚠️ Ошибка перевода ${LANGUAGE_NAMES[lang]}: ${err.message}`, progress: 15 + (i / totalLangs) * 30 });
      }
    }
    emit(job, 'progress', { step: 'translated', message: `✅ Переводы готовы для ${Object.keys(translations).length} языков`, progress: 45 });

    // Step 3: Analyze screenshots with Claude Vision
    const screenshotAnalyses = [];
    if (article.images.length > 0) {
      emit(job, 'progress', { step: 'analyzing', message: `🔎 Анализ ${article.images.length} скриншотов через Claude Vision...`, progress: 47 });

      for (let i = 0; i < article.images.length; i++) {
        const img = article.images[i];
        emit(job, 'progress', {
          step: 'analyzing_img',
          message: `🔎 Анализирую скриншот ${i + 1}/${article.images.length}...`,
          progress: 47 + (i / article.images.length) * 13,
        });
        try {
          const analysis = await analyzeScreenshot(img.absoluteUrl);
          screenshotAnalyses.push({ ...img, analysis });
          emit(job, 'progress', {
            step: 'analyzed',
            message: `  → ${analysis.description} (${analysis.path})`,
            progress: 47 + ((i + 1) / article.images.length) * 13,
          });
        } catch (err) {
          screenshotAnalyses.push({ ...img, analysis: null });
          emit(job, 'progress', { step: 'warn', message: `  ⚠️ Скриншот ${i + 1} пропущен: ${err.message}`, progress: 47 + ((i + 1) / article.images.length) * 13 });
        }
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
