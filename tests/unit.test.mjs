import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createPythonEngine, ENGINE_CAPABILITIES, ENGINE_PROTOCOL_VERSION, PythonEngineError } from '../index.js';
import { createEngineResult, processWorkerResult, validateOutput } from '../python-engine/result.js';
import { WorkerClient } from '../python-engine/worker-client.js';
import { PYTHON_PACKAGES } from '../runtime/packages.js';
import { resolvePackageArchives } from '../runtime/assets.js';
import { LIMITS } from '../runtime/config.js';
import { normalizeRequest } from '../python-engine/request.js';

function fixture(t, options = {}) {
  const transports = [], calls = [], statuses = [], results = [];
  const engine = createPythonEngine({
    onStatus: value => statuses.push(value), onResult: value => results.push(value), ...options,
    runtimeFactory: receive => {
      const transport = {
        disposed: 0, emit: receive, initialize() { calls.push(['initialize']); },
        run(...args) { calls.push(['run', ...args]); },
        loadPackages(...args) { calls.push(['loadPackages', ...args]); },
        dispose() { this.disposed++; },
      };
      transports.push(transport);
      return transport;
    },
  });
  t.after(() => engine.dispose());
  return { engine, transports, calls, statuses, results };
}
async function initialized(t, options) {
  const f = fixture(t, options);
  const loading = f.engine.initialize();
  f.transports[0].emit({ type: 'ready', version: '3.13.2' });
  await loading;
  return f;
}
function resultMessage(engine, fields = {}) {
  return { type: 'result', id: engine.getState().requestId, operation: engine.getState().activeOperation,
    stdout: '', stderr: '', truncated: false, error: '', duration: 0, ...fields };
}

test('curated metadata preserves all nine package and import identifiers', () => {
  assert.deepEqual(PYTHON_PACKAGES.map(({ label, runtimeName, importName }) => [label, runtimeName, importName]), [
    ['NumPy', 'numpy', 'numpy'], ['Pandas', 'pandas', 'pandas'], ['Matplotlib', 'matplotlib', 'matplotlib'],
    ['SciPy', 'scipy', 'scipy'], ['SymPy', 'sympy', 'sympy'], ['Scikit-learn', 'scikit-learn', 'sklearn'],
    ['NetworkX', 'networkx', 'networkx'], ['BeautifulSoup4', 'beautifulsoup4', 'bs4'], ['Pillow', 'pillow', 'PIL'],
  ]);
  assert.equal(new Set(PYTHON_PACKAGES.map(item => item.id)).size, 9);
});

test('archive resolution follows only pinned lockfile dependencies and rejects paths and URLs', () => {
  const lock = { packages: {
    pandas: { file_name: 'pandas.whl', depends: ['numpy', 'python-dateutil'] },
    numpy: { file_name: 'numpy.whl', depends: [] },
    'python-dateutil': { file_name: 'python_dateutil.whl', depends: ['six'] },
    six: { file_name: 'six.whl', depends: [] },
  } };
  assert.deepEqual(resolvePackageArchives(lock, 'pandas'), ['pandas.whl', 'numpy.whl', 'python_dateutil.whl', 'six.whl']);
  assert.throws(() => resolvePackageArchives(lock, 'requests'), /Unavailable in Pyodide 0\.29\.3/);
  for (const name of ['../demo.whl', 'https://example.com/demo.whl'])
    assert.throws(() => resolvePackageArchives({ packages: { demo: { file_name: name, depends: [] } } }, 'demo'), /invalid/);
});

test('public module imports without a DOM and exposes an idle engine and capabilities', t => {
  const { engine, transports } = fixture(t);
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(transports.length, 0);
  assert.equal(engine.ready(), false);
  assert.equal(engine.getState().status, 'idle');
  assert.equal(ENGINE_PROTOCOL_VERSION, 1);
  assert.deepEqual(Object.keys(ENGINE_CAPABILITIES).filter(key => ENGINE_CAPABILITIES[key]),
    ['run', 'compile', 'diagnostics', 'inspect', 'ast', 'bytecode', 'disassembly', 'streamingOutput', 'packages']);
  assert.equal(Object.isFrozen(engine.capabilities), true);
});

test('initialize is single-flight and waits for runtime confirmation', async t => {
  const { engine, transports } = fixture(t);
  await assert.rejects(engine.run('print(1)'), { code: 'NOT_READY' });
  const first = engine.initialize(), second = engine.initialize();
  assert.equal(first, second);
  assert.equal(engine.getState().status, 'initializing');
  transports[0].emit({ type: 'ready', version: '3.13.2' });
  assert.deepEqual(await first, { name: 'Pyodide', version: '0.29.3', pythonVersion: '3.13.2', status: 'ready' });
  await engine.initialize();
  assert.equal(transports.length, 1);
});

test('initialization failure is retryable and malformed versions fail closed', async t => {
  const { engine, transports } = fixture(t);
  const first = engine.initialize();
  transports[0].emit({ type: 'fatal', message: 'offline' });
  await assert.rejects(first, { code: 'RUNTIME_FAILURE', message: 'offline' });
  assert.equal(engine.getState().status, 'idle');
  const retry = engine.initialize();
  transports[1].emit({ type: 'ready', version: '<script>' });
  await assert.rejects(retry, { code: 'RUNTIME_FAILURE' });
});

