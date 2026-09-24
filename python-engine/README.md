# Python Engine API — protocol version 1

Import from the distribution's root `index.js`. Public exports are `createPythonEngine`, `PythonEngine`, `PythonEngineError`, `ENGINE_CAPABILITIES` and `ENGINE_PROTOCOL_VERSION`. Internal runtime modules and the test transport seam are not part of the stable contract.

## Construction

~~~js
const python = createPythonEngine({
  executionTimeoutMs: 15000,
  packageLoadTimeoutMs: 120000,
  onStdout: chunk => {},
  onStderr: chunk => {},
  onStream: stream => {},
  onStatus: state => {},
  onResult: result => {},
  onPackages: result => {},
  onError: error => {},
});
~~~

Callbacks are optional. Timeout options must be positive integers and cannot exceed the stated defaults. Invalid options throw `PythonEngineError` synchronously. Construction and module import do not access the DOM or start Python. `initialize()` requires a browser document with a body.

Each instance owns one interpreter. Independent instances have separate interpreters and share only immutable downloaded asset caches.

## Methods

| Method | Return | Behavior |
| --- | --- | --- |
| `initialize()` | `Promise<RuntimeInfo>` | Load the pinned interpreter. Concurrent initialization or recovery shares a promise. Resolves immediately if ready. Rejects `BUSY` during another operation. |
| `ready()` | boolean | True only when initialization has finished and no operation is active. |
| `isReady()` | boolean | Alias for `ready()`. |
| `isBusy()` | boolean | True while a source or package operation is active. |
| `getState()` | serializable state | Current status, ready flag, Python version, operation/request identity, generation and loaded package IDs. |
| `getRuntimeInfo()` | serializable metadata | Runtime name, Pyodide version, Python version and status. |
| `run(input, options?)` | `Promise<Result>` | Compile and execute Python directly, capturing output and errors without inspection artifacts. |
| `compile(input, options?)` | `Promise<Result>` | Run the real CPython compilation/inspection pipeline, without execution. |
| `inspect(input, options?)` | `Promise<Result>` | Return the same compiler artifacts without execution. |
| `diagnose(input, options?)` | `Promise<Result>` | Return tokenizer/parser/compiler diagnostics and available artifacts without execution. |
| `getAvailablePackages()` | array | Nine curated records with `id`, `label`, `runtimeName`, `importName`, `status`, `error`. |
| `loadPackages(ids)` | `Promise<PackageResult>` | Load curated IDs and their dependencies. Confirm imports. Does not run caller source. |
| `stop()` | boolean | Terminate the interpreter and reject pending work with `CANCELLED`. Returns whether work/initialization was active. Also releases a ready interpreter. |
| `cancel()` | `Promise<RuntimeInfo \| null>` | Reject active work with `CANCELLED`, terminate its sandbox and resolve after a fresh runtime is ready. Ready is a no-op; idle resolves `null`. |
| `reset()` | `Promise<RuntimeInfo>` | Reject pending work with `RESET`, destroy the interpreter, then initialize a fresh one. Concurrent replacement calls share a promise. |
| `dispose()` | void | Terminal cleanup. Reject pending work with `DISPOSED`. Safe to call repeatedly. |

`compile`, `inspect` and `diagnose` intentionally share the existing complete compiler pipeline. No fabricated AST, disassembly or bytecode is returned. `diagnose` does not attempt semantic inference or execute code to detect runtime errors; runtime errors appear in `run` results.

Operations are exclusive. There is no implicit queue, initialization or automatic run after loading packages. Use a separate engine instance for independent concurrent work.

## Input

Both forms are supported:

~~~js
await python.run("print('hello')", { filename: 'main.py', timeoutMs: 1000 });
await python.run({ source: "print('hello')", filename: 'main.py', timeoutMs: 1000 });
~~~

The object form supplies all request fields; a second options object is used only with string input. The same forms work for compile/inspect/diagnose.

`source` is a nonempty string, at most 100,000 JavaScript UTF-16 code units. `filename` defaults to `main.py`; it is a synthetic CPython filename used in tracebacks and code-object metadata, never a host path to open. It must contain 1–240 characters and no ASCII control characters. `timeoutMs` can override the instance default up to the 15,000 ms execution ceiling.

