// Development-only static file server. It never receives or executes Python source.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function serve(root, port = 4173) {
  root = resolve(root);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.wasm': 'application/wasm', '.py': 'text/plain', '.zip': 'application/zip' };
  const server = createServer(async (request, response) => {
    try {
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': `${types[extname(file)] || 'application/octet-stream'}${['.html', '.js', '.mjs', '.css', '.py'].includes(extname(file)) ? '; charset=utf-8' : ''}`, 'Cache-Control': 'no-cache' });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end('Not found'); }
  });
  return new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => done(server)); });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const server = await serve(root, Number(process.env.PORT || 4173));
  console.log(`Python engine modules: http://127.0.0.1:${server.address().port}/index.js (no application UI)`);
}
