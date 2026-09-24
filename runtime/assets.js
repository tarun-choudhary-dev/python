import { RUNTIME_BASE, RUNTIME_FILES, LOAD_TIMEOUT_MS, PYODIDE_VERSION } from './config.js';
import { PACKAGE_BY_ID } from './packages.js';

let pending;
let pendingInspector;
const packageDownloads = new Map();
/** Cache immutable runtime assets across Stop/retry, without caching a failed download. */
export function loadRuntimeAssets() {
  if (pending) return pending;
  pending = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LOAD_TIMEOUT_MS);
    async function read(url, binary = false) {
      const credentials = new URL(url).origin === location.origin ? 'same-origin' : 'omit';
      const response = await fetch(url, { signal: abort.signal, credentials, referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`Could not download ${new URL(url).pathname.split('/').pop()} (HTTP ${response.status}).`);
      return binary ? response.arrayBuffer() : response.text();
    }
    try {
      const [files, workerSource, executor] = await Promise.all([
        Promise.all(RUNTIME_FILES.map(async name => [name, await read(new URL(name, RUNTIME_BASE).href, true)])),
        read(new URL('./worker.js', import.meta.url).href),
        read(new URL('./executor.py', import.meta.url).href),
      ]);
      return { files: Object.fromEntries(files), workerSource, executor };
    } finally { clearTimeout(timer); }
  })().catch(error => { pending = null; throw error; });
  return pending;
}

/** Compiler inspection is fetched only for an explicit analysis request. */
export function loadInspectorSource() {
  if (pendingInspector) return pendingInspector;
  pendingInspector = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LOAD_TIMEOUT_MS);
    try {
      const response = await fetch(new URL('./inspector.py', import.meta.url).href,
        { signal: abort.signal, credentials: 'same-origin', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`Could not download inspector.py (HTTP ${response.status}).`);
      return response.text();
    } finally { clearTimeout(timer); }
  })().catch(error => { pendingInspector = null; throw error; });
  return pendingInspector;
}

function packageLock(assets) {
  let parsed;
  try { parsed = JSON.parse(new TextDecoder().decode(assets.files['pyodide-lock.json'])); }
  catch { throw new Error('The pinned Pyodide package lock file is invalid.'); }
  if (!parsed || typeof parsed !== 'object' || !parsed.packages || typeof parsed.packages !== 'object')
    throw new Error('The pinned Pyodide package lock file is invalid.');
  return parsed;
}

function safeArchiveName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/.test(name) && !name.includes('..');
}

/** Resolve only lockfile-declared transitive dependencies; no URL is accepted here. */
export function resolvePackageArchives(lock, runtimeName) {
  const files = new Set(), seen = new Set();
  const visit = name => {
    if (seen.has(name)) return;
    seen.add(name);
    const entry = lock?.packages?.[name];
    if (!entry || typeof entry !== 'object') throw new Error(`Unavailable in Pyodide ${PYODIDE_VERSION}.`);
    if (!safeArchiveName(entry.file_name)) throw new Error(`Pyodide's package record for ${name} is invalid.`);
    files.add(entry.file_name);
    if (!Array.isArray(entry.depends)) throw new Error(`Pyodide's dependency record for ${name} is invalid.`);
    for (const dependency of entry.depends) {
      if (typeof dependency !== 'string' || !dependency) throw new Error(`Pyodide's dependency record for ${name} is invalid.`);
      visit(dependency);
    }
  };
  visit(runtimeName);
  return [...files];
}

function downloadPackageArchive(name) {
  if (packageDownloads.has(name)) return packageDownloads.get(name);
  const request = (async () => {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), LOAD_TIMEOUT_MS);
    try {
      const url = new URL(name, RUNTIME_BASE);
      if (url.href !== RUNTIME_BASE + name) throw new Error('A package archive path was rejected.');
      const response = await fetch(url, { signal: abort.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) throw new Error(`Could not download ${name} (HTTP ${response.status}).`);
      return response.arrayBuffer();
    } finally { clearTimeout(timer); }
  })().catch(error => { packageDownloads.delete(name); throw error; });
  packageDownloads.set(name, request);
  return request;
}

/** Fetches a curated request's fixed wheels on the host for injection into the offline worker. */
export async function loadPackageAssets(packageIds) {
  const assets = await loadRuntimeAssets();
  const lock = packageLock(assets);
  const plans = [], errors = [];
  for (const id of [...new Set(packageIds)]) {
    const item = PACKAGE_BY_ID.get(id);
    if (!item) { errors.push({ id, error: 'This package is not in PYLAB\'s curated package list.' }); continue; }
    try { plans.push({ item, archives: resolvePackageArchives(lock, item.runtimeName) }); }
    catch (error) { errors.push({ id, error: error instanceof Error ? error.message : `Unavailable in Pyodide ${PYODIDE_VERSION}.` }); }
  }
  const archiveNames = [...new Set(plans.flatMap(plan => plan.archives))];
  const settled = await Promise.allSettled(archiveNames.map(downloadPackageArchive));
  const downloaded = new Map(), failures = new Map();
  settled.forEach((result, index) => {
    if (result.status === 'fulfilled') downloaded.set(archiveNames[index], result.value);
    else failures.set(archiveNames[index], result.reason instanceof Error ? result.reason.message : 'The package archive could not be downloaded.');
  });
  const packages = [], needed = new Set();
  for (const plan of plans) {
    const failed = plan.archives.find(name => failures.has(name));
    if (failed) errors.push({ id: plan.item.id, error: failures.get(failed) });
    else {
      packages.push(plan.item);
      for (const name of plan.archives) needed.add(name);
    }
  }
  return { packages, errors, files: Object.fromEntries([...needed].map(name => [name, downloaded.get(name)])) };
}
