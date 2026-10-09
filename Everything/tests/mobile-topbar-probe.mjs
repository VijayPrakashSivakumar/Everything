// Checks that the mobile topbar keeps its utility actions aligned beside the menu and brand mark.
//   node Everything/tests/mobile-topbar-probe.mjs
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { bootApp, startTestServer } from './test-server.mjs';

let PORT = 4430;
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
  await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    window.fetch = () => Promise.resolve({ ok: false, status: 0, json: async () => ({}) });
  });

  const widths = [320, 375, 414, 600, 601, 768, 1024, 1280];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 850 });
    await page.waitForTimeout(60);
    const layout = await page.evaluate(() => {
      const topbar = document.querySelector('.topbar');
      const actions = document.querySelector('.topbar-actions');
      const search = document.querySelector('.search-wrap');
      const searchToggle = document.getElementById('mobileSearchToggle');
      const menu = document.getElementById('hamburger');
      const box = (element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      return {
        viewport: document.documentElement.clientWidth,
        document: document.documentElement.scrollWidth,
        topbar: box(topbar),
        actions: box(actions),
        search: box(search),
        searchControl: box(document.querySelector('.search-box')),
        searchToggle: box(searchToggle),
        searchDisplay: getComputedStyle(search).display,
        searchToggleDisplay: getComputedStyle(searchToggle).display,
        topbarSearchOpen: document.querySelector('.topbar').classList.contains('is-search-open'),
        capture: box(document.querySelector('.mobile-capture-btn')),
        topbarCenter: (() => {
          const rect = topbar.getBoundingClientRect();
          return (rect.top + rect.bottom) / 2;
        })(),
        menu: box(menu),
        actionButtons: [...actions.querySelectorAll('.icon-btn, .avatar')].filter(
          (element) => element.getClientRects().length && getComputedStyle(element).display !== 'none',
        ).map((element) => ({
          label: element.getAttribute('aria-label') || element.title,
          ...box(element),
        })),
        actionTargets: [...actions.querySelectorAll('.topbar-menu-wrap')].filter(
          (element) => element.getClientRects().length,
        ).map(box),
        paletteDisplay: getComputedStyle(document.getElementById('paletteBtn')).display,
        actionsDisplay: getComputedStyle(actions).display,
        captureDisplay: getComputedStyle(document.querySelector('.mobile-capture-btn')).display,
      };
    });

    await check(`${width}px: header and controls fit without horizontal overflow`, async () => {
      assert.ok(layout.document <= layout.viewport + 1, `document=${layout.document}, viewport=${layout.viewport}`);
      if (width <= 600) {
        assert.equal(layout.searchDisplay, 'none', 'inline search field is crowding the phone navigation');
        assert.notEqual(layout.searchToggleDisplay, 'none', 'mobile search button is missing');
      } else {
        assert.ok(layout.search.width >= 120, `search width is only ${layout.search.width}px`);
        assert.equal(layout.searchToggleDisplay, 'none', 'mobile search button should not replace desktop search');
      }
      if (width <= 900) {
        assert.ok(layout.capture.width >= 44, `Capture shortcut is only ${layout.capture.width}px wide`);
        assert.ok(layout.capture.height >= 40, `Capture shortcut is only ${layout.capture.height}px tall`);
      }
      for (const button of layout.actionButtons) {
        const minimum = button.label === 'Account menu' ? (width <= 600 ? 40 : 32) : (width <= 900 ? 40 : 36);
        assert.ok(button.width >= minimum, `${button.label} target is only ${button.width}px`);
        assert.ok(button.left >= -1 && button.right <= width + 1, `${button.label} is outside the viewport`);
      }
      if (width <= 600) {
        for (const target of layout.actionTargets) {
          assert.ok(target.width >= 40, `menu action target is only ${target.width}px`);
          assert.ok(target.height >= 40, `menu action height is only ${target.height}px`);
        }
      }
    });

    await check(`${width}px: action controls use the intended header row`, async () => {
      assert.equal(layout.paletteDisplay === 'none', width <= 600, 'quick-jump visibility does not match the phone breakpoint');
      if (width <= 600) {
        assert.equal(layout.actionsDisplay, 'flex');
        assert.ok(Math.abs((layout.actions.top + layout.actions.bottom) / 2 - (layout.menu.top + layout.menu.bottom) / 2) < 2, `actions are not aligned with the menu: ${JSON.stringify({ actions: layout.actions, menu: layout.menu })}`);
        assert.ok(Math.abs((layout.capture.top + layout.capture.bottom) / 2 - (layout.menu.top + layout.menu.bottom) / 2) < 2, 'brand mark is not aligned with the menu');
        assert.ok(layout.searchToggle.width >= 40 && layout.searchToggle.height >= 40, 'mobile search target is too small');
        assert.notEqual(layout.captureDisplay, 'none', 'the Capture shortcut disappeared on mobile');
      } else {
        assert.equal(layout.actionsDisplay, 'contents');
        for (const button of layout.actionButtons) {
          assert.ok(Math.abs((button.top + button.bottom) / 2 - layout.topbarCenter) < 2, `${button.label} moved below the search row`);
        }
      }
    });
  }

  await check('mobile menu remains usable and quick-jump stays out of the phone topbar', async () => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.locator('#hamburger').click();
    assert.ok(await page.locator('#sidebar').evaluate((element) => element.classList.contains('open')));
    await page.locator('.sidebar-collapse').click();
    assert.ok(!(await page.locator('#sidebar').evaluate((element) => element.classList.contains('open'))));
    assert.equal(await page.locator('#paletteBtn').evaluate((element) => getComputedStyle(element).display), 'none');
    await page.setViewportSize({ width: 1280, height: 850 });
    await page.waitForTimeout(60);
    await page.locator('#paletteBtn').click();
    assert.ok(await page.locator('#commandPalette').evaluate((element) => element.classList.contains('open')));
    await page.keyboard.press('Escape');
  });

  await check('mobile search expands below the navigation, focuses, and closes on Escape or outside tap', async () => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(60);
    await page.locator('#mobileSearchToggle').click();
    await page.waitForFunction(() => document.activeElement.id === 'searchInput');
    const openState = await page.evaluate(() => {
      const topbar = document.querySelector('.topbar');
      const search = document.getElementById('searchWrap').getBoundingClientRect();
      const actions = document.querySelector('.topbar-actions').getBoundingClientRect();
      return {
        open: topbar.classList.contains('is-search-open'),
        expanded: document.getElementById('mobileSearchToggle').getAttribute('aria-expanded'),
        focused: document.activeElement.id,
        searchDisplay: getComputedStyle(document.getElementById('searchWrap')).display,
        searchWidth: search.width,
        searchTop: search.top,
        actionsBottom: actions.bottom,
      };
    });
    assert.equal(openState.open, true);
    assert.equal(openState.expanded, 'true');
    assert.equal(openState.focused, 'searchInput');
    assert.equal(openState.searchDisplay, 'block');
    assert.ok(openState.searchWidth >= 300, `expanded search width is only ${openState.searchWidth}px`);
    assert.ok(openState.searchTop >= openState.actionsBottom, 'expanded search is not below the navigation controls');
    await page.locator('#mobileSearchToggle').click();
    assert.equal(await page.locator('.topbar').evaluate((element) => element.classList.contains('is-search-open')), false);
    await page.locator('#mobileSearchToggle').click();
    await page.waitForFunction(() => document.activeElement.id === 'searchInput');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.topbar').evaluate((element) => element.classList.contains('is-search-open')), false);
    await page.locator('#mobileSearchToggle').click();
    await page.mouse.click(350, 790);
    assert.equal(await page.locator('.topbar').evaluate((element) => element.classList.contains('is-search-open')), false);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nMOBILE TOPBAR CHECKS FAILED' : `\nALL ${results.length} MOBILE TOPBAR CHECKS PASSED`);
