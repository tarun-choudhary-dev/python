import { EXECUTION_TIMEOUT_MS, MAX_SOURCE_CHARS } from '../runtime/config.js';
import { PythonEngineError } from './protocol.js';

/** Validate and snapshot public source input before transport submission. */
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
  if (request.timeoutMs !== undefined) timeoutMs = validateTimeout(request.timeoutMs, EXECUTION_TIMEOUT_MS);
  return Object.freeze({ source: request.source, filename, ...(timeoutMs ? { timeoutMs } : {}) });
}

export function validateTimeout(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new PythonEngineError(`timeoutMs must be an integer between 1 and ${maximum}.`, 'INVALID_TIMEOUT');
  return value;
}
