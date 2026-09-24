/** Public API integration tests: a blank host page, no PYLAB application code. */
export async function runEngineTests(entry = new URL('../index.js', import.meta.url).href) {
  const { createPythonEngine } = await import(entry);
  const checks = [], states = [], completed = [];
  let stdout = '', stderr = '';
  const engine = createPythonEngine({
    onStdout: chunk => { stdout += chunk; },
    onStderr: chunk => { stderr += chunk; },
    onStatus: state => states.push(state.status),
    onResult: result => completed.push(result),
  });
  function assert(condition, name) { if (!condition) throw new Error(name); checks.push(name); }
  async function rejects(promise, code) {
    try { await promise; } catch (error) {
      assert(error.code === code, 'API rejection: ' + code);
      return error;
    }
    throw new Error('Expected API rejection: ' + code);
  }
  async function run(source, options) {
    stdout = ''; stderr = '';
    const result = await engine.run(source, options);
    assert(stdout === result.stdout && stderr === result.stderr, 'stream chunks equal final stdout/stderr');
    return result;
  }
  try {
    assert(!engine.ready() && engine.getState().status === 'idle', 'engine starts idle');
    const info = await engine.initialize();
    assert(engine.ready() && /^3\./.test(info.pythonVersion) && info.version === '0.29.3', 'initialize confirms pinned runtime');
    assert(document.body.children.length === 1 && document.body.children[0].tagName === 'IFRAME',
      'the engine creates only its hidden sandbox, without an application UI');
    const frame = document.querySelector('iframe');
    assert(frame.hidden && frame.getAttribute('sandbox') === 'allow-scripts' && frame.contentDocument === null,
      'runtime iframe is hidden and opaque-origin');
    assert(engine.capabilities.compile && engine.capabilities.inspect && engine.capabilities.streamingOutput,
      'capabilities are available to API consumers');

    let result = await run('print("hello")');
    assert(result.stdout === 'hello\n' && result.status === 'completed' && result.exitCode === 0, 'run returns captured output and completion status');
    assert(!Object.hasOwn(result, 'inspection'), 'run result contains no compiler inspection artifacts');
    assert(JSON.stringify(JSON.parse(JSON.stringify(result))) === JSON.stringify(result), 'result is JSON serializable');
    result = await run('print("α🙂", end="")');
    assert(result.stdout === 'α🙂', 'Unicode and output without trailing newline');
    result = await run('import sys\nprint("out")\nsys.stderr.write("err\\n")');
    assert(result.stdout === 'out\n' && result.stderr === 'err\n' && !result.error, 'stdout and stderr are separate');
    result = await run('print("before")\nraise ValueError("after")', { filename: 'project/example.py' });
    assert(result.stdout === 'before\n' && result.status === 'failed' && result.error.includes('ValueError') &&
      result.error.includes('project/example.py') && result.diagnostics[0].kind === 'runtime' && result.errorLine === 2,
      'runtime exceptions preserve output and synthetic source location');
    result = await run('def :');
    assert(result.status === 'failed' && result.diagnostics.some(item => item.kind === 'syntax') &&
      result.errorLine === 1 && !Object.hasOwn(result, 'inspection'), 'syntax errors do not produce inspection artifacts');
    await rejects(engine.run('  \n'), 'EMPTY_SOURCE');
    assert(engine.ready(), 'invalid input does not destroy the runtime');

    for (const operation of ['compile', 'inspect', 'diagnose']) {
      result = await engine[operation]({ source: 'print("must not execute")\nraise RuntimeError("no")', filename: 'analysis.py' });
      assert(result.status === 'completed' && !result.stdout && !result.stderr && !result.error &&
        result.operation === operation && result.inspection.codeObjectText.includes('co_filename: analysis.py'),
        operation + ' uses CPython but does not execute user source');
    }
    result = await engine.compile('import definitely_missing_package');
    assert(result.status === 'completed', 'compile does not execute imports');
    result = await engine.diagnose('return 1');
    assert(result.diagnostics.some(item => item.kind === 'compilation' && item.line === 1) &&
      !result.inspection.bytecode, 'diagnose distinguishes compilation failure from parsing');
    result = await engine.diagnose('print(');
    assert(result.diagnostics.some(item => item.kind === 'syntax') &&
      result.inspection.tokens.some(item => item.value === 'print'), 'diagnose preserves partial tokens on syntax failure');
    result = await engine.inspect('café = "🙂"\nprint(café)');
    assert(result.inspection.ast.nodes.some(node => node.type === 'Constant' && node.col_offset === 8 && node.end_col_offset === 14) &&
      result.inspection.instructions.some(item => item.source?.column === 8 && item.source?.endColumn === 14),
      'raw CPython UTF-8 source positions survive the engine boundary');
    result = await engine.inspect('value = 1\n'.repeat(600));
    assert(result.inspection.tokens.length <= 1500 && result.inspection.ast.nodes.length <= 500 &&
      result.inspection.codeObjects.length <= 40 && result.inspection.instructions.length <= 4000 &&
      result.inspection.tokensTruncated, 'inspection artifacts remain bounded');
    await run('temporary_name = 99');
    result = await run('print(temporary_name)');
    assert(result.error.includes('NameError') && !Object.hasOwn(result, 'inspection'),
      'each run has fresh user globals and remains inspection-free after analysis');
    result = await run('print("x" * 200000)');
    assert(result.stdout.length + result.stderr.length <= 100000 && result.outputTruncated, 'execution output stays within shared limit');

    for (const name of ['window', 'document', 'fetch', 'eval', 'XMLHttpRequest']) {
      result = await run('from js import ' + name);
      assert(result.error?.includes('ImportError'), 'Python has no browser bridge: ' + name);
    }
    result = await run('import pyodide_js');
    assert(result.error?.includes('ModuleNotFoundError'), 'public JavaScript runtime bridge stays removed');
    result = await run('import urllib.request\nurllib.request.urlopen("https://example.com/engine-test")');
    assert(result.status === 'failed', 'Python HTTP access is unavailable');
    result = await run('import os\nprint(os.path.exists("C:/Users"))');
    assert(result.stdout === 'False\n', 'Python filesystem is virtual and cannot see host paths');
    result = await run('input("Name: ")');
    assert(result.error?.includes('EOFError'), 'interactive input remains unsupported');

    result = await run('import numpy');
    assert(result.error?.includes('ModuleNotFoundError'), 'package import fails before explicit loading');
    const packagePromise = engine.loadPackages(['numpy', 'sympy']);
    assert(engine.getState().status === 'loading-packages' &&
      engine.getAvailablePackages().find(item => item.id === 'numpy').status === 'loading', 'API exposes package loading state');
    await rejects(engine.loadPackages(['numpy']), 'BUSY');
    const packages = await packagePromise;
    assert(packages.status === 'completed' && packages.loadedPackages.includes('numpy') && packages.loadedPackages.includes('sympy'),
      'curated packages and dependencies load through the public API');
    result = await run('import numpy as np\nx = np.array([1, 2, 3])\nprint(x.mean())');
    assert(result.stdout === '2.0\n' && !result.error, 'NumPy integration computes mean');
    result = await run('import sympy\nx = sympy.Symbol("x")\nprint(x + 1)');
    assert(result.stdout === 'x + 1\n' && !result.error, 'SymPy integration works with its dependency');
    await rejects(engine.loadPackages(['requests']), 'INVALID_PACKAGES');

    const beforeResetGeneration = engine.getState().generation;
    await engine.reset();
    assert(engine.ready() && engine.getState().generation > beforeResetGeneration &&
      engine.getAvailablePackages().every(item => item.status === 'unloaded'), 'reset changes generation and unloads packages');
    result = await run('import numpy');
    assert(result.error?.includes('ModuleNotFoundError'), 'reset destroys the loaded interpreter');
    const loading = engine.loadPackages(['pandas']);
    const loadingCancelled = rejects(loading, 'CANCELLED');
    engine.stop();
    await loadingCancelled;
    assert(engine.getAvailablePackages().every(item => item.status === 'unloaded'), 'Stop during package loading clears states');
    await engine.reset();

    const infinite = engine.run('print("started", flush=True)\nwhile True:\n    pass');
    const cancelled = rejects(infinite, 'CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 120));
    assert(engine.stop(), 'Stop reports an active operation');
    await cancelled;
    assert(engine.getState().status === 'stopped' && !document.querySelector('iframe'), 'Stop removes the running sandbox');
    await engine.reset();
    result = await run('print("after stop")');
    assert(result.stdout === 'after stop\n', 'execution recovers after Stop and reset');

    await rejects(engine.run('while True:\n    pass', { timeoutMs: 100 }), 'TIMEOUT');
    assert(engine.getState().status === 'stopped' && !document.querySelector('iframe'), 'timeout terminates the sandbox');
    await engine.initialize();
    result = await run('print("after timeout")');
    assert(result.stdout === 'after timeout\n', 'execution recovers after timeout');
    assert(states.includes('running') && states.includes('compiling') && states.includes('inspecting') &&
      states.includes('diagnosing') && states.includes('loading-packages') && states.includes('stopped'),
      'status callbacks describe lifecycle transitions');
    assert(completed.every(result => result.operation && result.requestId), 'result callbacks include operation identity');
    engine.dispose();
    assert(engine.getState().status === 'disposed' && !document.querySelector('iframe'), 'dispose removes the interpreter');
    await rejects(engine.initialize(), 'DISPOSED');
    return { passed: checks.length, checks, runtime: info };
  } finally { engine.dispose(); }
}
