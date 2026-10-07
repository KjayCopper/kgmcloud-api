# ============================================================
# KGM Cloud backend - single-stage Node image
# ============================================================
FROM node:lts-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY email-templates ./email-templates
COPY docs ./docs

EXPOSE 3000

CMD ["node", "server.js"]
