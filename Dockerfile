FROM node:20-slim

WORKDIR /app

# Copy manifests first for layer-cache efficiency
COPY package*.json ./

# Production deps only
RUN npm install --omit=dev

# Copy source
COPY . .

# Compile TypeScript
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Health check — matches the /health route in index.ts
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', r => r.statusCode === 200 ? process.exit(0) : process.exit(1)).on('error', () => process.exit(1))"

CMD ["node", "dist/index.js"]
