# PYLAB Python Engine

A reusable browser Python engine built on **Pyodide 0.29.3 / CPython**. It executes Python, compiles without execution, returns diagnostics, and exposes real tokens, AST nodes, code objects, instructions, bytecode and disassembly.

This repository now contains the engine itself. The former PYLAB editor, themes, menus, snapshots, Compare, Trace navigation and CodeMirror have been removed. There is no application page or backend. Consumers provide their own interface.

## Use it from a browser application

Serve the contents of `dist/` over HTTP(S), preserving its directory structure. Import the root module after the browser document has a body:

~~~js
import { PythonEngine } from '/python-engine/index.js';

const python = new PythonEngine();

try {
  await python.initialize();
  const result = await python.run({ source: 'print("Hello, Python")' });
  console.log(result.stdout); // "Hello, Python\n"
  if (result.status === 'failed') console.error(result.error);
} finally {
  python.dispose();
}
~~~

Here `/python-engine/` is the URL where the **whole distribution** is mounted. At the repository root, use `./index.js`. An installed tarball exposes the bare import `pylab-python-engine` to a bundler or import map, but the application must still serve the package's companion runtime files at their relative URLs. The package is private and is not published to a registry.

Python syntax/runtime errors resolve a `status: 'failed'` result; invalid requests and engine failures reject with a coded `PythonEngineError`. `await python.cancel()` terminates active work and waits for a fresh interpreter, `await python.reset()` clears interpreter state, and `python.dispose()` is synchronous terminal cleanup. Call `inspect()`, `compile()` or `diagnose()` explicitly for compiler artifacts; `run()` does not include them. The [API guide](python-engine/README.md) covers the current result shape, packages, callbacks, limits and lifecycle.

The API contains no editor, DOM rendering, CSS or application state. Its browser transport creates one hidden sandbox iframe internally; this is required for isolation. Execution requires a browser document, workers, WebAssembly, MessageChannel and fetch. It is not a Node.js Python runtime or a worker-only host API.

[Full API, lifecycle, result schema and capability documentation](python-engine/README.md).

## Architecture

~~~text
Consumer application / future IDE
              |
          index.js
              |
        PythonEngine
  lifecycle, packages, events
              |
   request.js + WorkerClient
  validation, IDs, matching, timeouts
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
              |
  worker-result.js + result.js
  internal validation + public mapping
~~~

`run` compiles and executes directly through `executor.py`; it does not load or produce tokens, AST, code-object metadata, bytecode or disassembly. `compile`, `inspect` and `diagnose` load `inspector.py` on demand and never execute source. Compilation returns serializable metadata, not a live code object, executable handle or transferable CPython bytecode format. Inspection locations are authentic CPython positions.

There is one runtime implementation. `PythonEngine` owns public lifecycle and package state; the private WorkerClient owns request identity, matching, timeouts and transport failures. The runtime adapter retains the opaque iframe and MessageChannel. Worker responses are validated before public result mapping. These modules have no dependency on the removed PYLAB application.

~~~text
index.js                   Public entry point
python-engine/
  index.js                 Factory and public exports
  engine.js                Public lifecycle, events, package state
  worker-client.js         Private request IDs, matching and timeouts
  request.js               Source request validation
  protocol.js              Capabilities and public errors
  worker-result.js         Defensive worker-data validation
  result.js                Public result construction
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

Packages persist between normal operations. Stop, cancellation, timeout, reset, disposal and Worker failure destroy the interpreter and clear package state. Cancellation, operation timeout and recoverable Worker failure start a fresh runtime; initialization does not automatically reload packages. Source changes are the caller's concern and do not unload packages.

## Security and limits

The existing security boundary is retained:

- The runtime iframe uses `sandbox="allow-scripts"` with an opaque origin.
- Its worker inherits restrictive CSP, including `connect-src 'none'`.
- The public `js`/`pyodide_js` bridge is removed. Chromium tests confirm attempted Python imports of common DOM, network and storage APIs fail.
- Runtime and package assets are fetched by the host from the pinned CDN; the worker's replacement fetch has only a fixed in-memory asset map and no network fallback.
- Python has a virtual in-memory filesystem, not access to the host filesystem.
- Source, output, exception text and inspection artifacts are bounded. The execution watchdog terminates the sandbox, including an infinite loop.
- Operation IDs and runtime generations reject stale streams, results, package confirmations and lifecycle messages.
- Matching Worker replies are validated and size-checked before they reach consumers. Consumers must render strings as inert text.

