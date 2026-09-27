// Real-browser check for the theme system. Proves each concept actually changes the design
// tokens, that both schemes resolve, that the choice survives a reload without a flash of the
// wrong theme, and that `default` is still the original look.
//   node Everything/tests/theme-probe.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT = path.resolve(root, '..', 'tmp');
const PORT = 4404;

const server = spawn('node', [path.resolve(root, '..', 'serve.mjs'), String(PORT)], { stdio: 'ignore' });
for (let i = 0; i < 40; i += 1) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/index.html`)).ok) break; } catch { /* not up */ }
  await new Promise((r) => setTimeout(r, 250));
}
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
};

// Reads the tokens actually in force on a real element, not the stylesheet text.
const tokens = () => {
  const cs = getComputedStyle(document.querySelector('.card') || document.body);
  const root = getComputedStyle(document.documentElement);
  return {
    concept: document.documentElement.getAttribute('data-concept'),
    scheme: document.documentElement.getAttribute('data-scheme'),
    accent: root.getPropertyValue('--accent').trim(),
    bg: root.getPropertyValue('--bg').trim(),
    cardBg: cs.backgroundColor,
    radius: cs.borderTopLeftRadius,
    shadow: cs.boxShadow,
  };
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => { document.getElementById('authScreen').style.display = 'none'; });
  // The nav is only built when someone signs in. Build it so the screenshots show the whole
  // app, and so a theme that makes sidebar text unreadable is visible rather than subtle.
  await page.evaluate(() => { if (typeof renderNav === 'function') renderNav(); });

  await check('the app still boots and the picker is built', async () => {
    const n = await page.locator('.theme-option').count();
    assert.equal(n, 4, `four concepts must be offered, got ${n}`);
  });

  await check('default is unchanged: the original palette and shape', async () => {
    const t = await page.evaluate(tokens);
    assert.equal(t.concept, 'default', `expected default, got ${t.concept}`);
    assert.equal(t.accent, '#4361ee', 'the original accent must be untouched');
    assert.equal(t.bg, '#f5f6fb', 'the original background must be untouched');
    assert.equal(t.radius, '12px', 'the original card radius must be untouched');
  });

  const seen = {};
  for (const concept of ['premium', 'focus', 'casual']) {
    await check(`${concept} restyles the app through shared tokens`, async () => {
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

  await check('the concepts are genuinely different, not aliases', async () => {
    const accents = new Set(Object.values(seen).map((t) => t.accent));
    assert.equal(accents.size, 3, `each concept needs its own accent, got ${[...accents].join(' / ')}`);
    const radii = new Set(Object.values(seen).map((t) => t.radius));
    assert.ok(radii.size >= 2, `concepts should differ in shape too, got ${[...radii].join(' / ')}`);
  });

  await check('Deep Work is flat and square, Casual is round', async () => {
    assert.equal(seen.focus.radius, '4px', 'Deep Work must be square');
    assert.equal(seen.focus.shadow, 'none', 'Deep Work must be flat');
    assert.equal(seen.casual.radius, '18px', 'Casual must be round');
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
    await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
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
    for (const concept of ['default', 'premium', 'focus', 'casual']) {
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
            return {
              resting: resting ? contrast(getComputedStyle(resting).color, sidebarBg) : 99,
              active: active ? contrast(getComputedStyle(active).color, sidebarBg) : 99,
              capture: capture ? contrast(getComputedStyle(capture).color, sidebarBg) : 99,
            };
          },
          [concept, scheme],
        );
        assert.ok(ratio.resting >= 3, `${concept}/${scheme}: resting nav contrast ${ratio.resting.toFixed(2)}:1`);
        assert.ok(ratio.active >= 3, `${concept}/${scheme}: active nav contrast ${ratio.active.toFixed(2)}:1`);
        assert.ok(ratio.capture >= 3, `${concept}/${scheme}: capture label contrast ${ratio.capture.toFixed(2)}:1`);
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

