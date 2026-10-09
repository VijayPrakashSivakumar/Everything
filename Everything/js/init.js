/* ---------- Init ---------- */
restoreRememberedEmail();
if (window.claude) {
  initMultiUser();
} else {
  state = {
    items: [],
    events: [],
    projects: [],
    goals: [],
    people: [],
    theme: localStorage.getItem("theme") || "light",
  };
  if (state.theme)
    document.documentElement.setAttribute("data-theme", state.theme);
}
restoreSidebarCollapse();
syncSidebarMode();
repairVersionMismatch();
refreshIcons();
/* Draw the menu.

   This was missing, and it is the only thing that draws the menu at boot. renderNav() is called from
   nine other places — switchView, the item panel, model writes, utils — but on none of them during
   startup, so #navList sat empty until the person happened to navigate somewhere.

   For a signed-in user the gap was invisible: Firestore's onSnapshot callbacks call renderNav() as
   data arrives, so the menu appeared a moment after loading. It was therefore "always broken" for
   anyone who never receives that data — a signed-out visitor, a Firestore stream that errors, or the
   first paint before the connection is up — and on a phone the sidebar drawer opened onto nothing at
   all, with no list to tap.

   Calling it here costs one innerHTML write at boot and removes the dependency on data arriving to
   draw the navigation. The active item is still decided by activeView, so this does not mark the wrong
   one as current. */
renderNav();
updateNotifBtn();
renderQuote();
restoreDashboardLayout();
enableDashboardDragging();
initShortcuts();
  initBulkToggles();
initTheme();
initBackNavigation();
initInfoTips();
applyLaunchShortcut();
applySharedCapture();
/* updateViaCache: "none" is the part that matters.

   By default the browser is free to satisfy the worker script from its own HTTP cache and only
   revalidate on its own schedule, which can be hours. That produces the worst possible failure for
   this app: the device keeps running last week's sw.js, which serves last week's cache, while the
   deployment is correct and the network is fine. Nothing is visibly broken and nothing is visibly
   new.

   "none" makes the browser fetch the worker from the network every time it checks, so a deploy is
   visible on the next load rather than the next day. The explicit update() below does the same thing
   for the already-registered case, where register() on an existing registration returns immediately
   without checking anything. */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js", { scope: "./", updateViaCache: "none" })
    .then((reg) => {
      swRegistration = reg;
      reg.update().catch(() => {});
      return reg;
    })
    .catch((err) => console.warn("Service worker registration failed:", err));
  /* Coming back to an installed app, and switching back to it, are the moments a stale worker is
     most likely to survive: the tab was never closed, so nothing prompted a check. */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      navigator.serviceWorker.getRegistration().then((reg) => reg?.update()).catch(() => {});
    }
  });
}
initReminderDelivery();
initDayBoundaryRefresh();
setInterval(renderToday, 60000);
setInterval(shuffleQuote, 60000);

/* The brand mark stops waiting, because the app is no longer waiting. Last, so nothing above can be
   seen mid-render: the splash is removed once every view has been switched in, not before, or the
   first thing a person would see is an empty view repainting itself.

   `__appBooted` is set first and unconditionally, because it is what stops the splash from being
   shown over an app that is already usable. The app scripts run during parsing, so anything that
   shows the splash later — a readyState or DOMContentLoaded handler — has to be told the app is
   already up, and this is the only place that knows.

   The fallback timer in index.html removes the splash regardless, so a future edit that throws above
   this line cannot leave someone staring at a spinner that will never resolve. */
window.__appBooted = true;
if (window.__hideBootSplash) window.__hideBootSplash();
