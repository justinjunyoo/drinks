FROM node:20-slim
WORKDIR /app

# Install production deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY server.js ./
COPY public ./public

ENV NODE_ENV=production
# Cloud Run provides PORT; default to 8080 for local runs
EXPOSE 8080
CMD ["node", "server.js"]
