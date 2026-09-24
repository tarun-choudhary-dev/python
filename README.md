# PYLAB Python Engine

A reusable browser Python engine built on **Pyodide 0.29.3 / CPython**. It executes Python, compiles without execution, returns diagnostics, and exposes real tokens, AST nodes, code objects, instructions, bytecode and disassembly.

This repository now contains the engine itself. The former PYLAB editor, themes, menus, snapshots, Compare, Trace navigation and CodeMirror have been removed. There is no application page or backend. Consumers provide their own interface.

## Use it from a browser application

Serve this repository or the contents of `dist/` over HTTP(S), preserving the directory structure. Import the root module after the browser document has a body:

~~~js
import { createPythonEngine } from '/python-engine/index.js';

const python = createPythonEngine({
  onStdout: chunk => console.log(chunk),
  onStderr: chunk => console.error(chunk),
});

try {
  await python.initialize();

  const result = await python.run({
    source: "print('hello')",
    filename: 'main.py',
  });
  console.log(result.stdout); // "hello\n"

  const compiled = await python.compile('x = 10 * 5');
  console.log(compiled.inspection.disassembly);

  const diagnostics = await python.diagnose('return 1');
  console.log(diagnostics.diagnostics);
} finally {
  python.dispose();
}
~~~

Here `/python-engine/` is the URL where the **whole distribution** is mounted. At the repository root, use `./index.js`.

The API contains no editor, DOM rendering, CSS or application state. Its browser transport creates one hidden sandbox iframe internally; this is required for isolation. Execution requires a browser document, workers, WebAssembly, MessageChannel and fetch. It is not a Node.js Python runtime or a worker-only host API.

[Full API, lifecycle, result schema and capability documentation](python-engine/README.md).

## Architecture

~~~text
Consumer application / future IDE
              |
          index.js
              |
        PythonEngine
  lifecycle, promises, limits,
  validation, packages, events
              |
       PyodideRuntime
  fixed asset downloads + channel
              |
  opaque-origin sandboxed iframe
              |
       isolated Web Worker
              |
        Pyodide 0.29.3
              |
      CPython + executor.py
          | optional analysis
        inspector.py
~~~

`run` compiles and executes directly through `executor.py`; it does not load or produce tokens, AST, code-object metadata, bytecode or disassembly. `compile`, `inspect` and `diagnose` load `inspector.py` on demand and never execute source. Compilation returns serializable metadata, not a live code object, executable handle or transferable CPython bytecode format. Inspection locations are authentic CPython positions.

There is one runtime implementation. The engine and runtime modules separate lifecycle/data validation from browser isolation and CPython execution. They have no dependency on the removed PYLAB application.

~~~text
index.js                   Public entry point
python-engine/
  index.js                 Factory and public exports
  engine.js                Lifecycle, requests, events, package state
  protocol.js              Capabilities, request validation, errors
  result.js                Defensive worker-result validation
  README.md                API contract
runtime/
  config.js                Pinned runtime and limits
  assets.js                Fixed host-side asset downloads
  packages.js              Curated package metadata
  runtime.js               Opaque iframe and MessageChannel adapter
  sandbox.html             Restrictive CSP and worker termination
  worker.js                Pyodide operations and streaming
  executor.py              Direct CPython execution and errors
  inspector.py             Optional CPython compiler inspection
scripts/                   Static asset server and distribution build
tests/                     Unit and real browser/runtime tests
~~~

## Curated packages

~~~js
await python.initialize();
const loaded = await python.loadPackages(['numpy', 'sympy']);
if (loaded.status === 'completed') {
  const result = await python.run(
    'import numpy as np\nprint(np.array([1, 2, 3]).mean())'
  );
  console.log(result.stdout); // "2.0\n"
}
console.log(python.getAvailablePackages());
~~~

The catalog is exactly:

