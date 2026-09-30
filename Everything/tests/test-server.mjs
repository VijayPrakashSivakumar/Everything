// Shared boot sequence for the browser probes. Each probe used to copy round this logic, and the
// copies drifted: some polled 127.0.0.1 but then navigated to `localhost`, and none of them failed
// when the server never started â€” so a machine that resolves `localhost` to ::1 produced a bare
// `net::ERR_CONNECTION_REFUSED` from Playwright with nothing to explain it.
//
//   const server = await startTestServer(PORT);
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

   The probes used to hard-code a port each, and the numbering drifted until three suites shared
   one (4417, 4418, 4419). Sequential runs mostly got away with it, but any suite killed on a
   timeout leaves its static server alive â€” a killed parent does not take its child down on Windows
   â€” so the *next* run found the port taken and served somebody else's already-open app. The
   symptom was a suite failing against a stale build, which reads exactly like a real bug and is
   the hardest kind of failure to chase. */
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

/* Waits for the port to free up. A previous run's server is given a moment to disappear before we
   give up and move to the next candidate, because the common case really is a stale server that is
   about to die rather than a genuinely occupied port. */
async function waitForPort(port, attempts = 8) {
  for (let i = 0; i < attempts; i += 1) {
    if (await isPortFree(port)) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* Returns a port to actually use: the requested one when it is free, otherwise the next few
   candidates up.

   The wait comes first because the usual reason a port is busy is the previous run's server on its
   way out; moving straight to the next port would leave that one holding a socket for the whole run.

   `assignTo` exists because every probe declares `let PORT = 4416` and then calls
   testUrl(PORT) all over its own body. Returning the real port is not enough on its own: the probe
   would carry on building URLs from the constant it already has, walk over to whatever else is
   listening there, and quietly assert against somebody else's app. Writing the resolved value back
   into that binding is what makes the move actually safe. */
export async function resolvePort(requested, assignTo) {
  const base = Number(requested) || 4400;
  await waitForPort(base);
  const chosen = (await isPortFree(base))
    ? base
    : await findFreeNear(base);
  // Only a `let`/`var` binding can be written to; a `const` throws in strict mode, which every ES
  // module is, so the caller gets told to declare its port with `let` rather than crashing here.
  if (assignTo && chosen !== base) {
    try {
      assignTo(chosen);
    } catch {
      throw new Error(
        `port ${base} was busy and ${chosen} was free, but this probe's PORT is declared with ` +
          '"const" and cannot be updated. Change it to "let".',
      );
    }
  }
  return chosen;
}

async function findFreeNear(base) {
  for (let candidate = base + 1; candidate <= base + 40; candidate += 1) {
    if (await isPortFree(candidate)) return candidate;
  }
  throw new Error(`no free port near ${base} (tried ${base}-${base + 40})`);
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
        const moved = port !== Number(requestedPort);
        if (moved) {
          // Said out loud, because a silent move to a different port is how a probe ends up talking
          // to something it did not mean to.
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
