import { spawn } from 'node:child_process';
import { mkdtemp, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../scripts/serve.mjs';

const candidates = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean);
let executable;
for (const candidate of candidates) { try { await access(candidate); executable = candidate; break; } catch {} }
if (!executable) throw new Error('Set CHROME_PATH to a Chromium browser to run the browser runtime integration tests.');
const profile = await mkdtemp(join(tmpdir(), 'pylab-runtime-test-'));
const server = await serve(fileURLToPath(new URL('../', import.meta.url)), 0);
const url = `http://127.0.0.1:${server.address().port}/tests/harness.html`;
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
} finally { socket?.close(); chrome.kill(); server.close(); }
