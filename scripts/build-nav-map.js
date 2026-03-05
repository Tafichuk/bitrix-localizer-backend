#!/usr/bin/env node
/**
 * build-nav-map.js
 * Analyzes helpdesk.bitrix24.com sections and builds a navigation map.
 *
 * Usage:
 *   node scripts/build-nav-map.js
 *   node scripts/build-nav-map.js --resume   (continue from last checkpoint)
 *
 * Output: navigation-map.json (backend root)
 *
 * Uses claude-haiku (cheap) for bulk section analysis.
 * ~30 sections × 3 articles × 2 images = up to 180 Vision calls.
 */

require('dotenv').config();

const axios = require('axios');
const cheerio = require('cheerio');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const HELPDESK_BASE = 'https://helpdesk.bitrix24.com';
const OUTPUT_PATH = path.join(__dirname, '..', 'navigation-map.json');
const CHECKPOINT_PATH = path.join(__dirname, '..', 'nav-map-checkpoint.json');

const RESUME = process.argv.includes('--resume');
const ARTICLES_PER_SECTION = 3;
const IMAGES_PER_ARTICLE = 2;
const DELAY_VISION_MS = 2000;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Sections ─────────────────────────────────────────────────────────────────

const SECTIONS = [
  { id: '47912', name: 'Plans and Payments' },
  { id: '47478', name: 'Feed' },
  { id: '47481', name: 'Tasks and Projects' },
  { id: '47482', name: 'CRM' },
  { id: '47483', name: 'Calendar' },
  { id: '77623', name: 'Drive' },
  { id: '47480', name: 'Mail' },
  { id: '47484', name: 'Workgroups' },
  { id: '157576', name: 'CoPilot' },
  { id: '107059', name: 'Contact Center' },
  { id: '122783', name: 'Sales Center' },
  { id: '122485', name: 'Analytics' },
  { id: '143966', name: 'Inventory Management' },
  { id: '98283', name: 'Marketing' },
  { id: '95157', name: 'Sites' },
  { id: '47823', name: 'Employees' },
  { id: '157580', name: 'Automation' },
  { id: '77629', name: 'Workflows' },
  { id: '47487', name: 'Telephony' },
  { id: '47836', name: 'Settings' },
  { id: '47492', name: 'General questions' },
  { id: '122803', name: 'Employee Widget' },
  { id: '162876', name: 'Collabs' },
  { id: '127124', name: 'Knowledge base' },
  { id: '157574', name: 'BI Builder' },
  { id: '162944', name: 'Booking' },
  { id: '134832', name: 'CRM Payment' },
  { id: '152650', name: 'e-Signature' },
  { id: '159756', name: 'e-Signature for HR' },
  { id: '108779', name: 'Online Store' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isAuthorPhoto(src, alt, w, h) {
  if (!src) return true;
  if (/\/main\/[a-f0-9]{3}\//i.test(src)) return true;
  if (/\/(avatar|portrait|author)\//i.test(src)) return true;
  if (/resize_cache.*\/(photo|avatar|portrait)/i.test(src)) return true;
  const cleanAlt = (alt || '').trim();
  if (/^[A-ZА-ЯЁ][a-zа-яё]+ [A-ZА-ЯЁ][a-zа-яё]+$/.test(cleanAlt)) return true;
  if (w > 0 && w < 300 && h > 0 && h < 300) return true;
  return false;
}

async function fetchHtml(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        timeout: 20000,
        maxRedirects: 5,
      });
      return resp.data;
    } catch (err) {
      if (i < retries) await sleep(2000);
      else throw err;
    }
  }
}

// ─── Section: get article URLs ────────────────────────────────────────────────

async function getArticleUrls(sectionId, limit) {
  const url = `${HELPDESK_BASE}/section/${sectionId}/`;
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const found = new Set();

    // Flexible selectors for article links
    const sels = [
      'a.help-article-list__title',
      '.help-article-list a[href*="/open/"]',
      '.articles-list a[href*="/open/"]',
      '.help-articles-list a',
      'a[href*="/open/"]',
    ];
    for (const sel of sels) {
      $(sel).each((_, el) => {
        if (found.size >= limit) return false;
        const href = $(el).attr('href');
        if (!href) return;
        const full = href.startsWith('http') ? href : `${HELPDESK_BASE}${href}`;
        found.add(full);
      });
      if (found.size > 0) break;
    }

    return [...found].slice(0, limit);
  } catch (err) {
    console.warn(`    ⚠️  Section fetch failed: ${err.message}`);
    return [];
  }
}

