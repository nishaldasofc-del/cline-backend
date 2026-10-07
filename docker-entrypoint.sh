#!/bin/sh
# Render Free: no persistent disk. Scratch space is the container's ephemeral /tmp.
# Create it, hand it to the unprivileged user, then drop root.
set -e
d="${CLINE_DATA_DIR:-/tmp/cline-agent}"
mkdir -p "$d" && chown -R app:app "$d"
exec setpriv --reuid=10001 --regid=10001 --init-groups "$@"
