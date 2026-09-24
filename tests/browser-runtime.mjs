import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../scripts/serve.mjs';

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
const root = fileURLToPath(new URL('../', import.meta.url));
const consumerIndex = process.argv.indexOf('--consumer-root');
const consumerRoot = consumerIndex < 0 ? null : process.argv[consumerIndex + 1];
if (consumerIndex >= 0 && (!consumerRoot || process.argv.includes('--built')))
  throw new Error('Pass a clean consumer directory with --consumer-root, separately from --built.');
if (process.argv.includes('--built')) {
  async function files(directory, prefix = '') {
    const entries = await readdir(join(directory, prefix), { withFileTypes: true });
    const found = [];
    for (const entry of entries) {
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) found.push(...await files(directory, relative));
      else if (entry.isFile()) found.push(relative);
      else throw new Error(`Distribution contains a non-file entry: ${relative}`);
    }
    return found;
  }
  const expected = ['index.js', 'package.json', 'README.md', 'LICENSE', 'THIRD_PARTY.md',
    ...await files(root, 'python-engine'), ...await files(root, 'runtime')].sort();
  const actual = (await files(join(root, 'dist'))).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Distribution file list differs from source. Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  for (const relative of expected) {
    const [source, built] = await Promise.all([readFile(join(root, relative)), readFile(join(root, 'dist', relative))]);
    if (relative === 'package.json') {
      const sourceMetadata = JSON.parse(source.toString());
      const builtMetadata = JSON.parse(built.toString());
      delete sourceMetadata.scripts;
      delete sourceMetadata.engines;
      if (JSON.stringify(sourceMetadata) !== JSON.stringify(builtMetadata) ||
          Object.hasOwn(builtMetadata, 'scripts') || Object.hasOwn(builtMetadata, 'engines'))
        throw new Error('Distribution package metadata differs from the source release fields.');
      continue;
    }
    if (!source.equals(built)) throw new Error(`Distribution asset differs from source: ${relative}`);
  }
  console.log(`Distribution parity: ${expected.length - 1} assets match source byte-for-byte; release metadata omits Node tooling fields; no extra files.`);
}
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Set CHROME_PATH to a Chromium browser to run the browser runtime integration tests.');
const profile = await mkdtemp(join(tmpdir(), 'pylab-runtime-test-'));
const server = await serve(consumerRoot || root, 0);
const url = `http://127.0.0.1:${server.address().port}/${consumerRoot ? 'index.html' : 'tests/harness.html'}`;
const chrome = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, url], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let diagnostic = '';
chrome.stderr.on('data', chunk => { diagnostic += chunk.toString(); });
let socket;
try {
  let port;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!port) throw new Error(`Headless browser did not start: ${diagnostic}`);
  const browserInfo = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  console.log(`Browser: ${browserInfo.Browser} (${executable})`);
  let target;
  for (let attempt = 0; attempt < 100; attempt++) {
    target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(tab => tab.url === url);
    if (target) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!target) throw new Error('Runtime test page did not load.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map();
  const verbose = process.env.DEBUG_RUNTIME_TESTS === '1';
  let onLoaded;
  socket.onmessage = event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Page.loadEventFired') onLoaded?.();
    if (data.method === 'Log.entryAdded') console.error(data.params.entry.level, data.params.entry.text);
    if (data.method === 'Network.loadingFailed' && data.params.errorText !== 'net::ERR_ABORTED') console.error('Network failure:', data.params.errorText, data.params.blockedReason || '');
    if (verbose && data.method === 'Network.responseReceived') console.log('Asset:', data.params.response.status, new URL(data.params.response.url).pathname);
    if (data.method === 'Runtime.consoleAPICalled') console.log('Browser:', data.params.type, data.params.args.map(arg => arg.value || arg.description).join(' '));
    if (data.method === 'Runtime.exceptionThrown') console.error('Browser exception:', data.params.exceptionDetails);
    if (data.method === 'Target.attachedToTarget') {
      command('Runtime.enable', {}, data.params.sessionId);
      command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, data.params.sessionId);
    }
    if (pending.has(data.id)) { pending.get(data.id)(data); pending.delete(data.id); }
  };
  function command(method, params = {}, sessionId) {
    const id = ++sequence;
    return new Promise(resolve => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method, params, sessionId })); });
  }
  await command('Page.enable');
  await command('Log.enable');
  await command('Network.enable');
  await command('Runtime.enable');
  await command('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  const loaded = new Promise(resolve => { onLoaded = resolve; });
  await command('Page.navigate', { url });
  await loaded;
  if (consumerRoot) {
    const entry = new URL('node_modules/pylab-python-engine/index.js', url).href;
    const result = await command('Runtime.evaluate', {
      expression: `(${consumerSmoke.toString()})(${JSON.stringify(entry)})`,
      awaitPromise: true, returnByValue: true, timeout: 240000,
    });
    if (result.error || result.result?.exceptionDetails)
      throw new Error(JSON.stringify(result.error || result.result.exceptionDetails));
    console.log(JSON.stringify({ entry, consumer: result.result.result.value }, null, 2));
  } else {
    const result = await command('Runtime.evaluate', { expression: `import(${JSON.stringify(new URL('runtime-harness.js', url).href)}).then(module => module.runRuntimeTests())`, awaitPromise: true, returnByValue: true, timeout: 240000 });
    if (result.error || result.result?.exceptionDetails) throw new Error(JSON.stringify(result.error || result.result.exceptionDetails));
    console.log(JSON.stringify(result.result.result.value, null, 2));
    const engineEntry = new URL(process.argv.includes('--built') ? '../dist/index.js' : '../index.js', url).href;
    const engineResult = await command('Runtime.evaluate', {
      expression: `import(${JSON.stringify(new URL('engine-harness.js', url).href)}).then(module => module.runEngineTests(${JSON.stringify(engineEntry)}))`,
      awaitPromise: true, returnByValue: true, timeout: 240000,
    });
    if (engineResult.error || engineResult.result?.exceptionDetails)
      throw new Error(JSON.stringify(engineResult.error || engineResult.result.exceptionDetails));
    console.log(JSON.stringify({ entry: engineEntry, engine: engineResult.result.result.value }, null, 2));
  }
} finally { socket?.close(); chrome.kill(); server.close(); }

