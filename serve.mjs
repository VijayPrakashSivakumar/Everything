// Minimal static server for the app, so the browser probes can run against local changes instead of
// only against what is already deployed. No dependencies.
//
//   node serve.mjs [port]
import http from 'http';
import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve the folder to serve from this file's own location, not the current working directory:
// every probe spawns this script from wherever it happens to run, and a CWD-relative ROOT made
// them silently serve a folder that does not exist.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'Everything');
const HOST = '127.0.0.1';
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
  // Bind loopback explicitly. Left implicit, Node binds the IPv6 wildcard, and a `localhost` that
  // resolves to ::1 on some machines and 127.0.0.1 on others is what made the probes report a bare
  // "cannot connect" against a server that was demonstrably up.
  .listen(PORT, HOST, () => console.log(`serving ${ROOT} on http://${HOST}:${PORT}`))
  .on('error', (err) => {
    // A port already taken must be loud: a probe that quietly proceeds gets a connection error
    // several steps away from the real cause.
    console.error(`cannot serve on ${HOST}:${PORT} — ${err.code || err.message}`);
    process.exit(1);
  });
