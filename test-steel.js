require('dotenv').config();
const { takeScreenshotWithComputerUse } = require('./steel-screenshot');
const axios = require('axios');
const fs = require('fs');

async function test() {
  console.log('Скачиваю оригинальный скрин...');
  const resp = await axios.get(
    'https://helpdesk.bitrix24.ru/images/helpdesk/screenshots/ru/au/feed/zakrep/1.jpg',
    { responseType: 'arraybuffer' }
  );
  const base64 = Buffer.from(resp.data).toString('base64');

  console.log('Запускаю Computer Use...');
  const result = await takeScreenshotWithComputerUse(
    'https://testportal.bitrix24.com/stream/',
    'Feed/Activity stream with a post showing a pin icon on hover',
    base64
  );

  fs.writeFileSync('test_result.png', result);
  console.log('✅ Готово! Смотри test_result.png');
}

test().catch(console.error);
