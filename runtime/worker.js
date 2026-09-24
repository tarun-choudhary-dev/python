/* Classic worker loaded as a blob by sandbox.html. Its CSP blocks all network access. */
(() => {
  'use strict';
  const send = globalThis.postMessage.bind(globalThis);
  let pyodide, execute, inspect, responses, packageCatalog = [], busy = false, runId = 0, maxOutput = 100000;
  let stdout = '', stderr = '', truncated = false, lastStream = 0;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const cleanError = error => error instanceof Error ? error.message : 'An unexpected Python runtime error occurred.';
  const cleanPackageError = error => {
    const message = cleanError(error);
    const pythonError = [...message.matchAll(/(?:ModuleNotFoundError|ImportError|RuntimeError|ValueError|OSError):[^\r\n]*/g)].at(-1)?.[0];
    return (pythonError || message.split(/\r?\n/).find(line => line.trim()) || 'The package could not be loaded.').slice(0, 500);
  };

  function capture(channel, bytes) {
    const value = decoders[channel].decode(bytes, { stream: true });
    const used = stdout.length + stderr.length;
    const available = Math.max(0, maxOutput - used);
    if (value.length > available) truncated = true;
    if (channel === 'stdout') stdout += value.slice(0, available);
    else stderr += value.slice(0, available);
    if (runId && performance.now() - lastStream > 80) {
      lastStream = performance.now();
      send({ type: 'stream', id: runId, stdout, stderr, truncated });
    }
    return bytes.length;
  }

  async function initialize(data) {
    const { files, executor } = data.assets;
    maxOutput = data.maxOutput;
    packageCatalog = Array.isArray(data.packageCatalog) ? data.packageCatalog : [];
    // Pyodide's loader sees fixed in-memory assets, never the actual fetch API.
    // CSP independently prevents network requests, including through alternate APIs.
    const runtimeBase = 'https://runtime.invalid/';
    responses = new Map(Object.entries(files).map(([name, bytes]) => [runtimeBase + name, bytes]));
    Object.defineProperty(globalThis, 'fetch', { configurable: false, writable: false, value: async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!responses.has(url)) throw new TypeError('Network access is disabled in this Python playground.');
      return new Response(responses.get(url), { headers: { 'Content-Type': url.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream' } });
    }});
    const urls = ['pyodide.js', 'pyodide.asm.js'].map(name => URL.createObjectURL(new Blob([files[name]], { type: 'text/javascript' })));
    try {
      importScripts(...urls);
      pyodide = await loadPyodide({
        indexURL: runtimeBase,
        packageBaseUrl: runtimeBase,
        lockFileContents: new TextDecoder().decode(files['pyodide-lock.json']),
        jsglobals: Object.freeze(Object.create(null)),
        stdin: () => null,
        stdout: () => {}, stderr: () => {},
      });
    } finally { urls.forEach(url => URL.revokeObjectURL(url)); }
    pyodide.setStdout({ write: bytes => capture('stdout', bytes) });
    pyodide.setStderr({ write: bytes => capture('stderr', bytes) });
    pyodide.runPython(executor);
    execute = pyodide.globals.get('_pylab_execute');
    const version = pyodide.runPython("'.'.join(map(str, __import__('sys').version_info[:3]))");
    // Remove the convenient public JS runtime bridge. Empty `js` exposes no APIs.
    // This is defense in depth; the opaque origin + CSP are the browser boundary.
    pyodide.unregisterJsModule('pyodide_js');
    pyodide.runPython("import sys\nsys.modules.pop('pyodide_js', None)\nsys.modules.pop('js', None)");
    send({ type: 'ready', version });
  }

  async function loadPackages(data) {
    const results = Array.isArray(data.errors) ? data.errors.slice() : [];
    for (const [name, bytes] of Object.entries(data.files || {})) {
      if (/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(name) && !name.includes('..') && bytes instanceof ArrayBuffer)
        responses.set('https://runtime.invalid/' + name, bytes);
    }
    for (const item of Array.isArray(data.packages) ? data.packages : []) {
      const trusted = packageCatalog.find(entry => entry.id === item.id && entry.runtimeName === item.runtimeName && entry.importName === item.importName);
      if (!trusted) { results.push({ id: typeof item.id === 'string' ? item.id : '', error: 'The package request was rejected.' }); continue; }
      try {
        await pyodide.loadPackage(trusted.runtimeName);
        const imported = pyodide.runPython(`__import__(${JSON.stringify(trusted.importName)}) is not None`);
        if (imported !== true) throw new Error(`Could not import ${trusted.importName}.`);
        results.push({ id: trusted.id, loaded: true });
      } catch (error) { results.push({ id: trusted.id, error: cleanPackageError(error) }); }
    }
    const loadedRuntimeNames = Object.keys(pyodide.loadedPackages || {});
    const loadedPackageIds = [];
    for (const item of packageCatalog) {
      if (!loadedRuntimeNames.includes(item.runtimeName)) continue;
      try {
        if (pyodide.runPython(`__import__(${JSON.stringify(item.importName)}) is not None`) === true)
          loadedPackageIds.push(item.id);
      } catch { /* An installed archive alone does not prove the import works. */ }
    }
    send({ type: 'package-result', id: data.id, results, loadedRuntimeNames, loadedPackageIds });
  }

  globalThis.onmessage = async ({ data }) => {
    if (data.type === 'init') {
      try { await initialize(data); }
      catch (error) { send({ type: 'fatal', message: `Python could not start. ${cleanError(error)}` }); }
      return;
    }
    if (data.type === 'load-packages') {
      if (busy || !pyodide || !Number.isInteger(data.id)) return;
      busy = true;
      try { await loadPackages(data); }
      catch (error) { send({ type: 'package-result', id: data.id, results: [], loadedRuntimeNames: [], error: cleanError(error) }); }
      finally { busy = false; }
      return;
    }
    const analysisOperations = ['compile', 'inspect', 'diagnose'];
    if (!['run', 'analysis'].includes(data.type) || busy || !execute || !Number.isSafeInteger(data.id) ||
        typeof data.source !== 'string' || data.source.length > 100000 ||
        (data.type === 'analysis' && !analysisOperations.includes(data.operation)) || typeof data.filename !== 'string' ||
        !data.filename || data.filename.length > 240 || /[\x00-\x1f\x7f]/.test(data.filename)) return;
    busy = true;
    runId = data.id;
    stdout = ''; stderr = ''; truncated = false; lastStream = 0;
    decoders.stdout = new TextDecoder(); decoders.stderr = new TextDecoder();
    const started = performance.now();
    try {
      let result;
      if (data.type === 'run') {
        result = JSON.parse(execute(data.source, data.filename));
      } else {
        if (!inspect) {
          if (typeof data.inspector !== 'string') throw new Error('The inspection source is unavailable.');
          pyodide.runPython(data.inspector);
          inspect = pyodide.globals.get('_pylab_inspect');
        }
        result = JSON.parse(inspect(data.source, data.filename));
      }
      send({ type: 'result', id: runId, operation: data.type === 'run' ? 'run' : data.operation,
        ...result, stdout, stderr, truncated, duration: performance.now() - started });
    } catch (error) {
      send({ type: 'fatal', message: `The Python runtime needs to restart. ${cleanError(error)}` });
    } finally { busy = false; runId = 0; }
  };
})();
