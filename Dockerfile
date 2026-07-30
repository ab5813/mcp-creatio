# Multi-stage build for the MCP Creatio Server.
# Build stage compiles TypeScript; the runtime image carries only prod deps + dist.

# ---- build ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Transport: "http" (default, web service) or "stdio" (run with `docker run -i …`).
ENV CREATIO_MCP_TRANSPORT=http
ENV CREATIO_MCP_PORT=3000

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# OCR language data for scanned-PDF extraction (read-file format:"text").
# Bundled at build time so an offline/air-gapped runtime never fetches from the
# tessdata CDN. lav+eng+rus match the CREATIO_MCP_OCR_LANGS default.
RUN mkdir -p /app/tessdata && \
	wget -q -O /app/tessdata/lav.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/lav.traineddata && \
	wget -q -O /app/tessdata/eng.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/eng.traineddata && \
	wget -q -O /app/tessdata/rus.traineddata https://github.com/tesseract-ocr/tessdata/raw/main/rus.traineddata
ENV CREATIO_MCP_OCR_LANG_PATH=/app/tessdata
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Run as the unprivileged `node` user baked into the official image (never root in the cluster).
USER node

# Used in HTTP mode; ignored for stdio.
EXPOSE 3000

# Container-level liveness for plain Docker; Kubernetes uses its own probes against /healthz.
# wget ships with the alpine base (busybox). Honors CREATIO_MCP_PORT.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
	CMD wget -q -O- "http://127.0.0.1:${CREATIO_MCP_PORT:-3000}/healthz" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