test('invalid source, filename and timeout are rejected without dispatch', async t => {
  const { engine, calls } = await initialized(t);
  for (const [request, code] of [
    [null, 'INVALID_REQUEST'], [{}, 'INVALID_SOURCE'], ['', 'EMPTY_SOURCE'], ['  \n', 'EMPTY_SOURCE'],
    ['x'.repeat(100001), 'SOURCE_TOO_LARGE'], [{ source: 'pass', filename: 'x\n.py' }, 'INVALID_FILENAME'],
    [{ source: 'pass', filename: '\t' }, 'INVALID_FILENAME'], [{ source: 'pass', timeoutMs: 0 }, 'INVALID_TIMEOUT'],
    [{ source: 'pass', timeoutMs: 15001 }, 'INVALID_TIMEOUT'], [{ source: 'pass', timeoutMs: '100' }, 'INVALID_TIMEOUT'],
  ]) await assert.rejects(engine.run(request), { code });
  assert.equal(calls.filter(call => call[0] === 'run').length, 0);
  assert.equal(engine.ready(), true);
  for (const value of [0, -1, NaN, Infinity, 0.5, 15001, '50'])
    assert.throws(() => createPythonEngine({ executionTimeoutMs: value }), { code: 'INVALID_TIMEOUT' });
  assert.throws(() => createPythonEngine({ onResult: true }), { code: 'INVALID_OPTIONS' });
});

test('source and synthetic filename enforce both sides of their exact boundaries', async t => {
  const { engine, calls } = await initialized(t);
  for (const size of [LIMITS.sourceChars - 1, LIMITS.sourceChars])
    assert.equal(normalizeRequest('x'.repeat(size)).source.length, size);
  for (const size of [LIMITS.sourceChars + 1, LIMITS.sourceChars * 10])
    await assert.rejects(engine.run('x'.repeat(size)), { code: 'SOURCE_TOO_LARGE' });
  for (const size of [LIMITS.filenameChars - 1, LIMITS.filenameChars])
    assert.equal(normalizeRequest({ source: 'pass', filename: 'x'.repeat(size) }).filename.length, size);
  for (const size of [LIMITS.filenameChars + 1, LIMITS.filenameChars * 10])
    await assert.rejects(engine.run({ source: 'pass', filename: 'x'.repeat(size) }), { code: 'INVALID_FILENAME' });
  await assert.rejects(engine.run({ get source() { throw new Error('private source'); } }),
    { code: 'INVALID_REQUEST', message: 'The Python request could not be read.' });
  assert.equal(normalizeRequest({ source: 'pass', filename: 'λ.py' }).filename, 'λ.py');
  assert.equal(calls.filter(call => call[0] === 'run').length, 0);
  assert.equal(engine.ready(), true);
});

test('curated package count is checked before deduplication or dispatch', async t => {
  const { engine, calls } = await initialized(t);
  await assert.rejects(engine.loadPackages(Array(LIMITS.packageCount + 1).fill('numpy')), { code: 'INVALID_PACKAGES' });
  await assert.rejects(engine.loadPackages(Array(100_000).fill('numpy')), { code: 'INVALID_PACKAGES' });
  assert.equal(calls.filter(call => call[0] === 'loadPackages').length, 0);
  assert.equal(engine.ready(), true);
});

test('malformed and oversized matching transport messages fail closed and recover', async t => {
  for (const malformed of [
    { type: 'result', stdout: undefined },
    { type: 'result', stdout: 'x'.repeat(LIMITS.outputChars + 1) },
    { type: 'result', error: 'x'.repeat(LIMITS.errorChars + 1) },
    { type: 'result', diagnostic: 'x'.repeat(LIMITS.diagnosticFieldChars + 1) },
    { type: 'result', tokens: Array(LIMITS.tokenCount + 1).fill({}) },
    { type: 'result', trace: { instructions: Array(LIMITS.instructionCount + 1).fill({}) } },
    { type: 'result', trace: [] },
    { type: 'result', trace: new Map() },
    { type: 'result', extra: 'x'.repeat(LIMITS.resultChars) },
    { type: 'result', stdout: [], duration: 'bad' },
    { type: 'result', errorLine: -1 },
    { type: 'result', errorKind: 'unknown' },
    { type: 'result', id: '1' },
    { type: 'unknown' },
  ]) {
    const { engine, transports } = await initialized(t);
    const running = engine.run('pass');
    transports[0].emit({ ...resultMessage(engine), ...malformed });
    await assert.rejects(running, { code: 'RUNTIME_FAILURE' });
    assert.equal(engine.getState().status, 'initializing');
    const recovery = engine.initialize();
    transports[1].emit({ type: 'ready', version: '3.13.2' });
    await recovery;
    assert.equal(engine.ready(), true);
  }
});

