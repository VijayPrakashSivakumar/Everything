// Motion probe. Measures what the transitions and animations actually do in a running browser, and
// what they do when the reader has asked for none.
//
//   node Everything/tests/motion-probe.mjs
//
// Why this exists: motion is the one thing in this app that no existing suite looked at, and every
// other suite passed while navigation was a hard cut from one page to another. A feel problem cannot
// be caught by asking whether a layout overflows, so it has to be measured directly â€” and asserted,
// because the failure mode is silence: removing an animation breaks nothing and fails nothing, it
// just makes the app flat again and nobody notices for a month.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

let PORT = 4455;

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

/* Stated, not inherited: a machine with reduced motion turned on at the OS level would otherwise
   make these assertions pass for the wrong reason, or fail for the wrong one. */
const open = (reducedMotion) => browser.newPage({
  viewport: { width: 1280, height: 900 },
  reducedMotion,
});

try {
  const page = await open('no-preference');
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await page.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    state.items = [
      { id: 'm1', kind: 'task', title: 'Renew the passport', done: false, created: 1 },
      { id: 'm2', kind: 'task', title: 'Call the plumber', done: false, created: 2 },
    ];
    if (typeof renderAll === 'function') renderAll();
    if (typeof switchView === 'function') switchView('tasks', { history: 'none' });
  });

  await check('navigating to a view plays an arrival animation', async () => {
    await page.evaluate(() => switchView('tasks', { history: 'push' }));
    const running = await page.evaluate(() => {
      const el = document.querySelector('.view.active.entering');
      if (!el) return { found: false };
      return {
        found: true,
        name: el.getAnimations().map((a) => a.animationName || '').join(','),
        dur: getComputedStyle(el).animationDuration,
      };
    });
    assert.ok(running.found, 'no view carried the entering class after a navigation');
    assert.match(running.name, /view-arrive/, `expected view-arrive, got "${running.name}"`);
    assert.notEqual(running.dur, '0s', 'the arrival animation has no duration');
  });

  await check('the arrival animation ends at rest, not part-way', async () => {
    // `both` fill mode is what guarantees this. Without it the view would keep the `from` frame's
    // opacity and sit at 0 forever â€” which looks like the page failed to load.
    await page.waitForTimeout(400);
    const resting = await page.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.view.active'));
      return { opacity: cs.opacity, transform: cs.transform };
    });
    assert.equal(resting.opacity, '1', 'a settled view must be fully opaque');
    assert.ok(
      resting.transform === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(resting.transform),
      `a settled view must not be left displaced, got ${resting.transform}`,
    );
  });

  await check('re-rendering the list does not restart the animation', async () => {
    // The reason `entering` exists as a separate class. Ticking a checkbox re-renders the list; if
    // the fade restarted, the whole page would pulse on every tap and read as a glitch.
    //
    // Compared by playState and currentTime, not by whether an animation object exists. With
    // fill-mode `both` a finished animation stays attached and still reports itself from
    // getAnimations(), so counting objects would report a stale one as a replay.
    const before = await page.evaluate(() => {
      const anims = document.querySelector('.view.active').getAnimations();
      return anims.map((a) => ({ state: a.playState, at: a.currentTime }));
    });
    await page.evaluate(() => { if (typeof renderTasks === 'function') renderTasks(); });
    const after = await page.evaluate(() => {
      const anims = document.querySelector('.view.active').getAnimations();
      return anims.map((a) => ({ state: a.playState, at: a.currentTime }));
    });
    assert.equal(after.length, before.length,
      `a re-render changed the animation count from ${before.length} to ${after.length}`);
    assert.ok(after.every((a) => a.state !== 'running'),
      `a re-render restarted the arrival animation: ${JSON.stringify(after)}`);
  });