/** This function runs inside the isolated consumer page; it imports only the installed package. */
async function consumerSmoke(entry) {
  const { PythonEngine, PythonEngineError } = await import(entry);
  const checks = [];
  const check = (condition, name) => { if (!condition) throw new Error(name); checks.push(name); };
  const rejects = async (promise, code) => {
    try { await promise; } catch (error) {
      check(error instanceof PythonEngineError && error.code === code, `rejects ${code}`);
      return;
    }
    throw new Error(`Expected ${code} rejection.`);
  };
  const engine = new PythonEngine();
  try {
    await rejects(engine.run('pass'), 'NOT_READY');
    const info = await engine.initialize();
    check(engine.isReady() && info.version === '0.29.3' && /^3\./.test(info.pythonVersion), 'installed engine initializes');
    const frame = document.querySelector('iframe');
    check(frame?.getAttribute('sandbox') === 'allow-scripts' && frame.contentDocument === null,
      'installed package creates an opaque sandbox');
    let result = await engine.run({ source: 'print("Hello, Python")' });
    check(result.stdout === 'Hello, Python\n' && result.status === 'completed' && !Object.hasOwn(result, 'inspection'),
      'installed package executes without implicit inspection');
    result = await engine.run('print(');
    check(result.status === 'failed' && result.diagnostics[0]?.kind === 'syntax', 'syntax error resolves as a failed result');
    result = await engine.run('raise ValueError("consumer failure")');
    check(result.status === 'failed' && result.error.includes('consumer failure'), 'runtime error resolves as a failed result');
    result = await engine.run('import math\nprint(math.sqrt(81))');
    check(result.stdout === '9.0\n', 'standard-library import works');
    result = await engine.run('print("second run")');
    check(result.stdout === 'second run\n', 'sequential runs work');
    await rejects(engine.run('  \n'), 'EMPTY_SOURCE');
    await rejects(engine.run(null), 'INVALID_REQUEST');
    await rejects(engine.run('x'.repeat(100001)), 'SOURCE_TOO_LARGE');
    await rejects(engine.run({ source: 'pass', filename: 'x'.repeat(241) }), 'INVALID_FILENAME');
    result = await engine.run('print("x" * 100001)');
    check(result.stdout.length === 100000 && result.outputTruncated, 'installed package enforces output limit');
    result = await engine.inspect('value = 1');
    check(result.inspection?.ast.nodes.length > 0 && result.status === 'completed', 'explicit inspection works');
    result = await engine.diagnose('print(');
    check(result.status === 'failed' && result.diagnostics.some(item => item.kind === 'syntax'), 'explicit diagnosis works');
    await engine.reset();
    check(engine.isReady() && engine.getAvailablePackages().every(item => item.status === 'unloaded'),
      'reset leaves a fresh installed interpreter');
    const running = engine.run('while True:\n    pass');
    const cancelled = rejects(running, 'CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 100));
    await engine.cancel();
    await cancelled;
    check(engine.isReady(), 'cancellation recovers the installed interpreter');
    await rejects(engine.run('while True:\n    pass', { timeoutMs: 100 }), 'TIMEOUT');
    await engine.initialize();
    result = await engine.run('print("recovered")');
    check(result.stdout === 'recovered\n', 'timeout recovery permits another run');
    const packages = await engine.loadPackages(['numpy']);
    check(packages.status === 'completed' && packages.loadedPackages.includes('numpy'), 'curated package loads');
    result = await engine.run('import numpy as np\nprint(np.array([1, 2, 3]).sum())');
    check(result.stdout === '6\n', 'loaded package executes');
    engine.dispose();
    await rejects(engine.run('pass'), 'DISPOSED');
    // The private transport seam is used only by this test to corrupt an installed-package reply.
    let transport;
    const malformedProbe = new PythonEngine({ runtimeFactory: receive => {
      transport = { initialize() {}, run() {}, dispose() {}, emit: receive };
      return transport;
    } });
    try {
      const starting = malformedProbe.initialize();
      transport.emit({ type: 'ready', version: '3.13.2' });
      await starting;
      const pending = malformedProbe.run('pass');
      transport.emit({ type: 'result', id: malformedProbe.getState().requestId, operation: 'run',
        stdout: [], stderr: '', truncated: false, error: '', duration: 0 });
      await rejects(pending, 'RUNTIME_FAILURE');
      check(!malformedProbe.isReady(), 'malformed installed-package response fails closed');
      const restarting = malformedProbe.initialize();
      transport.emit({ type: 'ready', version: '3.13.2' });
      await restarting;
      const oversized = malformedProbe.run('pass');
      transport.emit({ type: 'result', id: malformedProbe.getState().requestId, operation: 'run',
        stdout: '', stderr: '', truncated: false, error: '', duration: 0, extra: 'x'.repeat(4000000) });
      await rejects(oversized, 'RUNTIME_FAILURE');
      check(!malformedProbe.isReady(), 'installed package rejects an oversized serialized response');
    } finally { malformedProbe.dispose(); }
    return { passed: checks.length, checks, runtime: info };
  } finally { engine.dispose(); }
}