test('package response collections and errors cannot exceed the curated protocol bounds', async t => {
  for (const bad of [
    { results: Array(LIMITS.packageCount * 2 + 1).fill({ id: 'numpy', loaded: true }) },
    { results: [{ id: 'numpy', error: 'x'.repeat(LIMITS.packageErrorChars + 1) }] },
    { results: [{ id: 'numpy', loaded: true }], loadedPackageIds: Array(LIMITS.packageCount + 1).fill('numpy') },
    { results: [{ id: 'numpy', loaded: true }], loadedRuntimeNames: Array(LIMITS.runtimePackageCount + 1).fill('numpy') },
  ]) {
    const { engine, transports } = await initialized(t);
    const pending = engine.loadPackages(['numpy']);
    transports[0].emit({ type: 'package-result', id: engine.getState().requestId, ...bad });
    await assert.rejects(pending, { code: 'RUNTIME_FAILURE' });
    assert.equal(engine.getAvailablePackages()[0].status, 'unloaded');
  }
});

test('operations forward identity and filename and return serializable structured results', async t => {
  const { engine, transports, calls } = await initialized(t);
  for (const operation of ['run', 'compile', 'inspect', 'diagnose']) {
    const pending = engine[operation]('print(1)', { filename: 'folder/example.py' });
    assert.deepEqual(calls.at(-1).slice(2), ['print(1)', operation, 'folder/example.py']);
    transports[0].emit(resultMessage(engine, { stdout: operation === 'run' ? '1\n' : '', duration: 4 }));
    const result = await pending;
    assert.equal(result.operation, operation);
    assert.equal(result.filename, 'folder/example.py');
    assert.equal(result.protocolVersion, 1);
    assert.equal(result.runtime.version, '0.29.3');
    assert.equal(result.pythonVersion, '3.13.2');
    assert.equal(result.status, 'completed');
    assert.equal(result.exitCode, 0);
    assert.equal(result.error, null);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  }
});

test('busy engines reject duplicate operations and initialize cannot restart an active run', async t => {
  const { engine, transports, calls } = await initialized(t);
  const pending = engine.run('pass');
  await assert.rejects(engine.run('pass'), { code: 'BUSY' });
  await assert.rejects(engine.compile('pass'), { code: 'BUSY' });
  await assert.rejects(engine.inspect('pass'), { code: 'BUSY' });
  await assert.rejects(engine.diagnose('pass'), { code: 'BUSY' });
  await assert.rejects(engine.loadPackages(['numpy']), { code: 'BUSY' });
  await assert.rejects(engine.initialize(), { code: 'BUSY' });
  assert.equal(calls.filter(call => call[0] === 'initialize').length, 1);
  transports[0].emit(resultMessage(engine));
  await pending;
});

test('streaming ignores regressions and flushes final chunks exactly once', async t => {
  const stdout = [], stderr = [];
  const { engine, transports } = await initialized(t, {
    onStdout: chunk => stdout.push(chunk), onStderr: chunk => stderr.push(chunk),
  });
  const pending = engine.run('pass'), id = engine.getState().requestId;
  for (const text of ['one', 'on', 'one']) transports[0].emit({ type: 'stream', id, stdout: text, stderr: '' });
  transports[0].emit(resultMessage(engine, { stdout: 'one two', stderr: 'warning' }));
  const result = await pending;
  assert.equal(stdout.join(''), result.stdout);
  assert.equal(stderr.join(''), result.stderr);
  assert.deepEqual(stdout, ['one', ' two']);
  assert.equal(validateOutput({ stdout: 'x'.repeat(80000), stderr: 'y'.repeat(80000) }).stderr.length, 20000);
  assert.equal(validateOutput({ stdout: 'x'.repeat(100001) }).outputTruncated, true);
});

test('a final result cannot contradict output already streamed to consumers', async t => {
  const stdout = [], completed = [];
  const { engine, transports } = await initialized(t, {
    onStdout: chunk => stdout.push(chunk), onResult: result => completed.push(result),
  });
  const running = engine.run('print("hello")');
  transports[0].emit({ type: 'stream', id: engine.getState().requestId, stdout: 'hello', stderr: '' });
  await Promise.resolve();
  transports[0].emit(resultMessage(engine, { stdout: 'hell' }));
  await assert.rejects(running, { code: 'RUNTIME_FAILURE' });
  assert.deepEqual(stdout, ['hello']);
  assert.deepEqual(completed, []);
  assert.equal(engine.getState().status, 'initializing');
  const recovery = engine.initialize();
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await recovery;
  assert.equal(engine.ready(), true);
});

