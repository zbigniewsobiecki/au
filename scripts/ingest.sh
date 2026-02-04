#!/bin/bash

# ==============================================================================
# Script: run-au.sh
# Description: Wrapper for running LLMIST commands with debug logging and rebuilding.
# Usage: ./run-au.sh <project_directory> <command> [additional_flags...]
# Example: ./run-au.sh ~/Code/car-dealership validate --dry-run
# ==============================================================================

# 1. Help / Usage Function
function show_usage {
    echo "Usage: $0 <project_directory> <command> [additional_flags...]"
    echo ""
    echo "Arguments:"
    echo "  <project_directory>  Path to the target project."
    echo "  <command>            Action to run: 'ingest', 'stats', or 'validate'."
    echo "  [additional_flags]   Any extra flags supported by the tool (e.g., --purge, --dry-run)."
    echo ""
    echo "Examples:"
    echo "  $0 ~/Code/car-dealership validate"
    echo "  $0 ~/Code/car-dealership ingest --purge"
    exit 1
}

# 2. Argument Parsing
PROJECT_DIR="$1"
COMMAND="$2"

# Capture all arguments starting from the 3rd one as "extra arguments"
# "${@:3}" expands to all positional parameters from 3 onwards
EXTRA_ARGS=("${@:3}")

# Check if mandatory arguments are provided
if [[ -z "$PROJECT_DIR" || -z "$COMMAND" ]]; then
    echo "Error: Missing mandatory arguments."
    show_usage
fi

# Resolve absolute path for the project directory
REAL_PROJECT_DIR=$(cd "$PROJECT_DIR" && pwd)

if [[ ! -d "$REAL_PROJECT_DIR" ]]; then
    echo "Error: Directory '$PROJECT_DIR' does not exist."
    exit 1
fi

# Validate command
VALID_COMMANDS=("ingest" "stats" "validate")
IS_VALID=false
for cmd in "${VALID_COMMANDS[@]}"; do
    if [[ "$cmd" == "$COMMAND" ]]; then
        IS_VALID=true
        break
    fi
done

if [[ "$IS_VALID" == "false" ]]; then
    echo "Error: Invalid command '$COMMAND'. Must be one of: ${VALID_COMMANDS[*]}"
    exit 1
fi

# 3. Environment Setup
export INGEST_DIR="$REAL_PROJECT_DIR"
# Define log directories
LOGDIR="/tmp/.au.debug.fix-v2"
export AU_DEBUG_EDITS_DIR="/tmp/.sysml.debug.fix-v2"

echo "========================================================"
echo "Project Dir: $INGEST_DIR"
echo "Log Dir:     $LOGDIR"
echo "Command:     $COMMAND"
if [ ${#EXTRA_ARGS[@]} -gt 0 ]; then
    echo "Extra Args:  ${EXTRA_ARGS[*]}"
fi
echo "========================================================"

# 4. Clean up old logs
echo "[*] Cleaning old logs..."
rm -rf "$LOGDIR" "$AU_DEBUG_EDITS_DIR"

# 5. Clear terminal
clear
reset

# 6. Rebuild the tool
echo "[*] Rebuilding project..."
npm run build
if [ $? -ne 0 ]; then
    echo "Error: Build failed. Exiting."
    exit 1
fi

# 7. Construct Flags
# Base environment variables
export AU_DEBUG_EDITS=1
export AU_EDITS_KEEP_ALL=1
export LLMIST_LOG_FILE="${LOGDIR}/au.log"
export LLMIST_LOG_LEVEL=debug
export LLMIST_LOG_RAW_DIRECTORY="$LOGDIR"

# Base arguments for the CLI
CLI_ARGS=(
    "$COMMAND"
    "--path" "$INGEST_DIR"
)

# Default hardcoded flags for 'validate' (can be overridden by EXTRA_ARGS if the tool allows it)
if [[ "$COMMAND" == "validate" ]]; then
    CLI_ARGS+=(
        "--coverage-threshold" "30"
        "--fix-iterations" "100"
        "-v"
        "-m" "openrouter:google/gemini-3-flash-preview"
        "--fix-batch-size" "20"
    )
fi

if [[ "$COMMAND" == "ingest" ]]; then
    CLI_ARGS+=(
        "-v"
        #"-m" "openrouter:deepseek/deepseek-v3.2"
        "-m" "gemini:gemini-3-flash-preview"
        #"-m" "openrouter:google/gemini-3-flash-preview"
    )
fi

# 8. Execution
echo "[*] Running command..."
mkdir -p "$LOGDIR"

echo "Running with: ${CLI_ARGS[@]} ${EXTRA_ARGS[@]}"

# Expand the CLI_ARGS array AND the EXTRA_ARGS array
./bin/run.js "${CLI_ARGS[@]}" "${EXTRA_ARGS[@]}"

