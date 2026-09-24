import { EXECUTION_TIMEOUT_MS, LIMITS, PACKAGE_LOAD_TIMEOUT_MS, PYODIDE_VERSION } from '../runtime/config.js';
import { PACKAGE_BY_ID, PYTHON_PACKAGES } from '../runtime/packages.js';
import { createEngineResult, validateOutput } from './result.js';
import { ENGINE_CAPABILITIES, PythonEngineError } from './protocol.js';
import { normalizeRequest, validateTimeout } from './request.js';
import { WorkerClient } from './worker-client.js';

const OPERATION_STATUS = { run: 'running', compile: 'compiling', inspect: 'inspecting', diagnose: 'diagnosing' };

/** A browser engine with no application, editor, or rendering dependencies. */
export class PythonEngine {
  constructor(options = {}) {
    this.callbacks = {};
    for (const name of ['onStatus', 'onStdout', 'onStderr', 'onStream', 'onResult', 'onError', 'onPackages']) {
      if (options[name] !== undefined && typeof options[name] !== 'function')
        throw new PythonEngineError(name + ' must be a function.', 'INVALID_OPTIONS');
      this.callbacks[name] = options[name];
    }
    this.executionTimeoutMs = validateTimeout(options.executionTimeoutMs ?? EXECUTION_TIMEOUT_MS, EXECUTION_TIMEOUT_MS);
    this.packageLoadTimeoutMs = validateTimeout(options.packageLoadTimeoutMs ?? PACKAGE_LOAD_TIMEOUT_MS, PACKAGE_LOAD_TIMEOUT_MS);
    // Internal transport seam for deterministic lifecycle tests; production uses the sandbox adapter.
    this.client = new WorkerClient(event => this._receive(event), options.runtimeFactory);
    this.status = 'idle';
    this.pythonVersion = '';
    this.generation = 0;
    this._clearPackages();
  }

  get capabilities() { return ENGINE_CAPABILITIES; }
  ready() { return this.status === 'ready'; }
  isReady() { return this.ready(); }
  isBusy() { return Boolean(this.active); }
  getState() {
    return {
      status: this.status, ready: this.ready(), pythonVersion: this.pythonVersion,
      activeOperation: this.active?.operation || null, requestId: this.active?.id ?? null,
      generation: this.generation, loadedPackages: this._loadedPackages(),
    };
  }
  getRuntimeInfo() {
    return { name: 'Pyodide', version: PYODIDE_VERSION, pythonVersion: this.pythonVersion, status: this.status };
  }
  getAvailablePackages() {
    return PYTHON_PACKAGES.map(item => ({ ...item, ...this.packageStates[item.id] }));
  }

  initialize() {
    if (this.status === 'disposed') return Promise.reject(this._error('DISPOSED'));
    if (this.recovery) return this.recovery;
    if (this.ready()) return Promise.resolve(this.getRuntimeInfo());
    if (this.initializer) return this.initializer.promise;
    if (this.active) return Promise.reject(this._error('BUSY'));
    this.generation++;
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    this.initializer = { promise, resolve, reject };
    this._setStatus('initializing');
    this.client.initialize();
    return promise;
  }

  run(input, options) { return this._operate('run', input, options); }
  compile(input, options) { return this._operate('compile', input, options); }
  inspect(input, options) { return this._operate('inspect', input, options); }
  diagnose(input, options) { return this._operate('diagnose', input, options); }

  _operate(operation, input, options) {
    let request;
    try { this._assertAvailable(); request = normalizeRequest(input, options); }
    catch (error) { return Promise.reject(error); }
    return this._begin({ operation, request, stdout: '', stderr: '' },
      request.timeoutMs ?? this.executionTimeoutMs,
      (id, timeoutMs) => this.client.run(id, request, operation, timeoutMs));
  }