Default execution/analysis timeout is 15 seconds; package loading and runtime loading allow 120 seconds. Source is limited to 100,000 UTF-16 code units, stdout/stderr share a 100,000-character budget, exception text is capped at 100,000 characters, and compiler artifacts are bounded to 1,500 tokens, 500 AST nodes, 40 code objects and 4,000 instructions. Matching result messages are limited to 4,000,000 serialized characters. See the API contract for details.

Normal runs use fresh user globals but share the interpreter's modules and virtual filesystem. Use `reset()` when those must be discarded. CPython introspection and Pyodide are not themselves a hostile-code sandbox; the browser isolation is the security boundary. The observed HTTP failure and bridge tests cover the tested Chromium runtime; the CSP and offline Worker fetch map are the architectural network restrictions. Browser storage is unavailable through the exposed Python API, while the Python virtual filesystem persists until reset. Browsers do not offer a portable hard memory quota for workers, so extreme allocation can still exhaust a tab. Deploy on an origin without sensitive same-origin services and preserve the sandbox/CSP.

The host must permit its local module/runtime assets and downloads from `https://cdn.jsdelivr.net/pyodide/v0.29.3/full/`, and allow the local sandbox iframe. Serve `runtime/sandbox.html` intact; do not give it same-origin sandbox privileges or relax its CSP. No credentials or user source are sent to the CDN. Initial startup needs download access; assets are cached in page memory across resets, not persisted by this engine.

## Browser and runtime compatibility

The engine needs a browser document with a body, iframes, dedicated Workers, MessageChannel, WebAssembly and fetch. Serve the source or rebuilt directory over HTTP(S) with its relative asset paths intact. The following full runtime and public API suites passed locally on Windows:

| Browser | Source entry | Rebuilt `dist/index.js` | Runtime observed |
| --- | --- | --- | --- |
| Google Chrome 153.0.8010.53 | 73 direct runtime + 149 public API checks | 73 + 149; 20 runtime/doc assets matched source byte-for-byte | Pyodide 0.29.3 / CPython 3.13.2 |
| Microsoft Edge 153.0.4234.48 | 73 + 149 | 73 + 149; same distribution parity | Pyodide 0.29.3 / CPython 3.13.2 |

These are verified environments, not a guarantee for every Chromium version. Firefox, Safari and mobile browsers have not been tested and are not claimed as supported. CI is configured to run both source and rebuilt suites with the available Chromium browser; this local validation does not report a CI run. The nine curated package IDs and their imports are part of the current API; individual package archive versions come from the Pyodide 0.29.3 lockfile. Node.js is only a build/test tool, not a Python runtime host.

## Build and test

Node.js 22+ is used only for development/build/test tooling; there are no npm dependencies.

~~~sh
npm test
npm run build
npm run test:runtime -- --built
~~~

`test:runtime` starts a temporary static server and headless Chromium and exercises the real opaque iframe, worker and CPython. With `--built`, it verifies the complete `dist/` file list, compares copied assets with source and checks the release metadata before its public API tests import `dist/index.js`; without it, they import the source entry. The direct runtime suite uses source assets in either mode. Set `CHROME_PATH` if Chrome/Edge is not in a detected location. Runtime/package download access is required. It retains the existing runtime regression suite and adds public engine API tests; UI-specific tests were removed along with the UI.

`build` recreates the generated `dist/` directory with the root entry, engine modules, runtime assets and documentation. The generated package metadata omits development scripts and their Node tooling requirement. It deliberately has no `index.html`. Mount these assets in the consumer application and import `index.js`. Keep companion assets beside the modules; bundlers must copy the worker, executor, optional inspector and sandbox without changing their relative URLs. For a local package-manager consumer, run `npm pack ./dist` and install the resulting tarball in that consumer; no registry publication is needed.

`npm run dev` serves source assets on `http://127.0.0.1:4173/index.js`. The blank `tests/harness.html` is only a browser test fixture. CI runs tests and builds the engine; the former automatic application deployment is removed.

The original repository license is retained. See [THIRD_PARTY.md](THIRD_PARTY.md) for runtime licenses.