## Result

All four source operations resolve to this JSON-serializable base shape:

~~~js
{
  protocolVersion: 1,
  requestId: 1,             // Monotonically increasing within this instance
  generation: 1,            // Changes when the interpreter changes
  operation: 'run',         // run | compile | inspect | diagnose
  status: 'completed',      // completed | failed
  exitCode: 0,              // 0 for success, 1 for a Python/analysis error
  filename: 'main.py',
  stdout: 'hello\n',
  stderr: '',
  error: null,              // Bounded traceback/error text on failure
  errorLine: 0,             // One-based source line; 0 when absent
  durationMs: 4.5,          // Worker processing time, not initial asset loading
  outputTruncated: false,
  pythonVersion: '...',     // Reported by the actual interpreter
  runtime: { name: 'Pyodide', version: '0.29.3', pythonVersion: '...' },
  diagnostics: [
    // { kind: 'syntax', severity: 'error', message: '...', line: 1 }
  ],
}
~~~

Only `compile`, `inspect` and `diagnose` results also contain this optional analysis field:

~~~js
inspection: {
    tokens: [],
    tokensTruncated: false,
    tokenError: null,
    ast: { nodes: [], tree: '', dump: '', error: null },
    codeObjects: [],
    codeObjectText: '',
    instructions: [],
    instructionsTruncated: false,
    bytecode: '',
    disassembly: '',
    compileError: null,
}
~~~

`run` results omit `inspection` entirely. Call `inspect`, `compile` or `diagnose` separately to request artifacts. `exitCode` is the engine's success/failure indicator, not an OS process exit code; Python `SystemExit` is captured as an exception. Python exceptions resolve a failed result so completed output remains available. They do not reject the promise. `stderr` alone does not indicate failure.

Diagnostic kinds are `tokenization`, `syntax`, `compilation` and `runtime`. They contain available one-based lines, not guessed columns; `0` means no line was available. Analysis parse failure yields a syntax diagnostic, while a valid AST rejected by `compile` yields a compilation diagnostic. `run` reports syntax or runtime errors directly from CPython execution; runtime errors appear only for `run`.

Artifacts are plain data, never live Python handles, host objects, DOM nodes or rendered HTML. `ast.tree`, `ast.dump`, `bytecode` and `disassembly` are text. AST node/parent/child records, code-object metadata and instruction records are structured as emitted by CPython and validated by the engine.

Positions preserve the existing runtime conventions:

- Token lines/columns are one-based; columns count Unicode code points.
- AST `lineno`/`end_lineno` are one-based; `col_offset`/`end_col_offset` are zero-based UTF-8 byte offsets.
- Instruction `source.line`/`endLine` are one-based; columns are zero-based UTF-8 byte offsets.
- End positions are exclusive. Missing locations are `null`; tokens may omit missing end positions.
- Instruction `codeId` connects an instruction to its code object. AST `parentId`/`children` connect bounded nodes.

An IDE must convert these positions to its editor's coordinate system if needed. The engine does not contain trace selection or display mappings.

## Events

Callbacks run as microtasks after internal state transitions; exceptions thrown by an observer are logged without interrupting engine promises.

`onStdout(chunk)` and `onStderr(chunk)` deliver incremental strings, including the final data that did not meet the worker's streaming throttle. Concatenating each channel's chunks reproduces the completed result. Cancelled operations may have emitted partial output.

`onStream` receives `{ requestId, generation, stdout, stderr, stdoutChunk, stderrChunk, outputTruncated }`. Full channel strings are cumulative and bounded; chunks are incremental. Use this callback when output needs operation identity.

`onResult` receives a completed source-operation result, including Python failures. `onPackages` receives a completed package result. Neither fires for cancelled/timed-out operations. Data notifications queued for a destroyed generation are discarded.

`onStatus` receives state snapshots when status changes. Statuses are:

~~~text
idle → initializing → ready
ready → running / compiling / inspecting / diagnosing / loading-packages → ready
active → initializing → ready  (cancel, timeout or recoverable Worker failure)
initializing → idle            (retryable initialization failure)
initializing → unavailable     (replacement failure)
any live state → stopped       (legacy stop())
any state → disposed          (terminal)