// ─── Article: extract images ──────────────────────────────────────────────────

async function getArticleImages(articleUrl, limit) {
  try {
    const html = await fetchHtml(articleUrl);
    const $ = cheerio.load(html);
    $('script, style, nav, footer').remove();

    let $content = null;
    for (const sel of ['.help-article__content', '.article-content', '.help-content', 'article', 'main']) {
      const el = $(sel).first();
      if (el.length && el.text().trim().length > 50) { $content = el; break; }
    }
    if (!$content) $content = $('body');

    const images = [];
    const seen = new Set();

    $content.find('img').each((_, el) => {
      if (images.length >= limit) return false;
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
      if (!src) return;
      if (src.includes('icon') || src.includes('logo') || src.endsWith('.svg') || src.endsWith('.gif')) return;
      if (seen.has(src)) return;

      const w = parseInt($(el).attr('width') || '0', 10);
      const h = parseInt($(el).attr('height') || '0', 10);
      const alt = $(el).attr('alt') || '';
      if (isAuthorPhoto(src, alt, w, h)) return;

      seen.add(src);
      const absUrl = src.startsWith('http') ? src : `${HELPDESK_BASE}${src.startsWith('/') ? '' : '/'}${src}`;
      images.push({ src, absoluteUrl: absUrl, alt });
    });

    return images;
  } catch (err) {
    console.warn(`    ⚠️  Article parse failed: ${err.message}`);
    return [];
  }
}

// ─── Download image for Vision ────────────────────────────────────────────────

async function downloadImage(url) {
  try {
    const resp = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    let buf;
    try {
      buf = await sharp(Buffer.from(resp.data))
        .resize({ width: 800, withoutEnlargement: true })
        .jpeg({ quality: 60 })
        .toBuffer();
    } catch { buf = Buffer.from(resp.data); }
    return { base64: buf.toString('base64'), mediaType: 'image/jpeg' };
  } catch { return null; }
}

// ─── Vision analysis (Haiku — cheap) ─────────────────────────────────────────

const VISION_PROMPT = `Analyze this Bitrix24 portal screenshot. Return ONLY valid JSON, no markdown:
{
  "navigationType": "left_menu",
  "urlPath": "/crm/deal/list/",
  "menuSection": "CRM",
  "menuSubsection": "Deals",
  "needsMenuExpand": true,
  "widgetSelectors": [],
  "viewType": "list",
  "description": "short description, max 60 chars"
}
navigationType: "left_menu" | "widget" | "settings" | "modal" | "top_menu"
For widget nav (tariff/limits/demo): urlPath="/", widgetSelectors=[CSS selectors].
For settings: urlPath starts with /settings/.`;

async function analyzeImage(imageData, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: imageData.mediaType, data: imageData.base64 } },
            { type: 'text', text: VISION_PROMPT },
          ],
        }],
      });
      const text = resp.content[0].text.trim();
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) return null;
      return JSON.parse(m[0]);
    } catch (err) {
      if (err.status === 429 && i < retries) {
        const wait = Math.pow(2, i) * 5000;
        console.warn(`    ⏳ Rate limit, waiting ${wait / 1000}s...`);
        await sleep(wait);
      } else if (i === retries) {
        console.warn(`    ⚠️  Vision error: ${err.message}`);
        return null;
      }
    }
  }
  return null;
}

// ─── Aggregate section analyses ───────────────────────────────────────────────

