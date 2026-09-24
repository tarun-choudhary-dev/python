import { LIMITS, PYODIDE_VERSION } from '../runtime/config.js';
import { ENGINE_PROTOCOL_VERSION } from './protocol.js';
import { safeText, safeInteger, validateOutput, processWorkerResult } from './worker-result.js';
export { validateOutput, processWorkerResult } from './worker-result.js';

function diagnosticsFor(result, operation) {
  const diagnostics = [];
  const add = (kind, message, line = 0) => { if (message) diagnostics.push({ kind, severity: 'error', message, line }); };
  add('tokenization', result.tokenError);
  add('syntax', result.astError, result.errorLine);
  if (result.compileError && !result.astError) add('compilation', result.compileError, result.errorLine);
  if (operation === 'run' && result.error && !result.astError && !result.compileError) add('runtime', result.error, result.errorLine);
  return diagnostics.slice(0, LIMITS.diagnosticCount);
}

export function createEngineResult(message, { operation, filename, pythonVersion, requestId, generation }) {
  if (operation === 'run') {
    const value = validateOutput(message);
    const error = safeText(message?.error) || null;
    const errorLine = Math.max(0, safeInteger(message?.errorLine));
    const kind = message?.errorKind === 'syntax' ? 'syntax' : 'runtime';
    return {
      protocolVersion: ENGINE_PROTOCOL_VERSION,
      requestId, generation, operation,
      status: error ? 'failed' : 'completed',
      exitCode: error ? 1 : 0,
      filename,
      stdout: value.stdout,
      stderr: value.stderr,
      error,
      errorLine,
      durationMs: Number.isFinite(message?.duration) ? Math.max(0, message.duration) : 0,
      outputTruncated: value.outputTruncated,
      pythonVersion,
      runtime: { name: 'Pyodide', version: PYODIDE_VERSION, pythonVersion },
      diagnostics: error ? [{ kind, severity: 'error', message: kind === 'syntax' ? safeText(message?.diagnostic, LIMITS.diagnosticFieldChars) || error : error, line: errorLine }] : [],
    };
  }
  const value = processWorkerResult(message);
  const error = value.error || value.compileError || value.astError || value.tokenError || null;
  return {
    protocolVersion: ENGINE_PROTOCOL_VERSION,
    requestId, generation, operation,
    status: error ? 'failed' : 'completed',
    exitCode: error ? 1 : 0,
    filename,
    stdout: value.stdout,
    stderr: value.stderr,
    error,
    errorLine: value.errorLine,
    durationMs: value.durationMs,
    outputTruncated: value.outputTruncated,
    pythonVersion,
    runtime: { name: 'Pyodide', version: PYODIDE_VERSION, pythonVersion },
    diagnostics: diagnosticsFor(value, operation),
    inspection: {
      tokens: value.tokens,
      tokensTruncated: value.tokensTruncated,
      ast: { nodes: value.astNodes, tree: value.astTree, dump: value.astDump, error: value.astError || null },
      codeObjects: value.codeObjects,
      codeObjectText: value.codeObjectText,
      instructions: value.instructions,
      instructionsTruncated: value.instructionsTruncated,
      bytecode: value.bytecode,
      disassembly: value.disassembly,
      compileError: value.compileError || null,
      tokenError: value.tokenError || null,
    },
  };
}
