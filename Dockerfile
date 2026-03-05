FROM node:20-slim

# Dependencies for @napi-rs/canvas (pre-built binaries, but may need these)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY src/ ./src/
COPY section-map.json ./

CMD ["node", "src/index.js"]
