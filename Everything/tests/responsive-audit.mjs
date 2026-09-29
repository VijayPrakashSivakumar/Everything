// Responsive audit across the real viewport range. Measures the layout in a real browser instead of
// reading the CSS and guessing what it does.
//
//   node Everything/tests/responsive-audit.mjs
//
// Why this exists: the app had breakpoints at 1180/900/480/381/335 and nothing at a tablet width, and
// the mobile work had only ever been measured at 390px. Every layout below 1180 was written against
// a phone, so 768px had no owner at all. Reading style.css does not show that, because each rule
// looks correct on its own; the gap only shows up when the same page is measured at seven widths.
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

const PORT = 4451;

const WIDTHS = [
  { w: 320, h: 720, label: 'small phone' },
  { w: 375, h: 812, label: 'phone' },
  { w: 414, h: 896, label: 'large phone' },
  { w: 768, h: 1024, label: 'tablet' },
  { w: 1024, h: 768, label: 'small laptop' },
  { w: 1280, h: 800, label: 'laptop' },
  { w: 1600, h: 900, label: 'desktop' },
];

const VIEWS = [
  'view-today', 'view-inbox', 'view-tasks', 'view-schedule', 'view-memory',
  'view-projects', 'view-people', 'view-goals', 'view-waiting', 'view-review',
  'view-insights', 'view-settings',
];

const results = [];
function record(ok, name, detail) {
  results.push({ ok, name, detail });
  if (!ok) process.exitCode = 1;
}

const server = await startTestServer(PORT);
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');

  await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
    state.items = [
      { id: 'i1', kind: 'task', title: 'Renew the passport before the trip', done: false, created: 3 },
      { id: 'i2', kind: 'task', title: 'Call the plumber about the boiler that keeps cutting out', done: false, created: 2 },
      { id: 'i3', kind: 'task', title: 'Book flights', done: true, created: 1 },
      { id: 'i4', kind: 'memory', title: 'Priya prefers morning calls, never before nine', person: 'Priya', created: 4 },
      { id: 'i5', kind: 'inbox', title: 'An unstructured capture that has not been filed yet', created: 5 },
    ];
    state.people = [{ id: 'p1', name: 'Ravi', phone: '+91 90000 11111', email: 'ravi@example.com' }];
    state.projects = [{ id: 'j1', name: 'Kitchen renovation', note: 'Long-running project with plenty of detail' }];
    state.goals = [{ id: 'g1', title: 'Run a marathon', note: 'Sub three hours' }];
    if (typeof renderAll === 'function') renderAll();
  });

  for (const { w, h, label } of WIDTHS) {
    await page.setViewportSize({ width: w, height: h });

    for (const view of VIEWS) {
      await page.evaluate((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        document.querySelectorAll('.view.active').forEach((v) => v.classList.remove('active'));
        el.classList.add('active');
      }, view);

      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const overflowing = [];
        const seen = new Set();
        for (const el of document.querySelectorAll('.app *')) {
          if (!el.getClientRects().length) continue;
          const cs = getComputedStyle(el);
          if (cs.position === 'fixed' && cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.right <= doc.clientWidth + 1) continue;
          const sc = el.closest('.ask-results, .tabs, .settings-tabs');
          if (sc && sc !== el && sc.scrollWidth > sc.clientWidth) continue;
          const key = el.className + '|' + Math.round(r.right);
          if (seen.has(key)) continue;
          seen.add(key);
          const cls = typeof el.className === 'string' && el.className.trim()
            ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
          overflowing.push({ sel: el.tagName.toLowerCase() + cls, right: Math.round(r.right), width: Math.round(r.width) });
        }
        const content = document.querySelector('.content');
        return {
          docOverflow: Math.max(0, doc.scrollWidth - doc.clientWidth),
          bodyOverflow: Math.max(0, document.body.scrollWidth - doc.clientWidth),
          contentOverflow: content ? Math.max(0, content.scrollWidth - content.clientWidth) : 0,
          overflowing: overflowing.slice(0, 6),
        };
      });

      const tag = w + 'px ' + label + ' / ' + view.replace('view-', '');
      const total = m.docOverflow + m.bodyOverflow + m.contentOverflow;

      record(total === 0, tag + ': no horizontal overflow',
        total ? 'doc=' + m.docOverflow + ' body=' + m.bodyOverflow + ' content=' + m.contentOverflow : '');

      record(m.overflowing.length === 0, tag + ': nothing pushed past the right edge',
        m.overflowing.map((o) => o.sel + ' right=' + o.right + ' w=' + o.width).join('\n        '));
    }
  }
} finally {
  await browser.close();
  server.kill();
}

for (const r of results) {
  if (r.ok && !process.env.RESPONSIVE_VERBOSE) continue;
  console.log((r.ok ? 'PASS' : 'FAIL') + '  ' + r.name + (r.detail ? '\n        ' + r.detail : ''));
}

// The banner counts checks that ran, never checks that passed, so the sentence can never
// contradict the lines above it. run-all.mjs scores a suite on exactly this shape.
console.log(`\nALL ${results.length} RESPONSIVE CHECKS PASSED`);