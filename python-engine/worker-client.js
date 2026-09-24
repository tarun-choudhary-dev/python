import { PyodideRuntime } from '../runtime/runtime.js';

/** Private request transport. The runtime adapter owns the opaque iframe and port. */
export class WorkerClient {
  constructor(onEvent, runtimeFactory = receive => new PyodideRuntime(receive)) {
    this.onEvent = onEvent;
    this.runtimeFactory = runtimeFactory;
    this.generation = 0;
    this.nextId = 0;
    this.pending = new Map();
    this.initializing = false;
  }

  initialize() {
    this.stop();
    const generation = this.generation;
    this.initializing = true;
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
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this._fail(new Error('The Python transport sent an invalid message.'));
      return;
    }
    if (message.type === 'ready') {
      if (!this.initializing) return;
      this.initializing = false;
      this.onEvent({ type: 'ready', version: message.version });
      return;
    }
    if (message.type === 'fatal') {
      this._fail(new Error(typeof message.message === 'string' ? message.message : 'The Python runtime failed.'));
      return;
    }
    if (!Number.isSafeInteger(message.id)) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === 'stream' && pending.operation === 'run') {
      if (!this._validOutput(message)) return this._fail(new Error('The Python transport sent malformed output.'));
      this.onEvent({ type: 'stream', id: message.id, payload: message });
      return;
    }
    const expected = pending.operation === 'load-packages' ? 'package-result' : 'result';
    if (message.type !== expected || (message.operation !== undefined && message.operation !== pending.operation) ||
        (expected === 'result' && (!this._validOutput(message) ||
          (message.error !== undefined && typeof message.error !== 'string') ||
          (message.duration !== undefined && (!Number.isFinite(message.duration) || message.duration < 0)))) ||
        (expected === 'package-result' &&
          (message.results !== undefined && !Array.isArray(message.results)))) {
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
      (message.truncated === undefined || typeof message.truncated === 'boolean');
  }

  _fail(error) {
    this.stop();
    this.onEvent({ type: 'fatal', error });
  }

  stop() {
    this.generation++;
    this.initializing = false;
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    const runtime = this.runtime;
    this.runtime = null;
    try { runtime?.dispose(); } catch { /* Pending engine work still settles. */ }
  }
}