| Name | API / Pyodide ID | Python import |
| --- | --- | --- |
| NumPy | numpy | numpy |
| Pandas | pandas | pandas |
| Matplotlib | matplotlib | matplotlib |
| SciPy | scipy | scipy |
| SymPy | sympy | sympy |
| Scikit-learn | scikit-learn | sklearn |
| NetworkX | networkx | networkx |
| BeautifulSoup4 | beautifulsoup4 | bs4 |
| Pillow | pillow | PIL |

The host downloads only selected packages' archives and dependencies from the pinned Pyodide lockfile. The worker uses Pyodide's package loader against a fixed in-memory asset map, then verifies Python imports. No arbitrary package, URL, PyPI or pip API is exposed. Matplotlib can perform noninteractive operations; the engine does not provide a plot renderer or image-display bridge.

Packages persist between normal operations. Stop, timeout, reset, disposal and fatal failure destroy the interpreter and clear package state. Initialization does not automatically reload packages. Source changes are the caller's concern and do not unload packages.

## Security and limits

The existing security boundary is retained:

- The runtime iframe uses `sandbox="allow-scripts"` with an opaque origin.
- Its worker inherits restrictive CSP, including `connect-src 'none'`.
- Python cannot use browser fetch, DOM, host window or the public JavaScript runtime bridge.
- Runtime and package assets are fetched by the host from the pinned CDN; the worker's replacement fetch has only a fixed in-memory asset map and no network fallback.
- Python has a virtual in-memory filesystem, not access to the host filesystem.
- Source, output and inspection artifacts are bounded. The execution watchdog terminates the sandbox, including an infinite loop.
- Operation IDs and runtime generations reject stale streams, results, package confirmations and lifecycle messages.
- Worker messages are untrusted and sanitized before they reach consumers. Consumers must render strings as inert text.

Default execution/analysis timeout is 15 seconds; package loading and runtime loading allow 120 seconds. Source is limited to 100,000 JavaScript characters, stdout/stderr share a 100,000-character budget, and compiler artifacts are bounded to 1,500 tokens, 500 AST nodes, 40 code objects and 4,000 instructions. See the API contract for details.

Normal runs use fresh user globals but share the interpreter's modules and virtual filesystem. Use `reset()` when those must be discarded. CPython introspection and Pyodide are not themselves a hostile-code sandbox; the browser isolation is the security boundary. Browsers do not offer a portable hard memory quota for workers, so extreme allocation can still exhaust a tab. Deploy on an origin without sensitive same-origin services and preserve the sandbox/CSP.

The host must permit its local module/runtime assets and downloads from `https://cdn.jsdelivr.net/pyodide/v0.29.3/full/`, and allow the local sandbox iframe. Serve `runtime/sandbox.html` intact; do not give it same-origin sandbox privileges or relax its CSP. No credentials or user source are sent to the CDN. Initial startup needs download access; assets are cached in page memory across resets, not persisted by this engine.

## Build and test

Node.js 22+ is used only for development/build/test tooling; there are no npm dependencies.

~~~sh
npm test
npm run build
npm run test:runtime -- --built
~~~

`test:runtime` starts a temporary static server and headless Chromium and exercises the real opaque iframe, worker and CPython. With `--built`, its public API tests import `dist/index.js`; without it, they import the source entry. Set `CHROME_PATH` if Chrome/Edge is not in a detected location. Runtime/package download access is required. It retains the existing runtime regression suite and adds public engine API tests; UI-specific tests were removed along with the UI.

`build` recreates the generated `dist/` directory with the root entry, engine modules, runtime assets and documentation. It deliberately has no `index.html`. Mount these assets in the consumer application and import `index.js`. Keep companion assets beside the modules; bundlers must copy the worker, executor, optional inspector and sandbox without changing their relative URLs.

`npm run dev` serves source assets on `http://127.0.0.1:4173/index.js`. The blank `tests/harness.html` is only a browser test fixture. CI runs tests and builds the engine; the former automatic application deployment is removed.

The original repository license is retained. See [THIRD_PARTY.md](THIRD_PARTY.md) for runtime licenses.
