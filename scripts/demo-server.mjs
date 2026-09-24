// Serves demo/ over http so the extension can be tried on demo/article.html
// without Chrome's "Allow access to file URLs" switch. Used by `npm run demo`,
// the end-to-end tests and the store screenshots.
//
//   npm run demo            → http://127.0.0.1:4323/article.html
//   PORT=4329 npm run demo  → another port
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEMO_DIR = fileURLToPath(new URL('../demo/', import.meta.url));
export const DEFAULT_DEMO_PORT = 4323;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/** Starts the server and resolves with { url, close } once it listens. */
export function startDemoServer({ port = DEFAULT_DEMO_PORT, host = '127.0.0.1' } = {}) {
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
    if (pathname === '/') {
      response.writeHead(302, { location: '/article.html' }).end();
      return;
    }
    if (pathname === '/favicon.ico') {
      response.writeHead(204).end();
      return;
    }
    const file = normalize(join(DEMO_DIR, pathname));
    if (!file.startsWith(DEMO_DIR.endsWith(sep) ? DEMO_DIR : DEMO_DIR + sep)) {
      response.writeHead(403).end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, {
        'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        origin: `http://${host}:${port}`,
        url: `http://${host}:${port}/article.html`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const port = Number(process.env.PORT) || DEFAULT_DEMO_PORT;
  const { url } = await startDemoServer({ port });
  console.log(`QuickNotes demo article: ${url}`);
  console.log('Load dist/ as an unpacked extension, open the URL above and select some text.');
  console.log('Press Ctrl+C to stop.');
}
