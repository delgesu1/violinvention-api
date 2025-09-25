FROM mcr.microsoft.com/playwright:v1.48.0-focal

WORKDIR /workspace/pdf-service

# Copy package files
COPY package*.json ./

# Skip browser download - already included in base image
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --omit=dev

# Copy application code
COPY . .

EXPOSE 3001

CMD ["npm", "start"]