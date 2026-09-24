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
