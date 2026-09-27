// Shared boot sequence for the browser probes. Each probe used to copy round this logic, and the
// copies drifted: some polled 127.0.0.1 but then navigated to `localhost`, and none of them failed
// when the server never started — so a machine that resolves `localhost` to ::1 produced a bare
// `net::ERR_CONNECTION_REFUSED` from Playwright with nothing to explain it.
//
//   const server = await startTestServer(PORT);
//   await page.goto(testUrl(PORT), { waitUntil: 'commit' });
//   ... server.kill() in the finally
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.resolve(here, '..', '..', 'serve.mjs');

// Always numeric loopback, never `localhost`: this is the address the server binds and the address
// the page is loaded from, so the two can never disagree about which loopback they mean.
export const TEST_HOST = '127.0.0.1';
export const testUrl = (port, file = 'index.html') => `http://${TEST_HOST}:${port}/${file}`;

export async function startTestServer(port) {
  const child = spawn('node', [SERVE, String(port)], { stdio: 'ignore' });
  let reason = 'no response';
  for (let i = 0; i < 40; i += 1) {
    // A dead child will never answer, so stop waiting on it and report why instead.
    if (child.exitCode !== null) { reason = `server exited with code ${child.exitCode}`; break; }
    try {
      const res = await fetch(testUrl(port));
      if (res.ok) return { port, host: TEST_HOST, url: testUrl(port), kill: () => child.kill() };
      reason = `HTTP ${res.status}`;
    } catch (err) {
      reason = err.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`static server never came up on ${TEST_HOST}:${port} (${reason})`);
}
