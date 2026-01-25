#!/bin/bash

export LOGDIR=${2} 
export TIMEOUT=${3}
rm -rf ${LOGDIR}
clear
reset
cd ~/Code/au
npm run build 
gtimeout ${TIMEOUT} env LLMIST_LOG_FILE=${LOGDIR}/au.log LLMIST_LOG_LEVEL=debug  LLMIST_LOG_RAW_DIRECTORY=$LOGDIR ./bin/run.js ingest --purge --path ${1} -v -m openrouter:google/gemini-3-flash-preview

echo "Timeout ${TIMEOUT} done."
echo "Check logs here: ${2}"
echo "Check SysML files here: ${1}/.sysml/"
