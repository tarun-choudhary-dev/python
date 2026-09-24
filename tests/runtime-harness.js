import { PyodideRuntime } from '../runtime/runtime.js';

/** Exercise the production sandbox/worker/CPython path without browser UI automation. */
export async function runRuntimeTests() {
  const checks = [];
  let resolveMessage, rejectMessage, expectedType, expectedId, id = 0, packageRequestId = 0;
  const runtime = new PyodideRuntime(message => {
    if (message.type === 'fatal' && expectedType !== 'fatal') rejectMessage?.(new Error(message.message));
    else if (message.type === expectedType && (expectedId === undefined || message.id === expectedId)) resolveMessage?.(message);
  });
  function wait(type, messageId) {
    expectedType = type; expectedId = messageId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), type === 'ready' || type === 'package-result' ? 180000 : 10000);
      resolveMessage = result => { clearTimeout(timer); resolve(result); };
      rejectMessage = error => { clearTimeout(timer); reject(error); };
    });
  }
  function assert(condition, name) { if (!condition) throw new Error(name); checks.push(name); }
  async function run(source) { const result = wait('result', ++id); runtime.run(id, source); return result; }
  async function loadPackages(packageIds) {
    const result = wait('package-result', ++packageRequestId);
    runtime.loadPackages(packageRequestId, packageIds);
    return result;
  }
  try {
    const originalFetch = window.fetch;
    window.fetch = async () => { throw new Error('Simulated runtime download failure'); };
    const failure = wait('fatal'); runtime.initialize();
    const failed = await failure;
    window.fetch = originalFetch;
    assert(failed.message.includes('Simulated runtime download failure'), 'runtime download failure is readable and retryable');
    const ready = wait('ready'); runtime.initialize();
    const info = await ready;
    assert(/^3\./.test(info.version), `CPython ${info.version} loaded in sandboxed browser worker`);
    let r = await run('import numpy');
    assert(r.error.includes('ModuleNotFoundError'), 'curated packages are not implicitly available before loading');
    let packages = await loadPackages(['numpy', 'sympy']);
    assert(packages.results.find(item => item.id === 'numpy')?.loaded === true && packages.results.find(item => item.id === 'sympy')?.loaded === true,
      'multiple curated packages are confirmed by the runtime');
    r = await run('import numpy as np\nx = np.array([1, 2, 3])\nprint(x.mean())');
    assert(r.stdout === '2.0\n' && !r.error, 'loaded NumPy imports and executes');
    r = await run('import sympy\nx = sympy.Symbol("x")\nprint(x + 1)');
    assert(r.stdout === 'x + 1\n' && !r.error, 'loaded SymPy and its dependency import and execute');
    const remainingPackages = ['pandas', 'matplotlib', 'scipy', 'scikit-learn', 'networkx', 'beautifulsoup4', 'pillow'];
    packages = await loadPackages(remainingPackages);
    assert(remainingPackages.every(packageId => packages.results.find(item => item.id === packageId)?.loaded === true),
      'all remaining curated packages are confirmed by the pinned runtime');
    r = await run(`import pandas as pd
import numpy as np
from matplotlib.colors import to_hex
from scipy.linalg import det
from sklearn.preprocessing import StandardScaler
import networkx as nx
from bs4 import BeautifulSoup
from PIL import Image
print(pd.Series([1, 2]).sum())
print(to_hex((1, 0, 0)))
print(det(np.eye(2)))
print(StandardScaler().fit_transform([[1.0], [3.0]]).ravel().tolist())
graph = nx.Graph([(1, 2), (2, 3)])
print(nx.shortest_path(graph, 1, 3))
print(BeautifulSoup("<b>x</b>", "html.parser").b.text)
print(Image.new("RGB", (1, 1), "red").getpixel((0, 0)))`);
    assert(r.stdout === '3\n#ff0000\n1.0\n[-1.0, 1.0]\n[1, 2, 3]\nx\n(255, 0, 0)\n' && !r.error,
      'Pandas, Matplotlib, SciPy, Scikit-learn, NetworkX, BeautifulSoup4, and Pillow import and execute');
    r = await run('print("Hello")\nx = 10\nprint(x * 5)');
    assert(r.stdout === 'Hello\n50\n' && !r.error, 'stdout is exact');
    assert(r.bytecode.includes('Bytecode bytes') && r.bytecode.includes('Constants'), 'real bytecode metadata');
    assert(r.disassembly.includes('LOAD_CONST') && r.disassembly.includes('STORE_NAME'), 'real CPython disassembly');
    r = await run('print("α🙂", end="")'); assert(r.stdout === 'α🙂', 'Unicode and no trailing newline');
    r = await run('import sys\nsys.stderr.write("diagnostic\\n")'); assert(r.stderr === 'diagnostic\n' && !r.error, 'stderr is separate');
    for (const [source, error] of [['def :', 'SyntaxError'], ['print(missing_name)', 'NameError'], ['1 + "a"', 'TypeError'], ['import no_such_pylab_module', 'ModuleNotFoundError'], ['1 / 0', 'ZeroDivisionError']]) {
      r = await run(source); assert(r.error.includes(error) && r.errorLine === 1, `${error} traceback and source line`);
      if (error === 'SyntaxError') assert(!r.bytecode && !r.disassembly, 'syntax errors have no compiled results');
    }
    r = await run('print("before")\nraise ValueError("after")'); assert(r.stdout === 'before\n' && r.error.includes('ValueError'), 'output survives a runtime exception');
    r = await run('def double(x):\n    return x * 2\nprint(double(4))');
    assert(r.stdout === '8\n' && r.bytecode.includes('CODE OBJECT: double') && r.disassembly.includes('Disassembly of'), 'nested code objects are inspected');
    await run('temporary_name = 99'); r = await run('print(temporary_name)'); assert(r.error.includes('NameError'), 'fresh global namespace for every run');
    r = await run('import math\nprint(math.sqrt(81))'); assert(r.stdout === '9.0\n', 'bundled standard library');
    r = await run('input("Name: ")'); assert(r.error.includes('EOFError'), 'unsupported interactive input produces a readable error');
    r = await run('from js import fetch'); assert(r.error.includes('ImportError'), 'Python receives no fetch bridge');
    r = await run('from js import eval'); assert(r.error.includes('ImportError'), 'Python receives no JavaScript eval bridge');
    r = await run('import pyodide_js'); assert(r.error.includes('ModuleNotFoundError'), 'public runtime bridge is removed');
    r = await run('print("x" * 200000)'); assert(r.stdout.length <= 100000 && r.truncated, 'output floods are bounded');
    r = await run('print("<script>alert(1)</script>")'); assert(r.stdout.startsWith('<script>'), 'HTML remains output text');
    runtime.run(++id, 'while True:\n    pass');
    await new Promise(resolve => setTimeout(resolve, 150));
    const reset = wait('ready'); runtime.initialize(); await reset;
    r = await run('print("recovered")'); assert(r.stdout === 'recovered\n', 'infinite worker can be stopped and reset');
    r = await run('import numpy'); assert(r.error.includes('ModuleNotFoundError'), 'runtime reset removes previously loaded packages');
    const phaseOneCount = checks.length;

    r = await run('x = 10\nprint(x * 2)');
    const xToken = r.tokens.find(item => item.type === 'NAME' && item.value === 'x');
    assert(xToken?.line === 1 && xToken?.column === 1 && r.tokens.some(item => item.type === 'NUMBER' && item.value === '10'), 'token types, values and one-based positions come from tokenize');
    assert(r.tokens.some(item => item.type === 'OP' && item.value === '*') && r.tokens.some(item => item.type === 'NAME' && item.value === 'print'), 'operator and callable tokens are structured');
    assert(r.astTree.startsWith('Module\n') && r.astTree.includes('Assign') && r.astTree.includes('Call') && r.astTree.includes('BinOp'), 'actual AST tree has expected nodes');
    assert(r.astDump.includes('Module(') && r.astDump.includes('Constant(value=10)'), 'actual ast.dump is available');
    assert(r.codeObject.includes('CPYTHON CODE OBJECT') && r.codeObject.includes('co_name: <module>') && r.codeObject.includes('co_filename: main.py'), 'compiled code object identity and filename');
    assert(r.codeObject.includes('co_argcount: 0') && r.codeObject.includes('co_nlocals: 0') && r.codeObject.includes('co_stacksize:') && r.codeObject.includes('co_flags:') && r.codeObject.includes('co_consts:') && r.codeObject.includes('co_names:') && r.codeObject.includes('co_varnames:') && r.codeObject.includes('bytecode length:'), 'code object metadata fields');
    assert(r.bytecode.includes('Offset') && r.bytecode.includes('Opcode') && r.bytecode.includes('Argument') && r.bytecode.includes('LOAD_CONST') && r.bytecode.includes('Bytecode bytes') && /\b[0-9a-f]{2} [0-9a-f]{2}\b/.test(r.bytecode), 'decoded opcodes and raw hexadecimal bytes coexist');

    r = await run('def double(value):\n    return value * 2\nclass Thing:\n    def size(self):\n        return 3\nprint(double(4))');
    assert(r.stdout === '8\n' && r.astTree.includes('FunctionDef (name=\'double\')') && r.astTree.includes('ClassDef (name=\'Thing\')'), 'nested function and class AST');
    assert(r.codeObject.includes('CPYTHON CODE OBJECT: double') && r.codeObject.includes('co_argcount: 1') && r.codeObject.includes('CPYTHON CODE OBJECT: Thing'), 'nested code object metadata');
    assert(r.bytecode.includes('CODE OBJECT: double') && r.bytecode.includes('CODE OBJECT: Thing') && r.disassembly.includes('Disassembly of'), 'nested bytecode and disassembly remain available');

    r = await run('total = 0\nfor i in range(3):\n    total += i\nprint(total)');
    assert(r.stdout === '3\n' && r.astTree.includes('For') && r.bytecode.includes('FOR_ITER'), 'loops appear through AST, bytecode and execution');
    r = await run('import math\nprint(math.factorial(4))');
    assert(r.stdout === '24\n' && r.astTree.includes('Import') && r.codeObject.includes('math') && r.bytecode.includes('IMPORT_NAME'), 'standard-library imports traverse the pipeline');
    r = await run('café = "λ🙂"\nprint(café)');
    assert(r.stdout === 'λ🙂\n' && r.tokens.some(item => item.value === 'café') && r.tokens.some(item => item.type === 'STRING' && item.value === '"λ🙂"') && r.astDump.includes('café'), 'Unicode identifiers and strings survive each stage');

    r = await run('print(');
    assert(r.tokens.some(item => item.value === 'print') && r.tokenError.includes('SYNTAX ERROR'), 'incomplete expression retains partial tokens and a tokenization error');
    assert(r.astError.startsWith('SYNTAX ERROR') && r.compileError.startsWith('SYNTAX ERROR') && !r.codeObject && !r.bytecode && !r.disassembly && r.error.includes('SyntaxError'), 'invalid source gives useful syntax errors in every later stage');
    r = await run('x =');
    assert(r.tokens.some(item => item.value === 'x') && r.astError.includes('SyntaxError') && !r.codeObject, 'parse error after successful tokenization');
    r = await run('return 1');
    assert(r.astTree.includes('Return') && r.compileError.includes('SYNTAX ERROR') && !r.bytecode, 'valid AST with invalid top-level return cannot produce code object');
    r = await run('print("before")\nraise ValueError("after")');
    assert(r.stdout === 'before\n' && r.astTree.includes('Raise') && r.codeObject && r.bytecode && r.disassembly && r.error.includes('ValueError'), 'runtime error preserves all completed inspection stages');
    r = await run('print("clean")');
    assert(r.stdout === 'clean\n' && !r.astError && !r.compileError && !r.tokenError && r.astTree, 'subsequent run clears prior syntax errors');
    r = await run('a = 1\n'.repeat(600));
    assert(r.tokens.length === 1500 && r.tokensTruncated, 'large token streams are bounded');

    r = await run('x = 10\ny = 20\nz = x + y\nprint(z)');
    assert(r.tokens.find(t => t.value === '10').endLine === 1 && r.tokens.find(t => t.value === '10').endColumn === 7, 'token end positions are retained');
    assert(r.trace.astNodes.some(n => n.type === 'BinOp' && n.lineno === 3 && n.col_offset === 4 && n.end_lineno === 3 && n.end_col_offset === 9), 'AST nodes retain CPython source byte ranges');
    assert(r.trace.astNodes.every((n, index) => n.id === `ast-${index}`) && r.trace.astNodes.length <= 500, 'AST node IDs remain stable and bounded');
    assert(r.trace.codeObjects[0].name === '<module>' && r.trace.instructions.some(i => i.opcode === 'BINARY_OP' && i.source?.line === 3), 'compiled instructions retain code object and source positions');
    assert([1,2,3,4].every(line => r.trace.instructions.some(i => i.source?.line === line)), 'four source statements have separately traceable instructions');
    assert(r.trace.instructions.filter(i => i.source?.line === 3).length > 1, 'multiple instructions legitimately share one source line');
    assert(r.trace.instructions.every(i => i.source === null || Number.isInteger(i.source.line)), 'missing instruction locations are explicitly null');
    r = await run('def add(a, b):\n    return a + b\nresult = add(2, 3)\nprint(result)');
    const functionCode = r.trace.codeObjects.find(c => c.name === 'add');
    assert(functionCode?.argcount === 2 && Number.isInteger(functionCode.stacksize) && Number.isInteger(functionCode.bytecodeLength) && Array.isArray(functionCode.constants) && Array.isArray(functionCode.varnames), 'structured code-object comparison metadata comes from CPython');
    assert(functionCode?.parentId === 'co-0' && r.trace.instructions.some(i => i.codeId === functionCode.id && i.source?.line === 2 && i.opcode === 'BINARY_OP'), 'function instructions retain distinct nested code context');
    r = await run('for i in range(5):\n    if i % 2 == 0:\n        print(i)');
    assert(r.trace.astNodes.some(n => n.type === 'For') && r.trace.astNodes.some(n => n.type === 'If') && r.trace.instructions.filter(i => i.source?.line === 2).length > 1, 'loops and conditions map many instructions to a line');
    r = await run('def hello(');
    assert(r.tokens.length > 0 && r.trace.astNodes.length === 0 && r.trace.instructions.length === 0 && r.error.includes('SyntaxError'), 'invalid syntax preserves token ranges but no later mappings');
    r = await run('café = "🙂"\nprint(café)');
    assert(r.trace.astNodes.some(n => n.type === 'Constant' && n.lineno === 1 && n.col_offset === 8 && n.end_col_offset === 14) &&
      r.trace.instructions.some(i => i.opcode === 'LOAD_CONST' && i.source?.column === 8 && i.source?.endColumn === 14), 'real Unicode AST and instruction columns use UTF-8 byte offsets');
    r = await run('a = 1\n'.repeat(600));
    assert(r.trace.astNodes.length <= 500 && r.trace.codeObjects.length <= 40 && r.trace.instructions.length <= 4000, 'long source respects all inspection mapping bounds');

    r = await run('x = 10 * 5\nprint(x)');
    const binOp = r.trace.astNodes.find(n => n.type === 'BinOp');
    assert(binOp?.fields.some(field => field.name === 'operator' && field.value === 'Mult'), 'AST detail records the real multiplication operator');
    assert(binOp.children.map(id => r.trace.astNodes.find(n => n.id === id)?.type).filter(type => type === 'Constant').length === 2, 'AST detail exposes bounded child node IDs');
    assert(binOp.children.every(id => r.trace.astNodes.some(n => n.id === id && n.parentId === binOp.id)), 'AST child links are stable across worker serialization');
    assert(r.trace.astNodes.length <= 500 && r.trace.astNodes.every(n => n.fields.length <= 8), 'AST detail metadata preserves inspection bounds');

    return { passed: checks.length, existing: phaseOneCount, new: checks.length - phaseOneCount, checks, version: info.version };
  } finally { runtime.dispose(); }
}
