// Proves the inline-help tooltips really open and close, in a real browser, on the places a first
// time user gets stuck. A tooltip that only exists as CSS is exactly the thing that silently
// stops working — the class is still on the element, nothing is ever seen.
//
//   node Everything/tests/help-probe.mjs
//
// Tapping is the case that matters: the app is mostly opened on a phone, where there is no hover
// and no `mouseenter`. So this drives `click()`, which is what a finger produces, and asserts the
// bubble is genuinely visible rather than merely present in the DOM.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl, bootApp } from './test-server.mjs';

let PORT = 4411;
const OUT = new URL('../tmp/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const results = [];
// Each result is printed as it happens, not collected to the end. A probe that only speaks when it
// finishes gives no clue at all about where it stopped, which is the worst possible failure mode
// for a test that is supposed to prove something works.
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  // Playwright's default actionability wait is 30s per click. A selector that is present but
  // hidden would burn that silently and look like a hang, so a failure here surfaces in seconds.
  page.setDefaultTimeout(6000);
  await bootApp(page, PORT);
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  await page.evaluate(() => { if (typeof renderNav === 'function') renderNav(); });
  // The capture fields live in a modal that starts closed, so without this every click below waits
  // for an element nobody can see.
  await page.evaluate(() => openCapture());
  await page.waitForTimeout(250);

  // The notes have to be attached at boot, without anybody opening the capture sheet first.
  await check('the confusing fields carry a note from the start', async () => {
    const mounted = await page.evaluate(() =>
      [...document.querySelectorAll('.info-tip')].map((t) => {
        const label = t.closest('label');
        return { for: label ? label.getAttribute('for') : null, text: t.textContent.trim() };
      }),
    );
    for (const id of ['captureSmartEnabled', 'capturePriority', 'captureRecurrence', 'panelStatusSelect']) {
      assert.ok(mounted.some((m) => m.for === id), `${id} has no info icon`);
    }
    for (const m of mounted) {
      assert.ok(m.text.length > 20, `the note on ${m.for} says nothing useful: "${m.text}"`);
    }
  });

  // Visibility, not existence: a bubble at opacity 0 is not an answer.
  const visible = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const cs = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    return {
      opacity: Number(cs.opacity),
      visibility: cs.visibility,
      w: Math.round(box.width),
      h: Math.round(box.height),
      inViewport: box.left >= 0 && box.right <= window.innerWidth + 1 && box.top >= -1,
    };
  }, sel);

  await check('tapping the icon opens the note and it is really visible', async () => {
    const tip = 'label[for="capturePriority"] .info-tip';
    const before = await visible(`${tip} .info-tip__bubble`);
    assert.equal(before.visibility, 'hidden', 'the note must start hidden');

    await page.click(tip);
    await page.waitForTimeout(220);
    const open = await visible(`${tip} .info-tip__bubble`);
    assert.ok(open.opacity > 0.9, `the note stayed transparent (${open.opacity})`);
    assert.equal(open.visibility, 'visible', 'the note is not visible');
    assert.ok(open.w > 40 && open.h > 20, `the note has no size (${open.w}x${open.h})`);
    assert.ok(open.inViewport, 'the note rendered off the side of the screen');
  });

  await check('the note is announced, not just drawn', async () => {
    const a11y = await page.evaluate(() => {
      const t = document.querySelector('label[for="capturePriority"] .info-tip');
      const b = t.querySelector('.info-tip__bubble');
      return {
        tag: t.tagName,
        expanded: t.getAttribute('aria-expanded'),
        describedby: t.getAttribute('aria-describedby'),
        bubbleId: b.id,
        role: b.getAttribute('role'),
        hidden: b.getAttribute('aria-hidden'),
      };
    });
    assert.equal(a11y.tag, 'BUTTON', 'the icon must be reachable by keyboard');
    assert.equal(a11y.expanded, 'true', 'aria-expanded must track the open state');
    assert.equal(a11y.describedby, a11y.bubbleId, 'aria-describedby must point at the note');
    assert.equal(a11y.role, 'tooltip', 'the note must be marked as a tooltip');
    assert.equal(a11y.hidden, 'false', 'an open note must not be hidden from a screen reader');
  });

  await check('a second tap closes it', async () => {
    const tip = 'label[for="capturePriority"] .info-tip';
    await page.click(tip);
    await page.waitForTimeout(220);
    const closed = await visible(`${tip} .info-tip__bubble`);
    assert.equal(closed.visibility, 'hidden', 'tapping again must close the note');
  });

  await check('Escape closes it', async () => {
    const tip = 'label[for="captureRecurrence"] .info-tip';
    await page.click(tip);
    await page.waitForTimeout(200);
    assert.equal((await visible(`${tip} .info-tip__bubble`)).visibility, 'visible', 'it did not open');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(220);
    assert.equal((await visible(`${tip} .info-tip__bubble`)).visibility, 'hidden', 'Escape did not close it');
  });

  // Escape is the app's own "close the top layer" key, and while the capture sheet is open that
  // layer is the sheet. So every test after the Escape one has to open it again — otherwise it is
  // not testing the note, it is testing a closed dialog.
  const openSheet = async (p) => {
    await p.evaluate(() => openCapture());
    await p.waitForTimeout(200);
  };

  await check('tapping anywhere else closes it, and only one is ever open', async () => {
    await openSheet(page);
    await page.click('label[for="capturePriority"] .info-tip');
    await page.waitForTimeout(180);
    await page.click('label[for="captureRecurrence"] .info-tip');
    await page.waitForTimeout(200);
    const openCount = await page.evaluate(() => document.querySelectorAll('.info-tip.is-open').length);
    assert.equal(openCount, 1, `expected one open note, got ${openCount}`);

    // Inside the sheet, because the sheet covers the page and a tap outside it would be swallowed
    // by the overlay first — which would prove nothing about the note.
    await page.click('#captureText');
    await page.waitForTimeout(220);
    const after = await page.evaluate(() => document.querySelectorAll('.info-tip.is-open').length);
    assert.equal(after, 0, `a tap elsewhere must close the note, ${after} still open`);
  });

  // The point of the feature: the sheet the user is actually stuck in.
  await check('the note works inside the open capture sheet on a phone', async () => {
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    });
    phone.setDefaultTimeout(6000);
    await phone.goto(testUrl(PORT), { waitUntil: 'commit' });
    await phone.waitForFunction(() => typeof window.openCapture === 'function');
    await phone.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
    await openSheet(phone);

    const tip = 'label[for="captureRecurrence"] .info-tip';
    // tap(), not click(): this context has a real touch pointer, and tapping is what a finger does.
    // The field also has to be scrolled into view first — on a 390px sheet it starts below the fold.
    await phone.locator(tip).scrollIntoViewIfNeeded();
    await phone.locator(tip).tap();
    await phone.waitForTimeout(260);
    const open = await phone.evaluate((s) => {
      const el = document.querySelector(s);
      const b = el.querySelector('.info-tip__bubble');
      const box = b.getBoundingClientRect();
      return {
        isOpen: el.classList.contains('is-open'),
        opacity: Number(getComputedStyle(b).opacity),
        visible: getComputedStyle(b).visibility,
        fits: box.left >= 0 && box.right <= window.innerWidth + 1,
        w: Math.round(box.width),
      };
    }, tip);
    assert.ok(open.isOpen, 'tapping the dot on a phone did not open the note');
    assert.ok(open.opacity > 0.9, `the note stayed transparent on a phone (${open.opacity})`);
    assert.equal(open.visible, 'visible', 'the note did not open on touch');
    assert.ok(open.fits, `the note runs off a 390px screen (${open.w}px wide)`);

    await phone.screenshot({ path: `${OUT}help-phone.png` });
    await phone.close();
  });

  // Every theme has to read: the bubble inherits tokens, which is the whole reason there are no
  // per-theme rules, and that only holds if it really inherits.
  await check('the note is readable in every theme', async () => {
    await openSheet(page);
    const concepts = await page.evaluate(() => APP_THEMES.map((t) => t.id));
    for (const c of concepts) {
      await page.evaluate((id) => setThemeConcept(id), c);
      await openSheet(page);
      await page.click('label[for="capturePriority"] .info-tip');
      await page.waitForTimeout(180);
      const r = await page.evaluate(() => {
        const b = document.querySelector('label[for="capturePriority"] .info-tip__bubble');
        const cs = getComputedStyle(b);
        return { text: cs.color, bg: cs.backgroundColor };
      });
      const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = (x) => x.map((v) => v / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce((acc, v, i) => acc + v * [0.2126, 0.7152, 0.0722][i], 0);
      const a = lum(rgb(r.text)); const b = lum(rgb(r.bg));
      const [hi, lo] = a > b ? [a, b] : [b, a];
      assert.ok((hi + 0.05) / (lo + 0.05) >= 3,
        `${c}: the note's own text on its own background is only ${((hi + 0.05) / (lo + 0.05)).toFixed(2)}:1`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    }
    await page.screenshot({ path: `${OUT}help-desktop.png` });
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nHELP CHECKS FAILED' : `\nALL ${results.length} HELP CHECKS PASSED`);