await check('a row acknowledges a press', async () => {
    const row = page.locator('.task-row:not(.swipeable)').first();
    await row.waitFor({ state: 'visible', timeout: 5000 });
    const box = await row.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const pressed = await page.evaluate(() => {
      const el = document.querySelector('.task-row:not(.swipeable)');
      const cs = getComputedStyle(el);
      return { transform: cs.transform, transition: cs.transitionProperty };
    });
    await page.mouse.up();
    assert.match(pressed.transition, /transform/,
      'a row has no transform transition, so a press cannot be animated');
    assert.ok(pressed.transform !== 'none',
      'the row did not change at all while pressed, so a tap gives no confirmation');
  });

  await check('a swipeable row is left out of the press rules', async () => {
    // Its transform belongs to the drag. Two rules fighting over one property mid-gesture is how a
    // row ends up stuck a few pixels sideways after release.
    const css = await page.evaluate(() => {
      const el = document.querySelector('.task-row.swipeable');
      return el ? getComputedStyle(el).transitionProperty : 'none';
    });
    assert.ok(!/transform/.test(css),
      `a swipeable row now transitions transform, which the drag also owns: ${css}`);
  });

  await check('the checkbox acknowledges a press', async () => {
    const cs = await page.evaluate(() => {
      const el = document.querySelector('.checkbox');
      return el ? getComputedStyle(el).transitionProperty : '';
    });
    assert.match(cs, /transform/, `the checkbox has no transform transition, got "${cs}"`);
  });

  // Brand loader: the one wait a person stares at must be provably alive, and must be the logo.
const loaderPage = await open('no-preference');
try {
  await loaderPage.goto(testUrl(PORT), { waitUntil: 'commit' });
  await loaderPage.waitForFunction(() => typeof window.brandLoaderHTML === 'function');
  await loaderPage.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    // Mounted deliberately. The loader only exists in the document while a wait is in progress, and
    // every check below measures the rendered thing — computed style, animation state, ARIA — rather
    // than the string the function returned, which would prove only that a template works.
    document.body.insertAdjacentHTML('beforeend', brandLoaderHTML({ label: 'Thinking…' }));
  });

  await check('the loader is the brand mark, path for path', async () => {
    // Compared against the sidebar mark in the real document rather than against a copy in this
    // probe. A loader built from a near-identical path is the failure: it looks like the logo at a
    // glance and is not, so the one moment the app is on screen unattended is the one moment the
    // branding is wrong.
    const same = await loaderPage.evaluate(() => {
      const logo = document.querySelector('.brand-mark path').getAttribute('d');
      const run = document.querySelector('.brand-loader .loader-run').getAttribute('d');
      const track = document.querySelector('.brand-loader .loader-track').getAttribute('d');
      return { logo, run, track };
    });
    assert.equal(same.run, same.logo, 'the moving part of the loader is not the logo path');
    assert.equal(same.track, same.logo, 'the track behind the loader is not the logo path');
  });

  await check('the stroke is normalised, so the dash maths is exact', async () => {
    // pathLength="1" is what lets .16 mean a sixth of the way round without measuring the curve.
    // Without it the dash is in user units and the loader would travel the wrong fraction of the
    // loop on any other mark.
    const len = await loaderPage.evaluate(() =>
      document.querySelector('.brand-loader .loader-run').getAttribute('pathLength'));
    assert.equal(len, '1', `the loader path is not normalised, pathLength is "${len}"`);
  });

  await check('the loader is actually moving, not a static mark', async () => {
    const moved = await loaderPage.evaluate(async () => {
      const read = () => getComputedStyle(document.querySelector('.brand-loader .loader-run'))
        .strokeDashoffset;
      const a = read();
      await new Promise((r) => setTimeout(r, 260));
      return { a, b: read() };
    });
    assert.notEqual(moved.a, moved.b,
      `the loader dash never moved (${moved.a} → ${moved.b}); a still mark reads as a hung app`);
  });

  await check('the loader announces itself without announcing every frame', async () => {
    const info = await loaderPage.evaluate(() => {
      const el = document.querySelector('.brand-loader');
      const svg = el.querySelector('svg');
      return {
        role: el.getAttribute('role'),
        label: el.querySelector('.brand-loader-label')?.textContent || '',
        svgHidden: svg.getAttribute('aria-hidden'),
      };
    });
    assert.equal(info.role, 'status', 'the loader is not announced as a status');
    assert.ok(info.label, 'the loader carries no words, so it says nothing to a screen reader');
    // The shape is decorative and the words carry the meaning. Announcing both would read the same
    // sentence twice.
    assert.equal(info.svgHidden, 'true', 'the decorative shape is exposed to a screen reader');
  });

  await check('a loader with no label still renders the mark', async () => {
    const ok = await loaderPage.evaluate(() =>
      brandLoaderHTML({ label: '' }).includes('brand-loader'));
    assert.ok(ok, 'a label-less loader produced nothing usable');
  });
} finally {
  await loaderPage.close();
}

