import { PyodideRuntime } from '../runtime/runtime.js';
import { LIMITS, LOAD_TIMEOUT_MS } from '../runtime/config.js';

const isRecord = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** Private request transport. The runtime adapter owns the opaque iframe and port. */
export class WorkerClient {
  constructor(onEvent, runtimeFactory = receive => new PyodideRuntime(receive), initializationTimeoutMs = LOAD_TIMEOUT_MS) {
    this.onEvent = onEvent;
    this.runtimeFactory = runtimeFactory;
    this.generation = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.initializing = false;
    this.initializationTimeoutMs = initializationTimeoutMs;
  }

  initialize() {
    this.stop();
    const generation = this.generation;
    this.initializing = true;
    this.initTimer = setTimeout(() => {
      if (generation === this.generation && this.initializing)
        this._fail(new Error('Python took too long to initialize.'), 'TIMEOUT');
    }, this.initializationTimeoutMs);
    try {
      this.runtime = this.runtimeFactory(message => this._receive(message, generation));
      Promise.resolve(this.runtime.initialize()).catch(error => {
        if (generation === this.generation) this._fail(error);
      });
    } catch (error) { this._fail(error); }
  }

  allocateId() { return ++this.nextId; }

  run(id, request, operation, timeoutMs) {
    this._send(id, operation, timeoutMs,
      () => this.runtime.run(id, request.source, operation, request.filename));
  }

  loadPackages(id, packageIds, timeoutMs) {
    this._send(id, 'load-packages', timeoutMs, () => this.runtime.loadPackages(id, packageIds));
  }

  _send(id, operation, timeoutMs, dispatch) {
    if (!this.runtime || this.pending.size || !Number.isSafeInteger(id)) {
      this._fail(new Error('The Python transport cannot accept this request.'));
      return;
    }
    const generation = this.generation;
    const timer = setTimeout(() => {
      if (generation !== this.generation || !this.pending.has(id)) return;
      this.stop();
      this.onEvent({ type: 'timeout', id });
    }, timeoutMs);
    this.pending.set(id, { operation, timer });
    try {
      Promise.resolve(dispatch()).catch(error => {
        if (generation === this.generation && this.pending.has(id)) this._fail(error);
      });
    } catch (error) { this._fail(error); }
  }

  _receive(message, generation) {
    if (generation !== this.generation) return;
    if (!isRecord(message)) {
      this._fail(new Error('The Python transport sent an invalid message.'));
      return;
    }
    if (message.type !== 'ready' && message.type !== 'fatal') {
      if (!Number.isSafeInteger(message.id) || message.id < 1) {
        this._fail(new Error('The Python transport sent an invalid request ID.'));
        return;
      }
      if (!this.pending.has(message.id)) return;
    }
    try {
      if (JSON.stringify(message).length > LIMITS.resultChars) throw new Error();
    } catch {
      this._fail(new Error('The Python transport sent an oversized or invalid message.'));
      return;
    }
    if (message.type === 'ready') {
      if (!this.initializing) return;
      if (typeof message.version !== 'string' || message.version.length > 64) {
        this._fail(new Error('The Python transport sent an invalid runtime version.'));
        return;
      }
      this.initializing = false;
      clearTimeout(this.initTimer);
      this.initTimer = null;
      this.onEvent({ type: 'ready', version: message.version });
      return;
    }
    if (message.type === 'fatal') {
      this._fail(new Error(typeof message.message === 'string' ? message.message.slice(0, LIMITS.fatalErrorChars) : 'The Python runtime failed.'), message.code);
      return;
    }
    if (!Number.isSafeInteger(message.id) || message.id < 1) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'stream' && pending.operation === 'run') {
      if (!this._validOutput(message)) return this._fail(new Error('The Python transport sent malformed output.'));
      this.onEvent({ type: 'stream', id: message.id, payload: message });
      return;
    }
    const expected = pending.operation === 'load-packages' ? 'package-result' : 'result';
    if (message.type !== expected || (expected === 'result' && message.operation !== pending.operation) ||
        (expected === 'result' && (!this._validOutput(message) ||
          typeof message.stdout !== 'string' || typeof message.stderr !== 'string' ||
          typeof message.truncated !== 'boolean' || typeof message.error !== 'string' ||
          (message.errorLine !== undefined && (!Number.isSafeInteger(message.errorLine) || message.errorLine < 0)) ||
          (message.errorKind !== undefined && !['', 'syntax', 'runtime'].includes(message.errorKind)) ||
          (typeof message.error === 'string' && message.error.length > LIMITS.errorChars) ||
          ['diagnostic', 'tokenError', 'astError', 'compileError', 'astTree', 'astDump', 'codeObject', 'bytecode', 'disassembly'].some(key =>
            message[key] !== undefined && (typeof message[key] !== 'string' || message[key].length >
              (key === 'diagnostic' ? LIMITS.diagnosticFieldChars : LIMITS.analysisFieldChars))) ||
          (message.tokens !== undefined && (!Array.isArray(message.tokens) || message.tokens.length > LIMITS.tokenCount)) ||
          (message.trace !== undefined && (!isRecord(message.trace) ||
            ['astNodes', 'codeObjects', 'instructions'].some((key, index) => message.trace[key] !== undefined &&
              (!Array.isArray(message.trace[key]) || message.trace[key].length >
                [LIMITS.astNodeCount, LIMITS.codeObjectCount, LIMITS.instructionCount][index])))) ||
          !Number.isFinite(message.duration) || message.duration < 0 || message.duration > Number.MAX_SAFE_INTEGER)) ||
        (expected === 'package-result' &&
          (!Array.isArray(message.results) || message.results.length > LIMITS.packageCount * 2 ||
            (message.loadedPackageIds !== undefined && (!Array.isArray(message.loadedPackageIds) ||
              message.loadedPackageIds.length > LIMITS.packageCount ||
              message.loadedPackageIds.some(id => typeof id !== 'string' || id.length > LIMITS.packageNameChars))) ||
            (message.loadedRuntimeNames !== undefined && (!Array.isArray(message.loadedRuntimeNames) ||
              message.loadedRuntimeNames.length > LIMITS.runtimePackageCount)) ||
            message.results.some(item => !isRecord(item) || typeof item.id !== 'string' || item.id.length > LIMITS.packageNameChars ||
              (item.error !== undefined && (typeof item.error !== 'string' || item.error.length > LIMITS.packageErrorChars)))))) {
      this._fail(new Error('The Python transport returned an unexpected response.'));
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    this.onEvent({ type: expected, id: message.id, payload: message });
  }

  _validOutput(message) {
    return (message.stdout === undefined || typeof message.stdout === 'string') &&
      (message.stderr === undefined || typeof message.stderr === 'string') &&
      (message.truncated === undefined || typeof message.truncated === 'boolean') &&
      (message.stdout?.length ?? 0) + (message.stderr?.length ?? 0) <= LIMITS.outputChars;
  }

  _fail(error, code) {
    this.stop();
    this.onEvent({ type: 'fatal', error, code });
  }

  stop() {
    this.generation++;
    this.initializing = false;
    clearTimeout(this.initTimer);
    this.initTimer = null;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    const runtime = this.runtime;
    this.runtime = null;
    try { runtime?.dispose(); } catch { /* Pending engine work still settles. */ }
  }
}