  loadPackages(packageIds) {
    try { this._assertAvailable(); }
    catch (error) { return Promise.reject(error); }
    if (!Array.isArray(packageIds) || !packageIds.length || packageIds.length > LIMITS.packageCount)
      return Promise.reject(new PythonEngineError('Select one or more IDs from the curated package catalog.', 'INVALID_PACKAGES'));
    const ids = [...new Set(packageIds)];
    if (ids.some(id => typeof id !== 'string' || !PACKAGE_BY_ID.has(id)))
      return Promise.reject(new PythonEngineError('Select one or more IDs from the curated package catalog.', 'INVALID_PACKAGES'));
    const pending = ids.filter(id => this.packageStates[id].status !== 'loaded');
    if (!pending.length) return Promise.resolve({
      status: 'completed', packages: ids.map(id => ({ id, loaded: true })), loadedPackages: this._loadedPackages(),
    });
    for (const id of pending) this.packageStates[id] = { status: 'loading', error: '' };
    return this._begin({ operation: 'load-packages', packageIds: ids }, this.packageLoadTimeoutMs,
      (id, timeoutMs) => this.client.loadPackages(id, pending, timeoutMs));
  }

  _begin(fields, timeoutMs, dispatch) {
    const id = this.client.allocateId();
    let resolve, reject;
    const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
    this.active = { ...fields, id, resolve, reject };
    this._setStatus(OPERATION_STATUS[fields.operation] || 'loading-packages');
    dispatch(id, timeoutMs);
    return promise;
  }

  stop() {
    if (this.status === 'disposed') return false;
    const wasActive = Boolean(this.active || this.initializer);
    this._destroy(this._error('CANCELLED'), 'stopped');
    return wasActive;
  }

  cancel() {
    if (this.status === 'disposed') return Promise.reject(this._error('DISPOSED'));
    if (this.recovery) return this.recovery;
    if (this.status === 'unavailable') return Promise.reject(this._error('INVALID_STATE'));
    if (!this.active && !this.initializer)
      return Promise.resolve(this.ready() ? this.getRuntimeInfo() : null);
    this._destroy(this._error('CANCELLED'), 'stopped');
    return this._recover();
  }

  reset() {
    if (this.status === 'disposed') return Promise.reject(this._error('DISPOSED'));
    if (this.recovery) return this.recovery;
    this._destroy(this._error('RESET'), 'stopped');
    return this._recover();
  }

  _recover() {
    if (this.recovery) return this.recovery;
    const attempt = this.initialize();
    const recovery = attempt.then(
      info => { if (this.recovery === recovery) this.recovery = null; return info; },
      error => {
        if (this.recovery === recovery) {
          this.recovery = null;
          if (this.status !== 'disposed' && this.status !== 'unavailable')
            this._destroy(error, 'unavailable');
        }
        throw error;
      });
    this.recovery = recovery;
    return recovery;
  }

  dispose() {
    if (this.status !== 'disposed') this._destroy(this._error('DISPOSED'), 'disposed');
  }

  _assertAvailable() {
    if (this.status === 'disposed') throw this._error('DISPOSED');
    if (this.active) throw this._error('BUSY');
    if (!this.ready()) throw this._error('NOT_READY');
  }

  _receive(message) {
    if (!message || typeof message !== 'object' || this.status === 'disposed') return;
    if (message.type === 'ready') {
      if (!this.initializer) return;
      if (typeof message.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(message.version)) {
        this._fatal(new Error('The runtime returned invalid version information.'));
        return;
      }
      this.pythonVersion = message.version;
      const initializer = this.initializer;
      this.initializer = null;
      this._setStatus('ready');
      initializer.resolve(this.getRuntimeInfo());
      return;
    }
    if (message.type === 'fatal') {
      this._fatal(message.error, message.code);
      return;
    }
    if (message.type === 'timeout') {
      if (!this.active || message.id !== this.active.id) return;
      const error = new PythonEngineError('The Python operation exceeded its time limit. The engine is restarting.', 'TIMEOUT');
      this._destroy(error, 'stopped');
      this._emit('onError', error);
      this._recover().catch(() => {});
      return;
    }
    const active = this.active;
    if (!active || message.id !== active.id) return;
    const payload = message.payload;
    if (message.type === 'stream' && active.operation === 'run') {
      this._stream(payload, active);
    } else if (message.type === 'package-result' && active.operation === 'load-packages') {
      const confirmed = new Set(Array.isArray(payload.loadedPackageIds) ?
        payload.loadedPackageIds.filter(id => PACKAGE_BY_ID.has(id)) : []);
      const packages = active.packageIds.map(id => {
        const raw = Array.isArray(payload.results) ? payload.results.find(item => item?.id === id) : null;
        const loaded = raw?.loaded === true || this.packageStates[id].status === 'loaded';
        if (loaded) confirmed.add(id);
        const error = typeof raw?.error === 'string' ? raw.error.slice(0, LIMITS.packageErrorChars) :
          typeof payload.error === 'string' ? payload.error.slice(0, LIMITS.packageErrorChars) : 'The runtime did not confirm that the package loaded.';
        this.packageStates[id] = loaded ? { status: 'loaded', error: '' } : { status: 'error', error };
        return { id, loaded, ...(loaded ? {} : { error }) };
      });
      for (const id of confirmed) {
        // Do not replace an explicit import failure with a loader's dependency record.
        if (!packages.some(item => item.id === id && !item.loaded))
          this.packageStates[id] = { status: 'loaded', error: '' };
      }
      const result = { status: packages.every(item => item.loaded) ? 'completed' : 'failed',
        packages, loadedPackages: this._loadedPackages() };
      this._finish(active, result, 'onPackages');
    } else if (message.type === 'result' && active.operation !== 'load-packages') {
      const result = createEngineResult(payload, {
        operation: active.operation, filename: active.request.filename, pythonVersion: this.pythonVersion,
        requestId: active.id, generation: this.generation,
      });
      if (active.operation === 'run') this._stream(payload, active);
      this._finish(active, result, 'onResult');
    }
  }

