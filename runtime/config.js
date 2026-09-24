// Runtime downloads are isolated here. These files are assets, never an execution API.
export const PYODIDE_VERSION = '0.29.3';
export const RUNTIME_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
export const RUNTIME_FILES = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
export const EXECUTION_TIMEOUT_MS = 15_000;
export const LOAD_TIMEOUT_MS = 120_000;
export const PACKAGE_LOAD_TIMEOUT_MS = 120_000;
export const MAX_SOURCE_CHARS = 100_000;
export const MAX_OUTPUT_CHARS = 100_000;