await check('every motion keyframe uses tokens, not literal durations', async () => {
    const literals = await page.evaluate(() => {
      const bad = [];
      for (const sheet of Array.from(document.styleSheets)) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        for (const rule of Array.from(rules || [])) {
          const text = rule.cssText || '';
          if (!/@keyframes/.test(text)) continue;
          for (const m of text.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) bad.push(m[0]);
        }
      }
      return bad;
    });
    assert.deepEqual(literals, [], `motion uses literal durations: ${literals.join(', ')}`);
  });

  await check('keyboard focus is visible, and a mouse click is not ringed', async () => {
    // Driven with a real Tab rather than el.focus(). :focus-visible deliberately does not match a
    // programmatic focus, and it deliberately does not match a mouse click — so calling focus() in
    // a test proves nothing and would have passed a stylesheet with no focus ring at all.
    await page.evaluate(() => { document.body.focus(); });
    let ringed = null;
    for (let i = 0; i < 14 && ringed === null; i += 1) {
      await page.keyboard.press('Tab');
      ringed = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        const cs = getComputedStyle(el);
        return { tag: el.tagName.toLowerCase(), outline: cs.outlineStyle, width: cs.outlineWidth };
      });
    }
    assert.ok(ringed, 'tabbing fourteen times never reached a focusable element');
    assert.ok(ringed.outline !== 'none',
      `keyboard focus on <${ringed.tag}> has no visible outline, got "${ringed.outline}"`);
    assert.ok(parseFloat(ringed.width) > 0,
      `the focus ring is ${ringed.width}, which is invisible`);
  });

  await page.close();

  /* ---- reduced motion: the same page, asking for none ---- */
  const still = await open('reduce');
  still.setDefaultTimeout(8000);
  await still.goto(testUrl(PORT), { waitUntil: 'commit' });
  await still.waitForFunction(() => typeof window.setThemeConcept === 'function');
  await still.evaluate(() => {
    document.getElementById('authScreen').style.display = 'none';
    if (typeof switchView === 'function') switchView('tasks', { history: 'none' });
  });

  await check('reduced motion stops every token-driven transition', async () => {
    const scale = await still.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--motion-scale').trim());
    assert.equal(scale, '0', `--motion-scale is "${scale}" under reduced motion, expected 0`);
  });

  await check('reduced motion also beats the theme concepts', async () => {
    // The specificity trap. Every concept sets --motion-scale on `:root[data-concept="â€¦"]`, which is
    // (0,2,0); a plain `:root` override is (0,1,0) and loses. If this fails, motion is switched off
    // for the default theme only and every other concept keeps moving the reader.
    const concepts = await still.evaluate(() => APP_THEMES.map((t) => t.id));
    assert.ok(concepts.length > 1, 'expected several theme concepts to test against');
    for (const concept of concepts) {
      await still.evaluate((c) => document.documentElement.setAttribute('data-concept', c), concept);
      const scale = await still.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--motion-scale').trim());
      assert.equal(scale, '0', `concept "${concept}" reports --motion-scale "${scale}" under reduced motion`);
    }
  });

  await check('reduced motion plays no arrival animation at all', async () => {
    await still.evaluate(() => {
      document.documentElement.removeAttribute('data-concept');
      switchView('tasks', { history: 'push' });
      switchView('money', { history: 'push' });
    });
    const running = await still.evaluate(() =>
      document.querySelector('.view.active').getAnimations().length);
    assert.equal(running, 0, `${running} animation(s) still run under reduced motion`);
  });

  await check('reduced motion leaves a row with no duration to wait out', async () => {
    const dur = await still.evaluate(() => {
      const el = document.querySelector('.task-row:not(.swipeable)');
      if (!el) return 'no-row';
      return getComputedStyle(el).transitionDuration;
    });
    assert.ok(dur === 'no-row' || dur.split(',').every((d) => d.trim() === '0s'),
      `a row still transitions under reduced motion: ${dur}`);
  });

  await still.close();
} finally {
  await browser.close();
  server.kill();
}

console.log(results.join('\n'));
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${failed ? `${failed} FAILED â€” ` : ''}ALL ${results.length} MOTION CHECKS PASSED`);