  _stream(message, active) {
    const { stdout, stderr, outputTruncated } = validateOutput(message);
    // Stream messages are cumulative. Reject regressions instead of duplicating chunks.
    if (!stdout.startsWith(active.stdout) || !stderr.startsWith(active.stderr)) return;
    const stdoutChunk = stdout.slice(active.stdout.length), stderrChunk = stderr.slice(active.stderr.length);
    active.stdout = stdout; active.stderr = stderr;
    if (stdoutChunk) this._emit('onStdout', stdoutChunk, true);
    if (stderrChunk) this._emit('onStderr', stderrChunk, true);
    this._emit('onStream', { requestId: active.id, generation: this.generation,
      stdout, stderr, stdoutChunk, stderrChunk, outputTruncated }, true);
  }

  _finish(active, result, callback) {
    this.active = null;
    this._setStatus('ready');
    this._emit(callback, result, true);
    active.resolve(result);
  }

  _fatal(cause, code = 'RUNTIME_FAILURE') {
    const initializing = Boolean(this.initializer);
    const recovering = Boolean(this.recovery);
    const error = new PythonEngineError(cause instanceof Error ? cause.message.slice(0, LIMITS.fatalErrorChars) : 'The Python runtime failed.', code === 'TIMEOUT' ? 'TIMEOUT' : 'RUNTIME_FAILURE');
    this._destroy(error, recovering ? 'unavailable' : initializing ? 'idle' : 'stopped');
    this._emit('onError', error);
    if (!recovering && !initializing && this.status !== 'disposed') this._recover().catch(() => {});
  }

  _destroy(error, status) {
    this.generation++;
    this.recovery = null;
    const active = this.active, initializer = this.initializer;
    this.active = null;
    this.initializer = null;
    this.client.stop();
    this.pythonVersion = '';
    this._clearPackages();
    this._setStatus(status);
    active?.reject(error);
    initializer?.reject(error);
  }

  _loadedPackages() { return PYTHON_PACKAGES.filter(item => this.packageStates[item.id].status === 'loaded').map(item => item.id); }
  _clearPackages() { this.packageStates = Object.fromEntries(PYTHON_PACKAGES.map(({ id }) => [id, { status: 'unloaded', error: '' }])); }
  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this._emit('onStatus', this.getState(), true);
  }
  _emit(name, value, currentGenerationOnly = false) {
    const callback = this.callbacks[name], generation = this.generation;
    if (!callback) return;
    // Observers cannot interrupt an internal transition or break operation promises.
    queueMicrotask(() => {
      if (currentGenerationOnly && generation !== this.generation) return;
      try { callback(value); } catch (error) { console.error('Python engine observer failed:', error); }
    });
  }
  _error(code) {
    const messages = {
      DISPOSED: 'The Python engine has been disposed.', CANCELLED: 'The Python operation was stopped.',
      RESET: 'The Python runtime was reset.', BUSY: 'The Python engine is busy.',
      INVALID_STATE: 'Reset the Python engine before cancelling from this state.',
      NOT_READY: 'Initialize the Python engine before starting an operation.',
    };
    return new PythonEngineError(messages[code], code);
  }
}
