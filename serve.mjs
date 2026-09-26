// Minimal static server for the app, so the browser probes can run against local changes instead of
// only against what is already deployed. No dependencies.
//
//   node serve.mjs [port]
import http from 'http';
import { readFile } from 'fs/promises';
import path from 'path';

const ROOT = path.resolve('Everything');
const PORT = Number(process.argv[2] || 4321);
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

http
  .createServer(async (req, res) => {
    // Resolve inside ROOT only: a crafted path must not escape the folder.
    const url = decodeURIComponent(req.url.split('?')[0]);
    const rel = url === '/' ? 'index.html' : url.replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      }).end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
    }
  })
  .listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
