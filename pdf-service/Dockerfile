FROM node:20-slim

# Install Chromium and required dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Skip Playwright browser download - using system Chromium
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /workspace/pdf-service

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY . .

EXPOSE 3001

CMD ["npm", "start"]