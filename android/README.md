# Everything — Android wrapper (native launch + WebView)

> **What this is:** a minimal native Android shell around the *unchanged* web app.
> It exists for one reason: an installed PWA (WebAPK) always shows Android's
> system-generated launch screen (built from `manifest.json` `name` /
> `background_color` / `theme_color` / `icons`) **before** any page code runs, so
> page code can never style it, animate it, or skip it. The only way to own the
> first frame is to stop launching through the WebAPK and launch through a
> native `Activity` whose window you control.
>
> **Launch flow after this change:**
>
> ```
> tap icon → Theme.Starting system splash (native, branded, ~colors of #bootSplash)
>          → MainActivity + WebView first pixels (index.html shows #bootSplash immediately)
>          → existing web animation → existing app (auth / nav / API untouched)
> ```
>
> There is deliberately **one** Activity, **no** SplashActivity, and **no** TWA /
> Bubblewrap. A second activity or a TWA is exactly what re-introduces the gap
> (white flash / Chrome splash) this wrapper removes.

## Files (all new — nothing in `Everything/` is modified)

| File | Why it exists |
| ---- | ------------- |
| `settings.gradle` / `build.gradle` / `gradle.properties` / `app/build.gradle` | Standard AGP shell. Only notable dep is `androidx.core:core-splashscreen` — the current best-practice splash API (Android 12+ backported). |
| `app/src/main/AndroidManifest.xml` | `INTERNET` permission, `MainActivity` as `LAUNCHER`, `hardwareAccelerated`, theme `Theme.Starting`, deep-link intent-filter for `?capture=1` / `?view=` shortcuts. |
| `app/src/main/java/com/everything/app/MainActivity.kt` | Owns the handoff. `installSplashScreen()` + `setKeepOnScreenCondition { !webReady }` keeps the native splash until the WebView's first pixels (`onPageCommitVisible`) are ready, then reveals the already-animating `#bootSplash`. WebView settings preserve auth/storage/API. |
| `app/src/main/res/values/themes.xml` | `Theme.Starting` (system splash: bg + animated icon) → `postSplashScreenTheme` → `Theme.Everything` (same `windowBackground` so there is no color pop). |
| `app/src/main/res/values/colors.xml` | Single source for the handoff color. `splash_bg` / `app_bg` **must** equal the web splash background `var(--bg, #f5f6fb)` → `#F5F6FB`. |
| `app/src/main/res/drawable/splash_icon.xml` | Static vector of the brand mark (same infinity path + `#4361EE → #7B2FF7` gradient as `#bootSplashGrad`). The *motion* lives in the web animation that follows; the native icon just needs to be the same mark so the cut is invisible. |
| `app/src/main/res/layout/activity_main.xml` | Full-screen `WebView` with the same background so no white frame shows around first paint. |

## Why not TWA / Bubblewrap?

A Trusted Web Activity still launches through Chrome and still shows Chrome's
generated splash (plus requires `assetlinks.json` + Play signing). A plain
`WebView` keeps cookies / `localStorage` / Supabase session inside your own
Activity, needs no asset-links handshake, and lets `windowBackground` ==
WebView background == `#bootSplash` background, which is what kills the flash.

## Build & run

1. Open `android/` in Android Studio (Giraffe+), let Gradle sync.
2. Set `PROD_URL` in `MainActivity.kt` to the deployed URL
   (default `https://everything-app-zeta.vercel.app/`).
3. Run on a device (API 26+; splash animation is richest on 31+).
4. Install from Play / sideload and **uninstall the old PWA WebAPK** (or users
   will have two icons). Optional follow-up only: set
   `prefer_related_applications: true` + `related_applications` in
   `Everything/manifest.json` to nudge PWA users to the Play app.

## The no-flash contract (check these if you touch anything)

1. `windowSplashScreenBackground` == `windowBackground` == `WebView` background
   == web `--bg` fallback `#F5F6FB`. Any one of these a different color *is* the flash.
2. Dismiss on `onPageCommitVisible`, **not** `onPageFinished`. `onPageFinished`
   fires after all 15 `js/*.js` + CDN scripts settle — holding the splash that
   long re-introduces a stuck-feeling pause; committing visible fires the moment
   `index.html` (which shows `#bootSplash` synchronously during parsing) can draw.
3. Single Activity. Do **not** add a `SplashActivity` that starts `MainActivity` —
   the activity transition itself is a blank frame.
4. Do **not** set `android:windowDisablePreview="true"` — that *creates* the
   black/white gap the splash is there to cover.

## Optional pixel-perfect handoff (web change, NOT required)

Default behaviour (no web change) is already gapless: native splash →
`#bootSplash` animating. If you want dismissal timed to `__appBooted` instead of
first paint, add one line inside `window.__hideBootSplash` in `Everything/index.html`:

```js
if (window.AndroidSplash) window.AndroidSplash.hide();
```

`MainActivity` already exposes `AndroidSplash.hide()` via
`addJavascriptInterface`. Behind a `window.AndroidSplash` guard it is a no-op in
browsers / the PWA, so existing probes (`boot-splash-probe.mjs`) are unaffected.
