const sharp = require('sharp');
const { createCanvas, loadImage } = require('@napi-rs/canvas');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * Downloads an image, asks Claude Vision to find all Russian text + coordinates,
 * then erases original text and draws translated text using canvas.
 *
 * @param {string} imageUrl  - URL of the original Russian screenshot
 * @param {string} targetLang - e.g. 'en', 'fr', 'de'
 * @returns {Promise<Buffer>} - PNG buffer of the localized image
 */
async function localizeImage(imageUrl, targetLang) {
  // 1. Download original image
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  const imageBuffer = Buffer.from(response.data);

  // 2. Get dimensions
  const metadata = await sharp(imageBuffer).metadata();
  const { width, height } = metadata;

  // 3. Compress for Claude API (keep aspect ratio, max 1280px wide)
  const compressedBuf = await sharp(imageBuffer)
    .resize({ width: 1280, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();
  const base64Image = compressedBuf.toString('base64');

  // Scale factor in case image was resized
  const compMeta = await sharp(compressedBuf).metadata();
  const scaleX = width / (compMeta.width || width);
  const scaleY = height / (compMeta.height || height);

  // 4. Claude Vision: find all Russian text elements with coordinates
  // Use compact field names to minimize token usage
  let textElements = [];
  try {
    const analysisResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Image },
          },
          {
            type: 'text',
            text: `Analyze Bitrix24 screenshot (${compMeta.width}x${compMeta.height}px). Find ALL Russian UI text.

Return ONLY compact JSON array (one object per line, no extra spaces):
[{"t":"ru text","tr":"${targetLang} translation","x":0,"y":0,"w":100,"h":20,"fs":14,"fc":"#000","bg":"#fff","b":false}]

Fields: t=original, tr=translation, x/y=top-left px, w/h=size px, fs=fontSize px, fc=fontColor hex, bg=bgColor hex, b=bold bool
- Include ALL visible Russian text (buttons, labels, menus, titles, hints)
- bg must be exact pixel background color
- Translate to ${targetLang} using Bitrix24 terminology
- If no Russian text: return []`,
          },
        ],
      }],
    });

    const responseText = analysisResponse.content[0].text || '';
    console.log(`[image-localizer] Response len=${responseText.length}, has_close_bracket=${responseText.includes(']')}`);

    textElements = parseJsonArray(responseText);
    console.log(`[image-localizer] Parsed ${textElements.length} elements`);
  } catch (e) {
    console.warn(`[image-localizer] Claude error: ${e.message}`);
    return imageBuffer;
  }

  if (textElements.length === 0) {
    console.log(`[image-localizer] No text elements found, returning original`);
    return imageBuffer;
  }

  // 5. Paint on canvas
  const pngBuffer = await sharp(imageBuffer).png().toBuffer();
  const image = await loadImage(pngBuffer);
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.drawImage(image, 0, 0, width, height);

  for (const el of textElements) {
    if (el.x == null || el.y == null || !el.w || !el.h) continue;

    // Scale coordinates back to original resolution
    const x = Math.round(el.x * scaleX);
    const y = Math.round(el.y * scaleY);
    const w = Math.round(el.w * scaleX);
    const h = Math.round(el.h * scaleY);
    const translatedText = el.tr || el.t || '';
    if (!translatedText) continue;

    // Erase original text with background color
    ctx.fillStyle = el.bg || '#ffffff';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);

    // Draw translated text
    ctx.fillStyle = el.fc || '#000000';
    const fontWeight = el.b ? 'bold' : 'normal';
    let fontSize = Math.round((el.fs || 14) * scaleY);
    ctx.font = `${fontWeight} ${fontSize}px Arial`;
    ctx.textBaseline = 'top';

    // Shrink font size if text doesn't fit horizontally
    while (ctx.measureText(translatedText).width > w - 2 && fontSize > 8) {
      fontSize -= 1;
      ctx.font = `${fontWeight} ${fontSize}px Arial`;
    }

    ctx.fillText(translatedText, x, y, w);
  }

  return canvas.toBuffer('image/png');
}

/**
 * Extracts and parses a JSON array from a Claude response string.
 * Handles code fences (```json...```) and truncated responses.
 */
function parseJsonArray(text) {
  // Strip code fences if present
  const fenceRe = /```(?:json)?\s*([\s\S]*?)\s*```/;
  const fenceMatch = fenceRe.exec(text);
  let candidate = fenceMatch ? fenceMatch[1].trim() : text.trim();

  // Find the start of the JSON array
  const start = candidate.indexOf('[');
  if (start === -1) return [];
  candidate = candidate.slice(start);

  // If we have a complete array, try parsing directly
  if (candidate.includes(']')) {
    const end = candidate.lastIndexOf(']');
    try {
      return JSON.parse(candidate.slice(0, end + 1));
    } catch (_) {}
  }

  // Response was truncated — try to recover by closing incomplete JSON
  // Remove the last incomplete object and close the array
  const lastComma = candidate.lastIndexOf(',');
  const lastBrace = candidate.lastIndexOf('}');
  let recovered = candidate;

  if (lastBrace > lastComma) {
    // Last object is complete, just close array
    recovered = candidate.slice(0, lastBrace + 1) + ']';
  } else if (lastComma !== -1) {
    // Last object incomplete, cut it off
    recovered = candidate.slice(0, lastComma) + ']';
  } else {
    return [];
  }

  try {
    const arr = JSON.parse(recovered);
    console.log(`[image-localizer] Recovered ${arr.length} elements from truncated response`);
    return arr;
  } catch (_) {
    return [];
  }
}

module.exports = { localizeImage };
