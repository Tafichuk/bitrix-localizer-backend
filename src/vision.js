const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const sharp = require('sharp');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Given a compressed screenshot (base64), a section key, and the available
 * step names for that section, asks Claude to pick the best step.
 *
 * Returns: step string (always a member of availableSteps, or 'default')
 */
async function getStepForScreenshot(base64, sectionKey, availableSteps) {
  const stepsStr = availableSteps.join(', ');

  const response = await callWithRetry({
    model: 'claude-sonnet-4-6',
    max_tokens: 60,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        {
          type: 'text',
          text: `This screenshot is from a Bitrix24 Russian helpdesk article.
Portal section: ${sectionKey}
Available steps: ${stepsStr}

Which step best matches what is shown?
Reply with ONLY the step name. If unsure, reply: default`,
        },
      ],
    }],
  });

  const raw = (response.content[0].text || '').trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const step = availableSteps.find(s => s.toLowerCase() === raw) || 'default';
  console.log(`[vision] ${sectionKey}: "${raw}" → step="${step}"`);
  return step;
}

/**
 * Downloads an image from URL and compresses it to 800px / JPEG 60%.
 * Returns { base64, mediaType } or null on failure.
 */
async function downloadAndCompress(url) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });

    let buf;
    try {
      buf = await sharp(Buffer.from(resp.data))
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    } catch {
      buf = Buffer.from(resp.data);
    }

    const origKb = Math.round(resp.data.byteLength / 1024);
    const compKb = Math.round(buf.byteLength / 1024);
    console.log(`[vision] Compressed: ${origKb}KB → ${compKb}KB`);
    return { base64: buf.toString('base64'), mediaType: 'image/jpeg' };
  } catch (err) {
    console.error(`[vision] Download failed ${url}: ${err.message}`);
    return null;
  }
}

// ─── Retry with exponential backoff on 429 ────────────────────────────────────

async function callWithRetry(params, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      if (err.status === 429 && i < maxRetries - 1) {
        const waitMs = Math.pow(2, i) * 5000;
        console.warn(`[vision] Rate limit 429, waiting ${waitMs / 1000}s (attempt ${i + 1}/${maxRetries})`);
        await new Promise(r => setTimeout(r, waitMs));
      } else {
        throw err;
      }
    }
  }
}

module.exports = { getStepForScreenshot, downloadAndCompress };
