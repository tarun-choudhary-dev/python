import { LIMITS, MAX_OUTPUT_CHARS } from '../runtime/config.js';

export const safeText = (value, limit = MAX_OUTPUT_CHARS) => typeof value === 'string' ? value.slice(0, limit) : '';
export const safeInteger = (value, fallback = 0) => Number.isSafeInteger(value) ? value : fallback;
const safeOptionalInteger = value => Number.isSafeInteger(value) ? value : null;

function validateTokens(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, LIMITS.tokenCount).filter(item => item && typeof item === 'object').map(item => ({
    type: safeText(item.type, 32), value: safeText(item.value, LIMITS.tokenValueChars),
    line: Math.max(0, safeInteger(item.line)), column: Math.max(0, safeInteger(item.column)),
    ...(Number.isSafeInteger(item.endLine) && Number.isSafeInteger(item.endColumn) ?
      { endLine: Math.max(0, item.endLine), endColumn: Math.max(0, item.endColumn) } : {}),
  }));
}

function validateAstNodes(value) {
  if (!Array.isArray(value)) return [];
  const ids = new Set();
  const nodes = value.slice(0, LIMITS.astNodeCount).filter(item => item && typeof item === 'object').map((item, index) => {
    const id = safeText(item.id, 40) || `ast-${index}`;
    ids.add(id);
    return {
      id, parentId: item.parentId === null ? null : safeText(item.parentId, 40) || null,
      depth: Math.max(0, safeInteger(item.depth)), type: safeText(item.type, 80), label: safeText(item.label, 240),
      fields: Array.isArray(item.fields) ? item.fields.slice(0, LIMITS.astFieldCount).filter(field => field && typeof field === 'object').map(field => ({
        name: safeText(field.name, 80), value: safeText(field.value, 240),
      })) : [],
      children: Array.isArray(item.children) ? item.children.slice(0, LIMITS.astNodeCount).map(id => safeText(id, 40)).filter(Boolean) : [],
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
  return value.slice(0, LIMITS.codeObjectCount).filter(item => item && typeof item === 'object').map((item, index) => ({
    id: safeText(item.id, 40) || `co-${index}`,
    parentId: item.parentId === null ? null : safeText(item.parentId, 40) || null,
    name: safeText(item.name, LIMITS.metadataNameChars), firstLine: safeInteger(item.firstLine), depth: Math.max(0, safeInteger(item.depth)),
    argcount: Math.max(0, safeInteger(item.argcount)), nlocals: Math.max(0, safeInteger(item.nlocals)),
    stacksize: Math.max(0, safeInteger(item.stacksize)), flags: Math.max(0, safeInteger(item.flags)),
    bytecodeLength: Math.max(0, safeInteger(item.bytecodeLength)),
    constants: Array.isArray(item.constants) ? item.constants.slice(0, LIMITS.codeMetadataCount).map(value => safeText(value, LIMITS.metadataConstantChars)) : [],
    names: Array.isArray(item.names) ? item.names.slice(0, LIMITS.codeMetadataCount).map(value => safeText(value, LIMITS.metadataNameChars)) : [],
    varnames: Array.isArray(item.varnames) ? item.varnames.slice(0, LIMITS.codeMetadataCount).map(value => safeText(value, LIMITS.metadataNameChars)) : [],
    metadataTruncated: item.metadataTruncated === true,
  }));
}

function validateInstructions(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, LIMITS.instructionCount).filter(item => item && typeof item === 'object').map((item, index) => {
    const source = item.source && typeof item.source === 'object' && Number.isSafeInteger(item.source.line) ? {
      line: item.source.line, column: safeOptionalInteger(item.source.column),
      endLine: safeOptionalInteger(item.source.endLine), endColumn: safeOptionalInteger(item.source.endColumn),
    } : null;
    return {
      id: safeText(item.id, 80) || `instruction-${index}`, codeId: safeText(item.codeId, 40),
      offset: Math.max(0, safeInteger(item.offset)), opcode: safeText(item.opcode, 80),
      arg: safeOptionalInteger(item.arg), argrepr: safeText(item.argrepr, LIMITS.instructionArgChars), source,
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
    tokensTruncated: message.tokensTruncated === true || (Array.isArray(message.tokens) && message.tokens.length > LIMITS.tokenCount),
    tokenError: safeText(message.tokenError), astTree: safeText(message.astTree), astDump: safeText(message.astDump),
    astError: safeText(message.astError), compileError: safeText(message.compileError),
    codeObjectText: safeText(message.codeObject), bytecode: safeText(message.bytecode), disassembly: safeText(message.disassembly),
    astNodes: validateAstNodes(trace.astNodes), codeObjects: validateCodeObjects(trace.codeObjects),
    instructions: validateInstructions(trace.instructions),
    instructionsTruncated: trace.instructionsTruncated === true || (Array.isArray(trace.instructions) && trace.instructions.length > LIMITS.instructionCount),
  };
}
