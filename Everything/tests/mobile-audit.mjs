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

  /* The search field, and the width its placeholder actually needs, in one measurement. The 390px
     pass and the narrower widths below both use this, so there is exactly one implementation of
     "does the placeholder still fit".

     Two earlier versions of this check silently reported every string as fitting, because one of
     them measured a detached probe node — always 0 wide, so it could not fail. The probe therefore
     has to be in the document before it is measured, and has to carry the input's font longhands
     rather than the `font` shorthand. */
  const measureSearchField = () => evaluate(`(() => {
    const box = document.getElementById('searchBox');
    const input = document.getElementById('searchInput');
    if (!box || !input) return { missing: true };
    const cs = getComputedStyle(input);
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.whiteSpace = 'pre';
    probe.style.left = '-9999px';
    probe.style.top = '0';
    probe.style.display = 'inline-block';
    probe.style.fontFamily = cs.fontFamily || 'sans-serif';
    probe.style.fontSize = cs.fontSize || '16px';
    probe.style.fontWeight = cs.fontWeight || '400';
    probe.style.letterSpacing = cs.letterSpacing || 'normal';
    probe.textContent = input.placeholder;
    document.body.appendChild(probe);
    const needed = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      missing: false,
      text: input.placeholder,
      needed: Math.round(needed),
      avail: Math.round(input.clientWidth),
      boxWidth: Math.round(box.getBoundingClientRect().width),
      vw: document.documentElement.clientWidth,
      docWidth: document.documentElement.scrollWidth,
    };
  })()`);

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

  // Every topbar *control* a phone can reach has to actually be reachable.
  //
  // The theme toggle was hidden under 900px to keep the search field above its 120px floor, which
  // left a user who had picked dark mode with no way back to light except digging through Settings.
  // It was restored by reclaiming width from the topbar gap, the side padding and the capture mark
  // instead, so the search floor and this can both hold. That trade is easy to undo by accident:
  // hiding one button looks like it "fixes" the layout, and the only test that noticed was the
  // search floor going quiet rather than anything failing loudly.
  //
  // So both halves are asserted together. Hiding a control to make room is a change that needs a
  // deliberate trade, not a silent way to pass this audit.
  //
  // The list is controls only, and deliberately excludes `.theme-dot`. That is the unread badge
  // inside the notification button, and it is `display: none` until something is unread — asserting
  // it visible would fail on a correctly working app with an empty inbox. Checking the button that
  // contains it is the thing that actually matters.
  const reach = await evaluate(`(() => {
    const wanted = ['#paletteBtn', '.theme-toggle', '.mobile-capture-btn', '.topbar-menu-wrap .icon-btn', '.avatar'];
    return wanted.map((sel) => {
      const el = document.querySelector(sel);
      const r = el && el.getBoundingClientRect();
      return {
        sel,
        present: !!el,
        visible: !!el && getComputedStyle(el).display !== 'none' && r.width > 0,
        w: r ? Math.round(r.width) : 0,
      };
    });
  })()`);
  const hidden = reach.filter((c) => c.present && !c.visible);
  const absent = reach.filter((c) => !c.present);
  record(hidden.length === 0 && absent.length === 0,
    'no topbar control is missing or hidden at 390px to make room',
    hidden.length || absent.length
      ? [...hidden.map((c) => c.sel), ...absent.map((c) => c.sel + ' (absent)')].join(', ')
      : reach.map((c) => `${c.sel}=${c.w}`).join(' '));

  // And the space those controls take must still leave the search field usable, which is the
  // constraint that removed the theme toggle in the first place. Asserted together with the search
  // checks above, so the two cannot be satisfied by trading one against the other.
  //
  // `widest` has to come from the same `rows` the filter builds, not from a fresh query. A previous
  // version of this line lost the local when it was refactored and read `rows` from nowhere, so the
  // message printed "widest child=undefinedpx" on every run — a check whose only output was a lie,
  // which is worse than no check because it looks like evidence.
  const bar = await evaluate(`(() => {
    const t = document.querySelector('.topbar');
    const rows = [...t.children].filter((el) => getComputedStyle(el).display !== 'none');
    const widths = rows.map((el) => Math.round(el.getBoundingClientRect().width));
    const widestName = rows[widths.indexOf(Math.max(...widths))];
    return {
      overflow: t.scrollWidth > t.clientWidth + 1,
      widest: widths.length ? Math.max(...widths) : null,
      widestChild: widestName ? (widestName.className || widestName.tagName).toString().slice(0, 24) : null,
      count: rows.length,
    };
  })()`);
  record(Number.isFinite(bar.widest) && !bar.overflow,
    'the topbar itself does not overflow with every control shown',
    bar.widest === null
      ? 'the topbar has no visible children to measure'
      : `${bar.count} children, widest ${bar.widestChild}=${bar.widest}px, overflow=${bar.overflow}`);

  // A placeholder that does not fit is truncated by the browser mid-word, and "Search an" reads as
  // a bug rather than as a hint. It is not a horizontal-overflow failure, so nothing above catches
  // it: the field is the right width and the text is simply too long for it. Measured by comparing
  // the placeholder against the space actually available inside the input — the how lives in
  // measureSearchField above, so this pass and the narrow-phone pass below cannot drift apart.
  const placeholder = await measureSearchField();
  record(!placeholder.missing && placeholder.avail >= placeholder.needed,
    'the search placeholder fits without being cut mid-word',
    `"${placeholder.text}" needs ${placeholder.needed}px, has ${placeholder.avail}px`);

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

  /* ---------- The same topbar on a narrower phone ----------

     390px is not the only phone. It is the width this audit was written at, and the 120px search
     floor above was only ever asserted there — so a topbar that just fits at 390 can collapse a few
     pixels narrower and nothing here says so.

     It collapses on the search field, because the field is the only child of the topbar allowed to
     shrink (`.search-wrap { flex: 1 1 auto; min-width: 0 }`); every control beside it has a fixed
     width and a 40px tap target, so the whole shortfall lands in that one place. Measured with the
     theme toggle restored: 128px at 390px, 98px at 360px and 58px at 320px, with the placeholder
     cut to "Searc" and then to a single character.

     360px is a 1080px screen at DPR 3 — most Android phones — and 375px is every iPhone from the
     SE2 to the 13 mini, so the two widths below are the range that matters. The floor is asserted
     where it can hold. At 320px seven controls and a 120px field cannot coexist, and this repo has
     already ruled that hiding a control to make a row fit is the worse trade, so what is checked
     there is the visible symptom: the placeholder still fitting. */
  for (const width of [360, 320]) {
    await client.send('Emulation.setDeviceMetricsOverride', {
      width, height: 800, deviceScaleFactor: 2, mobile: true,
    });
    await client.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
    await sleep(2500);

    const narrow = await measureSearchField();
    record(!narrow.missing && narrow.docWidth <= narrow.vw + 1,
      `no horizontal overflow at ${width}px`,
      `viewport=${narrow.vw} document=${narrow.docWidth}`);
    if (width >= 360) {
      record(!narrow.missing && narrow.boxWidth >= 120,
        `the search field keeps its 120px floor at ${width}px`, `width=${narrow.boxWidth}`);
    }
    record(!narrow.missing && narrow.avail >= narrow.needed,
      `the search placeholder still fits at ${width}px`,
      `"${narrow.text}" needs ${narrow.needed}px, has ${narrow.avail}px (field ${narrow.boxWidth}px)`);
  }

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

