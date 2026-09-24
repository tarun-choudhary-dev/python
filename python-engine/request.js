import { EXECUTION_TIMEOUT_MS, LIMITS, MAX_SOURCE_CHARS } from '../runtime/config.js';
import { PythonEngineError } from './protocol.js';

/** Validate and snapshot public source input before transport submission. */
export function normalizeRequest(input, options = {}) {
  if (typeof input !== 'string' && (!input || typeof input !== 'object' || Array.isArray(input)))
    throw new PythonEngineError('Expected Python source or a request object.', 'INVALID_REQUEST');
  let source, filename, timeout;
  try {
    source = typeof input === 'string' ? input : input.source;
    filename = typeof input === 'string' ? options?.filename : input.filename;
    timeout = typeof input === 'string' ? options?.timeoutMs : input.timeoutMs;
  } catch {
    throw new PythonEngineError('The Python request could not be read.', 'INVALID_REQUEST');
  }
  if (typeof source !== 'string')
    throw new PythonEngineError('Python source must be a string.', 'INVALID_SOURCE');
  if (source.length > MAX_SOURCE_CHARS)
    throw new PythonEngineError(`Python source must not exceed ${MAX_SOURCE_CHARS} characters.`, 'SOURCE_TOO_LARGE');
  if (!source.trim())
    throw new PythonEngineError('Python source cannot be empty.', 'EMPTY_SOURCE');
  filename = filename === undefined ? 'main.py' : filename;
  if (typeof filename !== 'string' || !filename || filename.length > LIMITS.filenameChars || /[\x00-\x1f\x7f]/.test(filename))
    throw new PythonEngineError('The filename must be a non-empty string without control characters.', 'INVALID_FILENAME');
  let timeoutMs;
  if (timeout !== undefined) timeoutMs = validateTimeout(timeout, EXECUTION_TIMEOUT_MS);
  return Object.freeze({ source, filename, ...(timeoutMs ? { timeoutMs } : {}) });
}

export function validateTimeout(value, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new PythonEngineError(`timeoutMs must be an integer between 1 and ${maximum}.`, 'INVALID_TIMEOUT');
  return value;
}
