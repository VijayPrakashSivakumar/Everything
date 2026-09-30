// Shared boot sequence for the browser probes. Each probe used to copy round this logic, and the
// copies drifted: some polled 127.0.0.1 but then navigated to `localhost`, and none of them failed
// when the server never started — so a machine that resolves `localhost` to ::1 produced a bare
// `net::ERR_CONNECTION_REFUSED` from Playwright with nothing to explain it.
//
//   const server = await startTestServer(PORT, (p) => { PORT = p; });
//   await page.goto(testUrl(PORT), { waitUntil: 'commit' });
//   ... server.kill() in the finally
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVE = path.resolve(here, '..', '..', 'serve.mjs');

// Always numeric loopback, never `localhost`: this is the address the server binds and the address
// the page is loaded from, so the two can never disagree about which loopback they mean.
export const TEST_HOST = '127.0.0.1';
export const testUrl = (port, file = 'index.html') => `http://${TEST_HOST}:${port}/${file}`;

/* Is anything already listening here?

   Each probe used to hard-code a port, and the numbering drifted until three suites shared one
   (4417, 4418, 4419). Sequential runs mostly got away with it, but a suite killed on a timeout
   leaves its static server holding the socket, because a killed parent does not take its child down
   on Windows. The next run then found the port busy and served a stale build, so the suite failed
   against code that had already been fixed, which is the hardest kind of failure to chase. */
function isPortFree(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ host: TEST_HOST, port }, () => {
      probe.destroy();
      resolve(false); // something answered, so the port is in use
    });
    probe.on('error', () => resolve(true)); // refused, so it is free
    probe.setTimeout(500, () => {
      probe.destroy();
      resolve(true);
    });
  });
}

/* The usual reason a port is busy is the previous run's server on its way out, so it is given a
   moment before the port is given up on. Moving straight to the next candidate would leave that
   socket held for the whole run. */
async function waitForPort(port, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    if (await isPortFree(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function findFreeNear(base) {
  for (let candidate = base + 1; candidate <= base + 40; candidate += 1) {
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(`no free port near ${base} (tried ${base}-${base + 40})`);
}

/* Returns the port actually in use: the requested one when it is free, otherwise the next one up.

   `assignTo` exists because every probe declares `const PORT = 4416` and then calls testUrl(PORT)
   throughout its own body. Returning the new port is not enough on its own: the probe would carry on
   building URLs from the constant it already holds, walk across to whatever else was listening, and
   quietly assert against somebody else's app. Writing the resolved value back into that binding is
   what makes the move actually safe, and is why the probes declare it with `let`. */
export async function resolvePort(requested, assignTo) {
  const base = Number(requested) || 4400;
  await waitForPort(base);
  const chosen = (await isPortFree(base)) ? base : await findFreeNear(base);
  if (assignTo && chosen !== base) assignTo(chosen);
  return chosen;
}

export async function startTestServer(requestedPort, assignTo) {
  const port = await resolvePort(requestedPort, assignTo);
  const child = spawn('node', [SERVE, String(port)], { stdio: 'ignore' });
  let reason = 'no response';
  for (let i = 0; i < 40; i += 1) {
    // A dead child will never answer, so stop waiting on it and report why instead.
    if (child.exitCode !== null) { reason = `server exited with code ${child.exitCode}`; break; }
    try {
      const res = await fetch(testUrl(port));
      if (res.ok) {
        // Said out loud, because a silent move to another port is how a probe ends up talking to
        // something it did not mean to.
        if (port !== Number(requestedPort)) {
          console.warn(`port ${requestedPort} was busy - using ${port} instead`);
        }
        return { port, host: TEST_HOST, url: testUrl(port), kill: () => child.kill() };
      }
      reason = `HTTP ${res.status}`;
    } catch (err) {
      reason = err.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error(`static server never came up on ${TEST_HOST}:${port} (${reason})`);
}
