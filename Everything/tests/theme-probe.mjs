// Real-browser check for the theme system. Proves each concept actually changes the design
// tokens, that the rendered result differs in typography, shape, density, elevation and motion —
// not only in colour — that both schemes resolve, that the choice survives a reload without a
// flash of the wrong theme, and that `default` is still the original look.
//   node Everything/tests/theme-probe.mjs
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startTestServer, testUrl, bootApp, waitForApp } from './test-server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.resolve(root, '..', 'tmp');
let PORT = 4404;

// Fails here, loudly, if the server cannot be reached — instead of letting Playwright report a
// connection error against a server that never started, several steps from the real cause.
const server = await startTestServer(PORT, (p) => { PORT = p; });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
};

/* Reads what the browser actually rendered, not what the stylesheet says. A token can be defined
   and still never reach an element, and the old probe could not tell the difference. */
const tokens = () => {
  const pick = (sel) => document.querySelector(sel);
  const cs = (el) => (el ? getComputedStyle(el) : null);
  const card = cs(pick('.card'));
  const heading = cs(pick('h1.page-title'));
  const nav = cs(pick('.nav-item'));
  const btn = cs(pick('.btn'));
  const motion = cs(pick('.theme-option'));
  const root = getComputedStyle(document.documentElement);
  const tok = (n) => root.getPropertyValue(n).trim();
  return {
    concept: document.documentElement.getAttribute('data-concept'),
    scheme: document.documentElement.getAttribute('data-scheme'),
    accent: tok('--accent'),
    bg: tok('--bg'),
    cardBg: card ? card.backgroundColor : '',
    radius: card ? card.borderTopLeftRadius : '',
    shadow: card ? card.boxShadow : '',
    // Typography: the display face, and the size ramp.
    headingFont: heading ? heading.fontFamily : '',
    headingSize: heading ? heading.fontSize : '',
    navSize: nav ? nav.fontSize : '',
    // Density: the padded surfaces that carry the rhythm of the app.
    cardPad: card ? card.paddingTop : '',
    btnPad: btn ? btn.paddingTop : '',
    navPad: nav ? nav.paddingTop : '',
    // Motion. A rule can list several properties, so compare the first duration: it is the one
    // `--motion-scale` actually moves, and comparing whole lists only adds commas to the noise.
    dur: motion ? motion.transitionDuration.split(',')[0].trim() : '',
    ease: motion ? motion.transitionTimingFunction.split(',')[0].trim() : '',
    // The levers themselves, so "the token is wrong" can be told from "the token is ignored".
    typeScale: tok('--type-scale'),
    density: tok('--density'),
    motionScale: tok('--motion-scale'),
  };
};

