FROM node:20-bookworm-slim

# System deps for Playwright Chromium (кэшируется отдельным слоем)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Сначала только package.json — npm install кэшируется если зависимости не менялись
COPY package.json package-lock.json* ./
RUN npm install

# Playwright устанавливается отдельным слоем — кэшируется если package.json не менялся
RUN npx playwright install chromium --with-deps 2>/dev/null || npx playwright install chromium

# Код копируется последним — не инвалидирует кэш зависимостей
COPY src/ ./src/
COPY knowledge-base.json ./

CMD ["node", "src/index.js"]
