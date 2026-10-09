// Verifies shared button sizing and the Insights/Review action layouts at phone, tablet, and desktop widths.
//   node Everything/tests/button-layout-probe.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { bootApp, startTestServer } from './test-server.mjs';

let PORT = 4427;
const server = await startTestServer(PORT, (port) => { PORT = port; });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(8000);
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (error) { results.push(`FAIL  ${name}\n        ${error.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

try {
  await bootApp(page, PORT);
  const fixture = await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString();
    state.items = [
      ...Array.from({ length: 14 }, (_, index) => ({
        id: `late-${index}`,
        kind: 'task',
        title: `A deliberately long overdue task title ${index + 1}`,
        dueDate: day(-index - 1),
        created: Date.now() - 10 * 86400000,
        done: false,
      })),
      { id: 'finished', kind: 'task', title: 'Recently finished task', created: Date.now() - 86400000, completedAt: Date.now() - 3600000, done: true },
      { id: 'waiting', kind: 'waiting', title: 'Waiting for a long-named contact', created: Date.now() - 20 * 86400000, done: false },
    ];
    state.people = [{ id: 'person-1', name: 'A contact with a deliberately long name' }];
    state.projects = [{ id: 'project-1', name: 'A project with a very long title' }];
    state.goals = [];
    renderAll();
    return true;
  });
  assert.equal(fixture, true);

  const widths = [
    { width: 320, height: 720, name: 'small phone' },
    { width: 375, height: 812, name: 'phone' },
    { width: 414, height: 896, name: 'large phone' },
    { width: 768, height: 1024, name: 'tablet' },
    { width: 1024, height: 768, name: 'small laptop' },
    { width: 1280, height: 900, name: 'desktop' },
    { width: 1600, height: 900, name: 'wide desktop' },
  ];

  for (const viewport of widths) {
    await page.setViewportSize(viewport);
    for (const view of ['insights', 'review']) {
      await page.evaluate((id) => switchView(id), view);
      const measurement = await page.evaluate(() => {
        const root = document.documentElement;
        const view = document.querySelector('.view.active');
        const buttons = [...view.querySelectorAll('button.btn, button.link-btn')].filter(
          (button) => button.getClientRects().length && getComputedStyle(button).display !== 'none',
        );
        const buttonRects = buttons.map((button) => {
          const rect = button.getBoundingClientRect();
          const parent = button.closest('.insight-actions, .insight-item, .card') || button.parentElement;
          const bounds = parent.getBoundingClientRect();
          return {
            label: button.innerText.trim(),
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
            height: rect.height,
            parentLeft: bounds.left,
            parentRight: bounds.right,
            parentTop: bounds.top,
            parentBottom: bounds.bottom,
          };
        });
        const overlaps = [];
        for (const container of view.querySelectorAll('.insight-actions, .insight-item')) {
          const controls = [...container.querySelectorAll('button.btn, button.link-btn')].filter(
            (button) => button.getClientRects().length,
          );
          for (let i = 0; i < controls.length; i += 1) {
            for (let j = i + 1; j < controls.length; j += 1) {
              const a = controls[i].getBoundingClientRect();
              const b = controls[j].getBoundingClientRect();
              if (a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1) {
                overlaps.push(`${controls[i].innerText} / ${controls[j].innerText}`);
              }
            }
          }
        }
        return {
          viewportWidth: root.clientWidth,
          viewWidth: view.clientWidth,
          viewScrollWidth: view.scrollWidth,
          documentScrollWidth: root.scrollWidth,
          buttons: buttonRects,
          overlaps,
          actionCount: view.querySelectorAll('.insight-actions > button, #reviewStuck button').length,
        };
      });
      const label = `${viewport.name} ${viewport.width}px / ${view}`;
      await check(`${label}: controls have consistent tap size and remain inside the viewport`, async () => {
        assert.ok(measurement.buttons.length > 0, 'fixture did not render any buttons');
        for (const button of measurement.buttons) {
          assert.ok(button.height >= 36, `"${button.label}" is only ${button.height}px tall`);
          assert.ok(button.left >= -1, `"${button.label}" starts outside the viewport at ${button.left}px`);
          assert.ok(button.right <= viewport.width + 1, `"${button.label}" ends outside the viewport at ${button.right}px`);
          assert.ok(button.right <= button.parentRight + 1, `"${button.label}" escapes its container`);
        }
      });
      await check(`${label}: buttons do not overlap and content does not overflow`, async () => {
        assert.deepEqual(measurement.overlaps, [], `overlapping controls: ${measurement.overlaps.join(', ')}`);
        assert.ok(measurement.viewScrollWidth <= measurement.viewWidth + 1, `view width ${measurement.viewWidth}, scroll width ${measurement.viewScrollWidth}`);
        assert.ok(measurement.documentScrollWidth <= measurement.viewportWidth + 1, `document width ${measurement.documentScrollWidth}, viewport ${measurement.viewportWidth}`);
      });
    }
  }

  await check('Insights actions remain functional after responsive layout changes', async () => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.evaluate(() => switchView('insights'));
    const initial = await page.locator('.insight-card').count();
    assert.ok(initial > 0, 'no insight cards were generated');
    await page.locator('.insight-card .insight-item > .link-btn').first().click();
    assert.ok(await page.locator('#view-insights').evaluate((el) => el.classList.contains('active')));
    assert.equal(await page.locator('.insight-card').count(), initial - 1, 'dismiss did not remove the insight');
  });

  await check('Review list expansion remains accessible and functional on mobile', async () => {
    await page.evaluate(() => switchView('review'));
    const expand = page.locator('#reviewStuck button.link-btn');
    assert.match(await expand.innerText(), /Show all/);
    await expand.click();
    assert.equal(await page.locator('#reviewStuck .task-row').count(), 15);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nBUTTON LAYOUT CHECKS FAILED' : `\nALL ${results.length} BUTTON LAYOUT CHECKS PASSED`);
