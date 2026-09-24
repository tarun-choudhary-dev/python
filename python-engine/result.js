import { MAX_OUTPUT_CHARS, PYODIDE_VERSION } from '../runtime/config.js';
import { ENGINE_PROTOCOL_VERSION } from './protocol.js';

const safeText = (value, limit = MAX_OUTPUT_CHARS) => typeof value === 'string' ? value.slice(0, limit) : '';
const safeInteger = (value, fallback = 0) => Number.isSafeInteger(value) ? value : fallback;
const safeOptionalInteger = value => Number.isSafeInteger(value) ? value : null;

function validateTokens(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1500).filter(item => item && typeof item === 'object').map(item => ({
    type: safeText(item.type, 32), value: safeText(item.value, 1000),
    line: Math.max(0, safeInteger(item.line)), column: Math.max(0, safeInteger(item.column)),
    ...(Number.isSafeInteger(item.endLine) && Number.isSafeInteger(item.endColumn) ?
      { endLine: Math.max(0, item.endLine), endColumn: Math.max(0, item.endColumn) } : {}),
  }));
}

function validateAstNodes(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  const nodes = value.slice(0, 500).filter(item => item && typeof item === 'object').map((item, index) => {
    const id = safeText(item.id, 40) || `ast-${index}`;
    ids.add(id);
    return {
      id, parentId: item.parentId === null ? null : safeText(item.parentId, 40) || null,
      depth: Math.max(0, safeInteger(item.depth)), type: safeText(item.type, 80), label: safeText(item.label, 240),
      fields: Array.isArray(item.fields) ? item.fields.slice(0, 8).filter(field => field && typeof field === 'object').map(field => ({
        name: safeText(field.name, 80), value: safeText(field.value, 240),
      })) : [],
      children: Array.isArray(item.children) ? item.children.slice(0, 500).map(id => safeText(id, 40)).filter(Boolean) : [],
      lineno: safeOptionalInteger(item.lineno), col_offset: safeOptionalInteger(item.col_offset),
      end_lineno: safeOptionalInteger(item.end_lineno), end_col_offset: safeOptionalInteger(item.end_col_offset),
    };
  });
  for (const node of nodes) {
    if (node.parentId !== null && !ids.has(node.parentId)) node.parentId = null;
    node.children = node.children.filter(id => ids.has(id));
  }
  return nodes;
}

function validateCodeObjects(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 40).filter(item => item && typeof item === 'object').map((item, index) => ({
    id: safeText(item.id, 40) || `co-${index}`,
    parentId: item.parentId === null ? null : safeText(item.parentId, 40) || null,
    name: safeText(item.name, 240), firstLine: safeInteger(item.firstLine), depth: Math.max(0, safeInteger(item.depth)),
    argcount: Math.max(0, safeInteger(item.argcount)), nlocals: Math.max(0, safeInteger(item.nlocals)),
    stacksize: Math.max(0, safeInteger(item.stacksize)), flags: Math.max(0, safeInteger(item.flags)),
    bytecodeLength: Math.max(0, safeInteger(item.bytecodeLength)),
    constants: Array.isArray(item.constants) ? item.constants.slice(0, 200).map(value => safeText(value, 120)) : [],
    names: Array.isArray(item.names) ? item.names.slice(0, 200).map(value => safeText(value, 240)) : [],
    varnames: Array.isArray(item.varnames) ? item.varnames.slice(0, 200).map(value => safeText(value, 240)) : [],
    metadataTruncated: item.metadataTruncated === true,
  }));
}

function validateInstructions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 4000).filter(item => item && typeof item === 'object').map((item, index) => {
    const source = item.source && typeof item.source === 'object' && Number.isSafeInteger(item.source.line) ? {
      line: item.source.line, column: safeOptionalInteger(item.source.column),
      endLine: safeOptionalInteger(item.source.endLine), endColumn: safeOptionalInteger(item.source.endColumn),
    } : null;
    return {
      id: safeText(item.id, 80) || `instruction-${index}`, codeId: safeText(item.codeId, 40),
      offset: Math.max(0, safeInteger(item.offset)), opcode: safeText(item.opcode, 80),
      arg: safeOptionalInteger(item.arg), argrepr: safeText(item.argrepr, 200), source,
    };
  });
}

/** Output uses one shared budget for stdout and stderr, including untrusted messages. */
export function validateOutput(message) {
  const stdout = safeText(message.stdout);
  const stderr = safeText(message.stderr, MAX_OUTPUT_CHARS - stdout.length);
  return { stdout, stderr, outputTruncated: message.truncated === true ||
    (typeof message.stdout === 'string' && message.stdout.length > stdout.length) ||
    (typeof message.stderr === 'string' && message.stderr.length > stderr.length) };
}

/** Validate all data crossing the untrusted worker boundary. */
export function processWorkerResult(message = {}) {
  if (!message || typeof message !== 'object') message = {};
  const trace = message.trace && typeof message.trace === 'object' ? message.trace : {};
  const tokens = validateTokens(message.tokens);
  return {
    ...validateOutput(message), error: safeText(message.error),
    errorLine: Math.max(0, safeInteger(message.errorLine)), durationMs: Number.isFinite(message.duration) ? Math.max(0, message.duration) : 0,
    tokens,
    tokensTruncated: message.tokensTruncated === true || (Array.isArray(message.tokens) && message.tokens.length > 1500),
    tokenError: safeText(message.tokenError), astTree: safeText(message.astTree), astDump: safeText(message.astDump),
    astError: safeText(message.astError), compileError: safeText(message.compileError),
    codeObjectText: safeText(message.codeObject), bytecode: safeText(message.bytecode), disassembly: safeText(message.disassembly),
    astNodes: validateAstNodes(trace.astNodes), codeObjects: validateCodeObjects(trace.codeObjects),
    instructions: validateInstructions(trace.instructions),
    instructionsTruncated: trace.instructionsTruncated === true || (Array.isArray(trace.instructions) && trace.instructions.length > 4000),
  };
}

function diagnosticsFor(result, operation) {
  const diagnostics = [];
  const add = (kind, message, line = 0) => { if (message) diagnostics.push({ kind, severity: 'error', message, line }); };
  add('tokenization', result.tokenError);
  add('syntax', result.astError, result.errorLine);
  if (result.compileError && !result.astError) add('compilation', result.compileError, result.errorLine);
  if (operation === 'run' && result.error && !result.astError && !result.compileError) add('runtime', result.error, result.errorLine);
  return diagnostics;
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
      diagnostics: error ? [{ kind, severity: 'error', message: kind === 'syntax' ? safeText(message?.diagnostic) || error : error, line: errorLine }] : [],
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
