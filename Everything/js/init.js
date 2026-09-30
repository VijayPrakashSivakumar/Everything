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
