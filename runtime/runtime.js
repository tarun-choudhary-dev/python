import { loadInspectorSource, loadPackageAssets, loadRuntimeAssets } from './assets.js';
import { LOAD_TIMEOUT_MS, MAX_OUTPUT_CHARS } from './config.js';
import { PYTHON_PACKAGES } from './packages.js';

/** The page talks to an opaque-origin sandbox through a private MessageChannel. */
export class PyodideRuntime {
  constructor(onMessage) { this.onMessage = onMessage; this.generation = 0; }
  async initialize() {
    this.dispose();
    const generation = this.generation;
    this.timer = setTimeout(() => this.fail('Python took too long to load. Check your connection and retry.', 'TIMEOUT'), LOAD_TIMEOUT_MS);
    try {
      const assets = await loadRuntimeAssets();
      if (generation !== this.generation) return;
      this.frame = document.createElement('iframe');
      this.frame.hidden = true;
      this.frame.title = 'Isolated Python runtime';
      this.frame.setAttribute('sandbox', 'allow-scripts');
      this.frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; usb 'none'; serial 'none'; hid 'none'; payment 'none'");
      this.frame.src = new URL('./sandbox.html', import.meta.url).href;
      this.onFrameLoad = () => {
        if (generation !== this.generation) return;
        const channel = new MessageChannel();
        this.port = channel.port1;
        this.port.onmessage = ({ data }) => {
          if (generation !== this.generation || !data || typeof data !== 'object') return;
          if (data.type === 'connected') this.port.postMessage({ type: 'init', assets, maxOutput: MAX_OUTPUT_CHARS, packageCatalog: PYTHON_PACKAGES });
          else if (data.type === 'ready') { clearTimeout(this.timer); this.onMessage(data); }
          else if (data.type === 'fatal') this.fail(typeof data.message === 'string' ? data.message : 'Python could not start. Retry to reload it.', data.code);
          else if (data.type === 'result' || data.type === 'stream' || data.type === 'package-result') this.onMessage(data);
        };
        this.port.onmessageerror = () => {
          if (generation === this.generation) this.fail('The Python sandbox sent an unreadable response.');
        };
        this.frame.contentWindow.postMessage('pylab-connect', '*', [channel.port2]);
      };
      this.onFrameError = () => {
        if (generation === this.generation) this.fail('The Python sandbox could not load.');
      };
      this.frame.addEventListener('load', this.onFrameLoad, { once: true });
      this.frame.addEventListener('error', this.onFrameError);
      document.body.append(this.frame);
    } catch (error) {
      if (generation === this.generation) this.fail(error instanceof Error ? error.message : 'Python could not load. Check your connection and retry.');
    }
  }
  async run(id, source, operation = 'run', filename = 'main.py') {
    if (operation === 'run') {
      this.port.postMessage({ type: 'run', id, source, filename });
      return;
    }
    const generation = this.generation;
    const inspector = await loadInspectorSource();
    if (generation !== this.generation || !this.port) return;
    this.port.postMessage({ type: 'analysis', id, source, operation, filename, inspector });
  }
  async loadPackages(id, packageIds) {
    const generation = this.generation;
    try {
      const assets = await loadPackageAssets(packageIds);
      if (generation !== this.generation || !this.port) return;
      if (!assets.packages.length) {
        this.onMessage({ type: 'package-result', id, results: assets.errors, loadedRuntimeNames: [] });
        return;
      }
      this.port.postMessage({ type: 'load-packages', id, ...assets });
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : 'Packages could not be prepared.';
      this.onMessage({ type: 'package-result', id, results: packageIds.map(packageId => ({ id: packageId, error: message })), loadedRuntimeNames: [] });
    }
  }
  fail(message, code) { this.dispose(); this.onMessage({ type: 'fatal', message, code }); }
  dispose() {
    this.generation++;
    clearTimeout(this.timer);
    const port = this.port, frame = this.frame;
    this.port = null;
    this.frame = null;
    if (frame) {
      if (this.onFrameLoad) frame.removeEventListener('load', this.onFrameLoad);
      if (this.onFrameError) frame.removeEventListener('error', this.onFrameError);
    }
    this.onFrameLoad = null;
    this.onFrameError = null;
    if (port) {
      port.onmessage = null;
      port.onmessageerror = null;
      try { port.postMessage({ type: 'stop' }); } catch { /* Closing the port still invalidates it. */ }
      try { port.close(); } catch { /* The iframe is removed below. */ }
    }
    frame?.remove();
  }
}
