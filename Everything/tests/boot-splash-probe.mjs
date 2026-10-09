// Boot splash probe. Measures the one screen a person sees before the app exists, which is exactly
// why nothing else could check it: every other suite waits for the app to boot, and by then the
// splash has already been removed.
//
//   node Everything/tests/boot-splash-probe.mjs
//
// Why this exists: two separate failures, both of which look finished in the source.
//
// The mark was 84px of box for roughly 50px of ink, because the curve fills only 24 of the viewBox's
// 40 units — barely larger than the sidebar logo, on the one screen someone stares at while waiting.
//
// And the travelling dash pointed its stroke at `url(#logoGrad)`, an id defined 280 lines later in
// the sidebar's svg. The splash is shown the instant the parser reaches it, so for its whole life
// that reference resolved to an element that did not exist yet. Per spec an unresolvable paint
// server renders *nothing at all* — so the animation was running, correctly, on a stroke nobody
// could see, leaving a still 20%-opacity track on screen. A still mark on a blank screen is exactly
// what a hung page looks like, which is the one thing a loading indicator must never look like.
//
// Neither fault is visible by reading the markup, so this measures the rendered result.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

let PORT = 4477;

const results = [];
const check = async (name, fn) => {
  try {
    await fn();
    results.push(`PASS  ${name}`);
  } catch (e) {
    results.push(`FAIL  ${name}\n        ${e.message}`);
    process.exitCode = 1;
  }
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

/* Held back on purpose. The splash exists in the gap before js/init.js runs, so waiting for the boot
   and then looking at it measures nothing — it is already gone. init.js is the one script that
   removes the splash, so delaying exactly that file leaves the real splash, from the real markup, on
   screen — rather than a version of it rebuilt for the test. */
const SPLASH_HOLD_MS = 8000;

async function openSplash(viewport, reducedMotion = 'no-preference', initDelay = SPLASH_HOLD_MS) {
  const page = await browser.newPage({ viewport, reducedMotion });
  await page.route('**/js/init.js', async (route) => {
    await new Promise((r) => setTimeout(r, initDelay));
    // Every check closes its page while this delay is still pending, so the continuation has to be
    // allowed to fail quietly. An unhandled rejection inside a route handler takes the whole process
    // down with it, and the run would report a crash on assertions that had all passed.
    await route.continue().catch(() => {});
  });
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForSelector('#bootSplash', { state: 'visible', timeout: 20000 });
  return page;
}

try {
  /* ---------- it is actually on screen ---------- */

  const page = await openSplash({ width: 1280, height: 900 });

  await check('the splash is shown before the app boots', async () => {
    const shown = await page.evaluate(() => {
      const el = document.getElementById('bootSplash');
      return {
        display: getComputedStyle(el).display,
        booted: window.__appBooted === true,
        covers: el.getBoundingClientRect().width >= window.innerWidth,
      };
    });
    assert.notEqual(shown.display, 'none', 'the splash was never shown');
    assert.equal(shown.booted, false, 'the app had already booted, so this is not the splash gap');
    assert.ok(shown.covers, 'the splash does not cover the viewport');
  });

  /* ---------- the mark is big enough to be the brand ---------- */

  await check('the mark fills enough of the screen to read as a logo', async () => {
    const box = await page.locator('.boot-splash-mark').boundingBox();
    assert.ok(box.width >= 150, `the mark is only ${Math.round(box.width)}px wide on a desktop screen`);
    assert.ok(box.height >= 90, `the mark is only ${Math.round(box.height)}px tall`);
    // The curve fills 24 of the viewBox's 40 units, so the ink is always 60% of the box. Asserted on
    // the box because that is what CSS controls; a future viewBox change moves the ink and this
    // number follows it, which is the point.
    const ink = box.width * (24 / 40);
    assert.ok(ink >= 100, `the drawn logo is only ${Math.round(ink)}px of ink wide`);
  });

  await check('the word is set at a size that belongs to the mark', async () => {
    const word = await page.evaluate(() => {
      const el = document.querySelector('.boot-splash-name');
      const mark = document.querySelector('.boot-splash-mark').getBoundingClientRect();
      const style = getComputedStyle(el);
      return {
        size: parseFloat(style.fontSize),
        gap: parseFloat(style.marginTop),
        markWidth: mark.width,
        text: el.textContent.trim(),
      };
    });
    assert.equal(word.text.toLowerCase(), 'everything', 'the word under the mark is not the app name');
    // Under about a twentieth of the mark the word stops being the name of the app and becomes a
    // caption on a logo.
    assert.ok(word.size >= word.markWidth / 20,
      `the word is ${word.size}px under a ${Math.round(word.markWidth)}px mark — too small to lock up`);
    assert.ok(word.gap > 0, 'the word is jammed against the mark');
  });

  /* ---------- the animation is visible, not merely running ---------- */

  await check('the travelling dash resolves to a paint that exists', async () => {
    const stroke = await page.evaluate(() => {
      const run = document.querySelector('.boot-splash .loader-run');
      const computed = getComputedStyle(run);
      const url = /url\(["']?#([^"')]+)/.exec(computed.stroke);
      return {
        stroke: computed.stroke,
        referenced: url ? url[1] : '',
        resolved: url ? !!document.getElementById(url[1]) : false,
        // The whole failure was a borrow, so this is the check that stops it becoming one again.
        insideSplash: url
          ? !!document.querySelector(`.boot-splash-mark #${CSS.escape(url[1])}`)
          : false,
      };
    });
    assert.notEqual(stroke.stroke, 'none', 'the travelling dash has no stroke at all');
    assert.ok(stroke.referenced, `the dash is not painted by a gradient (got "${stroke.stroke}")`);
    assert.ok(stroke.resolved,
      `the dash points at #${stroke.referenced}, which does not exist — an unresolvable paint server ` +
      'renders nothing, so the animation runs on an invisible stroke');
    assert.ok(stroke.insideSplash,
      `the dash borrows #${stroke.referenced} from outside its own svg. The splash is shown before ` +
      'the rest of the document is parsed, so anything defined further down the page is not there ' +
      'yet to be painted with — that is the fault this line exists to keep fixed.');
  });

  await check('the dash is genuinely moving, not painted once and left', async () => {
    const motion = await page.evaluate(async () => {
      const run = document.querySelector('.boot-splash .loader-run');
      const running = run.getAnimations().filter((a) => a.playState === 'running');
      const first = getComputedStyle(run).strokeDashoffset;
      await new Promise((r) => setTimeout(r, 450));
      return { count: running.length, first, second: getComputedStyle(run).strokeDashoffset };
    });
    assert.ok(motion.count > 0, 'nothing is animating the dash — the splash is a still mark');
    assert.notEqual(motion.second, motion.first,
      `the dash offset never changed (${motion.first}) — the animation is declared but not running`);
  });

  /* ---------- reduced motion is still a status, not a hang ---------- */

  await check('reduced motion stops the travel but keeps the mark readable', async () => {
    const calm = await openSplash({ width: 1280, height: 900 }, 'reduce');
    try {
      const out = await calm.evaluate(() => {
        const run = document.querySelector('.boot-splash .loader-run');
        const style = getComputedStyle(run);
        return {
          animation: style.animationName,
          offset: style.strokeDashoffset,
          stroke: style.stroke,
          width: document.querySelector('.boot-splash-mark').getBoundingClientRect().width,
        };
      });
      assert.equal(out.animation, 'none', 'the dash still travels under prefers-reduced-motion');
      assert.notEqual(out.stroke, 'none', 'reduced motion left the dash unpainted');
      // Half the loop, so it still reads as "working" rather than as a frozen frame.
      assert.notEqual(parseFloat(out.offset), -1,
        'the dash is parked at the end of its travel, which looks like a stuck frame');
      assert.ok(out.width >= 150, 'the mark is small under reduced motion too');
    } finally {
      await calm.close();
    }
  });

  /* ---------- a phone ---------- */

  await check('the mark scales down on a phone without vanishing', async () => {
    const phone = await openSplash({ width: 390, height: 844 });
    try {
      const out = await phone.evaluate(() => {
        const mark = document.querySelector('.boot-splash-mark').getBoundingClientRect();
        const word = parseFloat(getComputedStyle(document.querySelector('.boot-splash-name')).fontSize);
        return { width: mark.width, height: mark.height, word, viewWidth: window.innerWidth };
      });
      assert.ok(out.width >= 120,
        `the mark is only ${Math.round(out.width)}px wide on a 390px phone — a speck`);
      assert.ok(out.width <= out.viewWidth,
        `the mark (${Math.round(out.width)}px) is wider than the screen (${out.viewWidth}px)`);
      assert.ok(out.word >= 15, `the word shrank to ${out.word}px on a phone`);
    } finally {
      await phone.close();
    }
  });

  await check('the startup animation plays before the login screen is exposed', async () => {
    const fresh = await openSplash({ width: 1280, height: 900 }, 'no-preference', 50);
    try {
      await fresh.waitForFunction(() => window.__appBooted === true, null, { timeout: 45000 });
      const startup = await fresh.evaluate(() => ({
        display: getComputedStyle(document.getElementById('bootSplash')).display,
        animation: getComputedStyle(document.querySelector('.boot-splash .loader-run')).animationName,
        authDisplay: getComputedStyle(document.getElementById('authScreen')).display,
      }));
      assert.notEqual(startup.display, 'none',
        'the startup splash disappeared as soon as initialization completed');
      assert.notEqual(startup.animation, 'brand-loader-run',
        'the brand animation must not run on the boot/splash screen');
      assert.equal(startup.authDisplay, 'flex',
        'the login screen should be ready behind the startup animation');
      await fresh.waitForFunction(
        () => getComputedStyle(document.getElementById('bootSplash')).display === 'none',
        null,
        { timeout: 3000 },
      );
    } finally {
      await fresh.close();
    }
  });

  /* ---------- the app still comes up ---------- */

  await check('the splash still gets out of the way when the app boots', async () => {
    const fresh = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await fresh.goto(testUrl(PORT), { waitUntil: 'commit' });
      await fresh.waitForFunction(() => window.__appBooted === true, null, { timeout: 45000 });
      await fresh.waitForFunction(
        () => getComputedStyle(document.getElementById('bootSplash')).display === 'none',
        null,
        { timeout: 3000 },
      );
    } finally {
      await fresh.close();
    }
  });

  await check('signed-in data sync shows and then hides the full-screen loader', async () => {
    const fresh = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await fresh.goto(testUrl(PORT), { waitUntil: 'commit' });
      await fresh.waitForFunction(() => window.__appBooted === true, null, { timeout: 45000 });
      const shown = await fresh.evaluate(() => {
        window.startSupabaseSync = () =>
          new Promise((resolve) => { window.__resolveInitialSync = resolve; });
        window.showInviteCode = () => {};
        window.loadHouseholdName = () => {};
        window.loadProfile = () => {};
        handleAuthStateChange("SIGNED_IN", {
          user: { id: "loading-probe-user", email: "loading-probe@example.com" },
        });
        const el = document.getElementById('bootSplash');
        return {
          display: getComputedStyle(el).display,
          accessible: el.getAttribute('aria-hidden') === 'false',
          busy: document.body.getAttribute('aria-busy') === 'true',
        };
      });
      assert.notEqual(shown.display, 'none', 'sign-in did not show the full-screen loader');
      assert.ok(shown.accessible, 'the loading status is hidden from assistive technology');
      assert.ok(shown.busy, 'the page is not marked busy while loading');
      await fresh.evaluate(() => window.__resolveInitialSync());
      await fresh.waitForFunction(
        () => getComputedStyle(document.getElementById('bootSplash')).display === 'none',
      );
      const hidden = await fresh.evaluate(() => ({
        display: getComputedStyle(document.getElementById('bootSplash')).display,
        busy: document.body.hasAttribute('aria-busy'),
      }));
      assert.equal(hidden.display, 'none', 'the loader did not hide when data loading finished');
      assert.ok(!hidden.busy, 'the page remained marked busy after data loading finished');
    } finally {
      await fresh.close();
    }
  });

  await check('ordinary view switches do not show the full-screen loader', async () => {
    const fresh = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await fresh.goto(testUrl(PORT), { waitUntil: 'commit' });
      await fresh.waitForFunction(() => window.__appBooted === true, null, { timeout: 45000 });
      await fresh.waitForFunction(
        () => getComputedStyle(document.getElementById('bootSplash')).display === 'none',
        null,
        { timeout: 3000 },
      );
      const display = await fresh.evaluate(() => {
        switchView('tasks');
        return getComputedStyle(document.getElementById('bootSplash')).display;
      });
      assert.equal(display, 'none', 'a normal view switch showed the full-screen loader');
    } finally {
      await fresh.close();
    }
  });

  await page.close();
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode ? `\n${results.filter((r) => r.startsWith('FAIL')).length} FAILED`
  : `\nALL ${results.length} TESTS PASSED`);