stopped/unavailable → initializing → ready
~~~

A status callback is a transition snapshot from the current runtime generation; queued notifications from a discarded generation are dropped. Use `getState()` when current state is needed.

`onError` reports infrastructure failures and timeouts. Validation, `BUSY`, cancellation, reset and disposal are reported by the operation's rejected promise instead.

## Cancellation and errors

Attach a rejection handler when an operation may be stopped:

~~~js
const pending = python.run('while True:\n    pass');
const outcome = pending.catch(error => {
  if (error.code !== 'CANCELLED') throw error;
  return null;
});
await python.cancel(); // terminates the old Worker and starts a fresh runtime
await outcome;
~~~

`stop()` retains its synchronous legacy behavior and leaves the engine stopped until `initialize()` or `reset()`. Cancellation and operation timeout destroy the interpreter and package state, then start a fresh runtime; `initialize()` can await an in-progress replacement. An active Worker failure rejects the operation and also starts replacement. Initial startup failures leave the engine idle for retry; failed replacement leaves it unavailable until an explicit `initialize()` or `reset()` retry. Packages are not reloaded automatically. `dispose()` is terminal: create a new instance to use Python again.

Each rejected promise uses `PythonEngineError` with `name`, `message`, `code` and optional serializable `details`. `JSON.stringify(error)` is supported.

| Codes | Meaning |
| --- | --- |
| `INVALID_REQUEST`, `INVALID_SOURCE`, `EMPTY_SOURCE`, `SOURCE_TOO_LARGE`, `INVALID_FILENAME`, `INVALID_TIMEOUT` | Invalid source-operation input |
| `INVALID_OPTIONS` | Invalid construction callbacks/options |
| `INVALID_PACKAGES` | Empty, malformed, unknown or non-curated package request |
| `NOT_READY`, `BUSY`, `INVALID_STATE` | Lifecycle precondition failed |
| `CANCELLED`, `RESET`, `DISPOSED` | Caller terminated the pending operation |
| `TIMEOUT` | Initialization or operation deadline; active operations start replacement |
| `RUNTIME_FAILURE` | Runtime initialization, worker or transport failure; active failures start replacement |

Runtime generations and monotonically increasing request IDs reject stale messages. Callers still own source revision tracking: compare the request/source revision with the current editor before displaying a result.

## Package result

~~~js
{
  status: 'completed', // or 'failed' if any requested import failed
  packages: [
    { id: 'numpy', loaded: true },
    // { id: 'sympy', loaded: false, error: '...' }
  ],
  loadedPackages: ['numpy'], // includes import-confirmed curated dependencies
}
~~~

A missing or failed import is never treated as loaded just because a wheel was installed. Catalog status is `unloaded`, `loading`, `loaded` or `error`. Duplicate IDs are deduplicated; already-loaded IDs need no new download. Partial failure resolves a failed package result and leaves the runtime usable. Retrying an errored curated package is supported. No package unload, search, version picker, arbitrary URL or pip interface exists.

## Capabilities and limits

`python.capabilities` is frozen and currently advertises `run`, `compile`, `diagnostics`, `inspect`, `ast`, `bytecode`, `disassembly`, `streamingOutput` and `packages`, all true. Artifact flags describe fields supplied by `inspect`; they are not additional `ast()`/`bytecode()` methods. Future language engines may advertise a different set.

Runtime loading and package loading have 120-second ceilings; all source operations have a 15-second ceiling. Lower execution/package deadlines can be selected at construction; source requests may override the execution deadline within its ceiling.

Stdout/stderr share 100,000 characters. Tokens are limited to 1,500 entries and 1,000 characters per value; AST nodes to 500 with eight scalar detail fields each; code objects to 40 with 200 constants/names/locals each; instructions to 4,000. Inspection text fields and errors are capped at 100,000 characters each. Nested code inspection is limited to depth 12. Token/instruction truncation is explicit; AST traversal text marks omitted nodes. These are inspection/output bounds, not a browser memory quota.

See the [root README](../README.md#security-and-limits) for the preserved sandbox, networking, host filesystem and deployment restrictions.
