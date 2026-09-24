export { PythonEngine } from './engine.js';
export { ENGINE_CAPABILITIES, ENGINE_PROTOCOL_VERSION, PythonEngineError } from './protocol.js';

import { PythonEngine } from './engine.js';

export function createPythonEngine(options) { return new PythonEngine(options); }