function aggregate(sectionName, analyses) {
  if (!analyses.length) return { navigationType: null, urlPatterns: [], menuSection: null, needsExpand: false, widgetSelectors: [], subsections: {}, sampleCount: 0 };

  // Most common navigationType
  const typeCount = {};
  for (const a of analyses) if (a.navigationType) typeCount[a.navigationType] = (typeCount[a.navigationType] || 0) + 1;
  const navigationType = Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0]?.[0] || 'left_menu';

  // Unique URL paths
  const urlPatterns = [...new Set(analyses.map((a) => a.urlPath).filter(Boolean))];

  // Most common menuSection
  const menuSections = analyses.map((a) => a.menuSection).filter(Boolean);
  const menuCount = {};
  menuSections.forEach((m) => (menuCount[m] = (menuCount[m] || 0) + 1));
  const menuSection = Object.entries(menuCount).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const needsExpand = analyses.some((a) => a.needsMenuExpand);
  const widgetSelectors = [...new Set(analyses.flatMap((a) => a.widgetSelectors || []).filter(Boolean))];

  // Subsections by menuSubsection
  const subsections = {};
  for (const a of analyses) {
    if (a.menuSubsection && a.urlPath) {
      subsections[a.menuSubsection] = {
        url: a.urlPath,
        viewType: a.viewType || 'list',
        needsExpand: a.needsMenuExpand || false,
      };
    }
  }

  return { navigationType, urlPatterns, menuSection, needsExpand, widgetSelectors, subsections, sampleCount: analyses.length };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY not set. Create a .env file or export it.');
    process.exit(1);
  }

  console.log('🗺️  Building navigation map from helpdesk.bitrix24.com');
  console.log(`   Sections: ${SECTIONS.length}, articles/section: ${ARTICLES_PER_SECTION}, images/article: ${IMAGES_PER_ARTICLE}`);
  console.log(`   Model: claude-haiku-4-5 (cost-efficient)\n`);

  // Load checkpoint if resuming
  let checkpoint = {};
  if (RESUME && fs.existsSync(CHECKPOINT_PATH)) {
    try {
      checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf8'));
      console.log(`   ♻️  Resuming from checkpoint (${Object.keys(checkpoint).length} sections done)\n`);
    } catch { checkpoint = {}; }
  }

  const sectionResults = { ...checkpoint };
  const urlPatternMap = {};

  let visionCallCount = 0;

  for (const section of SECTIONS) {
    if (sectionResults[section.name]) {
      console.log(`⏭  [${section.name}] — already in checkpoint, skipping`);
      continue;
    }

    console.log(`\n📁 [${section.name}] (section ${section.id})`);
    const analyses = [];

    const articleUrls = await getArticleUrls(section.id, ARTICLES_PER_SECTION);
    console.log(`   Articles found: ${articleUrls.length}`);

    for (const articleUrl of articleUrls) {
      console.log(`   📄 ${articleUrl}`);
      const images = await getArticleImages(articleUrl, IMAGES_PER_ARTICLE);
      console.log(`      Images found: ${images.length}`);

      for (const img of images) {
        const shortUrl = img.absoluteUrl.length > 70 ? img.absoluteUrl.slice(0, 70) + '…' : img.absoluteUrl;
        process.stdout.write(`      🖼  ${shortUrl} … `);

        const imageData = await downloadImage(img.absoluteUrl);
        if (!imageData) { console.log('download failed'); continue; }

        const analysis = await analyzeImage(imageData);
        visionCallCount++;
        if (analysis) {
          analyses.push(analysis);
          console.log(`✅ ${analysis.navigationType} → ${analysis.urlPath}`);
        } else {
          console.log('analysis failed');
        }

        await sleep(DELAY_VISION_MS);
      }

      await sleep(500);
    }

    const agg = aggregate(section.name, analyses);
    sectionResults[section.name] = { helpdeskSection: section.id, ...agg };
    console.log(`   ✅ Aggregated: type=${agg.navigationType}, urls=[${agg.urlPatterns.join(', ')}], samples=${agg.sampleCount}`);

    // Save checkpoint after each section
    fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(sectionResults, null, 2));
  }

  // Build urlPatternMap from all sections
  for (const [name, data] of Object.entries(sectionResults)) {
    for (const urlPath of (data.urlPatterns || [])) {
      if (!urlPatternMap[urlPath]) {
        urlPatternMap[urlPath] = {
          section: name,
          navigationType: data.navigationType,
          menuSection: data.menuSection,
          needsExpand: data.needsExpand,
          widgetSelectors: data.widgetSelectors || [],
        };
      }
    }
  }

  const navMap = {
    generated: new Date().toISOString(),
    totalSections: SECTIONS.length,
    visionCallsUsed: visionCallCount,
    sections: sectionResults,
    urlPatternMap,
    commonPatterns: {
      settingsButton: 'gear icon near list header or top-right corner',
      createButton: 'green Add/Create button, top-right area',
      leftMenuExpand: 'click parent menu item to expand children (CRM → Deals, Leads…)',
      widgetArea: 'bottom-right corner or activity feed top area',
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(navMap, null, 2));

  // Clean up checkpoint
  if (fs.existsSync(CHECKPOINT_PATH)) fs.unlinkSync(CHECKPOINT_PATH);

  console.log(`\n✅ Navigation map saved: ${OUTPUT_PATH}`);
  console.log(`   Sections: ${Object.keys(sectionResults).length}`);
  console.log(`   URL patterns mapped: ${Object.keys(urlPatternMap).length}`);
  console.log(`   Total Vision calls: ${visionCallCount}`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
