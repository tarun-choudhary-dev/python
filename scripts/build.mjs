import { mkdir, copyFile, cp, rm, lstat, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = resolve(root, 'dist');
// dist is generated output. Rebuild it cleanly so removed application assets cannot survive.
if (dirname(output) !== resolve(root)) throw new Error('Build output must be inside the repository.');
const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; });
if (existing?.isSymbolicLink()) throw new Error('Refusing to replace a linked build directory.');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of ['index.js', 'README.md', 'LICENSE', 'THIRD_PARTY.md']) {
  await copyFile(resolve(root, file), resolve(output, file));
}
// Development commands and the Node tooling requirement do not apply to the browser package.
const metadata = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
delete metadata.scripts;
delete metadata.engines;
await writeFile(resolve(output, 'package.json'), JSON.stringify(metadata, null, 2) + '\n');
for (const directory of ['python-engine', 'runtime']) {
  await cp(resolve(root, directory), resolve(output, directory), { recursive: true });
}
console.log('Built the browser engine in dist/. Import dist/index.js; serve its companion runtime assets unchanged.');
