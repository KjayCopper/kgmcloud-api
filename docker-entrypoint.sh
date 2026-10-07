#!/bin/sh
# Seed the uploads volume from the files baked into the image.
# Only runs when the volume is empty (first boot after the ServApp is
# created), so files uploaded later are never overwritten.
set -e

mkdir -p /app/uploads
if [ -d /seed/uploads ] && [ -z "$(ls -A /app/uploads 2>/dev/null)" ]; then
  echo "Seeding uploads volume from image..."
  cp -r /seed/uploads/. /app/uploads/
  echo "Seeded."
fi

exec node server.js