test('public analysis operations enforce request, lifecycle, timeout and disposal rules', async t => {
  for (const operation of ['compile', 'inspect', 'diagnose']) {
    const { engine, transports } = fixture(t);
    await assert.rejects(engine[operation]('pass'), { code: 'NOT_READY' });
    const startup = engine.initialize();
    transports[0].emit({ type: 'ready', version: '3.13.2' });
    await startup;
    await assert.rejects(engine[operation]('  \n'), { code: 'EMPTY_SOURCE' });
    await assert.rejects(engine[operation]({ source: 'pass', timeoutMs: 0 }), { code: 'INVALID_TIMEOUT' });
    const pending = engine[operation]('pass');
    assert.equal(engine.getState().activeOperation, operation);
    await assert.rejects(engine.run('pass'), { code: 'BUSY' });
    await assert.rejects(engine[operation]('pass'), { code: 'BUSY' });
    const cancelled = assert.rejects(pending, { code: 'CANCELLED' });
    const recovery = engine.cancel();
    await cancelled;
    transports.at(-1).emit({ type: 'ready', version: '3.13.2' });
    await recovery;
    const timed = engine[operation]('pass', { timeoutMs: 5 });
    await assert.rejects(timed, { code: 'TIMEOUT' });
    const timeoutRecovery = engine.initialize();
    transports.at(-1).emit({ type: 'ready', version: '3.13.2' });
    await timeoutRecovery;
    const resetPending = engine[operation]('pass');
    const resetError = assert.rejects(resetPending, { code: 'RESET' });
    const reset = engine.reset();
    await resetError;
    transports.at(-1).emit({ type: 'ready', version: '3.13.2' });
    await reset;
    const disposed = engine[operation]('pass');
    const disposedError = assert.rejects(disposed, { code: 'DISPOSED' });
    engine.dispose();
    await disposedError;
    await assert.rejects(engine[operation]('pass'), { code: 'DISPOSED' });
  }
});

test('malformed analysis replies fail each public analysis operation and permit recovery', async t => {
  for (const [operation, malformed] of [
    ['compile', { tokens: {} }],
    ['inspect', { trace: { astNodes: [] }, astTree: 7 }],
    ['diagnose', { trace: { instructions: Array(LIMITS.instructionCount + 1).fill({}) } }],
  ]) {
    const { engine, transports } = await initialized(t);
    const pending = engine[operation]('pass');
    transports[0].emit(resultMessage(engine, malformed));
    await assert.rejects(pending, { code: 'RUNTIME_FAILURE' });
    assert.equal(engine.getState().status, 'initializing');
    const recovery = engine.initialize();
    transports[1].emit({ type: 'ready', version: '3.13.2' });
    await recovery;
    assert.equal(engine.ready(), true);
  }
});

test('late results and streams cannot complete a newer request', async t => {
  const { engine, transports, results } = await initialized(t);
  const first = engine.run('pass'), oldId = engine.getState().requestId;
  transports[0].emit(resultMessage(engine, { stdout: 'first' }));
  await first;
  const second = engine.run('pass');
  transports[0].emit({ type: 'result', id: oldId, stdout: 'stale' });
  transports[0].emit({ type: 'result', id: oldId, extra: 'x'.repeat(LIMITS.resultChars + 1) });
  transports[0].emit({ type: 'unknown', id: oldId, extra: 'x'.repeat(LIMITS.resultChars + 1) });
  transports[0].emit({ type: 'stream', id: oldId, stdout: 'stale' });
  assert.equal(engine.getState().status, 'running');
  transports[0].emit(resultMessage(engine, { stdout: 'second' }));
  assert.equal((await second).stdout, 'second');
  assert.deepEqual(results.map(result => result.stdout), ['first', 'second']);
});

test('stop rejects running work and old generation ready/fatal/results are discarded', async t => {
  const { engine, transports } = await initialized(t);
  const pending = engine.run('while True: pass');
  const rejection = assert.rejects(pending, { code: 'CANCELLED' }), oldId = engine.getState().requestId;
  assert.equal(engine.stop(), true);
  await rejection;
  assert.equal(transports[0].disposed, 1);
  assert.equal(engine.getState().status, 'stopped');
  const restart = engine.reset();
  transports[0].emit({ type: 'ready', version: '9.9.9' });
  transports[0].emit({ type: 'fatal', message: 'stale crash' });
  transports[0].emit({ type: 'result', id: oldId, stdout: 'stale' });
  assert.equal(engine.getState().status, 'initializing');
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await restart;
  const next = engine.run('pass');
  transports[1].emit(resultMessage(engine, { stdout: 'new runtime' }));
  assert.equal((await next).stdout, 'new runtime');
});

test('reset and dispose cancel initialization and discard subsequent ready messages', async t => {
  const { engine, transports } = fixture(t);
  const first = engine.initialize(), firstError = assert.rejects(first, { code: 'RESET' });
  const reset = engine.reset(), resetError = assert.rejects(reset, { code: 'DISPOSED' });
  await firstError;
  engine.dispose();
  await resetError;
  for (const transport of transports) transport.emit({ type: 'ready', version: '3.13.2' });
  assert.equal(engine.getState().status, 'disposed');
  assert.equal(engine.stop(), false);
  await assert.rejects(engine.initialize(), { code: 'DISPOSED' });
  await assert.rejects(engine.reset(), { code: 'DISPOSED' });
  await assert.rejects(engine.run('pass'), { code: 'DISPOSED' });
});

