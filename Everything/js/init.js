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
