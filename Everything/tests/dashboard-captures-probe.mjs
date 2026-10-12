// The dashboard's recent captures must come from live state and disappear after a successful delete.
//
//   node Everything/tests/dashboard-captures-probe.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, bootApp } from './test-server.mjs';

let port = 4457;
const server = await startTestServer(port, (resolvedPort) => { port = resolvedPort; });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await bootApp(page, port);
  await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
    const oldCapture = {
      id: 'old-capture',
      kind: 'memory',
      title: 'Real capture from three weeks ago',
      created: Date.now() - 21 * 24 * 60 * 60 * 1000,
      scope: 'shared',
    };
    const otherCapture = {
      id: 'other-capture',
      kind: 'memory',
      title: 'Another real capture',
      created: Date.now(),
      scope: 'shared',
    };
    state.items = [otherCapture, oldCapture];
    sharedItems = state.items.slice();
    privateItems = [];
    let deletedId = '';
    db = {
      collection: () => ({
        doc: (id) => ({
          delete: async () => { deletedId = id; },
        }),
      }),
    };
    window.__deletedCaptureId = () => deletedId;
    renderAll();
  });

  const beforeDelete = await page.locator('#recentList').innerText();
  assert.match(beforeDelete, /Real capture from three weeks ago/,
    'the Dashboard should show a real older capture when it is among the latest four');
  assert.match(beforeDelete, /Another real capture/,
    'the Dashboard should show the other live capture');

  await page.evaluate(() => dbDeleteItem('old-capture'));
  const afterDelete = await page.locator('#recentList').innerText();
  assert.doesNotMatch(afterDelete, /Real capture from three weeks ago/,
    'a successfully deleted capture remained in Recent captures');
  assert.match(afterDelete, /Another real capture/,
    'deleting one capture must leave the other live capture visible');
  assert.equal(await page.evaluate(() => window.__deletedCaptureId()), 'old-capture',
    'the delete must reach the database-backed delete operation');
  assert.equal(await page.evaluate(() => state.items.some((item) => item.id === 'old-capture')), false,
    'the deleted capture remained in live app state');

  console.log('ALL 1 DASHBOARD CAPTURES CHECKS PASSED');
} finally {
  await browser.close();
  server.kill();
}
