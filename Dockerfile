# Single image: builds the UI, runs the API which also serves the UI.
FROM node:20-alpine AS ui
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:20-alpine
ENV NODE_ENV=production
ENV PORT=4000
WORKDIR /app
COPY backend/package*.json backend/
RUN cd backend && npm ci --omit=dev
COPY backend/ backend/
COPY db/ db/
COPY --from=ui /app/frontend/dist frontend/dist
# Uploaded installers + install scripts (local storage). Mount a persistent volume here.
RUN mkdir -p backend/data/storage && chown -R node:node backend/data
VOLUME ["/app/backend/data"]
USER node
EXPOSE 4000
HEALTHCHECK CMD wget -qO- http://localhost:${PORT}/healthz || exit 1
CMD ["node", "backend/src/index.js"]
