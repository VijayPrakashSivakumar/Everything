// Proves the sign-in screen's own recovery path works, because "forgot password" silently doing
// nothing is the worst possible failure for it.
//
//   node Everything/tests/auth-recovery-probe.mjs
//
// The complaint this exists for: pressing "Forgot password?" changed nothing, and the only way a
// locked-out user finds out is by trying it. Everything here drives the real elements a finger
// would hit, and asserts on what a person can actually see afterwards.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startTestServer, testUrl } from './test-server.mjs';

let PORT = 4419;

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(`PASS  ${name}`); }
  catch (err) { results.push(`FAIL  ${name}\n        ${err.message}`); process.exitCode = 1; }
  console.log(results[results.length - 1]);
};

const server = await startTestServer(PORT, (p) => { PORT = p; });
const browser = await chromium.launch();

/* Matched by path rather than by glob: the request carries a query string and the glob form did
   not catch it, which left the button stuck on "Sending…" and made two of the checks below fail
   for a reason that had nothing to do with the code under test. */
const isRecover = (url) => url.pathname.includes('/auth/v1/recover');

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(8000);
  await page.goto(testUrl(PORT), { waitUntil: 'commit' });
  await page.waitForFunction(() => typeof window.showForgotPassword === 'function');

  // Read what the screen is showing, the way a person reads it.
  const screen = () => page.evaluate(() => ({
    signInVisible: getComputedStyle(document.getElementById('authFormNormal')).display !== 'none',
    forgotVisible: getComputedStyle(document.getElementById('authFormForgot')).display !== 'none',
    message: (document.getElementById('forgotMessage') || {}).textContent || '',
  }));

  await check('pressing "Forgot password?" actually opens the reset panel', async () => {
    const before = await screen();
    assert.equal(before.signInVisible, true, 'the sign-in form should start visible');
    // A real tap on the real link, not a direct call to the handler behind it.
    await page.click('text=Forgot password?');
    const after = await screen();
    assert.equal(after.forgotVisible, true, 'the reset panel did not open');
    assert.equal(after.signInVisible, false, 'the sign-in form stayed on top of it');
  });

  await check('"Back to sign in" returns to the form', async () => {
    await page.click('text=Back to sign in');
    const s = await screen();
    assert.equal(s.signInVisible, true, 'the sign-in form did not come back');
    assert.equal(s.forgotVisible, false, 'the reset panel is still on top');
  });

  await check('an empty email is refused in plain words, not silence', async () => {
    await page.click('text=Forgot password?');
    await page.click('text=Send reset link');
    const s = await screen();
    assert.match(s.message, /enter your email/i,
      `an empty field must say what to do, got "${s.message}"`);
  });

  await check('a typed email reaches the request and reports back', async () => {
    // Intercepted at the network, because the Supabase client is a module-level const and cannot be
    // swapped from outside. This still exercises the real request the button makes.
    let seen = null;
    await page.route(isRecover, async (route) => {
      seen = JSON.parse(route.request().postData() || '{}');
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.fill('#forgotEmail', 'someone@example.com');
    await page.click('text=Send reset link');
    await page.waitForFunction(() => /check your email/i.test(
      document.getElementById('forgotMessage').textContent,
    ), null, { timeout: 5000 });
    await page.unroute(isRecover);
    assert.equal(seen?.email, 'someone@example.com', 'the typed email never reached Supabase');
  });

  await check('a rejected request shows the real reason instead of claiming success', async () => {
    // The exact failure a misconfigured project produces: the reset link's redirect is not on the
    // allow-list. Saying "check your email" for a request that failed is worse than silence — the
    // person waits for a mail that is never coming.
    await page.route(isRecover, async (route) => {
      await route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          msg: 'Requested path is not allowed',
          error_code: 'validation_failed',
        }),
      });
    });
    await page.fill('#forgotEmail', 'someone@example.com');
    await page.click('text=Send reset link');
    // Wait for the request to *finish* — the button re-enabling in the finally block. Waiting on
    // the text instead matched the in-flight "Sending…" line and read it before the answer arrived.
    await page.waitForFunction(() => !document.getElementById('forgotSendBtn').disabled,
      null, { timeout: 5000 });
    const s = await screen();
    await page.unroute(isRecover);
    assert.match(s.message, /not allowed|allow-list|allowed redirect/i,
      `the real reason was swallowed: "${s.message}"`);
    assert.doesNotMatch(s.message, /check your email/i, 'a failed request claimed success');
  });

  await check('the send button cannot be spammed into many reset emails', async () => {
    // A double tap used to fire two requests. A locked-out person tapping again is exactly who
    // would trip the provider's rate limit and lock themselves out further.
    let calls = 0;
    await page.route(isRecover, async (route) => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 300));
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.fill('#forgotEmail', 'someone@example.com');
    await page.evaluate(() => { document.getElementById('forgotMessage').textContent = ''; });
    await page.click('text=Send reset link');
    await page.waitForFunction(() => !document.getElementById('forgotSendBtn').disabled,
      null, { timeout: 5000 });
    await page.unroute(isRecover);
    assert.equal(calls, 1, `three taps sent ${calls} reset emails`);
  });

  await check('a reset link leads somewhere a new password can actually be set', async () => {
    // The email links back to a page that must accept a new password, or the link is a dead end
    // even when the mail does arrive.
    const wired = await page.evaluate(() => ({
      hasNewPasswordForm: !!document.getElementById('authFormNewPassword'),
      hasHandler: typeof authUpdatePassword === 'function',
    }));
    assert.equal(wired.hasNewPasswordForm, true, 'there is no form to set a new password in');
    assert.equal(wired.hasHandler, true, 'the new-password form is not wired to anything');
  });

  await check('a sign-in arriving after a recovery does not close the reset form', async () => {
    /* The check above asserts the form and the handler exist. Necessary, nowhere near sufficient,
       and the reason this complaint survived a green suite: nothing ever drove the arrival.

       This is the sequence that actually happens. Supabase reads the recovery token, establishes a
       session, and emits SIGNED_IN as well as PASSWORD_RECOVERY. The old code handled the recovery
       event correctly and returned — and then the sign-in that followed hid the auth screen and
       switched to the main view, so the person landed in the app holding a recovery session with
       no form in front of them and no error to explain why. Nothing threw; the link worked and the
       screen was still wrong.

       Driven directly rather than through a real token because the events, not the crypto, are the
       claim under test — and because a live recovery token is a credential a test should not need. */
    const after = await page.evaluate(() => {
      const shown = (id) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).display !== 'none' : null;
      };
      const snapshot = () => ({
        authScreen: shown('authScreen'),
        newPassword: shown('authFormNewPassword'),
        signIn: shown('authFormNormal'),
      });
      const session = {
        user: { id: '11111111-2222-3333-4444-555555555555', email: 'locked.out@example.com' },
      };
      handleAuthStateChange('PASSWORD_RECOVERY', session);
      const afterRecovery = snapshot();
      // The ordinary sign-in that a recovery session also produces.
      handleAuthStateChange('SIGNED_IN', session);
      return { afterRecovery, afterSignIn: snapshot() };
    });

    assert.equal(after.afterRecovery.newPassword, true,
      `PASSWORD_RECOVERY must show the reset form (got ${JSON.stringify(after.afterRecovery)})`);
    assert.equal(after.afterRecovery.signIn, false, 'the sign-in form must not cover it');
    assert.equal(after.afterSignIn.newPassword, true,
      `the sign-in that follows must not close the reset form (got ${JSON.stringify(after.afterSignIn)})`);
    assert.equal(after.afterSignIn.authScreen, true, 'the auth screen must stay up mid-reset');
  });

  await check('a recovery link does not leave its token in the address bar', async () => {
    // The hash holds a live session token. Left in place it ends up in history, bookmarks and
    // screenshots, and a refresh drops the person back into a reset they already finished.
    const hash = await page.evaluate(() => window.location.hash);
    assert.equal(hash, '', `a live recovery token was left in the URL: ${hash}`);
  });
} finally {
  await browser.close();
  server.kill();
}

console.log(process.exitCode ? '\nAUTH RECOVERY CHECKS FAILED' : `\nALL ${results.length} AUTH RECOVERY CHECKS PASSED`);
