#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
exec npx tsx "$DIR/dev.mjs" "$@"