test('reset cancels running work and does not accept an old result', async t => {
  const { engine, transports } = await initialized(t);
  const pending = engine.inspect('pass'), cancelled = assert.rejects(pending, { code: 'RESET' });
  const reset = engine.reset();
  await cancelled;
  transports[0].emit({ type: 'result', id: 1 });
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await reset;
  assert.equal(engine.ready(), true);
});

test('execution timeout terminates runtime and starts fresh recovery', async t => {
  const errors = [];
  const { engine, transports } = await initialized(t, { onError: error => errors.push(error.code) });
  await assert.rejects(engine.run('while True: pass', { timeoutMs: 5 }), { code: 'TIMEOUT' });
  assert.equal(engine.getState().status, 'initializing');
  assert.equal(transports[0].disposed, 1);
  assert.deepEqual(errors, ['TIMEOUT']);
  await assert.rejects(engine.run('pass'), { code: 'NOT_READY' });
  const loading = engine.initialize();
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await loading;
});

test('worker failures clear packages, reject active work, and recover', async t => {
  const { engine, transports } = await initialized(t);
  const packages = engine.loadPackages(['numpy']);
  transports[0].emit({ type: 'package-result', id: engine.getState().requestId, results: [{ id: 'numpy', loaded: true }] });
  await packages;
  const pending = engine.run('pass');
  transports[0].emit({ type: 'fatal', message: 'worker crashed' });
  await assert.rejects(pending, { code: 'RUNTIME_FAILURE' });
  assert.deepEqual(engine.getState().loadedPackages, []);
  assert.equal(engine.getState().status, 'initializing');
  const recovery = engine.initialize();
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await recovery;
  assert.equal(engine.ready(), true);
});

test('multiple packages expose loading, loaded and failed states without running source', async t => {
  const { engine, transports, calls } = await initialized(t);
  const pending = engine.loadPackages(['numpy', 'sympy', 'numpy']);
  assert.deepEqual(calls.at(-1).slice(2), [['numpy', 'sympy']]);
  assert.equal(engine.getAvailablePackages().find(item => item.id === 'numpy').status, 'loading');
  await assert.rejects(engine.loadPackages(['numpy']), { code: 'BUSY' });
  transports[0].emit({ type: 'package-result', id: engine.getState().requestId,
    results: [{ id: 'numpy', loaded: true }, { id: 'sympy', error: '<b>failed</b>' }] });
  assert.equal((await pending).status, 'failed');
  assert.equal(engine.getAvailablePackages().find(item => item.id === 'numpy').status, 'loaded');
  assert.equal(engine.getAvailablePackages().find(item => item.id === 'sympy').error, '<b>failed</b>');
  assert.equal(calls.some(call => call[0] === 'run'), false);
  const count = calls.length;
  await engine.loadPackages(['numpy']);
  assert.equal(calls.length, count);
});

test('missing confirmations fail and only import-confirmed dependencies become loaded', async t => {
  const { engine, transports } = await initialized(t);
  const pending = engine.loadPackages(['pandas', 'sympy']);
  transports[0].emit({ type: 'package-result', id: engine.getState().requestId,
    results: [{ id: 'pandas', loaded: true }], loadedRuntimeNames: ['sympy'], loadedPackageIds: ['numpy', 'requests'] });
  await pending;
  assert.deepEqual(engine.getState().loadedPackages, ['numpy', 'pandas']);
  assert.equal(engine.getAvailablePackages().find(item => item.id === 'sympy').status, 'error');
  const running = engine.run('new_source = 1');
  transports[0].emit(resultMessage(engine));
  await running;
  assert.deepEqual(engine.getState().loadedPackages, ['numpy', 'pandas']);
});

test('arbitrary packages and URLs are rejected before transport', async t => {
  const { engine, calls } = await initialized(t);
  for (const request of [[], new Array(1), ['requests'], ['https://example.com/a.whl'], ['numpy', 'os'], 'numpy', [null]])
    await assert.rejects(engine.loadPackages(request), { code: 'INVALID_PACKAGES' });
  assert.equal(calls.some(call => call[0] === 'loadPackages'), false);
});

test('stop during package loading resets states and rejects late confirmations', async t => {
  const { engine, transports } = await initialized(t);
  const pending = engine.loadPackages(['numpy']), stopped = assert.rejects(pending, { code: 'CANCELLED' });
  const id = engine.getState().requestId;
  engine.stop();
  await stopped;
  transports[0].emit({ type: 'package-result', id, results: [{ id: 'numpy', loaded: true }] });
  assert.equal(engine.getAvailablePackages().every(item => item.status === 'unloaded'), true);
});

test('package timeout also resets package state', async t => {
  const { engine } = await initialized(t, { packageLoadTimeoutMs: 5 });
  await assert.rejects(engine.loadPackages(['numpy']), { code: 'TIMEOUT' });
  assert.equal(engine.getAvailablePackages().every(item => item.status === 'unloaded'), true);
});

