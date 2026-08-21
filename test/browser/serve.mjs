/**
 * A static file server for the browser conformance page — twenty lines of `node:http` rather than
 * a dev-server dependency, because this repo's whole claim is that it needs nothing.
 *
 * It exists only so ES module imports resolve: browsers block `import` over `file://` for CORS
 * reasons. The library itself runs perfectly from a local file once loaded.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

createServer(async (request, response) => {
  // normalize() collapses any ../ before the join, so a crafted URL cannot escape ROOT.
  const relative = normalize(decodeURIComponent((request.url ?? '/').split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const path = join(ROOT, relative.endsWith('/') ? `${relative}index.html` : relative);

  if (!path.startsWith(ROOT)) {
    response.writeHead(403).end('forbidden');
    return;
  }
  try {
    const body = await readFile(path);
    response.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`serving ${ROOT} on http://127.0.0.1:${PORT}`));
