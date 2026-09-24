import { EXECUTION_TIMEOUT_MS, MAX_SOURCE_CHARS } from '../runtime/config.js';

export const ENGINE_PROTOCOL_VERSION = 1;

export const ENGINE_OPERATIONS = Object.freeze(['run', 'compile', 'inspect', 'diagnose']);

export const ENGINE_CAPABILITIES = Object.freeze({
  run: true,
  compile: true,
  diagnostics: true,
  inspect: true,
  ast: true,
  bytecode: true,
  disassembly: true,
  streamingOutput: true,
  packages: true,
});

export class PythonEngineError extends Error {
  constructor(message, code = 'ENGINE_ERROR', details = undefined) {
    super(message);
    this.name = 'PythonEngineError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
  toJSON() { return { name: this.name, message: this.message, code: this.code, ...(this.details ? { details: this.details } : {}) }; }
}

export function validateTimeout(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new PythonEngineError(`timeoutMs must be an integer between 1 and ${maximum}.`, 'INVALID_TIMEOUT');
  return value;
}

export function normalizeRequest(input, options = {}) {
  const request = typeof input === 'string' ? { ...options, source: input } : input;
  if (!request || typeof request !== 'object' || Array.isArray(request))
    throw new PythonEngineError('Expected Python source or a request object.', 'INVALID_REQUEST');
  if (typeof request.source !== 'string')
    throw new PythonEngineError('Python source must be a string.', 'INVALID_SOURCE');
  if (!request.source.trim())
    throw new PythonEngineError('Python source cannot be empty.', 'EMPTY_SOURCE');
  if (request.source.length > MAX_SOURCE_CHARS)
    throw new PythonEngineError(`Python source must not exceed ${MAX_SOURCE_CHARS} characters.`, 'SOURCE_TOO_LARGE');
  const filename = request.filename === undefined ? 'main.py' : request.filename;
  if (typeof filename !== 'string' || !filename || filename.length > 240 || /[\x00-\x1f\x7f]/.test(filename))
    throw new PythonEngineError('The filename must be a non-empty string without control characters.', 'INVALID_FILENAME');
  let timeoutMs;
  if (request.timeoutMs !== undefined) {
    timeoutMs = validateTimeout(request.timeoutMs, EXECUTION_TIMEOUT_MS);
  }
  return Object.freeze({ source: request.source, filename, ...(timeoutMs ? { timeoutMs } : {}) });
}
