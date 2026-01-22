/**
 * Preload script to suppress Chevrotain parser warnings from sysml-parser.
 * This must be loaded via Node's --require flag before any ESM modules.
 */

// Suppress console.warn
const originalWarn = console.warn;
console.warn = (...args) => {
  const msg = args[0];
  if (typeof msg === "string" && msg.includes("Ambiguous Alternatives Detected")) {
    return;
  }
  originalWarn.apply(console, args);
};

// Suppress console.error for Chevrotain warnings too
const originalError = console.error;
console.error = (...args) => {
  const msg = args[0];
  if (typeof msg === "string" && msg.includes("Ambiguous Alternatives Detected")) {
    return;
  }
  originalError.apply(console, args);
};

// Suppress console.log for Chevrotain warnings
const originalLog = console.log;
console.log = (...args) => {
  const msg = args[0];
  if (typeof msg === "string" && msg.includes("Ambiguous Alternatives Detected")) {
    return;
  }
  originalLog.apply(console, args);
};
