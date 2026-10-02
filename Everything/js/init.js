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
restoreNudge();
restoreDashboardLayout();
enableDashboardDragging();
initShortcuts();
  initBulkToggles();
initTheme();
initBackNavigation();
initInfoTips();
applyLaunchShortcut();
applySharedCapture();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .then((reg) => {
      swRegistration = reg;
      return reg;
    })
    .catch((err) => console.warn("Service worker registration failed:", err));
}
initReminderDelivery();
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
