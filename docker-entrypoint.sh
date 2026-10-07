#!/bin/sh
# Seed the uploads volume from the files baked into the image.
# Only runs when the volume is empty (first boot after the ServApp is
# created), so files uploaded later are never overwritten.
# Logs every branch so boot logs are diagnosable.
set -e

echo "[entrypoint] kgmcloud-api boot"

if [ ! -d /seed/uploads ]; then
  echo "[entrypoint] ERROR: /seed/uploads missing - this image has no baked files (old image?)"
else
  mkdir -p /app/uploads
  count_seed=$(find /seed/uploads -type f | wc -l)
  if [ -z "$(ls -A /app/uploads 2>/dev/null)" ]; then
    echo "[entrypoint] volume empty - seeding $count_seed files from image..."
    cp -r /seed/uploads/. /app/uploads/
    echo "[entrypoint] seeded OK - volume now has $(find /app/uploads -type f | wc -l) files"
  else
    echo "[entrypoint] volume already has $(find /app/uploads -type f | wc -l) files - skipping seed"
  fi
fi

exec node server.js
