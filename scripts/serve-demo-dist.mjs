import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const rootArgument = process.env['VIEWLEADER_PACKED_DEMO_DIST'];
if (rootArgument === undefined) throw new Error('VIEWLEADER_PACKED_DEMO_DIST is required');
const root = resolve(rootArgument);
const port = 4173;

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${request.headers.host}`).pathname);
    const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) throw new Error('Invalid path');
    let file;
    try {
      file = (await stat(candidate)).isDirectory() ? resolve(candidate, 'index.html') : candidate;
    } catch (error) {
      if (extname(pathname) !== '') throw error;
      file = resolve(root, 'index.html');
    }
    response.statusCode = 200;
    response.setHeader('content-type', contentType(file));
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.end(request.method === 'HEAD' ? undefined : await readFile(file));
  } catch {
    response.statusCode = 404;
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close(() => process.exit(0)));
}

function contentType(file) {
  switch (extname(file)) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.map': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.wasm': return 'application/wasm';
    case '.ifc': return 'application/octet-stream';
    case '.woff2': return 'font/woff2';
    default: return 'application/octet-stream';
  }
}
