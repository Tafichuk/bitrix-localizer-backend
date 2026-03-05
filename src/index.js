require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const { parseArticle } = require('./scraper');
const { translateContent } = require('./translator');
const { localizeImage } = require('./image-localizer');
const { generateZip } = require('./generator');

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory job store
const jobs = new Map();

app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json({ limit: '10mb' }));

app.get('/health', (req, res) => res.json({ status: 'ok', version: '4.0.0' }));

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
    emit(job, 'progress', { step: 'translated', message: `✅ Переводы готовы: ${Object.keys(translations).length} языков`, progress: 40 });

    // Step 3: Localize images via Claude Vision
    // localizedScreenshots: { [src]: { [lang]: Buffer } }
    const localizedScreenshots = {};
    const screenshots = article.screenshots;

    if (screenshots.length > 0) {
      emit(job, 'progress', {
        step: 'localizing_img',
        message: `🖼️ Локализую ${screenshots.length} скриншот(ов) для ${languages.length} языка(ов)...`,
        progress: 42,
      });

      const totalOps = screenshots.length * languages.length;
      let doneOps = 0;

      for (let si = 0; si < screenshots.length; si++) {
        const img = screenshots[si];
        localizedScreenshots[img.src] = {};
        localizedScreenshots[img.absoluteUrl] = localizedScreenshots[img.src];

        for (let li = 0; li < languages.length; li++) {
          const lang = languages[li];
          try {
            const buffer = await localizeImage(img.absoluteUrl, lang);
            localizedScreenshots[img.src][lang] = buffer;
            emit(job, 'progress', {
              step: 'localizing_img',
              message: `🖼️ ${si + 1}/${screenshots.length} [${LANGUAGE_NAMES[lang] || lang}]: локализован`,
              progress: 42 + (++doneOps / totalOps) * 43,
            });
          } catch (err) {
            emit(job, 'progress', {
              step: 'warn',
              message: `⚠️ Скрин ${si + 1} [${lang}] — ошибка: ${err.message}`,
              progress: 0,
            });
            // Use original image as fallback
            try {
              const axios = require('axios');
              const orig = await axios.get(img.absoluteUrl, { responseType: 'arraybuffer', timeout: 20000 });
              localizedScreenshots[img.src][lang] = Buffer.from(orig.data);
            } catch (_) {}
            ++doneOps;
          }

          if (li < languages.length - 1) await sleep(1500);
        }

        if (si < screenshots.length - 1) await sleep(1000);
      }

      emit(job, 'progress', {
        step: 'localized_img',
        message: `✅ Все скриншоты локализованы`,
        progress: 85,
      });
    }

    // Step 4: Generate ZIP
    emit(job, 'progress', { step: 'generating', message: '📦 Генерация HTML файлов...', progress: 90 });
    const zipBuffer = await generateZip(article, translations, screenshots, localizedScreenshots);
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

app.listen(PORT, () => console.log(`Bitrix Localizer Backend v4 running on port ${PORT}`));