test('worker validation bounds all artifact collections and strips unexpected fields', () => {
  const result = processWorkerResult({
    stdout: '<script>inert</script>', stderr: 1, duration: -1, errorLine: Infinity,
    tokens: Array.from({ length: 1600 }, () => ({ type: 'NAME', value: 'x'.repeat(2000), line: 1, column: 1, ignored: {} })),
    trace: {
      astNodes: Array.from({ length: 600 }, (_, i) => ({ id: 'ast-' + i, type: 'Name', fields: [], children: [], lineno: 1 })),
      codeObjects: Array.from({ length: 50 }, (_, i) => ({ id: 'co-' + i, constants: Array(250).fill('x'), ignored: {} })),
      instructions: Array.from({ length: 4500 }, (_, i) => ({ id: 'i-' + i, source: { line: 1, column: null }, arg: null })),
    },
  });
  assert.equal(result.stdout, '<script>inert</script>');
  assert.equal(result.stderr, '');
  assert.equal(result.durationMs, 0);
  assert.equal(result.errorLine, 0);
  assert.equal(result.tokens.length, 1500);
  assert.equal(result.tokens[0].value.length, 1000);
  assert.equal(result.tokens[0].ignored, undefined);
  assert.equal(result.astNodes.length, 500);
  assert.equal(result.codeObjects.length, 40);
  assert.equal(result.codeObjects[0].constants.length, 200);
  assert.equal(result.instructions.length, 4000);
  assert.equal(result.instructionsTruncated, true);
  assert.equal(result.tokensTruncated, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('run diagnostics distinguish syntax and runtime errors without inspection', () => {
  const context = { operation: 'run', filename: 'main.py', pythonVersion: '3.13.2', requestId: 1, generation: 1 };
  for (const [fields, kind] of [
    [{ error: 'SyntaxError', errorKind: 'syntax', diagnostic: 'syntax' }, 'syntax'],
    [{ error: 'NameError' }, 'runtime'],
  ]) {
    const result = createEngineResult({ ...fields, errorLine: 2 }, context);
    assert.equal(result.status, 'failed');
    assert.equal(result.exitCode, 1);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0].kind, kind);
    assert.equal(result.diagnostics[0].line, 2);
    assert.equal(Object.hasOwn(result, 'inspection'), false);
  }
  const compilation = createEngineResult({ error: 'SyntaxError', compileError: 'top-level return', errorLine: 2 },
    { ...context, operation: 'diagnose' });
  assert.equal(compilation.diagnostics[0].kind, 'compilation');
  assert.equal(JSON.parse(JSON.stringify(new PythonEngineError('cancelled', 'CANCELLED'))).code, 'CANCELLED');
});

test('synchronous and asynchronous transport failures reject and replace runtime', async t => {
  for (const asynchronous of [false, true]) {
    const { engine, transports } = await initialized(t);
    transports[0].run = () => {
      if (asynchronous) return Promise.reject(new Error('transport failed'));
      throw new Error('transport failed');
    };
    await assert.rejects(engine.run('pass'), { code: 'RUNTIME_FAILURE' });
    assert.equal(engine.getState().status, 'initializing');
    const recovery = engine.initialize();
    transports[1].emit({ type: 'ready', version: '3.13.2' });
    await recovery;
  }
});

test('WorkerClient rejects a malformed matching response and ignores an old generation', async t => {
  const { engine, transports } = await initialized(t);
  const first = engine.run('print(1)');
  const id = engine.getState().requestId;
  transports[0].emit({ type: 'result', id, operation: 'inspect', stdout: 'wrong operation' });
  await assert.rejects(first, { code: 'RUNTIME_FAILURE' });
  assert.equal(transports[0].disposed, 1);
  const recovery = engine.initialize();
  transports[0].emit({ type: 'result', id, stdout: 'late' });
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await recovery;
  const second = engine.run('print(2)');
  transports[1].emit(resultMessage(engine, { stdout: '2\n' }));
  assert.equal((await second).stdout, '2\n');
});

test('cancel replaces an active run and stale output cannot complete the next run', async t => {
  const { engine, transports, results } = await initialized(t);
  const first = engine.run('while True: pass');
  const oldId = engine.getState().requestId;
  const cancelled = assert.rejects(first, { code: 'CANCELLED' });
  const recovery = engine.cancel();
  assert.equal(engine.cancel(), recovery);
  await cancelled;
  assert.equal(transports[0].disposed, 1);
  assert.equal(engine.getState().status, 'initializing');
  transports[0].emit({ type: 'result', id: oldId, stdout: 'old' });
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await recovery;
  const second = engine.run('print("new")');
  const newId = engine.getState().requestId;
  transports[0].emit({ type: 'stream', id: oldId, stdout: 'old' });
  transports[0].emit({ type: 'result', id: oldId, stdout: 'old' });
  transports[1].emit({ type: 'result', id: oldId, stdout: 'old' });
  assert.equal(engine.getState().requestId, newId);
  assert.equal(engine.getState().status, 'running');
  transports[1].emit(resultMessage(engine, { stdout: 'new\n' }));
  assert.equal((await second).stdout, 'new\n');
  assert.deepEqual(results.map(result => result.stdout), ['new\n']);
});

test('cancel from created or ready is a no-op; cancellation during initialization replaces it', async t => {
  const { engine, transports } = fixture(t);
  assert.equal(await engine.cancel(), null);
  const first = engine.initialize();
  const interrupted = assert.rejects(first, { code: 'CANCELLED' });
  const recovery = engine.cancel();
  await interrupted;
  transports[0].emit({ type: 'ready', version: '3.13.2' });
  assert.equal(engine.getState().status, 'initializing');
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await recovery;
  const count = transports.length;
  assert.equal((await engine.cancel()).status, 'ready');
  assert.equal(transports.length, count);
  assert.equal(engine.isReady(), true);
  assert.equal(engine.isBusy(), false);
});

test('reset shares replacement, clears packages and ignores old package confirmation', async t => {
  const { engine, transports } = await initialized(t);
  const loading = engine.loadPackages(['numpy']);
  const oldId = engine.getState().requestId;
  const interrupted = assert.rejects(loading, { code: 'RESET' });
  const recovery = engine.reset();
  assert.equal(engine.reset(), recovery);
  await interrupted;
  transports[0].emit({ type: 'package-result', id: oldId, results: [{ id: 'numpy', loaded: true }] });
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await recovery;
  assert.deepEqual(engine.getState().loadedPackages, []);
  assert.equal(engine.getAvailablePackages().find(item => item.id === 'numpy').status, 'unloaded');
  const next = engine.run('print(1)');
  transports[1].emit(resultMessage(engine, { stdout: '1\n' }));
  assert.equal((await next).stdout, '1\n');
});

test('cancelling package loading clears it and ignores stale package callbacks', async t => {
  const packageCallbacks = [];
  const { engine, transports } = await initialized(t, { onPackages: value => packageCallbacks.push(value) });
  const loading = engine.loadPackages(['numpy']);
  const oldId = engine.getState().requestId;
  const interrupted = assert.rejects(loading, { code: 'CANCELLED' });
  const recovery = engine.cancel();
  await interrupted;
  transports[0].emit({ type: 'package-result', id: oldId, results: [{ id: 'numpy', loaded: true }] });
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await recovery;
  await Promise.resolve();
  assert.deepEqual(packageCallbacks, []);
  assert.equal(engine.getAvailablePackages().find(item => item.id === 'numpy').status, 'unloaded');
  assert.equal(engine.ready(), true);
});

test('timeout and Worker failure recovery reject old work and fail closed if replacement fails', async t => {
  const { engine, transports } = await initialized(t);
  const work = engine.run('while True: pass', { timeoutMs: 5 });
  const oldId = engine.getState().requestId;
  await assert.rejects(work, { code: 'TIMEOUT' });
  assert.equal(engine.getState().status, 'initializing');
  const recovery = engine.initialize();
  transports[0].emit({ type: 'result', id: oldId, stdout: 'late' });
  transports[1].emit({ type: 'fatal', message: 'replacement failed' });
  await assert.rejects(recovery, { code: 'RUNTIME_FAILURE' });
  assert.equal(engine.getState().status, 'unavailable');
  assert.equal(engine.isReady(), false);
  const reset = engine.reset();
  transports[2].emit({ type: 'ready', version: '3.13.2' });
  await reset;
  assert.equal(engine.ready(), true);
});

test('dispose during recovery is terminal, idempotent and blocks all methods', async t => {
  const { engine, transports, results } = await initialized(t);
  const work = engine.run('while True: pass');
  const interrupted = assert.rejects(work, { code: 'CANCELLED' });
  const recovery = engine.cancel();
  await interrupted;
  engine.dispose();
  engine.dispose();
  await assert.rejects(recovery, { code: 'DISPOSED' });
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  assert.equal(engine.getState().status, 'disposed');
  assert.equal(transports.length, 2);
  for (const operation of ['run', 'compile', 'inspect', 'diagnose'])
    await assert.rejects(engine[operation]('pass'), { code: 'DISPOSED' });
  for (const operation of ['initialize', 'cancel', 'reset'])
    await assert.rejects(engine[operation](), { code: 'DISPOSED' });
  await assert.rejects(engine.loadPackages(['numpy']), { code: 'DISPOSED' });
  assert.deepEqual(results, []);
});

test('initialization watchdog and Worker creation failure clean up and permit retry', async t => {
  const events = [], adapters = [];
  const client = new WorkerClient(event => events.push(event), receive => {
    const adapter = { receive, disposed: 0, initialize() {}, dispose() { this.disposed++; } };
    adapters.push(adapter);
    return adapter;
  }, 5);
  t.after(() => client.stop());
  client.initialize();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(events[0].type, 'fatal');
  assert.equal(events[0].code, 'TIMEOUT');
  assert.equal(adapters[0].disposed, 1);
  client.initialize();
  adapters[0].receive({ type: 'ready', version: '9.9.9' });
  adapters[1].receive({ type: 'ready', version: '3.13.2' });
  assert.equal(events.at(-1).version, '3.13.2');

  let attempts = 0;
  const engine = createPythonEngine({ runtimeFactory: receive => {
    if (++attempts === 1) throw new Error('Worker creation failed');
    return { initialize() {}, dispose() {}, emit: receive, run() {}, loadPackages() {} };
  } });
  t.after(() => engine.dispose());
  await assert.rejects(engine.initialize(), { code: 'RUNTIME_FAILURE' });
  assert.equal(engine.getState().status, 'idle');
  const retry = engine.initialize();
  engine.client.runtime.emit({ type: 'ready', version: '3.13.2' });
  await retry;
});

test('engine initialization timeout is retryable and disposal suppresses queued completion callbacks', async t => {
  const { engine, transports, results } = fixture(t);
  engine.client.initializationTimeoutMs = 5;
  const startup = engine.initialize();
  await assert.rejects(startup, { code: 'TIMEOUT' });
  assert.equal(engine.getState().status, 'idle');
  assert.equal(transports[0].disposed, 1);
  engine.client.initializationTimeoutMs = 120000;
  const retry = engine.initialize();
  transports[0].emit({ type: 'ready', version: '3.13.2' });
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  await retry;
  const work = engine.run('print(1)');
  transports[1].emit(resultMessage(engine, { stdout: '1\n' }));
  engine.dispose();
  await work;
  await Promise.resolve();
  assert.deepEqual(results, []);
  assert.equal(engine.getState().status, 'disposed');
});

test('repeated timeouts each replace the adapter and reject late responses', async t => {
  const { engine, transports } = await initialized(t);
  for (let cycle = 0; cycle < 2; cycle++) {
    const work = engine.run('while True: pass', { timeoutMs: 5 });
    const old = transports.at(-1), oldId = engine.getState().requestId;
    await assert.rejects(work, { code: 'TIMEOUT' });
    const recovery = engine.initialize();
    old.emit({ type: 'result', id: oldId, stdout: 'late' });
    transports.at(-1).emit({ type: 'ready', version: '3.13.2' });
    await recovery;
    assert.equal(old.disposed, 1);
    assert.equal(engine.ready(), true);
  }
});

test('a superseded recovery rejection cannot destroy a newer reset', async t => {
  const { engine, transports } = await initialized(t);
  const work = engine.run('while True: pass');
  const cancelled = assert.rejects(work, { code: 'CANCELLED' });
  const firstRecovery = engine.cancel();
  await cancelled;
  const stoppedRecovery = assert.rejects(firstRecovery, { code: 'CANCELLED' });
  engine.stop();
  const secondRecovery = engine.reset();
  await stoppedRecovery;
  assert.equal(engine.getState().status, 'initializing');
  transports[1].emit({ type: 'ready', version: '3.13.2' });
  assert.equal(engine.getState().status, 'initializing');
  transports[2].emit({ type: 'ready', version: '3.13.2' });
  await secondRecovery;
  assert.equal(engine.ready(), true);
});

test('repeated cancel, reset and run cycles leave only the current adapter active', async t => {
  const { engine, transports } = await initialized(t);
  for (let cycle = 0; cycle < 3; cycle++) {
    const work = engine.run('while True: pass');
    const interrupted = assert.rejects(work, { code: 'CANCELLED' });
    const recovery = engine.cancel();
    await interrupted;
    transports.at(-1).emit({ type: 'ready', version: '3.13.2' });
    await recovery;
    const next = engine.run('print(1)');
    transports.at(-1).emit(resultMessage(engine, { stdout: '1\n' }));
    await next;
    const reset = engine.reset();
    transports.at(-1).emit({ type: 'ready', version: '3.13.2' });
    await reset;
    assert.equal(engine.client.pending.size, 0);
    assert.equal(engine.ready(), true);
  }
  assert(transports.slice(0, -1).every(adapter => adapter.disposed === 1));
});

test('CSP, iframe isolation and absent JS bridges remain in production sources', async () => {
  const [sandbox, runtime, worker] = await Promise.all(['sandbox.html', 'runtime.js', 'worker.js']
    .map(name => readFile(new URL('../runtime/' + name, import.meta.url), 'utf8')));
  assert.match(sandbox, /connect-src 'none'/);
  assert.match(sandbox, /default-src 'none'/);
  assert.match(runtime, /setAttribute\('sandbox', 'allow-scripts'\)/);
  assert.doesNotMatch(runtime, /allow-same-origin/);
  assert.match(worker, /jsglobals: Object.freeze\(Object.create\(null\)\)/);
  assert.match(worker, /unregisterJsModule\('pyodide_js'\)/);
  assert.match(worker, /if \(!responses.has\(url\)\) throw/);
  assert.match(sandbox, /worker\?\.terminate\(\)/);
  assert.match(sandbox, /data.type === 'run' \|\| data.type === 'analysis'/);
  assert.match(sandbox, /request.operation = data.operation/);
});

test('engine modules have no editor, application or rendering dependencies', async () => {
  for (const name of await readdir(new URL('../python-engine/', import.meta.url))) {
    if (!name.endsWith('.js')) continue;
    const text = await readFile(new URL('../python-engine/' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /from ['"][^'"]*(?:ui\/|editor\/|controller|app\.js|view\.js)/);
    assert.doesNotMatch(text, /\b(?:document|CodeMirror|HTMLElement)\b/);
  }
});
