const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function analyzeScreenshot(imageUrl) {
  // Download image
  const response = await axios.get(imageUrl, {
    responseType: 'arraybuffer',
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });

  const imageData = Buffer.from(response.data).toString('base64');
  const contentType = response.headers['content-type'] || 'image/png';
  // Claude supports: image/jpeg, image/png, image/gif, image/webp
  const mediaType = contentType.includes('jpeg') || contentType.includes('jpg')
    ? 'image/jpeg'
    : contentType.includes('webp')
    ? 'image/webp'
    : contentType.includes('gif')
    ? 'image/gif'
    : 'image/png';

  const analysis = await client.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: imageData },
        },
        {
          type: 'text',
          text: `This is a screenshot from the RUSSIAN Bitrix24 portal (bitrix24.ru).
Analyze what is shown and determine the URL path on the ENGLISH Bitrix24 portal (bitrix24.com) to navigate to this same page.

Bitrix24 common URL paths:
- CRM Deals: /crm/deal/list/
- CRM Leads: /crm/lead/list/
- CRM Contacts: /crm/contact/list/
- CRM Companies: /crm/company/list/
- Tasks: /tasks/list/
- Sites: /sites/
- Online Store: /shop/
- Telephony: /telephony/
- Chat & Calls: /im/
- Calendar: /calendar/
- HR: /timeman/
- Disk/Files: /disk/
- Feed: /stream/
- Company: /company/
- Workflows: /bizproc/
- Settings: /settings/
- CoPilot/AI: /ai/
- Automation Rules: /crm/automation/
- Kanban: /crm/deal/kanban/

Respond ONLY with valid JSON:
{
  "module": "module name in English",
  "path": "/exact/url/path/",
  "description": "Brief English description of what is shown (max 60 chars)",
  "confidence": "high|medium|low"
}`,
        },
      ],
    }],
  });

  const text = analysis.content[0].text.trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Vision response is not JSON');

  const result = JSON.parse(jsonMatch[0]);

  // Validate path
  if (!result.path || !result.path.startsWith('/')) {
    result.path = '/';
  }

  return result;
}

module.exports = { analyzeScreenshot };
