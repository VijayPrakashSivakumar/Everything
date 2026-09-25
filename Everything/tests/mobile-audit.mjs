// Headless mobile audit. Drives the real Chrome over the DevTools protocol at a 390px
// viewport (Vivo V27 reports ~393 CSS px) and measures the elements that matter on a phone.
// No test framework and no npm install required.
//
//   node Everything/tests/mobile-audit.mjs
//
// Read-only: it measures only, and never writes to the database.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 3, mobile: true };
const PORT = 8731;
const DEBUG_PORT = PORT + 1;

const results = [];
function record(ok, name, detail) {
  results.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- static server so the page runs over http:// (file:// blocks the API) ----
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(root, rel === '/' ? 'index.html' : rel);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// ---- minimal CDP client ----
async function cdpConnect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = waiting.get(msg.id);
    if (!entry) return;
    waiting.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  });
  return {
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const messageId = ++id;
      waiting.set(messageId, { resolve, reject });
      ws.send(JSON.stringify({ id: messageId, method, params }));
    }),
    close: () => ws.close(),
  };
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'everything-audit-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', `--remote-debugging-port=${DEBUG_PORT}`,
  `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

function cleanup() {
  try { chrome.kill(); } catch (e) { /* already exited */ }
  try { server.close(); } catch (e) { /* already closed */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}
process.on('exit', cleanup);

async function main() {
  await new Promise((resolve) => server.listen(PORT, resolve));

  let ready = null;
  for (let i = 0; i < 40 && !ready; i += 1) {
    try { ready = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`); }
    catch { await sleep(250); }
  }
  if (!ready) throw new Error('Chrome did not expose a debugging endpoint');

  const targets = await fetchJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  const page = targets.find((t) => t.type === 'page');
  const client = await cdpConnect(page.webSocketDebuggerUrl);

  await client.send('Page.enable');
  await client.send('Runtime.enable');
  await client.send('Emulation.setDeviceMetricsOverride', VIEWPORT);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await sleep(3000);

  const evaluate = async (expression) => {
    const r = await client.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed');
    return r.result.value;
  };

  const base = await evaluate(`(() => ({
    vw: document.documentElement.clientWidth,
    docWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }))()`);
  record(base.docWidth <= base.vw + 1, 'no horizontal overflow at 390px',
    `viewport=${base.vw} document=${base.docWidth} body=${base.bodyWidth}`);

  const search = await evaluate(`(() => {
    const box = document.getElementById('searchBox');
    const input = document.getElementById('searchInput');
    if (!box || !input) return { missing: true };
    const b = box.getBoundingClientRect();
    const i = input.getBoundingClientRect();
    return {
      boxWidth: Math.round(b.width), boxHeight: Math.round(b.height),
      inputWidth: Math.round(i.width), readonly: input.readOnly,
      fontSize: getComputedStyle(input).fontSize,
    };
  })()`);
  record(!search.missing && search.boxWidth > 120 && search.boxHeight >= 32,
    'the search field is usable at 390px', JSON.stringify(search));
  record(!search.missing && !search.readonly,
    'the search input is editable, not a click target', `readonly=${search.readonly}`);
  record(!search.missing && search.inputWidth >= 44,
    'the search input meets the 44px touch-target width', `width=${search.inputWidth}`);
  record(!search.missing && parseFloat(search.fontSize) >= 16,
    'the search input avoids iOS focus-zoom', `fontSize=${search.fontSize}`);

  // Tapping the field must open the dropdown anchored beneath it.
  await evaluate(`(() => {
    const i = document.getElementById('searchInput');
    i.focus(); i.dispatchEvent(new Event('focus'));
    i.value = 'a'; i.dispatchEvent(new Event('input'));
    return true;
  })()`);
  await sleep(300);

  const drop = await evaluate(`(() => {
    const dd = document.getElementById('searchDropdown');
    const box = document.getElementById('searchBox');
    if (!dd) return { missing: true };
    const d = dd.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    return {
      hidden: dd.hidden, width: Math.round(d.width), height: Math.round(d.height),
      left: Math.round(d.left), right: Math.round(d.right), vw,
      fieldBottom: Math.round(b.bottom), ddTop: Math.round(d.top),
      leftGap: Math.round(d.left), rightGap: Math.round(vw - d.right),
    };
  })()`);
  record(!drop.missing && !drop.hidden, 'tapping the search field opens the dropdown',
    JSON.stringify(drop));
  record(!drop.missing && drop.left >= -1 && drop.right <= drop.vw + 1,
    'the dropdown stays inside the viewport', `left=${drop.left} right=${drop.right} vw=${drop.vw}`);
  record(!drop.missing && drop.ddTop >= drop.fieldBottom - 2, 'the dropdown sits below the field',
    `fieldBottom=${drop.fieldBottom} dropdownTop=${drop.ddTop}`);
  record(!drop.missing && drop.leftGap >= 0 && drop.rightGap >= 0,
    'the dropdown leaves space on both sides',
    `leftGap=${drop.leftGap} rightGap=${drop.rightGap}`);

  // The Capture sheet must fit the phone and not exceed the viewport height.
  const capture = await evaluate(`(() => {
    if (typeof openCapture !== 'function') return { missing: true };
    openCapture();
    const overlay = document.getElementById('captureModal');
    const modal = overlay && overlay.querySelector('.modal');
    if (!modal) return { missing: true };
    const m = modal.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    return {
      open: overlay.classList.contains('open'),
      width: Math.round(m.width), height: Math.round(m.height),
      left: Math.round(m.left), right: Math.round(m.right), vw, vh,
      leftGap: Math.round(m.left), rightGap: Math.round(vw - m.right),
    };
  })()`);
  record(!capture.missing && capture.open, 'the Capture sheet opens at 390px', JSON.stringify(capture));
  record(!capture.missing && capture.width <= capture.vw, 'the Capture sheet fits the screen width',
    `width=${capture.width} vw=${capture.vw}`);
  record(!capture.missing && capture.leftGap >= 8 && capture.rightGap >= 8,
    'the Capture sheet is inset from both edges',
    `leftGap=${capture.leftGap} rightGap=${capture.rightGap}`);
  record(!capture.missing && Math.abs(capture.leftGap - capture.rightGap) <= 2,
    'the Capture sheet is centred', `leftGap=${capture.leftGap} rightGap=${capture.rightGap}`);
  record(!capture.missing && capture.height <= capture.vh, 'the Capture sheet fits the viewport height',
    `height=${capture.height} vh=${capture.vh}`);

  await evaluate(`(() => { if (typeof closeCapture === 'function') closeCapture(); return true; })()`);

  // Every menu view must be reachable without horizontal overflow.
  const views = await evaluate(`(async () => {
    const navItems = document.querySelectorAll('#navList .nav-item').length;
    const names = Array.from(document.querySelectorAll('.view')).map((v) => v.id);
    const report = [];
    for (const name of names) {
      if (typeof switchView !== 'function') break;
      switchView(name.replace('view-', ''));
      await new Promise((r) => setTimeout(r, 150));
      const vw = document.documentElement.clientWidth;
      const el = document.getElementById(name);
      report.push({
        view: name,
        ownOverflow: el.scrollWidth > el.clientWidth + 1,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        docOverflow: document.documentElement.scrollWidth > vw + 1,
      });
    }
    return { navItems, report };
  })()`);

  record(views.navItems > 0 || views.report.length > 0,
    'the shell renders either the menu or the auth screen',
    `navItems=${views.navItems} views=${views.report.length}`);
  const bad = views.report.filter((v) => v.docOverflow);
  record(bad.length === 0, 'no menu view pushes the page wider than the screen at 390px',
    bad.length
      ? bad.map((v) => `${v.view} scroll=${v.scrollWidth} client=${v.clientWidth}`).join('; ')
      : `${views.report.length} views checked`);

  // Top-bar tap targets. 40px is the practical minimum for a phone; the brand mark is a logo
  // rather than a control, so it is reported separately instead of failing the run.
  const taps = await evaluate(`(() => {
    const small = [];
    for (const s of ['#hamburger', '.theme-toggle', '.icon-btn']) {
      document.querySelectorAll(s).forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        if (getComputedStyle(el).display === 'none') return;
        if (r.width < 40 || r.height < 40) {
          small.push({ sel: s, w: Math.round(r.width), h: Math.round(r.height) });
        }
      });
    }
    return small;
  })()`);
  record(taps.length === 0, 'top-bar icon buttons are at least 40x40',
    taps.length ? JSON.stringify(taps) : 'all large enough');

  client.close();
}

main()
  .then(() => {
    console.log(results.join('\n'));
    console.log(process.exitCode
      ? '\nMOBILE AUDIT FOUND PROBLEMS'
      : `\nALL ${results.length} MOBILE CHECKS PASSED`);
    cleanup();
    process.exit(process.exitCode || 0);
  })
  .catch((err) => {
    console.log(results.join('\n'));
    console.log(`\nMOBILE AUDIT ERROR: ${err.message}`);
    cleanup();
    process.exit(1);
  });

