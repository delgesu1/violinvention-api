FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    wget \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace/pdf-service

# Copy package files
COPY package*.json ./

# Install dependencies and Playwright browsers
ENV PLAYWRIGHT_BROWSERS_PATH=/workspace/pdf-service/.playwright-browsers
RUN npm ci --production && \
    npx playwright install chromium

# Copy application code
COPY . .

EXPOSE 3001

CMD ["npm", "start"]