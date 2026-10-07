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

/* ---------- booting the app ---------- */

/* Every probe opened the page the same way and waited for the same global:

     await page.goto(testUrl(PORT), { waitUntil: 'commit' });
     await page.waitForFunction(() => typeof window.setThemeConcept === 'function');

   Two things were wrong with that, and both had to be fixed rather than papered over with a longer
   timeout.

   The gate was too early. `setThemeConcept` is declared in js/shell.js, but `state` is assigned in
   js/init.js, which index.html loads *after* it. So the wait could return while the data layer did
   not exist yet, and the next line — anything touching `state` — failed with `Cannot set properties
   of null`. That race was invisible while the boot was slow, because the blocking CDN scripts gave
   init plenty of time to finish first.

   The diagnostic was useless. The gate depends on jsdelivr and unpkg answering, because those are
   blocking <script src> tags ahead of every app script. When they were slow, four suites
   (conversation, nextaction, documents, money) died on this line with a bare `TimeoutError`, which
   reads as a logic failure in whatever feature the probe was written for. So a timeout now says
   which of the two causes it was, by looking at what actually failed to load.

   The libraries themselves are deliberately NOT stubbed. That was tried and reverted: chrono-node is
   genuinely load-bearing for the date extraction several probes assert on, and signout-probe drives
   `sb.auth.signOut`, so replacing the CDN with empty stubs would have deleted real coverage rather
   than making the suite faster. The boot is a network dependency and pretending otherwise would be a
   worse lie than the timeout was. */
const APP_BOOTED = () => {
  if (typeof window.setThemeConcept !== 'function') return false;
  // `state` is a top-level `let`, reachable here in page scope but not as a property of `window`.
  try { return typeof state !== 'undefined' && !!state; } catch { return false; }
};

/* Waits until the app has finished booting, without navigating. Use after a reload or a redirect
   where `page.goto` is not the call that loaded the document.

   Exported because the share target probe lands on the app twice — once by redirect, once by reload —
   and both need the same signal as the initial boot. `bootApp` covers the first of those. */
export async function waitForApp(page, { timeout = 30000 } = {}) {
  await page.waitForFunction(APP_BOOTED, null, { timeout });
}

/* Loads the app and waits until it has finished booting, then says why if it did not.

   "Booted" includes the startup overlay leaving the screen. js/init.js sets `__appBooted` when the
   app is ready, but index.html only *arms* the splash hide at that moment - a minimum visible beat
   plus a fade (~850ms) - and until it lands a fixed z-index:9999 layer covers the whole page. A
   probe that hit-tests straight after this return (the phone menu does, 450ms in) would be tapping
   the splash rather than the app. Waiting it out here means every probe starts at the point a
   person actually reaches: app up, overlay gone, nothing left to race. The splash probe drives the
   overlay itself and never calls this, so its show/hide assertions are untouched. */
export async function bootApp(page, port, { timeout = 45000 } = {}) {
  const failedVendor = [];
  page.on('requestfailed', (r) => {
    if (/cdn\.jsdelivr\.net|unpkg\.com/.test(r.url())) failedVendor.push(r.url());
  });

  await page.goto(testUrl(port), { waitUntil: 'commit' });
  try {
    await page.waitForFunction(APP_BOOTED, null, { timeout });
  } catch (err) {
    const cause = failedVendor.length
      ? `these third-party scripts did not load: ${failedVendor.join(', ')}. ` +
        'That is a network or CDN problem, not a fault in the code under test.'
      : 'no CDN request failed, so this looks like a broken or reordered script rather than a ' +
        'slow network — check the script order in index.html.';
    throw new Error(`the app never finished booting at ${testUrl(port)} within ${timeout}ms. ${cause} (${err.message})`);
  }
  /* The overlay's own wait: __hideBootSplash only arms a minimum-visible timer at __appBooted,
     and __hideLoadingOverlay's fade is what finally takes the layer off the page. */
  try {
    await page.waitForFunction(() => {
      const el = document.getElementById('bootSplash');
      return !el || getComputedStyle(el).display === 'none';
    }, null, { timeout });
  } catch (err) {
    throw new Error(
      `the app booted at ${testUrl(port)} but its startup splash never left the screen within ${timeout}ms. ` +
      `__hideBootSplash (index.html) arms a minimum-visible timer at __appBooted and __hideLoadingOverlay ` +
      `does the fade - one of those is not running (${err.message})`);
  }

}
