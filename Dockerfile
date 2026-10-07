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

# Legacy uploads from the VPS - seeded into the /app/uploads volume
# on first boot (see docker-entrypoint.sh)
COPY uploads /seed/uploads
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["/docker-entrypoint.sh"]
