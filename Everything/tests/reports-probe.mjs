// Exercises the real Reports view against seeded workspace records, including filters and CSV export.
//   node Everything/tests/reports-probe.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { bootApp, startTestServer } from './test-server.mjs';

let PORT = 4420;
const server = await startTestServer(PORT, (port) => { PORT = port; });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
page.setDefaultTimeout(8000);
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (error) { results.push(`FAIL  ${name}\n        ${error.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

try {
  await bootApp(page, PORT);
  await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
  });
  const now = Date.now();
  const seeded = [
    { id: 'done-task', kind: 'task', title: 'Renew passport', project: 'Atlas', done: true, created: now - 2 * 86400000, completedAt: now - 86400000 },
    { id: 'open-task', kind: 'task', title: 'Book a table', project: 'Atlas', done: false, created: now - 3 * 86400000 },
    { id: 'garden-note', kind: 'note', title: 'Garden plans', project: 'Garden', done: false, created: now - 2 * 86400000 },
    { id: 'old-note', kind: 'note', title: 'Archive reference', done: false, created: now - 70 * 86400000 },
    { id: 'formula-title', kind: 'task', title: '=SUM(1,1)', done: false, created: now - 86400000 },
  ];
  await page.evaluate((items) => { state.items = items; state.goals = []; renderNav(); }, seeded);

  await check('the Reports menu entry opens a populated report view', async () => {
    await page.locator('.nav-item').filter({ hasText: 'Reports' }).click();
    assert.equal(await page.locator('#view-reports').evaluate((el) => el.classList.contains('active')), true);
    assert.equal(await page.locator('#reportPreview .report-item').count(), 4, 'the default 30-day range should exclude the old record');
    assert.match(await page.locator('#reportStats').innerText(), /4\s+Matching records/);
  });

  await check('date range and search filters update preview and counts', async () => {
    await page.locator('#reportPeriod').selectOption('7');
    assert.equal(await page.locator('#reportPreview .report-item').count(), 4);
    await page.locator('#reportSearch').fill('Atlas');
    assert.equal(await page.locator('#reportPreview .report-item').count(), 2);
    assert.match(await page.locator('#reportPreview').innerText(), /Renew passport/);
    assert.doesNotMatch(await page.locator('#reportPreview').innerText(), /Garden plans/);
  });

  await check('type and status filters narrow the report and can be cleared', async () => {
    await page.locator('#reportStatusFilter').selectOption('completed');
    assert.equal(await page.locator('#reportPreview .report-item').count(), 1);
    assert.match(await page.locator('#reportPreview').innerText(), /Renew passport/);
    await page.locator('#reportKind').selectOption('note');
    assert.equal(await page.locator('#reportPreview .report-item').count(), 0);
    await page.locator('.report-actions').getByRole('button', { name: 'Clear filters' }).click();
    assert.equal(await page.locator('#reportPreview .report-item').count(), 4);
  });

  await check('type cards filter, generated reports update status, and preview opens item details', async () => {
    await page.locator('.report-type-row').filter({ hasText: 'Task' }).click();
    assert.equal(await page.locator('#reportPreview .report-item').count(), 3);
    await page.getByRole('button', { name: /Generate report/ }).click();
    assert.match(await page.locator('#reportGeneratedAt').innerText(), /Last generated/);
    await page.locator('#reportPreview .report-item').first().click();
    assert.equal(await page.locator('#panel').evaluate((el) => el.classList.contains('open')), true);
  });

  await check('CSV export respects filters and neutralizes spreadsheet formulas', async () => {
    await page.evaluate(() => { closePanel(); });
    await page.locator('#reportSearch').fill('Atlas');
    await page.locator('#reportKind').selectOption('task');
    await page.locator('#reportStatusFilter').selectOption('completed');
    const [filteredDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Export CSV/ }).click(),
    ]);
    const filteredCsv = readFileSync(await filteredDownload.path(), 'utf8').replace(/^\uFEFF/, '');
    assert.match(filteredCsv, /Renew passport/);
    assert.doesNotMatch(filteredCsv, /Book a table|Garden plans|Archive reference/);

    await page.locator('.report-actions').getByRole('button', { name: 'Clear filters' }).click();
    await page.locator('#reportPeriod').selectOption('all');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Export CSV/ }).click(),
    ]);
    assert.match(download.suggestedFilename(), /^everything-report-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = readFileSync(await download.path(), 'utf8').replace(/^\uFEFF/, '');
    assert.match(csv, /Renew passport/);
    assert.match(csv, /Archive reference/);
    assert.match(csv, /'=SUM\(1,1\)/);
    assert.equal((csv.match(/"Garden plans"/g) || []).length, 1);
  });

  await check('empty, loading, and invalid-data states are explicit', async () => {
    await page.evaluate(() => { state.items = []; renderReports(); });
    assert.match(await page.locator('#reportPreview').innerText(), /waiting to take shape/i);
    assert.equal(await page.locator('#reportExportButton').isDisabled(), true);
    await page.evaluate(() => { state.items = undefined; renderReports(); });
    assert.match(await page.locator('#reportMessage').innerText(), /records are unavailable/i);
    assert.equal(await page.locator('#reportMessage').getAttribute('role'), 'alert');
    await page.evaluate(() => { state = null; renderReports(); });
    assert.match(await page.locator('#reportMessage').innerText(), /Loading your workspace data/);
  });

  await check('the report layout fits a phone viewport', async () => {
    await page.evaluate((items) => { state = { items, goals: [], projects: [], people: [] }; renderReports(); }, seeded);
    await page.setViewportSize({ width: 375, height: 812 });
    const dimensions = await page.locator('#view-reports').evaluate((el) => ({
      width: el.clientWidth,
      scrollWidth: el.scrollWidth,
    }));
    assert.ok(dimensions.scrollWidth <= dimensions.width, `report content overflows: ${JSON.stringify(dimensions)}`);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nREPORTS CHECKS FAILED' : `\nALL ${results.length} REPORTS CHECKS PASSED`);
