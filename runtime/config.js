// Runtime downloads are isolated here. These files are assets, never an execution API.
import { PYTHON_PACKAGES } from './packages.js';
export const PYODIDE_VERSION = '0.29.3';
export const RUNTIME_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
export const RUNTIME_FILES = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
// Sent with initialization so the host, sandbox Worker and Python helpers use
// the same values. Character limits count JavaScript UTF-16 code units.
export const LIMITS = Object.freeze({
  sourceChars: 100_000, filenameChars: 240, outputChars: 100_000,
  errorChars: 100_000, fatalErrorChars: 1000, diagnosticCount: 4,
  diagnosticFieldChars: 100_000, packageErrorChars: 500, packageCount: PYTHON_PACKAGES.length,
  runtimePackageCount: 256, packageNameChars: Math.max(...PYTHON_PACKAGES.map(item => item.id.length)),
  tokenCount: 1500, tokenValueChars: 1000, astNodeCount: 500,
  astFieldCount: 8, codeObjectCount: 40, codeDepth: 12,
  codeMetadataCount: 200, metadataNameChars: 240, metadataConstantChars: 120,
  instructionCount: 4000, instructionArgChars: 200,
  analysisFieldChars: 100_000, resultChars: 4_000_000,
  executionTimeoutMs: 15_000, loadTimeoutMs: 120_000, packageLoadTimeoutMs: 120_000,
});
export const EXECUTION_TIMEOUT_MS = LIMITS.executionTimeoutMs;
export const LOAD_TIMEOUT_MS = LIMITS.loadTimeoutMs;
export const PACKAGE_LOAD_TIMEOUT_MS = LIMITS.packageLoadTimeoutMs;
export const MAX_SOURCE_CHARS = LIMITS.sourceChars;
export const MAX_OUTPUT_CHARS = LIMITS.outputChars;
