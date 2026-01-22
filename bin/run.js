#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_OPTIONS="--require $DIR/suppress-chevrotain-warnings.cjs" exec node "$DIR/run.mjs" "$@"