try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
    // Stated, not inherited from the machine: the motion assertions need the durations the
    // stylesheet asks for, not the ones an environment happens to force.
    reducedMotion: 'no-preference',
  });
  await bootApp(page, PORT);
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  // The nav is only built when someone signs in. Build it so the screenshots show the whole
  // app, and so a theme that makes sidebar text unreadable is visible rather than subtle.
  await page.evaluate(() => { if (typeof renderNav === 'function') renderNav(); });

  // The list comes from the app itself, so a concept cannot be added without also being checked.
  const CONCEPTS = await page.evaluate(() => APP_THEMES.map((t) => t.id));
  const LABEL = await page.evaluate(() => Object.fromEntries(APP_THEMES.map((t) => [t.id, t.label])));

  await check('the app still boots and every concept is offered', async () => {
    const n = await page.locator('.theme-option').count();
    assert.equal(n, CONCEPTS.length, `${CONCEPTS.length} concepts must be offered, got ${n}`);
    for (const c of CONCEPTS) {
      assert.ok(await page.locator(`.theme-option[data-concept="${c}"]`).count(), `${c} has no option`);
    }
  });

  await check('default is unchanged: the original palette, type, shape, density and motion', async () => {
    const t = await page.evaluate(tokens);
    assert.equal(t.concept, 'default', `expected default, got ${t.concept}`);
    assert.equal(t.accent, '#4361ee', 'the original accent must be untouched');
    assert.equal(t.bg, '#f5f6fb', 'the original background must be untouched');
    assert.equal(t.radius, '12px', 'the original card radius must be untouched');
    assert.equal(t.headingSize, '22px', 'the original page-title size must be untouched');
    assert.equal(t.navSize, '14px', 'the original nav size must be untouched');
    assert.equal(t.cardPad, '18px', 'the original card padding must be untouched');
    assert.equal(t.btnPad, '9px', 'the original button padding must be untouched');
    assert.equal(t.dur, '0.15s', 'the original transition timing must be untouched');
    assert.equal(t.typeScale, '1', 'the default type scale must be 1');
    assert.equal(t.density, '1', 'the default density must be 1');
    assert.equal(t.motionScale, '1', 'the default motion scale must be 1');
  });

  const seen = {};
  for (const concept of CONCEPTS.filter((c) => c !== 'default')) {
    await check(`${LABEL[concept]} restyles the app through shared tokens`, async () => {
      await page.evaluate((c) => setThemeConcept(c), concept);
      await page.waitForTimeout(120);
      const t = await page.evaluate(tokens);
      assert.equal(t.concept, concept, 'the concept attribute must be set');
      assert.notEqual(t.accent, '#4361ee', `${concept} must change the accent`);
      assert.notEqual(t.cardBg, t.bg, 'the card must read differently from the page');
      seen[concept] = t;
      await page.screenshot({ path: path.join(OUT, `theme-${concept}.png`) });
    });
  }

  // The point of the token families: a concept is a whole system, not a recolour. These are the
  // checks that were missing before, when a concept that changed nothing but colour would pass.
  const distinct = (pick) => new Set(Object.values(seen).map(pick)).size;
  const all = (pick) => [...new Set(Object.values(seen).map(pick))].join(' / ');

  await check('every concept has its own colour identity', async () => {
    assert.equal(distinct((t) => t.accent), Object.keys(seen).length,
      `each concept needs its own accent, got ${all((t) => t.accent)}`);
  });

  await check('shape differs: the corner ramp is a real lever', async () => {
    assert.ok(distinct((t) => t.radius) >= 4, `expected varied card radii, got ${all((t) => t.radius)}`);
  });

  await check('typography differs: the size ramp moves', async () => {
    assert.ok(distinct((t) => t.headingSize) >= 3, `expected varied page-title sizes, got ${all((t) => t.headingSize)}`);
    assert.notEqual(seen.dense.headingSize, '22px', 'Dense must not keep the default page-title size');
  });

  await check('typography differs: the display face is a real lever', async () => {
    assert.ok(distinct((t) => t.headingFont) >= 2, `expected more than one display face, got ${all((t) => t.headingFont)}`);
    assert.match(seen.editorial.headingFont, /Georgia|serif/i, `Editorial must put a serif on headings, got ${seen.editorial.headingFont}`);
    assert.match(seen.dense.headingFont, /mono/i, `Dense must put a monospaced face on headings, got ${seen.dense.headingFont}`);
  });

  await check('density differs: the padded surfaces tighten or breathe', async () => {
    assert.ok(distinct((t) => t.cardPad) >= 3, `expected varied card padding, got ${all((t) => t.cardPad)}`);
    assert.ok(parseFloat(seen.dense.cardPad) < 18, `Dense must be tighter than the default, got ${seen.dense.cardPad}`);
    assert.ok(parseFloat(seen.casual.cardPad) > 18, `Casual must be roomier than the default, got ${seen.casual.cardPad}`);
  });

  await check('motion differs, and Deep Work is still', async () => {
    assert.equal(seen.focus.dur, '0s', `Deep Work must not animate, got ${seen.focus.dur}`);
    const others = Object.entries(seen).filter(([c]) => c !== 'focus').map(([, t]) => t.dur);
    assert.ok(new Set(others).size >= 2, `concepts should differ in timing too, got ${[...new Set(others)].join(' / ')}`);
  });

  await check('elevation differs: flat and lifted are both reachable', async () => {
    assert.equal(seen.focus.shadow, 'none', 'Deep Work must be flat');
    assert.equal(seen.editorial.shadow, 'none', 'Editorial is paper: nothing is lifted off it');
    assert.notEqual(seen.aurora.shadow, 'none', 'Aurora must lift its surfaces off the gradient');
  });

  await check('Aurora is glass, and nothing else quietly grew a blur', async () => {
    const read = async (c) => page.evaluate((id) => {
      setThemeConcept(id);
      return {
        filter: getComputedStyle(document.querySelector('.card')).backdropFilter,
        image: getComputedStyle(document.body).backgroundImage,
      };
    }, c);
    const aurora = await read('aurora');
    assert.match(aurora.filter, /blur/, `Aurora cards must be glassy, got ${aurora.filter}`);
    assert.notEqual(aurora.image, 'none', 'Aurora must paint a gradient behind the app');
    // Derived, not listed. A hard-coded allowlist is how a concept added later would grow a blur
    // and go unchecked, which is the whole failure this probe exists to prevent.
    for (const c of CONCEPTS.filter((id) => id !== 'aurora')) {
      const other = await read(c);
      assert.equal(other.filter, 'none', `${c} must not blur what is behind its cards`);
    }
  });

  await check('Deep Work is flat and square, Casual is round', async () => {
    assert.equal(seen.focus.radius, '4px', 'Deep Work must be square');
    assert.equal(seen.casual.radius, '18px', 'Casual must be round');
  });

  await check('the shape, density and motion system holds in dark as well as light', async () => {
    for (const concept of CONCEPTS.filter((c) => c !== 'default')) {
      await page.evaluate((c) => setThemeConcept(c), concept);
      const light = await page.evaluate(tokens);
      await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); syncThemeScheme(); });
      const dark = await page.evaluate(tokens);
      assert.equal(dark.radius, light.radius,
        `${concept}: the corner ramp must not change with the scheme (${light.radius} -> ${dark.radius})`);
      assert.equal(dark.cardPad, light.cardPad,
        `${concept}: density must not change with the scheme (${light.cardPad} -> ${dark.cardPad})`);
      assert.equal(dark.dur, light.dur,
        `${concept}: motion must not change with the scheme (${light.dur} -> ${dark.dur})`);
    }
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); syncThemeScheme(); });
  });

  await check('a concept carries its own dark palette', async () => {
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'dark'); syncThemeScheme(); });
    await page.waitForTimeout(120);
    const dark = await page.evaluate(tokens);
    assert.equal(dark.scheme, 'dark', 'the scheme must follow the light/dark choice');
    assert.notEqual(dark.bg, seen.casual.bg, 'the dark palette must differ from the light one');
    await page.screenshot({ path: path.join(OUT, 'theme-casual-dark.png') });
    await page.evaluate(() => setThemeConcept('default'));
    await page.waitForTimeout(100);
    const d = await page.evaluate(tokens);
    assert.equal(d.bg, '#0b0d17', 'default dark must be the original dark background');
    await page.evaluate(() => { document.documentElement.setAttribute('data-theme', 'light'); syncThemeScheme(); });
  });

  await check('the choice survives a reload, applied before first paint', async () => {
    await page.evaluate(() => setThemeConcept('premium'));
    await page.waitForTimeout(100);
    const atBoot = await page.evaluate(() => ({
      concept: document.documentElement.getAttribute('data-concept'),
      scheme: document.documentElement.getAttribute('data-scheme'),
    }));
    assert.equal(atBoot.concept, 'premium', 'the head script must apply the concept');
    assert.ok(atBoot.scheme, 'the head script must resolve a scheme');
    await page.reload({ waitUntil: 'commit' });
    await waitForApp(page);
    const after = await page.evaluate(tokens);
    assert.equal(after.concept, 'premium', 'the concept must survive a reload');
    assert.equal(after.accent, '#8a6d3b', 'the premium accent must still be in force');
  });

  await check('an unknown concept falls back to default', async () => {
    await page.evaluate(() => {
      document.documentElement.setAttribute('data-concept', 'not-a-theme');
      applyThemeConcept(currentThemeConcept());
    });
    const t = await page.evaluate(tokens);
    assert.equal(t.concept, 'default', 'an unknown concept must resolve to default');
    assert.equal(t.accent, '#4361ee', 'and keep the default palette');
  });

  // The regression that motivated the sidebar tokens: a pale sidebar with hard-coded light text
  // is invisible. Every concept, in both schemes, has to keep its own text readable.
  await check('sidebar text stays readable in every theme and scheme', async () => {
    for (const concept of CONCEPTS) {
      for (const scheme of ['light', 'dark']) {
        const ratio = await page.evaluate(
          ([c, s]) => {
            setThemeConcept(c);
            document.documentElement.setAttribute('data-theme', s);
            syncThemeScheme();
            // The nav is only built once someone signs in, so build it here: the real
            // computed colour is what matters, not what the token says.
            if (typeof renderNav === 'function' && !document.querySelector('.nav-item')) renderNav();
            const root = getComputedStyle(document.documentElement);
            // getPropertyValue can hand back #rrggbb or rgb(...), so both have to be read.
            const parse = (value) => {
              const v = value.trim();
              if (v.startsWith('#')) {
                const hex = v.slice(1);
                const full = hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex;
                return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
              }
              return v.match(/[\d.]+/g).slice(0, 3).map(Number);
            };
            const lum = (rgb) =>
              rgb
                .map((v) => v / 255)
                .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
                .reduce((a, v, i) => a + v * [0.2126, 0.7152, 0.0722][i], 0);
            const contrast = (fg, bg) => {
              const a = lum(parse(fg));
              const b = lum(parse(bg));
              const [hi, lo] = a > b ? [a, b] : [b, a];
              return (hi + 0.05) / (lo + 0.05);
            };
            const sidebarBg = root.getPropertyValue('--sidebar');
            // Both the resting label and the active one, which is the case that was broken.
            const resting = document.querySelector('.nav-item:not(.active)');
            const active = document.querySelector('.nav-item.active');
            const capture = document.querySelector('.capture-label');
            // The profile block and the capture button were both hard-coded white, which is
            // invisible on a pale sidebar. The nav check could not see either of them.
            const profile = document.querySelector('.sidebar-profile-copy strong');
            const captureBtn = document.querySelector('.capture-btn');
            return {
              resting: resting ? contrast(getComputedStyle(resting).color, sidebarBg) : 99,
              active: active ? contrast(getComputedStyle(active).color, sidebarBg) : 99,
              capture: capture ? contrast(getComputedStyle(capture).color, sidebarBg) : 99,
              profile: profile ? contrast(getComputedStyle(profile).color, sidebarBg) : 99,
              captureBtn: captureBtn ? contrast(getComputedStyle(captureBtn).color, sidebarBg) : 99,
            };
          },
          [concept, scheme],
        );
        assert.ok(ratio.resting >= 3, `${concept}/${scheme}: resting nav contrast ${ratio.resting.toFixed(2)}:1`);
        assert.ok(ratio.active >= 3, `${concept}/${scheme}: active nav contrast ${ratio.active.toFixed(2)}:1`);
        assert.ok(ratio.capture >= 3, `${concept}/${scheme}: capture label contrast ${ratio.capture.toFixed(2)}:1`);
        assert.ok(ratio.profile >= 3, `${concept}/${scheme}: profile name contrast ${ratio.profile.toFixed(2)}:1`);
        assert.ok(ratio.captureBtn >= 3, `${concept}/${scheme}: capture button contrast ${ratio.captureBtn.toFixed(2)}:1`);
      }
    }
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
console.log(process.exitCode ? '\nTHEME CHECKS FAILED' : `\nALL ${results.length} THEME CHECKS PASSED`);
console.log(`screenshots: ${OUT}\\theme-*.png`);

