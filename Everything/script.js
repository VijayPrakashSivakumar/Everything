const SUPABASE_URL = "https://fyikavzqkezjykvxhqnz.supabase.co"; // e.g. https://xxxx.supabase.co
const SUPABASE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5aWthdnpxa2V6anlrdnhocW56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MTA3NDAsImV4cCI6MjEwNTM4Njc0MH0.nNI8-lKsVJCo1vTYCsmQNchBkaOOkJ5ur0FQz_d4QeI";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const VAPID_PUBLIC_KEY =
  "BHWGWugtw2V9RIk_4mItF_ef3sx0ZJBTPuKZVjTEDfOY-o80jJcXXurZlYBhTJAyhqNQzmtBIjDdEguHwyb0hoU";
let deferredInstallPrompt = null;

function isAppInstalled() {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

function isIosDevice() {
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function updateInstallAction() {
  const installItem = document.getElementById("installAppItem");
  if (!installItem) return;
  const canInstall =
    !isAppInstalled() && (deferredInstallPrompt || isIosDevice());
  installItem.style.display = canInstall ? "block" : "none";
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  updateInstallAction();
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  updateInstallAction();
});

async function installApp() {
  if (isIosDevice() && !deferredInstallPrompt) {
    alert(
      'To install Everything, tap Share in Safari, then choose "Add to Home Screen".',
    );
    return;
  }
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  updateInstallAction();
}

async function authSignUp() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const authError = document.getElementById("authError");

  if (!email || !password) {
    authError.textContent = "Enter both email and password.";
    return;
  }

  try {
    const { error } = await sb.auth.signUp({ email, password });
    authError.textContent = error
      ? error.message
      : "Check your email to confirm, then sign in.";
  } catch (err) {
    authError.textContent = err?.message || "Could not create the account.";
  }
}
async function authSignIn() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const authError = document.getElementById("authError");

  if (!email || !password) {
    authError.textContent = "Enter both email and password.";
    return;
  }

  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    authError.textContent = error ? error.message : "";
  } catch (err) {
    authError.textContent = err?.message || "Could not sign in.";
  }
}
function togglePasswordVisibility(inputId, toggleId) {
  const input = document.getElementById(inputId);
  const toggle = document.getElementById(toggleId);
  const isHidden = input.type === "password";
  input.type = isHidden ? "text" : "password";
  toggle.textContent = isHidden ? "🙈" : "👁️";
}

function showForgotPassword() {
  document.getElementById("authFormNormal").style.display = "none";
  document.getElementById("authFormForgot").style.display = "block";
}
function showNormalAuth() {
  document.getElementById("authFormForgot").style.display = "none";
  document.getElementById("authFormNormal").style.display = "block";
}

async function authForgotPassword() {
  const email = document.getElementById("forgotEmail").value.trim();
  const msg = document.getElementById("forgotMessage");
  if (!email) {
    msg.style.color = "var(--red-fg)";
    msg.textContent = "Enter your email first.";
    return;
  }
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  });
  msg.style.color = error ? "var(--red-fg)" : "var(--accent)";
  msg.textContent = error
    ? error.message
    : "Check your email for a reset link.";
}

async function authUpdatePassword() {
  const pw = document.getElementById("newPassword").value;
  const err = document.getElementById("newPasswordError");
  if (pw.length < 6) {
    err.textContent = "Password must be at least 6 characters.";
    return;
  }
  const { error } = await sb.auth.updateUser({ password: pw });
  if (error) {
    err.textContent = error.message;
    return;
  }
  err.style.color = "var(--accent)";
  err.textContent = "Password updated — signing you in…";
  setTimeout(() => (window.location.href = window.location.origin), 1200);
}
async function authSignOut() {
  const authError = document.getElementById("authError");
  const logoutMessage = document.getElementById("logoutMessage");
  if (authError) authError.textContent = "";
  if (logoutMessage) {
    logoutMessage.textContent = "";
    logoutMessage.style.display = "none";
  }

  try {
    const { error } = await sb.auth.signOut();
    if (error) throw error;
    await sb.removeAllChannels();
  } catch (err) {
    const message = err?.message || "Could not sign out. Please try again.";
    if (logoutMessage) {
      logoutMessage.textContent = message;
      logoutMessage.style.display = "block";
    }
    if (authError) authError.textContent = message;
    return false;
  }
  return true;
}
async function confirmLogoutPage() {
  const logoutButton = document.querySelector(
    '#view-logout button[onclick="confirmLogoutPage()"]',
  );
  if (logoutButton) {
    logoutButton.disabled = true;
    logoutButton.textContent = "Signing out...";
  }
  try {
    const signedOut = await authSignOut();
    if (signedOut) return;
  } finally {
    if (logoutButton) {
      logoutButton.disabled = false;
      logoutButton.innerHTML = `
        <svg class="logout-button-icon" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M8 3H4v14h4" />
          <path d="M11 6l4 4-4 4M6 10h9" />
        </svg>
        Log Out`;
    }
  }
}
let sbUser = null;
let sbChannel = null;
let syncReadyPromise = null;
let hasCompletedAt = false;

function itemToRow(item) {
  const row = {
    id: item.id,
    owner_id: sbUser,
    scope: item.scope || "shared",
    kind: item.kind,
    title: item.title,
    sub: item.sub || "",
    priority: item.priority || "",
    person: item.person || "",
    due: item.due || "",
    due_date: item.dueDate || null,
    recurrence: item.recurrence || "none",
    status: item.status || "",
    project: item.project || "",
    created: item.created,
    done: !!item.done,
    notified: !!item.notified,
    household_id: currentHouseholdId,
    media_url: item.mediaUrl || "",
  };
  // Only sent once the completed_at migration has been applied — see supabase/migrations.
  if (hasCompletedAt)
    row.completed_at = item.completedAt
      ? new Date(item.completedAt).toISOString()
      : null;
  return row;
}
function rowToItem(row) {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    title: row.title,
    sub: row.sub,
    priority: row.priority,
    person: row.person,
    due: row.due,
    dueDate: row.due_date,
    recurrence: row.recurrence,
    status: row.status,
    project: row.project,
    created: Number(row.created),
    done: row.done,
    notified: row.notified,
    mediaUrl: row.media_url,
    completedAt: row.completed_at ? new Date(row.completed_at).getTime() : "",
  };
}

/* items.completed_at arrives with supabase/migrations/001. Probe once at sync time so a
   database that hasn't been migrated yet keeps saving normally (the chart then falls back
   to the local completion log). */
async function detectCompletedAtColumn() {
  try {
    const { error } = await sb.from("items").select("completed_at").limit(1);
    return !error;
  } catch (e) {
    return false;
  }
}

async function startSupabaseSync(userId) {
  await ensureHousehold(userId);
  sbUser = userId;
  hasCompletedAt = await detectCompletedAtColumn();
  const { data, error } = await sb
    .from("items")
    .select("*")
    .eq("household_id", currentHouseholdId)
    .order("created", { ascending: false });
  if (!error && data) {
    state.items = data.map(rowToItem);
    if (!state.projects) state.projects = [];
    if (!state.goals) state.goals = [];
    renderAll();
  }
  if (sbChannel) sb.removeChannel(sbChannel);
  sbChannel = sb
    .channel("items-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "items",
        filter: `household_id=eq.${currentHouseholdId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE") {
          state.items = state.items.filter((i) => i.id !== payload.old.id);
        } else {
          const updated = rowToItem(payload.new);
          const idx = state.items.findIndex((i) => i.id === updated.id);
          if (idx >= 0) state.items[idx] = updated;
          else state.items.unshift(updated);
        }
        renderAll();
      },
    )
    .subscribe();

  const { data: projData } = await sb
    .from("projects")
    .select("*")
    .eq("household_id", currentHouseholdId)
    .order("created", { ascending: false });
  if (projData) state.projects = projData;
  const { data: goalData } = await sb
    .from("goals")
    .select("*")
    .eq("household_id", currentHouseholdId)
    .order("created", { ascending: false });
  if (goalData) state.goals = goalData;
  const { data: peopleData } = await sb
    .from("people")
    .select("*")
    .eq("household_id", currentHouseholdId)
    .order("created", { ascending: false });
  if (peopleData) state.people = peopleData;
  renderProjects();
  renderGoals();
  renderNav();
  renderReports();

  sb.channel("projects-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "projects",
        filter: `household_id=eq.${currentHouseholdId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE")
          state.projects = state.projects.filter(
            (p) => p.id !== payload.old.id,
          );
        else {
          const idx = state.projects.findIndex((p) => p.id === payload.new.id);
          if (idx >= 0) state.projects[idx] = payload.new;
          else state.projects.unshift(payload.new);
        }
        renderProjects();
        renderNav();
      },
    )
    .subscribe();

  sb.channel("goals-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "goals",
        filter: `household_id=eq.${currentHouseholdId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE")
          state.goals = state.goals.filter((g) => g.id !== payload.old.id);
        else {
          const idx = state.goals.findIndex((g) => g.id === payload.new.id);
          if (idx >= 0) state.goals[idx] = payload.new;
          else state.goals.unshift(payload.new);
        }
        renderGoals();
        renderReports();
      },
    )
    .subscribe();

  sb.channel("people-sync")
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "people",
        filter: `household_id=eq.${currentHouseholdId}`,
      },
      (payload) => {
        if (payload.eventType === "DELETE")
          state.people = state.people.filter((p) => p.id !== payload.old.id);
        else {
          const idx = state.people.findIndex((p) => p.id === payload.new.id);
          if (idx >= 0) state.people[idx] = payload.new;
          else state.people.unshift(payload.new);
        }
        renderPeople();
      },
    )
    .subscribe();
}
let currentHouseholdId = null;

async function ensureHousehold(userId) {
  const { data: membership } = await sb
    .from("household_members")
    .select("household_id")
    .eq("user_id", userId)
    .limit(1);
  if (membership && membership.length) {
    currentHouseholdId = membership[0].household_id;
    return;
  }
  const { data: newHouse } = await sb
    .from("households")
    .insert({ created_by: userId, created: Date.now() })
    .select()
    .single();
  if (newHouse) {
    currentHouseholdId = newHouse.id;
    await sb
      .from("household_members")
      .insert({ household_id: newHouse.id, user_id: userId, role: "owner" });
  }
}

async function getInviteCode() {
  const { data } = await sb
    .from("households")
    .select("invite_code")
    .eq("id", currentHouseholdId)
    .single();
  return data ? data.invite_code : null;
}

async function showInviteCode() {
  if (!currentHouseholdId) return;
  const code = await getInviteCode();
  document.getElementById("inviteCodeDisplay").textContent = code || "—";
}

async function loadHouseholdName() {
  if (syncReadyPromise) await syncReadyPromise;
  if (!currentHouseholdId) return;
  const { data } = await sb
    .from("households")
    .select("name")
    .eq("id", currentHouseholdId)
    .single();
  const input = document.getElementById("householdNameInput");
  if (input && data) input.value = data.name || "My Household";
}

async function saveHouseholdName() {
  const name = document.getElementById("householdNameInput").value.trim();
  if (!name || !currentHouseholdId) return;
  await sb.from("households").update({ name }).eq("id", currentHouseholdId);
}

async function joinHousehold() {
  const code = document.getElementById("joinCodeInput").value.trim();
  const msg = document.getElementById("joinMessage");
  if (!code) {
    msg.textContent = "Enter a code.";
    return;
  }
  const { data: house } = await sb
    .from("households")
    .select("id")
    .eq("invite_code", code)
    .single();
  if (!house) {
    msg.style.color = "var(--red-fg)";
    msg.textContent = "Invalid invite code.";
    return;
  }
  await sb.from("household_members").delete().eq("user_id", sbUser);
  await sb
    .from("household_members")
    .insert({ household_id: house.id, user_id: sbUser, role: "member" });
  currentHouseholdId = house.id;
  msg.style.color = "var(--accent)";
  msg.textContent = "Joined! Reloading your data…";
  await startSupabaseSync(sbUser);
  showInviteCode();
}
function toggleAvatarMenu() {
  const menu = document.getElementById("avatarMenu");
  menu.style.display = menu.style.display === "block" ? "none" : "block";
}
document.addEventListener("click", (e) => {
  const menu = document.getElementById("avatarMenu");
  const wrap = document.getElementById("avatarWrap");
  if (
    menu &&
    menu.style.display === "block" &&
    !menu.contains(e.target) &&
    e.target !== wrap &&
    !wrap.contains(e.target)
  ) {
    menu.style.display = "none";
  }
});
function confirmSignOut() {
  if (confirm("Sign out of Everything?")) {
    authSignOut();
  }
  document.getElementById("avatarMenu").style.display = "none";
}

let syncedUserId = null;

sb.auth.onAuthStateChange((event, session) => {
  const authScreen = document.getElementById("authScreen");
  if (event === "PASSWORD_RECOVERY") {
    authScreen.style.display = "flex";
    document.getElementById("authFormNormal").style.display = "none";
    document.getElementById("authFormForgot").style.display = "none";
    document.getElementById("authFormNewPassword").style.display = "block";
    return;
  }
  if (session) {
    authScreen.style.display = "none";
    if (syncedUserId !== session.user.id) {
      syncedUserId = session.user.id;
      syncReadyPromise = startSupabaseSync(session.user.id);
      showInviteCode();
      loadHouseholdName();
      loadProfile();
      document.getElementById("settingsEmail").textContent = session.user.email;
    }
    const name = session.user.email.split("@")[0];
    const greetEl = document.getElementById("greeting");
    if (greetEl) greetEl.textContent = `${greetingText()}, ${name}!`;
    const av = document.getElementById("avatarInitial");
    if (av) av.textContent = name.charAt(0).toUpperCase();
    document.getElementById("avatarMenuEmail").textContent = session.user.email;
  } else {
    syncedUserId = null;
    sbUser = null;
    currentHouseholdId = null;
    syncReadyPromise = null;
    authScreen.style.display = "flex";
  }
});
function showSettingsTab(tab) {
  document
    .querySelectorAll(".settings-panel")
    .forEach((p) => (p.style.display = "none"));
  document.getElementById("settingsTab-" + tab).style.display = "block";
  document
    .querySelectorAll(".tab-vert")
    .forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
}

async function loadProfile() {
  if (syncReadyPromise) await syncReadyPromise;
  if (!sbUser) return;
  const { data } = await sb
    .from("profiles")
    .select("*")
    .eq("user_id", sbUser)
    .single();
  const profile = data || {
    full_name: "",
    phone: "",
    avatar_url: "",
    date_format: "MM/DD/YYYY",
    time_format: "12h",
  };
  document.getElementById("profileFullName").value = profile.full_name || "";
  document.getElementById("profilePhone").value = profile.phone || "";
  document.getElementById("dateFormatSelect").value =
    profile.date_format || "MM/DD/YYYY";
  document.getElementById("timeFormatSelect").value =
    profile.time_format || "12h";
  document.getElementById("themeSelect").value =
    document.documentElement.getAttribute("data-theme") === "dark"
      ? "dark"
      : "light";
  const { data: authData } = await sb.auth.getUser();
  if (authData?.user)
    document.getElementById("profileEmail").value = authData.user.email;
  updateAvatarDisplay(profile.full_name, profile.avatar_url);
}

function updateAvatarDisplay(name, url) {
  const el = document.getElementById("settingsAvatar");
  const initial = document.getElementById("settingsAvatarInitial");
  if (url) {
    el.style.backgroundImage = `url(${url})`;
    el.style.backgroundSize = "cover";
    initial.style.display = "none";
  } else {
    initial.textContent = (
      name ||
      document.getElementById("avatarInitial").textContent ||
      "?"
    )
      .charAt(0)
      .toUpperCase();
  }
}

async function saveProfile() {
  if (!sbUser) return;
  const profile = {
    user_id: sbUser,
    full_name: document.getElementById("profileFullName").value.trim(),
    phone: document.getElementById("profilePhone").value.trim(),
    date_format: document.getElementById("dateFormatSelect").value,
    time_format: document.getElementById("timeFormatSelect").value,
    created: Date.now(),
  };
  const { error } = await sb.from("profiles").upsert(profile);
  if (error) {
    console.error("Profile save failed:", error.message);
    return;
  }
  const av = document.getElementById("avatarInitial");
  if (av && profile.full_name)
    av.textContent = profile.full_name.charAt(0).toUpperCase();
  const greetEl = document.getElementById("greeting");
  if (greetEl && profile.full_name)
    greetEl.textContent = `${greetingText()}, ${profile.full_name.split(" ")[0]}!`;
}

async function uploadAvatar() {
  const file = document.getElementById("avatarUploadInput").files[0];
  if (!file || !sbUser) return;
  const path = `${sbUser}/avatar_${Date.now()}.${file.name.split(".").pop()}`;
  const { error } = await sb.storage.from("captures").upload(path, file);
  if (error) {
    console.error("Avatar upload failed:", error.message);
    return;
  }
  const { data } = sb.storage.from("captures").getPublicUrl(path);
  await sb.from("profiles").upsert({
    user_id: sbUser,
    avatar_url: data.publicUrl,
    created: Date.now(),
  });
  updateAvatarDisplay(null, data.publicUrl);
}

function setThemeFromSelect() {
  const val = document.getElementById("themeSelect").value;
  document.documentElement.setAttribute("data-theme", val);
  state.theme = val;
  save();
}

/* ---------- Data model ---------- */
const NAV = [
  { id: "today", icon: "🏠", label: "Today" },
  { id: "inbox", icon: "📥", label: "Inbox", badgeKey: "inboxCount" },
  { id: "tasks", icon: "✅", label: "Tasks", badgeKey: "taskCount" },
  { id: "schedule", icon: "📅", label: "Schedule" },
  { id: "memory", icon: "🧠", label: "Memory" },
  { id: "people", icon: "👥", label: "People" },
  { id: "projects", icon: "📁", label: "Projects" },
  { id: "goals", icon: "🎯", label: "Goals" },
  { id: "reports", icon: "📊", label: "Reports" },
  { id: "insights", icon: "✨", label: "Insights" },
  { id: "settings", icon: "⚙️", label: "Settings" },
  { id: "logout", icon: "↪️", label: "Logout", divider: true },
];

let state = null;
let currentItemId = null;
let captureType = "text";

function seedData() {
  return {
    items: [],
    events: [],
    projects: [],
    goals: [],
    people: [],
    theme: "light",
  };
}

function cid() {
  return "i_" + Math.random().toString(36).slice(2, 10);
}
function formatDueDisplay(iso) {
  if (!iso) return "";
  const d = new Date(iso),
    now = new Date();
  const timeStr = d.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (d.toDateString() === now.toDateString()) return "Today, " + timeStr;
  const tmrw = new Date(now);
  tmrw.setDate(now.getDate() + 1);
  if (d.toDateString() === tmrw.toDateString()) return "Tomorrow, " + timeStr;
  return (
    d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    ", " +
    timeStr
  );
}
function nextOccurrence(iso, recurrence) {
  const d = new Date(iso);
  if (recurrence === "daily") d.setDate(d.getDate() + 1);
  else if (recurrence === "weekly") d.setDate(d.getDate() + 7);
  else if (recurrence === "monthly") d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}
function isToday(dueDate) {
  if (!dueDate) return false;
  return new Date(dueDate).toDateString() === new Date().toDateString();
}
function isOverdue(item) {
  return (
    !!item.dueDate &&
    !item.done &&
    new Date(item.dueDate).getTime() < Date.now() &&
    !isToday(item.dueDate)
  );
}
function greetingText() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}
const MOTIVATION_QUOTES = [
  "Progress is not about being busy, it's about making things happen.",
  "Small steps taken daily lead to big changes eventually.",
  "You don't need to see the whole staircase, just the next step.",
  "Discipline is choosing between what you want now and what you want most.",
  "Clarity comes from action, not from thinking about it more.",
  "The best time to start was earlier. The next best time is now.",
  "A little progress each day adds up to big results.",
  "Done is better than perfect.",
  "Focus on being productive instead of busy.",
  "Every task you finish makes the next one easier.",
  "What gets captured gets remembered. What gets remembered gets done.",
  "You don't have to be great to start, but you have to start to be great.",
  "Slow progress is still progress.",
  "The secret to getting ahead is getting started.",
  "One task at a time builds momentum.",
  "Consistency beats intensity over time.",
  "A clear list makes for a clear mind.",
  "Your future is built by what you do today, not what you plan for tomorrow.",
  "Action is the antidote to overwhelm.",
  "Organize your intentions and your days will organize themselves.",
];

function getDailyQuoteIndex() {
  const start = new Date(new Date().getFullYear(), 0, 0);
  const diff = Date.now() - start.getTime();
  const dayOfYear = Math.floor(diff / 86400000);
  return dayOfYear % MOTIVATION_QUOTES.length;
}

let currentQuoteIndex = null;

function renderQuote() {
  const el = document.getElementById("heroQuoteText");
  if (!el) return;
  if (currentQuoteIndex === null) currentQuoteIndex = getDailyQuoteIndex();
  el.textContent = MOTIVATION_QUOTES[currentQuoteIndex];
}

function shuffleQuote() {
  let next;
  do {
    next = Math.floor(Math.random() * MOTIVATION_QUOTES.length);
  } while (next === currentQuoteIndex && MOTIVATION_QUOTES.length > 1);
  currentQuoteIndex = next;
  renderQuote();
}

async function saveQuoteToMemory(btnEl) {
  const text = MOTIVATION_QUOTES[currentQuoteIndex];
  const newItem = {
    id: cid(),
    kind: "memory",
    title: text,
    sub: "Saved quote",
    priority: "",
    person: "",
    due: "",
    status: "",
    project: "",
    created: Date.now(),
    done: false,
    scope: "private",
  };
  state.items.unshift(newItem);
  await dbSaveItem(newItem);
  if (!btnEl) return;
  const original = btnEl.textContent;
  btnEl.textContent = "✓ Saved";
  setTimeout(() => {
    btnEl.textContent = original;
  }, 1500);
}

/* ============================================================
   MULTI-USER DATA LAYER
   Everyone who opens this artifact's link (within the org) shares
   the same live data via the `db` capability. Falls back to
   localStorage (single browser only) if `db` isn't granted.
   ============================================================ */
let db = null;

let currentUserId = null;
let sharedItems = [];
let privateItems = [];

function mergeItems() {
  state.items = [...sharedItems, ...privateItems];
}

async function initMultiUser() {
  db = await window.claude?.use("db");
  const user = await window.claude?.use("user");

  if (user) {
    try {
      const me = await user.me();
      currentUserId = me.id;
      document.getElementById("greeting").textContent =
        `Good morning, ${me.name || "there"}!`;
      const av = document.getElementById("avatarInitial");
      if (av) av.textContent = (me.name || "V").charAt(0).toUpperCase();
    } catch (e) {
      /* no identity available in this view — keep defaults */
    }
  }

  if (!db) {
    try {
      const raw = localStorage.getItem("everything_state_v1");
      state = raw ? JSON.parse(raw) : seedData();
    } catch (e) {
      state = seedData();
    }
    if (!state.projects) state.projects = [];
    if (!state.goals) state.goals = [];
    if (!state.people) state.people = [];
    sharedItems = state.items;
    privateItems = [];
    if (state.theme)
      document.documentElement.setAttribute("data-theme", state.theme);
    renderAll();
    return;
  }

  const itemsCol = db.collection("items");
  const projCol = db.collection("projects");
  const goalCol = db.collection("goals");

  const existing = await itemsCol.get();
  if (existing.empty) {
    const seed = seedData();
    for (const it of seed.items) await itemsCol.doc(it.id).set(it);
    for (const p of seed.projects) await projCol.doc(p.id).set(p);
    for (const g of seed.goals) await goalCol.doc(g.id).set(g);
  }

  state = { items: [], projects: [], goals: [], theme: "light" };

  itemsCol.onSnapshot((snap) => {
    sharedItems = snap.docs.map((d) => ({ ...d.data(), scope: "shared" }));
    mergeItems();
    renderAll();
  });
  projCol.onSnapshot((snap) => {
    state.projects = snap.docs.map((d) => d.data());
    renderProjects();
    renderNav();
  });
  goalCol.onSnapshot((snap) => {
    state.goals = snap.docs.map((d) => d.data());
    renderGoals();
    renderReports();
  });

  // Per-person private items — only visible to the signed-in viewer who created them
  if (currentUserId) {
    const privateItemsCol = db
      .doc(`data/users/${currentUserId}/profile`)
      .collection("items");
    privateItemsCol.onSnapshot((snap) => {
      privateItems = snap.docs.map((d) => ({ ...d.data(), scope: "private" }));
      mergeItems();
      renderAll();
    });
  }
}

/* Use these instead of save() whenever items/projects/goals are mutated.
   item.scope must be 'shared' (default) or 'private'. */
function itemCollectionFor(item) {
  if (!db) return null;
  if (item.scope === "private" && currentUserId)
    return db.doc(`data/users/${currentUserId}/profile`).collection("items");
  return db.collection("items");
}
async function dbSaveItem(item) {
  if (syncReadyPromise) await syncReadyPromise;
  if (!item.scope) item.scope = "shared";
  const col = itemCollectionFor(item);
  if (col) {
    await col.doc(item.id).set(item);
  } else if (sbUser) {
    const { error } = await sb.from("items").upsert(itemToRow(item));
    if (error) console.error("Supabase save failed:", error.message);
  } else {
    save();
  }
  renderAll();
}
async function dbDeleteItem(id) {
  if (syncReadyPromise) await syncReadyPromise;
  const item = state.items.find((i) => i.id === id);
  const col = item
    ? itemCollectionFor(item)
    : db
      ? db.collection("items")
      : null;
  if (col) {
    await col.doc(id).delete();
  } else if (sbUser) {
    const { error } = await sb
      .from("items")
      .delete()
      .eq("id", id)
      .eq("household_id", currentHouseholdId);
    if (error) console.error("Supabase delete failed:", error.message);
  } else {
    state.items = state.items.filter((i) => i.id !== id);
    save();
  }
  renderAll();
}
async function dbSaveProject(p) {
  if (syncReadyPromise) await syncReadyPromise;
  if (db) {
    await db.collection("projects").doc(p.id).set(p);
  } else if (sbUser) {
    await sb
      .from("projects")
      .upsert({ ...p, household_id: currentHouseholdId });
  } else {
    save();
    renderProjects();
    renderNav();
  }
}
async function dbSaveGoal(g) {
  if (syncReadyPromise) await syncReadyPromise;
  if (db) {
    await db.collection("goals").doc(g.id).set(g);
  } else if (sbUser) {
    await sb.from("goals").upsert({ ...g, household_id: currentHouseholdId });
  } else {
    save();
    renderGoals();
    renderReports();
  }
}
async function dbSavePerson(p) {
  if (syncReadyPromise) await syncReadyPromise;
  if (db) {
    await db.collection("people").doc(p.id).set(p);
  } else if (sbUser) {
    await sb.from("people").upsert({ ...p, household_id: currentHouseholdId });
  } else {
    save();
    renderPeople();
  }
}

function save() {
  try {
    localStorage.setItem("everything_state_v1", JSON.stringify(state));
  } catch (e) {
    console.error("save failed", e);
  }
}
function resetData() {
  if (db) {
    alert(
      "Reset is disabled in multi-user mode — delete items individually instead.",
    );
    return;
  }
  state = seedData();

  save();
  renderAll();
}

/* ---------- Nav & routing ---------- */
function renderNav() {
  const nav = document.getElementById("navList");
  nav.innerHTML = "";
  NAV.forEach((item) => {
    if (item.divider) {
      const hr = document.createElement("div");
      hr.style.cssText =
        "height:1px;background:var(--sidebar-hover);margin:10px 4px;";
      nav.appendChild(hr);
    }
    const el = document.createElement("div");
    el.className = "nav-item" + (item.id === activeView ? " active" : "");
    let badge = "";
    if (item.id === "inbox") badge = state.items.length;
    if (item.id === "tasks")
      badge = state.items.filter((i) => i.kind === "task" && !i.done).length;
    el.innerHTML = `<div class="left"><span class="nav-icon">${item.icon}</span>${item.label}</div>${badge ? `<span class="nav-badge">${badge}</span>` : ""}`;
    el.onclick = () => switchView(item.id);
    nav.appendChild(el);
  });
}

let activeView = "today";

function switchView(id) {
  activeView = id;
  document
    .querySelectorAll(".view")
    .forEach((v) => v.classList.remove("active"));
  document.getElementById("view-" + id).classList.add("active");
  renderNav();
  if (document.getElementById("sidebar").classList.contains("open"))
    toggleSidebar();
  if (id === "schedule") renderCalendar();
  if (id === "reports") renderReports();
  if (id === "projects") renderProjects();
  if (id === "goals") renderGoals();
  if (id === "tasks") renderTasks();
  if (id === "inbox") renderInbox();
  if (id === "memory") renderMemory();
  if (id === "people") renderPeople();
}

function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
}

/* ---------- Rendering ---------- */
function timeAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "Just now";
  if (m < 60) return m + " minute" + (m > 1 ? "s" : "") + " ago";
  const h = Math.floor(diff / 3600000);
  if (h < 24) return h + " hour" + (h > 1 ? "s" : "") + " ago";
  const d = Math.floor(h / 24);
  if (d === 1) return "Yesterday";
  return d + " days ago";
}

function kindIcon(kind) {
  return (
    {
      task: "✓",
      event: "📅",
      waiting: "⏳",
      memory: "💭",
      project: "📁",
      openloop: "🔴",
      file: "📄",
      voice: "🎙️",
      image: "🖼️",
      link: "🔗",
    }[kind] || "•"
  );
}
function kindColor(kind) {
  return (
    {
      task: ["var(--blue-bg)", "var(--blue-fg)"],
      event: ["var(--purple-bg)", "var(--purple-fg)"],
      waiting: ["var(--amber-bg)", "var(--amber-fg)"],
      memory: ["var(--green-bg)", "var(--green-fg)"],
      project: ["var(--blue-bg)", "var(--blue-fg)"],
      openloop: ["var(--red-bg)", "var(--red-fg)"],
      file: ["var(--purple-bg)", "var(--purple-fg)"],
      voice: ["var(--red-bg)", "var(--red-fg)"],
      image: ["var(--green-bg)", "var(--green-fg)"],
      link: ["var(--blue-bg)", "var(--blue-fg)"],
    }[kind] || ["var(--bg)", "var(--text)"]
  );
}

function renderToday() {
  document.getElementById("todayDate").textContent =
    new Date().toLocaleDateString(undefined, {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  const todays = state.items.filter(
    (i) =>
      !i.done &&
      (((i.kind === "task" || i.kind === "event") &&
        (isToday(i.dueDate) ||
          isOverdue(i) ||
          (!i.dueDate && i.due === "Today"))) ||
        i.kind === "waiting"),
  );
  document.getElementById("statTasks").textContent = state.items.filter(
    (i) => i.kind === "task" && !i.done,
  ).length;
  document.getElementById("statEvents").textContent = state.items.filter(
    (i) => i.kind === "event",
  ).length;
  document.getElementById("statWaiting").textContent = state.items.filter(
    (i) => i.kind === "waiting",
  ).length;
  document.getElementById("statOpen").textContent = state.items.filter(
    (i) => i.kind === "openloop",
  ).length;

  const list = document.getElementById("todayList");
  list.innerHTML = "";
  todays.forEach((item) => {
    list.appendChild(taskRow(item));
  });

  const recent = document.getElementById("recentList");
  recent.innerHTML = "";
  [...state.items]
    .sort((a, b) => b.created - a.created)
    .slice(0, 4)
    .forEach((item) => {
      const [bg, fg] = kindColor(item.kind);
      const el = document.createElement("div");
      el.className = "recent-item";
      el.onclick = () => openPanel(item.id);
      el.innerHTML = `<div class="recent-dot" style="background:${bg};color:${fg};">${kindIcon(item.kind)}</div>
      <div><div class="recent-text">${escapeHtml(item.title)}</div><div class="recent-tag">${item.kind.charAt(0).toUpperCase() + item.kind.slice(1)}</div></div>
      <div class="recent-time">${timeAgo(item.created)}</div>`;
      recent.appendChild(el);
    });

  const insights = document.getElementById("insightsList");
  const insightData = getInsights();
  insights.innerHTML = insightData
    .map(
      (i) =>
        `<div class="insight-item"><span>${i.icon}</span><div><div class="insight-title">${i.title}</div><div class="insight-sub">${i.sub}</div></div></div>`,
    )
    .join("");
  document.getElementById("insightsFull").innerHTML =
    insights.innerHTML || '<p class="empty">Nothing to show yet.</p>';
  const statsEl = document.getElementById("insightsStats");
  if (statsEl) {
    const totalItems = state.items.length;
    const completedCount = state.items.filter((i) => i.done).length;
    const activeDays = new Set(
      state.items.map((i) => new Date(i.created).toDateString()),
    ).size;
    statsEl.innerHTML = `
      <div class="stat-card"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);">📥</div><div><div class="stat-num">${totalItems}</div><div class="stat-label">Total captured</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);">✔</div><div><div class="stat-num">${completedCount}</div><div class="stat-label">Completed</div></div></div>
      <div class="stat-card"><div class="stat-icon" style="background:var(--purple-bg);color:var(--purple-fg);">📅</div><div><div class="stat-num">${activeDays}</div><div class="stat-label">Active days</div></div></div>
    `;
  }
}

function getInsights() {
  const arr = [];
  const openLoops = state.items.filter(
    (i) => i.kind === "openloop" || i.kind === "waiting",
  );
  if (openLoops.length)
    arr.push({
      icon: "✨",
      title: `You have ${openLoops.length} open loop${openLoops.length > 1 ? "s" : ""}`,
      sub: openLoops
        .map((o) => o.title)
        .slice(0, 3)
        .join(", "),
    });

  // Most active project
  const projectCounts = {};
  state.items.forEach((i) => {
    if (i.project)
      projectCounts[i.project] = (projectCounts[i.project] || 0) + 1;
  });
  const topProject = Object.entries(projectCounts).sort(
    (a, b) => b[1] - a[1],
  )[0];
  if (topProject)
    arr.push({
      icon: "📁",
      title: `Most active project: ${topProject[0]}`,
      sub: `${topProject[1]} item${topProject[1] > 1 ? "s" : ""} linked`,
    });

  // Most mentioned person
  const personCounts = {};
  state.items.forEach((i) => {
    if (i.person) personCounts[i.person] = (personCounts[i.person] || 0) + 1;
  });
  const topPerson = Object.entries(personCounts).sort((a, b) => b[1] - a[1])[0];
  if (topPerson)
    arr.push({
      icon: "👤",
      title: `You mention ${topPerson[0]} most often`,
      sub: `${topPerson[1]} linked item${topPerson[1] > 1 ? "s" : ""}`,
    });

  // Busiest day of week (by creation)
  const dayCounts = [0, 0, 0, 0, 0, 0, 0];
  state.items.forEach((i) => {
    dayCounts[new Date(i.created).getDay()]++;
  });
  const maxDay = dayCounts.indexOf(Math.max(...dayCounts));
  if (Math.max(...dayCounts) > 0) {
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    arr.push({
      icon: "📈",
      title: `You capture the most on ${dayNames[maxDay]}s`,
      sub: `${dayCounts[maxDay]} item${dayCounts[maxDay] > 1 ? "s" : ""} total`,
    });
  }

  // Overdue warning
  const overdue = state.items.filter((i) => isOverdue(i));
  if (overdue.length)
    arr.push({
      icon: "⚠️",
      title: `${overdue.length} task${overdue.length > 1 ? "s are" : " is"} overdue`,
      sub: overdue
        .slice(0, 3)
        .map((o) => o.title)
        .join(", "),
    });

  // Stale open loops (open for 7+ days)
  const stale = openLoops.filter((i) => Date.now() - i.created > 7 * 86400000);
  if (stale.length)
    arr.push({
      icon: "🕰️",
      title: `${stale.length} open loop${stale.length > 1 ? "s have" : " has"} sat for a week+`,
      sub: stale
        .slice(0, 3)
        .map((s) => s.title)
        .join(", "),
    });

  if (!arr.length)
    arr.push({
      icon: "🌱",
      title: "Not enough activity yet",
      sub: "Capture more to start seeing patterns.",
    });
  return arr;
}

function taskRow(item) {
  const row = document.createElement("div");
  row.className = "task-row" + (item.done ? " done" : "");
  row.onclick = (e) => {
    if (e.target.closest(".checkbox")) return;
    openPanel(item.id);
  };
  const check = document.createElement("div");
  check.className = "checkbox" + (item.done ? " checked" : "");
  check.textContent = item.done ? "✓" : "";
  check.onclick = () => toggleDone(item.id);
  row.appendChild(check);

  const meta = document.createElement("div");
  meta.className = "task-meta";
  let mediaHtml = "";
  if (item.kind === "voice" && item.mediaUrl)
    mediaHtml = `<audio controls src="${item.mediaUrl}" style="height:28px;margin-top:4px;"></audio>`;
  if (item.kind === "image" && item.mediaUrl)
    mediaHtml = `<img src="${item.mediaUrl}" style="max-width:120px;border-radius:6px;margin-top:4px;display:block;">`;
  if (item.kind === "file" && item.mediaUrl)
    mediaHtml = `<a href="${item.mediaUrl}" target="_blank" style="font-size:12.5px;color:var(--accent);">Open file</a>`;
  if (item.kind === "link")
    mediaHtml = `<a href="${escapeHtml(item.title)}" target="_blank" style="font-size:12.5px;color:var(--accent);">${escapeHtml(item.title)}</a>`;
  meta.innerHTML = `<div class="task-title">${item.scope === "private" ? "🔒 " : ""}${escapeHtml(item.kind === "link" ? "Link" : item.title)}</div><div class="task-sub">${escapeHtml(item.sub || "")}${item.person ? " · <span>👤 " + escapeHtml(item.person) + "</span>" : ""}</div>${mediaHtml}`;
  row.appendChild(meta);

  if (item.due) {
    const t = document.createElement("div");
    t.className = "task-time";
    t.textContent =
      (item.recurrence && item.recurrence !== "none" ? "🔁 " : "") + item.due;
    row.appendChild(t);
  }
  const badgeText = item.priority || item.status || item.kind;
  if (badgeText) {
    const b = document.createElement("span");
    b.className = "badge " + (item.priority || item.kind);
    b.textContent = item.priority
      ? item.priority.charAt(0).toUpperCase() + item.priority.slice(1)
      : badgeText;
    row.appendChild(b);
  }
  return row;
}

async function toggleDone(id) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  item.done = !item.done;
  item.completedAt = item.done ? Date.now() : "";
  logCompletion(item.id, item.done);
  await dbSaveItem(item);
  if (
    item.done &&
    item.recurrence &&
    item.recurrence !== "none" &&
    item.dueDate
  ) {
    const nextDue = nextOccurrence(item.dueDate, item.recurrence);
    const next = {
      ...item,
      id: cid(),
      done: false,
      completedAt: "",
      dueDate: nextDue,
      due: formatDueDisplay(nextDue),
      created: Date.now(),
    };
    state.items.unshift(next);
    await dbSaveItem(next);
  }
}

function renderInbox(filter) {
  filter = filter || "all";
  const tabs = [
    ["all", "All"],
    ["text", "Text"],
    ["voice", "Voice"],
    ["image", "Images"],
    ["file", "Files"],
    ["link", "Links"],
  ];
  const tabRow = document.getElementById("inboxTabs");
  tabRow.innerHTML = tabs
    .map(
      ([id, label]) =>
        `<div class="tab ${id === filter ? "active" : ""}" onclick="renderInbox('${id}')">${label}</div>`,
    )
    .join("");
  const searchInput = document.getElementById("inboxSearchInput");
  const query = searchInput ? searchInput.value.trim().toLowerCase() : "";
  const list = document.getElementById("inboxList");
  list.innerHTML = "";
  const textKinds = ["task", "event", "memory", "waiting", "openloop"];
  const items = [...state.items]
    .sort((a, b) => b.created - a.created)
    .filter((i) => {
      if (filter === "text") {
        if (!textKinds.includes(i.kind)) return false;
      } else if (filter !== "all" && i.kind !== filter) return false;
      if (!query) return true;
      return (
        i.title +
        " " +
        (i.sub || "") +
        " " +
        (i.person || "") +
        " " +
        (i.project || "")
      )
        .toLowerCase()
        .includes(query);
    });
  if (!items.length) {
    list.innerHTML = query
      ? '<p class="empty">Nothing matches that filter.</p>'
      : '<p class="empty">Nothing here yet.</p>';
    return;
  }
  items.forEach((item) => list.appendChild(taskRow(item)));
}

function renderTasks(filter) {
  filter = filter || "all";
  const tabs = [
    ["all", "All"],
    ["today", "Today"],
    ["overdue", "Overdue"],
    ["upcoming", "Upcoming"],
    ["completed", "Completed"],
  ];
  const tabRow = document.getElementById("taskTabs");
  if (tabRow) {
    tabRow.innerHTML = tabs
      .map(
        ([id, label]) =>
          `<div class="tab ${id === filter ? "active" : ""}" onclick="renderTasks('${id}')">${label}</div>`,
      )
      .join("");
  }

  const list = document.getElementById("tasksList");
  let tasks = state.items.filter((i) => i.kind === "task");

  if (filter === "today")
    tasks = tasks.filter((i) => !i.done && isToday(i.dueDate));
  else if (filter === "overdue") tasks = tasks.filter((i) => isOverdue(i));
  else if (filter === "upcoming")
    tasks = tasks.filter(
      (i) => !i.done && i.dueDate && !isToday(i.dueDate) && !isOverdue(i),
    );
  else if (filter === "completed") tasks = tasks.filter((i) => i.done);
  else tasks = tasks.filter((i) => !i.done);

  tasks.sort((a, b) => {
    if (a.dueDate && b.dueDate)
      return new Date(a.dueDate) - new Date(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return b.created - a.created;
  });

  list.innerHTML = "";
  if (!tasks.length) {
    const emptyMsgs = {
      all: "No open tasks — nice work.",
      today: "Nothing due today.",
      overdue: "Nothing overdue.",
      upcoming: "No upcoming tasks scheduled.",
      completed: "Nothing completed yet.",
    };
    list.innerHTML = `<p class="empty">${emptyMsgs[filter] || "No tasks yet. Capture one!"}</p>`;
    return;
  }
  tasks.forEach((t) => list.appendChild(taskRow(t)));
}

function renderMemory() {
  const container = document.getElementById("memoryGrouped");
  if (!container) return;
  const searchInput = document.getElementById("memorySearchInput");
  const query = searchInput ? searchInput.value.trim().toLowerCase() : "";

  let mem = state.items.filter((i) => i.kind === "memory");
  if (query) {
    mem = mem.filter((i) =>
      (i.title + " " + (i.sub || "") + " " + (i.person || ""))
        .toLowerCase()
        .includes(query),
    );
  }
  mem.sort((a, b) => b.created - a.created);

  if (!mem.length) {
    container.innerHTML = `<div class="card"><p class="empty">${query ? "No memories match that search." : "No memories captured yet."}</p></div>`;
    return;
  }

  const groups = {};
  const now = new Date();
  mem.forEach((item) => {
    const d = new Date(item.created);
    let label;
    if (d.toDateString() === now.toDateString()) label = "Today";
    else {
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      if (d.toDateString() === yesterday.toDateString()) label = "Yesterday";
      else
        label = d.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
        });
    }
    if (!groups[label]) groups[label] = [];
    groups[label].push(item);
  });

  container.innerHTML = Object.entries(groups)
    .map(
      ([label, items]) => `
    <div class="card">
      <div class="card-head"><h3>${label}</h3></div>
      <div>${items
        .map(
          (i) => `<div class="task-row" onclick="openPanel('${i.id}')">
        <div class="task-meta"><div class="task-title">${i.scope === "private" ? "🔒 " : ""}${escapeHtml(i.title)}</div>
        <div class="task-sub">${timeAgo(i.created)}${i.person ? " · 👤 " + escapeHtml(i.person) : ""}</div></div>
      </div>`,
        )
        .join("")}</div>
    </div>`,
    )
    .join("");
}

function renderPeople() {
  const el = document.getElementById("peopleList");
  if (!el) return;
  const namesFromItems = [
    ...new Set(state.items.filter((i) => i.person).map((i) => i.person)),
  ];
  const knownNames = state.people.map((p) => p.name);
  const inferredOnly = namesFromItems.filter((n) => !knownNames.includes(n));

  const rows = [
    ...state.people.map((p) => ({
      id: p.id,
      name: p.name,
      notes: p.notes || "",
      real: true,
    })),
    ...inferredOnly.map((n) => ({ id: null, name: n, notes: "", real: false })),
  ];

  if (!rows.length) {
    el.innerHTML =
      '<p class="empty">No people yet — add one below or tag someone on a task.</p>';
    return;
  }

  el.innerHTML = rows
    .map((p) => {
      const count = state.items.filter((i) => i.person === p.name).length;
      return `<div class="task-row" onclick="openPersonModal(${p.id ? `'${p.id}'` : "null"}, '${escapeHtml(p.name)}')">
      <div class="avatar" style="width:32px;height:32px;font-size:12px;">${p.name.charAt(0).toUpperCase()}</div>
      <div class="task-meta"><div class="task-title">${escapeHtml(p.name)}</div><div class="task-sub">${count} linked item${count !== 1 ? "s" : ""}${p.notes ? " · has notes" : ""}</div></div>
    </div>`;
    })
    .join("");
}
let currentPersonName = null;
function openPersonModal(id, name) {
  currentPersonName = name;
  const person = state.people.find((p) => p.name === name);
  document.getElementById("personModalName").textContent = name;
  document.getElementById("personNotes").value = person
    ? person.notes || ""
    : "";
  const items = state.items.filter((i) => i.person === name);
  const list = document.getElementById("personItemsList");
  list.innerHTML = items.length
    ? items
        .map(
          (i) =>
            `<div class="task-row" onclick="closePersonModal();openPanel('${i.id}')"><div class="checkbox ${i.done ? "checked" : ""}">${i.done ? "✓" : ""}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub || "")}</div></div></div>`,
        )
        .join("")
    : '<p class="empty">No linked items yet.</p>';
  document.getElementById("personModal").classList.add("open");
}
function closePersonModal() {
  document.getElementById("personModal").classList.remove("open");
  currentPersonName = null;
}
async function savePersonNotes() {
  if (!currentPersonName) return;
  let person = state.people.find((p) => p.name === currentPersonName);
  const notes = document.getElementById("personNotes").value.trim();
  if (!person) {
    person = { id: cid(), name: currentPersonName, notes, created: Date.now() };
    state.people.unshift(person);
  } else {
    person.notes = notes;
  }
  await dbSavePerson(person);
  closePersonModal();
}

async function addPersonManual() {
  const input = document.getElementById("newPersonInput");
  const name = input.value.trim();
  if (!name) return;
  if (state.people.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    input.value = "";
    return;
  }
  const p = { id: cid(), name, notes: "", created: Date.now() };
  state.people.unshift(p);
  input.value = "";
  await dbSavePerson(p);
}

/* ---------- Projects ---------- */
async function addProject() {
  const input = document.getElementById("newProjectInput");
  const name = input.value.trim();
  if (!name) return;
  const p = { id: cid(), name, created: Date.now() };
  state.projects.unshift(p);
  input.value = "";
  await dbSaveProject(p);
}
function renderProjects() {
  const el = document.getElementById("projectsList");
  if (!el) return;
  if (!state.projects.length) {
    el.innerHTML =
      '<div class="card"><p class="empty">No projects yet.</p></div>';
    return;
  }
  el.innerHTML = state.projects
    .map((p) => {
      const items = state.items.filter((i) => i.project === p.name);
      const done = items.filter((i) => i.done).length;
      const total = items.length;
      const pct = total ? Math.round((done / total) * 100) : 0;
      return `<div class="card">
      <div class="card-head">
        <h3>${escapeHtml(p.name)}</h3>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="badge task">${total - done} open</span>
          <button class="btn danger" style="padding:4px 10px;font-size:12px;" onclick="deleteProject('${p.id}','${escapeHtml(p.name)}')">Delete</button>
        </div>
      </div>
      ${
        total
          ? `<div style="background:var(--bg);border-radius:6px;height:6px;margin-bottom:12px;overflow:hidden;">
        <div style="background:var(--green-fg);height:100%;width:${pct}%;transition:width .3s;"></div>
      </div><p style="font-size:12px;color:var(--muted);margin:-6px 0 12px;">${pct}% complete (${done}/${total})</p>`
          : ""
      }
      ${items.length ? items.map((i) => `<div class="task-row" onclick="openPanel('${i.id}')"><div class="checkbox ${i.done ? "checked" : ""}">${i.done ? "✓" : ""}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub || "")}</div></div></div>`).join("") : '<p class="empty">No items here yet.</p>'}
    </div>`;
    })
    .join("");
}

/* ---------- Goals ---------- */
async function addGoal() {
  const input = document.getElementById("newGoalInput");
  const title = input.value.trim();
  if (!title) return;
  const g = { id: cid(), title, done: false, created: Date.now() };
  state.goals.unshift(g);
  input.value = "";
  await dbSaveGoal(g);
}
async function toggleGoal(id) {
  const g = state.goals.find((g) => g.id === id);
  if (g) {
    g.done = !g.done;
    await dbSaveGoal(g);
  }
}
function renderGoals() {
  const el = document.getElementById("goalsList");
  if (!el) return;
  if (!state.goals.length) {
    el.innerHTML = '<p class="empty">No goals set yet.</p>';
    return;
  }

  const active = state.goals.filter((g) => !g.done);
  const done = state.goals.filter((g) => g.done);

  const renderRow = (g) => {
    const days = Math.floor((Date.now() - g.created) / 86400000);
    return `<div class="task-row">
      <div class="checkbox ${g.done ? "checked" : ""}" onclick="toggleGoal('${g.id}')">${g.done ? "✓" : ""}</div>
      <div class="task-meta">
        <div class="task-title" style="${g.done ? "text-decoration:line-through;color:var(--muted);" : ""}">${escapeHtml(g.title)}</div>
        <div class="task-sub">${g.done ? "Completed" : days === 0 ? "Started today" : `In progress · ${days} day${days !== 1 ? "s" : ""}`}</div>
      </div>
      <button class="btn danger" style="padding:4px 10px;font-size:12px;" onclick="deleteGoal('${g.id}')">Delete</button>
    </div>`;
  };

  let html = "";
  if (active.length) html += active.map(renderRow).join("");
  if (done.length)
    html +=
      `<div class="card-head" style="margin-top:${active.length ? "16px" : "0"};"><h3 style="font-size:13px;color:var(--muted);">Completed (${done.length})</h3></div>` +
      done.map(renderRow).join("");
  el.innerHTML = html;
}

/* Items only store a `done` flag, so we keep a small local log of *when* something
   was completed. Used by the Reports activity chart. */
let doneLog = {};
try {
  doneLog = JSON.parse(localStorage.getItem("everything_done_log_v1") || "{}");
} catch (e) {
  doneLog = {};
}

function logCompletion(id, done) {
  if (done) doneLog[id] = Date.now();
  else delete doneLog[id];
  try {
    localStorage.setItem("everything_done_log_v1", JSON.stringify(doneLog));
  } catch (e) {}
}

/* When an item was completed: the stored timestamp when we have one (items.completed_at,
   or this device's log on an un-migrated database), otherwise fall back to when it was
   captured. */
function completedWhen(item) {
  return item.completedAt || doneLog[item.id] || item.created;
}

/* ---------- Reports ---------- */
function renderReports() {
  const statsEl = document.getElementById("reportStats");
  if (!statsEl) return;
  const weekAgo = Date.now() - 7 * 86400000;
  const allTasks = state.items.filter((i) => i.kind === "task");
  const completedTasks = allTasks.filter((i) => i.done);
  const completed = state.items.filter((i) => i.done);
  const createdThisWeek = state.items.filter((i) => i.created >= weekAgo);
  const completionRate = allTasks.length
    ? Math.round((completedTasks.length / allTasks.length) * 100)
    : 0;
  const byType = {};
  state.items.forEach((i) => {
    byType[i.kind] = (byType[i.kind] || 0) + 1;
  });

  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);">✔</div><div><div class="stat-num">${completed.length}</div><div class="stat-label">Completed</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);">📥</div><div><div class="stat-num">${createdThisWeek.length}</div><div class="stat-label">Captured this week</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--purple-bg);color:var(--purple-fg);">📈</div><div><div class="stat-num">${completionRate}%</div><div class="stat-label">Task completion rate</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--amber-bg);color:var(--amber-fg);">🎯</div><div><div class="stat-num">${state.goals.filter((g) => !g.done).length}</div><div class="stat-label">Open goals</div></div></div>
  `;

  const completedEl = document.getElementById("reportCompleted");
  completedEl.innerHTML = completed.length
    ? [...completed]
        .sort((a, b) => completedWhen(b) - completedWhen(a))
        .slice(0, 10)
        .map(
          (i) =>
            `<div class="task-row"><div class="checkbox checked">✓</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">Completed ${timeAgo(completedWhen(i))}</div></div></div>`,
        )
        .join("")
    : '<p class="empty">Nothing finished yet.</p>';

  const typeEl = document.getElementById("reportByType");
  const maxCount = Math.max(...Object.values(byType), 1);
  typeEl.innerHTML = Object.keys(byType).length
    ? Object.entries(byType)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => {
          const pct = Math.round((v / maxCount) * 100);
          const [bg, fg] = kindColor(k);
          return `<div style="margin-bottom:10px;">
          <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:4px;"><span>${kindIcon(k)} ${k.charAt(0).toUpperCase() + k.slice(1)}</span><span>${v}</span></div>
          <div style="background:var(--bg);border-radius:6px;height:8px;overflow:hidden;"><div style="background:${fg};height:100%;width:${pct}%;"></div></div>
        </div>`;
        })
        .join("")
    : '<p class="empty">No data yet.</p>';

  const chartEl = document.getElementById("reportChart");
  if (chartEl) chartEl.innerHTML = renderActivityChart(14);
}

/* Captured vs completed per day for the last `days` days. */
function renderActivityChart(days) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const buckets = [];
  const indexByDay = {};
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    indexByDay[d.toDateString()] = buckets.length;
    buckets.push({ date: d, captured: 0, completed: 0 });
  }

  state.items.forEach((item) => {
    const capturedAt = indexByDay[new Date(item.created).toDateString()];
    if (capturedAt !== undefined) buckets[capturedAt].captured++;

    const completedStamp = item.completedAt || doneLog[item.id];
    if (item.done && completedStamp) {
      const completedAt = indexByDay[new Date(completedStamp).toDateString()];
      if (completedAt !== undefined) buckets[completedAt].completed++;
    }
  });

  const max = Math.max(
    ...buckets.map((b) => Math.max(b.captured, b.completed)),
    1,
  );

  return buckets
    .map((b) => {
      const capturedH = Math.round((b.captured / max) * 100);
      const completedH = Math.round((b.completed / max) * 100);
      const label = b.date.toLocaleDateString(undefined, { day: "numeric" });
      const tip = `${b.date.toLocaleDateString()} — ${b.captured} captured, ${b.completed} completed`;
      return `<div class="chart-col" title="${tip}">
      <div class="chart-bars">
        <div class="chart-bar" style="height:${capturedH}%;background:var(--accent);"></div>
        <div class="chart-bar" style="height:${completedH}%;background:var(--green-fg);"></div>
      </div>
      <div class="chart-label">${label}</div>
    </div>`;
    })
    .join("");
}

/* ---------- Calendar ---------- */
let calViewDate = new Date();
let calMode = "week";

function getScheduledItems() {
  return state.items.filter((i) => i.dueDate && !i.done);
}
function getWeekStart(d) {
  const date = new Date(d);
  date.setDate(date.getDate() - date.getDay());
  date.setHours(0, 0, 0, 0);
  return date;
}
function setCalView(mode) {
  calMode = mode;
  renderCalendar();
}
function calGoToday() {
  calViewDate = new Date();
  renderCalendar();
}
function calNav(dir) {
  if (calMode === "week") calViewDate.setDate(calViewDate.getDate() + dir * 7);
  else calViewDate.setMonth(calViewDate.getMonth() + dir);
  renderCalendar();
}

function renderCalendar() {
  const wTab = document.getElementById("calTabWeek"),
    mTab = document.getElementById("calTabMonth");
  if (wTab) wTab.classList.toggle("active", calMode === "week");
  if (mTab) mTab.classList.toggle("active", calMode === "month");
  document.getElementById("calWeekView").style.display =
    calMode === "week" ? "block" : "none";
  document.getElementById("calGrid").style.display =
    calMode === "month" ? "grid" : "none";
  if (calMode === "week") renderWeekView();
  else renderMonthView();
}

function renderWeekView() {
  const container = document.getElementById("calWeekView");
  const start = getWeekStart(calViewDate);
  const days = [...Array(7)].map((_, i) => {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    return d;
  });
  document.getElementById("calRangeLabel").textContent =
    `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

  const startHour = 7,
    endHour = 20,
    rowHeight = 50;
  const hours = [];
  for (let h = startHour; h <= endHour; h++) hours.push(h);
  const scheduled = getScheduledItems();

  let html = `<div class="cal-week-wrap"><div class="cal-time-col"><div class="cal-week-head-spacer"></div>`;
  hours.forEach((h) => {
    html += `<div class="cal-hour-label">${h === 12 ? "12 PM" : h < 12 ? h + " AM" : h - 12 + " PM"}</div>`;
  });
  html += `</div><div class="cal-week-days">`;

  days.forEach((day) => {
    const isToday = day.toDateString() === new Date().toDateString();
    html += `<div class="cal-week-day-col">
      <div class="cal-week-day-head ${isToday ? "today" : ""}"><span>${day.toLocaleDateString(undefined, { weekday: "short" })}</span><span class="num">${day.getDate()}</span></div>
      <div class="cal-week-day-body" style="height:${hours.length * rowHeight}px;">`;
    hours.forEach(() => {
      html += `<div class="cal-hour-row"></div>`;
    });

    scheduled
      .filter((i) => new Date(i.dueDate).toDateString() === day.toDateString())
      .forEach((item) => {
        const d = new Date(item.dueDate);
        const hour = d.getHours() + d.getMinutes() / 60;
        if (hour < startHour || hour > endHour + 1) return;
        const top = (hour - startHour) * rowHeight;
        const [bg, fg] = kindColor(item.kind);
        html += `<div class="cal-week-event" style="top:${top}px;height:${rowHeight - 4}px;background:${bg};color:${fg};" onclick="openPanel('${item.id}')"><b>${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</b> ${escapeHtml(item.title)}</div>`;
      });
    html += `</div></div>`;
  });
  html += `</div></div>`;
  container.innerHTML = html;
}

function renderMonthView() {
  const now = calViewDate;
  document.getElementById("calRangeLabel").textContent = now.toLocaleDateString(
    undefined,
    { month: "long", year: "numeric" },
  );
  const grid = document.getElementById("calGrid");
  grid.innerHTML = "";
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach((d) => {
    const h = document.createElement("div");
    h.className = "cal-day-head";
    h.textContent = d;
    grid.appendChild(h);
  });
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
  ).getDate();
  const scheduled = getScheduledItems();
  for (let i = 0; i < startOffset; i++) {
    const c = document.createElement("div");
    c.className = "cal-cell";
    grid.appendChild(c);
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const cellDate = new Date(now.getFullYear(), now.getMonth(), d);
    const c = document.createElement("div");
    c.className =
      "cal-cell" +
      (cellDate.toDateString() === new Date().toDateString() ? " today" : "");
    const num = document.createElement("div");
    num.className = "num";
    num.textContent = d;
    c.appendChild(num);
    scheduled
      .filter(
        (i) => new Date(i.dueDate).toDateString() === cellDate.toDateString(),
      )
      .forEach((item) => {
        const ev = document.createElement("div");
        ev.className = "cal-event";
        ev.onclick = () => openPanel(item.id);
        ev.textContent =
          new Date(item.dueDate).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          }) +
          " " +
          item.title;
        c.appendChild(ev);
      });
    grid.appendChild(c);
  }
}

/* ---------- Task detail panel ---------- */
function openPanel(id) {
  currentItemId = id;
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  document.getElementById("panelTitle").textContent = item.title;
  document.getElementById("panelDesc").textContent = item.sub || "";
  document.getElementById("panelType").textContent =
    item.kind.charAt(0).toUpperCase() + item.kind.slice(1);
  document.getElementById("panelDue").textContent = item.due || "—";
  document.getElementById("panelPerson").textContent = item.person || "—";
  document.getElementById("panelProject").textContent = item.project || "—";
  document.getElementById("panelPriority").textContent = item.priority
    ? item.priority.charAt(0).toUpperCase() + item.priority.slice(1)
    : "—";
  document.getElementById("panelStatus").textContent = item.done
    ? "Complete" +
      (completedWhen(item) ? " · " + timeAgo(completedWhen(item)) : "")
    : item.status || "Open";
  document.getElementById("panelVisibility").textContent =
    item.scope === "private" ? "🔒 Private (only you)" : "🌐 Shared";
  document.getElementById("panelCreated").textContent = new Date(
    item.created,
  ).toLocaleString();
  const badge = document.getElementById("panelBadge");
  badge.textContent = item.priority
    ? item.priority.charAt(0).toUpperCase() + item.priority.slice(1)
    : item.kind;
  badge.className = "badge " + (item.priority || item.kind);

  renderRelatedChips(item);

  document.getElementById("overlay").classList.add("open");
  document.getElementById("panel").classList.add("open");
}

function renderRelatedChips(item) {
  const container = document.getElementById("panelRelated");
  const chips = [];

  if (item.person) {
    chips.push({
      label: `👤 ${item.person}`,
      tag: "Person",
      onclick: `closePanel();openPersonModal(null,'${escapeHtml(item.person)}')`,
    });
  }
  if (item.project) {
    chips.push({
      label: `📁 ${item.project}`,
      tag: "Project",
      onclick: `closePanel();switchView('projects')`,
    });
  }

  const related = state.items
    .filter(
      (i) =>
        i.id !== item.id &&
        ((item.person && i.person === item.person) ||
          (item.project && i.project === item.project)),
    )
    .slice(0, 5);

  related.forEach((r) => {
    chips.push({
      label: `${kindIcon(r.kind)} ${r.title}`,
      tag: r.kind.charAt(0).toUpperCase() + r.kind.slice(1),
      onclick: `closePanel();openPanel('${r.id}')`,
    });
  });

  container.innerHTML = chips.length
    ? chips
        .map(
          (
            c,
          ) => `<div onclick="${c.onclick}" style="display:flex;flex-direction:column;gap:2px;padding:6px 12px;border:1px solid var(--border);border-radius:8px;cursor:pointer;background:var(--bg);">
        <span style="font-size:13px;font-weight:600;">${c.label}</span>
        <span style="font-size:10.5px;color:var(--muted);">${c.tag}</span>
      </div>`,
        )
        .join("")
    : '<p class="empty" style="padding:0;">Nothing related yet.</p>';
}
function closePanel() {
  document.getElementById("overlay").classList.remove("open");
  document.getElementById("panel").classList.remove("open");
  currentItemId = null;
}
function openEditModal() {
  if (!currentItemId) return;
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item) return;
  document.getElementById("editTitle").value = item.title || "";
  document.getElementById("editSub").value = item.sub || "";
  document.getElementById("editPriority").value = item.priority || "";
  document.getElementById("editDueDate").value = item.dueDate
    ? item.dueDate.slice(0, 16)
    : "";
  document.getElementById("editRecurrence").value = item.recurrence || "none";
  document.getElementById("editPerson").value = item.person || "";
  const projSel = document.getElementById("editProject");
  projSel.innerHTML =
    '<option value="">No project</option>' +
    state.projects
      .map(
        (p) =>
          `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`,
      )
      .join("");
  projSel.value = item.project || "";
  document.getElementById("editModal").classList.add("open");
}
function closeEditModal() {
  document.getElementById("editModal").classList.remove("open");
}
async function saveEdit() {
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item) return closeEditModal();
  item.title = document.getElementById("editTitle").value.trim() || item.title;
  item.sub = document.getElementById("editSub").value.trim();
  item.priority = document.getElementById("editPriority").value;
  item.person = document.getElementById("editPerson").value.trim();
  item.project = document.getElementById("editProject").value;

  const editDueVal = document.getElementById("editDueDate").value;
  const newDueDate = editDueVal ? new Date(editDueVal).toISOString() : "";
  if (newDueDate !== item.dueDate) item.notified = false;
  item.dueDate = newDueDate;
  item.recurrence = document.getElementById("editRecurrence").value;
  if (item.dueDate) item.due = formatDueDisplay(item.dueDate);

  closeEditModal();
  closePanel();
  await dbSaveItem(item);
}
async function completeCurrent() {
  if (!currentItemId) return;
  await toggleDone(currentItemId);
  closePanel();
}
async function deleteCurrent() {
  if (!currentItemId) return;
  const id = currentItemId;
  state.items = state.items.filter((i) => i.id !== id);
  closePanel();
  await dbDeleteItem(id);
}

/* ---------- Quick reschedule ("snooze") ---------- */
function applyDueToItem(item, date) {
  item.dueDate = date ? date.toISOString() : "";
  item.due = date ? formatDueDisplay(item.dueDate) : "";
  item.notified = false;
  return item;
}

function nextNineAm(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(9, 0, 0, 0);
  return d;
}

async function snoozeCurrent(mode) {
  const item = state.items.find((i) => i.id === currentItemId);
  if (!item) return;

  if (mode === "tomorrow9") applyDueToItem(item, nextNineAm(1));
  else if (mode === "day")
    applyDueToItem(item, new Date(Date.now() + 86400000));
  else if (mode === "week")
    applyDueToItem(item, new Date(Date.now() + 7 * 86400000));
  else if (mode === "clear") applyDueToItem(item, null);

  await dbSaveItem(item);
  openPanel(item.id);
}
async function dbDeleteProject(id) {
  if (syncReadyPromise) await syncReadyPromise;
  if (db) {
    await db.collection("projects").doc(id).delete();
  } else if (sbUser) {
    const { error } = await sb
      .from("projects")
      .delete()
      .eq("id", id)
      .eq("household_id", currentHouseholdId);
    if (error) console.error("Supabase project delete failed:", error.message);
  } else {
    state.projects = state.projects.filter((p) => p.id !== id);
    save();
  }
  renderProjects();
  renderNav();
}
async function dbDeleteGoal(id) {
  if (syncReadyPromise) await syncReadyPromise;
  if (db) {
    await db.collection("goals").doc(id).delete();
  } else if (sbUser) {
    const { error } = await sb
      .from("goals")
      .delete()
      .eq("id", id)
      .eq("household_id", currentHouseholdId);
    if (error) console.error("Supabase goal delete failed:", error.message);
  } else {
    state.goals = state.goals.filter((g) => g.id !== id);
    save();
  }
  renderGoals();
  renderReports();
}
async function deleteGoal(id) {
  if (!confirm("Delete this goal?")) return;
  state.goals = state.goals.filter((g) => g.id !== id);
  await dbDeleteGoal(id);
}

async function deleteProject(id, name) {
  if (
    !confirm(
      `Delete "${name}"? Items linked to it will keep their project tag but the project itself will be removed.`,
    )
  )
    return;
  state.projects = state.projects.filter((p) => p.id !== id);
  await dbDeleteProject(id);
}

/* ---------- Capture modal ---------- */
const CAPTURE_TYPES = [
  { id: "text", label: "📝 Text" },
  { id: "task", label: "✓ Task" },
  { id: "event", label: "📅 Event" },
  { id: "memory", label: "💭 Memory" },
  { id: "waiting", label: "⏳ Waiting for" },
  { id: "openloop", label: "🔴 Open loop" },
  { id: "voice", label: "🎙️ Voice" },
  { id: "image", label: "🖼️ Image" },
  { id: "file", label: "📄 File" },
  { id: "link", label: "🔗 Link" },
];
let mediaRecorder = null;
let recordedChunks = [];
let recordingSeconds = 0;
let recordingInterval = null;
let pendingBlob = null;
let pendingBlobExt = null;

async function toggleVoiceRecording() {
  const btn = document.getElementById("voiceRecordBtn");
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      pendingBlob = blob;
      pendingBlobExt = "webm";
      document.getElementById("voicePreview").src = URL.createObjectURL(blob);
      document.getElementById("voicePreview").style.display = "block";
      clearInterval(recordingInterval);
      document.getElementById("voiceTimer").textContent = "";
      btn.textContent = "🎙️ Re-record";
      stream.getTracks().forEach((t) => t.stop());
    };
    mediaRecorder.start();
    recordingSeconds = 0;
    btn.textContent = "⏹️ Stop recording";
    recordingInterval = setInterval(() => {
      recordingSeconds++;
      document.getElementById("voiceTimer").textContent =
        `${Math.floor(recordingSeconds / 60)}:${String(recordingSeconds % 60).padStart(2, "0")}`;
    }, 1000);
  } catch (e) {
    alert("Microphone access denied or unavailable.");
  }
}

function previewImageFile() {
  const file = document.getElementById("imageFileInput").files[0];
  if (!file) return;
  pendingBlob = file;
  pendingBlobExt = file.name.split(".").pop();
  const preview = document.getElementById("imagePreview");
  preview.src = URL.createObjectURL(file);
  preview.style.display = "block";
}

function previewGenericFile() {
  const file = document.getElementById("genericFileInput").files[0];
  if (!file) return;
  pendingBlob = file;
  pendingBlobExt = file.name.split(".").pop();
  document.getElementById("fileNamePreview").textContent =
    `Selected: ${file.name}`;
}

async function uploadPendingBlob() {
  if (!pendingBlob || !sbUser) return null;
  const path = `${sbUser}/${cid()}.${pendingBlobExt}`;
  const { error } = await sb.storage.from("captures").upload(path, pendingBlob);
  if (error) {
    console.error("Upload failed:", error.message);
    return null;
  }
  const { data } = sb.storage.from("captures").getPublicUrl(path);
  return data.publicUrl;
}
let captureAutoDetected = false;
let captureScope = "shared";
function pickScope(scope) {
  captureScope = scope;
  document
    .querySelectorAll("#visibilityRow .type-chip")
    .forEach((el) => el.classList.toggle("active", el.dataset.scope === scope));
}
function openCapture() {
  captureType = "text";
  if (document.getElementById("sidebar").classList.contains("open"))
    toggleSidebar();
  captureAutoDetected = false;
  captureScope = "shared";
  pickScope("shared");
  const row = document.getElementById("typeRow");
  row.innerHTML = CAPTURE_TYPES.map(
    (t) =>
      `<div class="type-chip ${t.id === captureType ? "active" : ""}" data-type="${t.id}" onclick="pickType('${t.id}', true)">${t.label}</div>`,
  ).join("");
  document.getElementById("captureText").value = "";
  document.getElementById("captureHint").textContent = "";
  populateProjectSelect();
  document.getElementById("captureModal").classList.add("open");
  document.getElementById("captureDueDate").value = "";
  document.getElementById("captureRecurrence").value = "none";
  document.getElementById("capturePriority").value = "";
  document.getElementById("capturePerson").value = "";
  document.getElementById("voiceCaptureUI").style.display = "none";
  document.getElementById("imageCaptureUI").style.display = "none";
  document.getElementById("fileCaptureUI").style.display = "none";
  document.getElementById("linkCaptureUI").style.display = "none";
  document.getElementById("captureText").style.display = "block";
  document.getElementById("voicePreview").style.display = "none";
  document.getElementById("imagePreview").style.display = "none";
  document.getElementById("fileNamePreview").textContent = "";
  document.getElementById("linkUrlInput").value = "";
  pendingBlob = null;
  pendingBlobExt = null;
  if (mediaRecorder && mediaRecorder.state === "recording")
    mediaRecorder.stop();
  document.getElementById("voiceRecordBtn").textContent = "🎙️ Start recording";
  setTimeout(() => document.getElementById("captureText").focus(), 50);
}
function populateProjectSelect() {
  const sel = document.getElementById("captureProject");
  sel.innerHTML =
    '<option value="">No project</option>' +
    state.projects
      .map(
        (p) =>
          `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`,
      )
      .join("");
}
function pickType(id, manual) {
  captureType = id;
  if (manual) captureAutoDetected = true;
  document
    .querySelectorAll(".type-chip")
    .forEach((el) => el.classList.toggle("active", el.dataset.type === id));

  document.getElementById("voiceCaptureUI").style.display =
    id === "voice" ? "block" : "none";
  document.getElementById("imageCaptureUI").style.display =
    id === "image" ? "block" : "none";
  document.getElementById("fileCaptureUI").style.display =
    id === "file" ? "block" : "none";
  document.getElementById("linkCaptureUI").style.display =
    id === "link" ? "block" : "none";
  document.getElementById("captureText").style.display =
    id === "voice" ? "none" : "block";
}
function detectType(text) {
  const t = text.toLowerCase();
  if (
    /\b(tomorrow|today|at \d|am|pm|meeting|call|deadline|due|schedule)\b/.test(
      t,
    ) &&
    /\b(meeting|call|event|appointment|sync|demo)\b/.test(t)
  )
    return "event";
  if (
    /\b(todo|to-do|task|need to|have to|remind me|follow up|send|finish|complete|call|email)\b/.test(
      t,
    )
  )
    return "task";
  return "memory";
}
let extractDebounce = null;
function onCaptureInput() {
  const text = document.getElementById("captureText").value;
  document.getElementById("captureHint").textContent = "";
  if (!text.trim()) {
    captureAutoDetected = false;
    return;
  }

  if (!captureAutoDetected) {
    const guessed = detectType(text);
    if (guessed !== captureType) pickType(guessed, false);
  }

  clearTimeout(extractDebounce);
  document.getElementById("captureHint").textContent = "✨ Reading…";
  extractDebounce = setTimeout(() => extractWithAI(text), 700);
}

async function extractWithAI(text) {
  let result = null;

  // Free path: Claude artifact's built-in sample capability (no cost)
  let sample;
  try {
    sample = await window.claude?.use("sample");
  } catch (e) {
    sample = null;
  }
  if (sample) {
    const now = new Date().toISOString();
    const projectList = state.projects.map((p) => p.name).join(", ") || "none";
    const prompt = `You extract structured data from a quick personal note for a productivity app. Current date/time: ${now}. Known projects: ${projectList}.\n\nNote: "${text}"\n\nRespond with ONLY raw JSON:\n{"kind":"task|event|memory|waiting|openloop","priority":"high|medium|low|","dueDate":"ISO 8601 datetime or empty string","person":"name or empty string","project":"one of the known projects if it clearly matches, else empty string","recurrence":"none|daily|weekly|monthly"}`;
    try {
      const res = await sample(prompt, { modelTier: "quick" });
      result = JSON.parse(res.text.replace(/```json|```/g, "").trim());
    } catch (e) {
      result = null;
    }
  }

  // Free path: local rule-based extraction (no API, no cost) — used on the live Vercel site
  if (!result) {
    result = extractLocally(text);
  }

  if (document.getElementById("captureText").value !== text) return;
  applyExtraction(result);
}
function applyExtraction(data) {
  if (data.kind && !captureAutoDetected) pickType(data.kind, false);

  const prioEl = document.getElementById("capturePriority");
  if (data.priority && !prioEl.value) prioEl.value = data.priority;

  const dueEl = document.getElementById("captureDueDate");
  if (data.dueDate && !dueEl.value) {
    dueEl.value = data.dueDate.slice(0, 16);
  }

  const personEl = document.getElementById("capturePerson");
  if (data.person && !personEl.value) personEl.value = data.person;

  const projEl = document.getElementById("captureProject");
  if (data.project && !projEl.value) {
    const match = [...projEl.options].find((o) => o.value === data.project);
    if (match) projEl.value = data.project;
  }

  const recEl = document.getElementById("captureRecurrence");
  if (data.recurrence && data.recurrence !== "none" && recEl.value === "none")
    recEl.value = data.recurrence;

  const parts = [];
  if (data.kind) parts.push(data.kind);
  if (data.dueDate) parts.push("due " + formatDueDisplay(data.dueDate));
  if (data.person) parts.push("person: " + data.person);
  document.getElementById("captureHint").textContent = parts.length
    ? `✨ AI detected: ${parts.join(", ")} — edit any field to override.`
    : "";
}

const DAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const DAY_WORD_RE =
  /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/;

/* Compact fallback date parser for notes like "tomorrow at 5pm", "in 2 hours" or
   "friday 14:30". Only used when chrono-node isn't available (offline / CDN blocked). */
function parseLocalDate(text, now) {
  const ref = now ? new Date(now) : new Date();
  const t = " " + text.toLowerCase() + " ";

  const relative = t.match(/\bin\s+(\d+)\s*(min|minute|hour|hr|day|week)s?\b/);
  if (relative) {
    const n = parseInt(relative[1], 10);
    const d = new Date(ref);
    if (relative[2].startsWith("min")) d.setMinutes(d.getMinutes() + n);
    else if (relative[2] === "day") d.setDate(d.getDate() + n);
    else if (relative[2] === "week") d.setDate(d.getDate() + n * 7);
    else d.setHours(d.getHours() + n);
    return d;
  }

  const timeMatch =
    t.match(/\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/) ||
    t.match(/\bat\s+(\d{1,2})[:.](\d{2})\b/) ||
    t.match(/\b(\d{1,2}):(\d{2})\b/);

  const d = new Date(ref);

  if (/\btomorrow\b/.test(t)) {
    d.setDate(d.getDate() + 1);
  } else if (DAY_WORD_RE.test(t)) {
    const target = DAY_NAMES.indexOf(t.match(DAY_WORD_RE)[1]);
    let delta = (target - d.getDay() + 7) % 7;
    if (delta === 0) delta = 7; // "friday" said on a Friday means the coming one
    d.setDate(d.getDate() + delta);
  } else if (
    !/\b(today|tonight|this morning|this afternoon|this evening)\b/.test(t)
  ) {
    return null;
  }

  if (timeMatch) {
    let h = parseInt(timeMatch[1], 10);
    if (timeMatch[3] === "pm" && h < 12) h += 12;
    if (timeMatch[3] === "am" && h === 12) h = 0;
    d.setHours(h, timeMatch[2] ? parseInt(timeMatch[2], 10) : 0, 0, 0);
  } else if (/\btonight\b/.test(t)) d.setHours(21, 0, 0, 0);
  else if (/\bevening\b/.test(t)) d.setHours(19, 0, 0, 0);
  else if (/\bafternoon\b/.test(t)) d.setHours(14, 0, 0, 0);
  else d.setHours(9, 0, 0, 0);

  // No explicit time given and the guess is already behind us — park it an hour out.
  if (!timeMatch && d.getTime() <= ref.getTime()) {
    d.setTime(ref.getTime() + 3600000);
    d.setMinutes(0, 0, 0);
  }

  return d;
}

function extractLocally(text) {
  const result = {
    kind: "",
    priority: "",
    dueDate: "",
    person: "",
    project: "",
    recurrence: "none",
  };

  // Date/time via chrono-node (loaded from a CDN in index.html)
  if (window.chrono) {
    try {
      const parsed = window.chrono.parseDate(text, new Date());
      if (parsed) result.dueDate = parsed.toISOString();
    } catch (e) {
      /* fall through to the built-in parser below */
    }
  }

  // Built-in fallback so dates still work offline or if the CDN is blocked
  if (!result.dueDate) {
    const local = parseLocalDate(text);
    if (local) result.dueDate = local.toISOString();
  }

  // Never suggest a due date that has already passed (e.g. "yesterday")
  if (result.dueDate && new Date(result.dueDate).getTime() < Date.now() - 60000)
    result.dueDate = "";

  // Person: "call/meet/with/for <Capitalized Name>"
  const personMatch = text.match(
    /\b(?:call|meet|with|for|from)\s+([A-Z][a-z]+)\b/,
  );
  if (personMatch) result.person = personMatch[1];

  // Priority from urgency words
  if (/\b(urgent|asap|critical|important)\b/i.test(text))
    result.priority = "high";
  else if (/\b(sometime|eventually|whenever|low priority)\b/i.test(text))
    result.priority = "medium";

  // Recurrence
  if (/\bevery day|daily\b/i.test(text)) result.recurrence = "daily";
  else if (/\bevery week|weekly\b/i.test(text)) result.recurrence = "weekly";
  else if (/\bevery month|monthly\b/i.test(text)) result.recurrence = "monthly";

  // Project — match against known project names
  const proj = state.projects.find((p) =>
    text.toLowerCase().includes(p.name.toLowerCase()),
  );
  if (proj) result.project = proj.name;

  // Kind
  result.kind = detectType(text);
  if (/\bwaiting (on|for)\b/i.test(text)) result.kind = "waiting";
  else if (/\b(need to decide|undecided|not sure yet)\b/i.test(text))
    result.kind = "openloop";

  return result;
}
function closeCapture() {
  document.getElementById("captureModal").classList.remove("open");
}
async function saveCapture() {
  const kind = captureType;
  const isMediaType = ["voice", "image", "file"].includes(kind);
  const isLink = kind === "link";
  const text = isLink
    ? document.getElementById("linkUrlInput").value.trim()
    : document.getElementById("captureText").value.trim();

  if (isMediaType && !pendingBlob) return closeCapture();
  if (!isMediaType && !text) return closeCapture();

  let mediaUrl = null;
  if (isMediaType) {
    mediaUrl = await uploadPendingBlob();
  }

  const project = document.getElementById("captureProject").value;
  const dueVal = document.getElementById("captureDueDate").value;
  const dueISO = dueVal ? new Date(dueVal).toISOString() : "";
  const recurrence = document.getElementById("captureRecurrence").value;
  const priority =
    document.getElementById("capturePriority").value ||
    (kind === "task" ? "medium" : "");
  const person = document.getElementById("capturePerson").value.trim();

  const captionText = document.getElementById("captureText").value.trim();
  const titles = {
    voice: "Voice note",
    image: captionText || "Image",
    file: pendingBlob ? pendingBlob.name : "File",
    link: text,
  };
  const subs = {
    voice: "Voice",
    image: captionText ? "Image" : "",
    file: "File",
    link: text,
  };

  const kindMap = {
    text: "memory",
    task: "task",
    event: "event",
    memory: "memory",
    waiting: "waiting",
    openloop: "openloop",
    voice: "voice",
    image: "image",
    file: "file",
    link: "link",
  };
  const realKind = kindMap[kind] || "memory";

  const newItem = {
    id: cid(),
    kind: realKind,
    title: isMediaType || isLink ? titles[kind] : text,
    sub:
      isMediaType || isLink
        ? subs[kind] || ""
        : kind === "task"
          ? "Captured task"
          : kind === "event"
            ? "Captured event"
            : kind === "waiting"
              ? "Waiting for"
              : kind === "openloop"
                ? "Open loop"
                : "Memory",
    priority,
    person,
    due: dueISO ? formatDueDisplay(dueISO) : kind === "task" ? "Today" : "",
    dueDate: dueISO,
    recurrence,
    status: kind === "task" ? "Today" : "",
    project,
    created: Date.now(),
    done: false,
    scope: captureScope,
    mediaUrl: mediaUrl || "",
  };
  state.items.unshift(newItem);
  closeCapture();
  await dbSaveItem(newItem);
}
async function quickCapture() {
  const input = document.getElementById("quickRemember");
  const text = input.value.trim();
  if (!text) return;
  const newItem = {
    id: cid(),
    kind: "memory",
    title: text,
    sub: "Memory",
    priority: "",
    person: "",
    due: "",
    status: "",
    project: "",
    created: Date.now(),
    done: false,
  };
  state.items.unshift(newItem);
  input.value = "";
  await dbSaveItem(newItem);
}
async function startNudge() {
  const newItem = {
    id: cid(),
    kind: "task",
    title: "Work on business idea",
    sub: "20-minute focus block",
    priority: "medium",
    person: "",
    due: "Today",
    status: "Today",
    project: "",
    created: Date.now(),
    done: false,
  };
  state.items.unshift(newItem);
  await dbSaveItem(newItem);
  switchView("tasks");
}

/* ---------- Ask / Search ---------- */
function openAsk() {
  document.getElementById("askOverlay").classList.add("open");
  document.getElementById("askInput").value = "";
  document.getElementById("askResults").innerHTML =
    '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
  setTimeout(() => document.getElementById("askInput").focus(), 50);
}
function closeAsk() {
  document.getElementById("askOverlay").classList.remove("open");
}
let askDebounce = null;
let lastAskQuery = "";
function runAsk(q) {
  lastAskQuery = q;
  const results = document.getElementById("askResults");
  if (!q.trim()) {
    results.innerHTML =
      '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
    return;
  }
  const ql = q.toLowerCase();
  const matches = state.items.filter((i) =>
    (i.title + " " + (i.sub || "") + " " + (i.person || ""))
      .toLowerCase()
      .includes(ql),
  );
  let html = `<div id="aiAnswerSlot"></div>`;
  html += matches.length
    ? matches
        .map(
          (m) =>
            `<div class="ask-result-item" onclick="closeAsk();openPanel('${m.id}')"><b>${escapeHtml(m.title)}</b><br><span style="color:var(--muted)">${escapeHtml(m.sub || "")}</span></div>`,
        )
        .join("")
    : '<p class="empty">No matches found.</p>';
  results.innerHTML = html;

  clearTimeout(askDebounce);
  askDebounce = setTimeout(() => {
    if (lastAskQuery === q) askAI(q);
  }, 550);
}

async function askAI(q) {
  const slot = document.getElementById("aiAnswerSlot");
  if (!slot) return;
  slot.innerHTML = `<div class="ask-answer">Thinking…</div>`;

  const ql = q.toLowerCase();
  const contextItems = state.items.filter((i) =>
    (i.title + " " + (i.sub || "") + " " + (i.person || ""))
      .toLowerCase()
      .includes(ql),
  );
  const contextPool = contextItems.length
    ? contextItems
    : state.items.slice(0, 20);

  let sample;
  try {
    sample = await window.claude?.use("sample");
  } catch (e) {
    sample = null;
  }

  const buildSourcesHtml = () =>
    contextPool.length
      ? `
    <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);">
      <div style="font-size:11.5px;color:var(--muted);font-weight:600;margin-bottom:6px;">SOURCES</div>
      ${contextPool
        .slice(0, 5)
        .map(
          (
            i,
          ) => `<div onclick="closeAsk();openPanel('${i.id}')" style="display:flex;align-items:center;gap:6px;padding:5px 0;cursor:pointer;font-size:12.5px;">
        <span>${kindIcon(i.kind)}</span><span style="color:var(--accent);">${escapeHtml(i.title)}</span>
      </div>`,
        )
        .join("")}
    </div>`
      : "";

  if (sample) {
    const context = contextPool
      .slice(0, 60)
      .map(
        (i) =>
          `- [${i.kind}${i.priority ? "/" + i.priority : ""}] ${i.title}${i.sub ? ": " + i.sub : ""}${i.person ? " (person: " + i.person + ")" : ""}${i.due ? " (due: " + i.due + ")" : ""}`,
      )
      .join("\n");
    const prompt = `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Be concise (2-4 sentences), specific, and reference relevant items by name. If nothing in the context is relevant, say so briefly.\n\nCaptured items:\n${context}\n\nQuestion: ${q}`;
    try {
      const result = await sample(prompt, {
        modelTier: "quick",
        onText: ({ text }) => {
          slot.innerHTML = `<div class="ask-answer">${escapeHtml(text)}</div>`;
        },
      });
      slot.innerHTML = `<div class="ask-answer">${escapeHtml(result.text)}${buildSourcesHtml()}</div>`;
      return;
    } catch (err) {
      /* fall through to API below */
    }
  }

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, items: contextPool }),
    });
    const data = await res.json();
    slot.innerHTML = `<div class="ask-answer">${escapeHtml(data.answer || data.error || "No answer.")}${buildSourcesHtml()}</div>`;
  } catch (err) {
    slot.innerHTML = contextItems.length
      ? `<div class="ask-answer"><b>Answer:</b> Based on what you've captured — ${escapeHtml(
          contextItems
            .slice(0, 3)
            .map((m) => m.title)
            .join("; "),
        )}.${buildSourcesHtml()}</div>`
      : `<div class="ask-answer">Couldn't reach the AI right now.</div>`;
  }
}

/* ---------- Keyboard shortcuts ---------- */
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.tagName === "SELECT" ||
    el.isContentEditable === true
  );
}

/* Modals and the Ask overlay block the single-letter shortcuts; the item slide-over
   does not — a quick capture from there just closes it first. */
function isBlockingOverlayOpen() {
  return (
    !!document.querySelector(".modal-overlay.open") ||
    document.getElementById("askOverlay").classList.contains("open")
  );
}

/* Closes the top-most thing that is open. Returns true if it closed something. */
function closeTopmostOverlay() {
  const notif = document.getElementById("notifPanel");
  if (notif && notif.style.display === "block") {
    notif.style.display = "none";
    return true;
  }

  const avatar = document.getElementById("avatarMenu");
  if (avatar && avatar.style.display === "block") {
    avatar.style.display = "none";
    return true;
  }

  if (document.getElementById("askOverlay").classList.contains("open")) {
    closeAsk();
    return true;
  }
  if (document.getElementById("editModal").classList.contains("open")) {
    closeEditModal();
    return true;
  }
  if (document.getElementById("personModal").classList.contains("open")) {
    closePersonModal();
    return true;
  }
  if (document.getElementById("captureModal").classList.contains("open")) {
    closeCapture();
    return true;
  }
  if (document.getElementById("panel").classList.contains("open")) {
    closePanel();
    return true;
  }

  return false;
}

function shortcutsModifierLabel() {
  const isApple =
    /mac|iphone|ipad|ipod/i.test(navigator.platform || "") ||
    /mac os x/i.test(navigator.userAgent || "");
  return isApple ? "⌘ K" : "Ctrl K";
}

function initShortcuts() {
  const hint = document.getElementById("searchKbdHint");
  if (hint) hint.textContent = shortcutsModifierLabel();

  document.addEventListener("keydown", (e) => {
    const key = e.key;

    if (key === "Escape") {
      if (closeTopmostOverlay()) e.preventDefault();
      return;
    }

    const modifier = e.metaKey || e.ctrlKey;

    if (modifier && (key === "k" || key === "K")) {
      e.preventDefault();
      openAsk();
      return;
    }

    if (isTypingTarget(e.target) || modifier || e.altKey) return;

    if (key === "/") {
      e.preventDefault();
      openAsk();
      return;
    }

    if (key === "c" || key === "C") {
      e.preventDefault();
      if (isBlockingOverlayOpen()) return;
      if (document.getElementById("panel").classList.contains("open"))
        closePanel();
      openCapture();
    }
  });
}

/* ---------- Backup: export / import ---------- */
function exportData() {
  const payload = {
    app: "everything",
    version: 1,
    exportedAt: new Date().toISOString(),
    items: state.items || [],
    projects: state.projects || [],
    goals: state.goals || [],
    people: state.people || [],
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `everything-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFileAsText(file) {
  if (file.text) return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

async function importData(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;

  let payload;
  try {
    payload = JSON.parse(await readFileAsText(file));
  } catch (e) {
    alert("That file is not valid JSON.");
    input.value = "";
    return;
  }

  const incomingItems = Array.isArray(payload.items) ? payload.items : [];
  const incomingProjects = Array.isArray(payload.projects)
    ? payload.projects
    : [];
  const incomingGoals = Array.isArray(payload.goals) ? payload.goals : [];
  const incomingPeople = Array.isArray(payload.people) ? payload.people : [];

  if (
    !incomingItems.length &&
    !incomingProjects.length &&
    !incomingGoals.length &&
    !incomingPeople.length
  ) {
    alert("No Everything data found in that file.");
    input.value = "";
    return;
  }

  if (
    !confirm(
      `Import ${incomingItems.length} item(s)? Existing records with the same id will be replaced.`,
    )
  ) {
    input.value = "";
    return;
  }

  state.items = state.items || [];
  state.projects = state.projects || [];
  state.goals = state.goals || [];
  state.people = state.people || [];

  for (const item of incomingItems) {
    if (!item || !item.id) continue;
    const existing = state.items.find((i) => i.id === item.id);
    if (existing) Object.assign(existing, item);
    else state.items.unshift(item);
    await dbSaveItem(item);
  }
  for (const p of incomingProjects) {
    if (!p || !p.id) continue;
    if (!state.projects.some((x) => x.id === p.id)) state.projects.unshift(p);
    await dbSaveProject(p);
  }
  for (const g of incomingGoals) {
    if (!g || !g.id) continue;
    if (!state.goals.some((x) => x.id === g.id)) state.goals.unshift(g);
    await dbSaveGoal(g);
  }
  for (const p of incomingPeople) {
    if (!p || !p.id) continue;
    if (!state.people.some((x) => x.id === p.id)) state.people.unshift(p);
    await dbSavePerson(p);
  }

  input.value = "";
  renderAll();
  alert(`Imported ${incomingItems.length} item(s).`);
}

/* PWA manifest shortcuts / deep links: ./?capture=1 and ./?view=tasks */
function applyLaunchShortcut() {
  if (!state || !location.search) return;

  const params = new URLSearchParams(location.search);
  const view = params.get("view");

  if (view && document.getElementById("view-" + view)) switchView(view);

  if (params.get("capture") === "1") openCapture();
}

/* ---------- Theme ---------- */
function toggleTheme() {
  const root = document.documentElement;
  const cur = root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  const next = cur === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  state.theme = next;
  save();
}

/* ---------- Utility ---------- */
function escapeHtml(str) {
  return (str || "").replace(
    /[&<>"']/g,
    (s) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        s
      ],
  );
}

function renderAll() {
  renderNav();
  renderToday();
  renderInbox();
  renderTasks();
  renderMemory();
  renderPeople();
  renderProjects();
  renderGoals();
  renderReports();
  renderNotifDot();
  if (activeView === "schedule") renderCalendar();
  const sq = document.getElementById("settingsQuote");
  if (
    sq &&
    typeof MOTIVATION_QUOTES !== "undefined" &&
    currentQuoteIndex !== null
  )
    sq.textContent = '"' + MOTIVATION_QUOTES[currentQuoteIndex] + '"';
}
let notifiedIds = new Set(
  JSON.parse(localStorage.getItem("notified_ids") || "[]"),
);

function requestNotifications() {
  if (!("Notification" in window)) {
    alert("Notifications aren't supported in this browser.");
    return;
  }

  Notification.requestPermission().then((perm) => {
    updateNotifBtn();
    if (perm === "granted") {
      new Notification("Everything", {
        body: "Reminders are on — you'll get notified when tasks are due.",
      });
    }
  });
}
function getNotificationItems() {
  return state.items.filter(
    (i) =>
      !i.done &&
      ((i.dueDate && (isToday(i.dueDate) || isOverdue(i))) ||
        i.kind === "waiting"),
  );
}
function renderNotifDot() {
  const dot = document.getElementById("notifDot");
  if (dot) dot.style.display = getNotificationItems().length ? "block" : "none";
}
function toggleNotifPanel() {
  const panel = document.getElementById("notifPanel");
  const opening = panel.style.display !== "block";
  panel.style.display = opening ? "block" : "none";
  if (opening) renderNotifPanel();
}
function renderNotifPanel() {
  const items = getNotificationItems();
  document.getElementById("notifList").innerHTML = items.length
    ? items
        .map(
          (i) => `
    <div class="task-row" style="padding:9px 14px;" onclick="toggleNotifPanel();openPanel('${i.id}')">
      <div class="task-meta"><div class="task-title">${isOverdue(i) ? "⚠️ " : ""}${escapeHtml(i.title)}</div>
      <div class="task-sub">${isOverdue(i) ? "Overdue" : i.due || "Waiting for"}</div></div>
    </div>`,
        )
        .join("")
    : '<p class="empty" style="padding:14px;">Nothing needs attention right now.</p>';
}
document.addEventListener("click", (e) => {
  const panel = document.getElementById("notifPanel");
  if (
    panel &&
    panel.style.display === "block" &&
    !panel.contains(e.target) &&
    !e.target.closest(".icon-btn")
  ) {
    panel.style.display = "none";
  }
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePushNotifications() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    alert("Push notifications aren't supported in this browser.");
    return;
  }

  const reg = await navigator.serviceWorker.register("./sw.js", {
    scope: "./",
  });
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
  });

  if (sbUser) {
    await sb.from("push_subscriptions").upsert({
      user_id: sbUser,
      subscription: sub.toJSON(),
      created: Date.now(),
    });
  }

  const btn = document.getElementById("notifBtn");
  if (btn) btn.textContent = "✓ Push enabled";
}

function updateNotifBtn() {
  const btn = document.getElementById("notifBtn");
  if (!btn || !("Notification" in window)) return;
  const perm = Notification.permission;
  btn.textContent =
    perm === "granted"
      ? "✓ Enabled"
      : perm === "denied"
        ? "Blocked — check browser settings"
        : "Enable notifications";
}
function checkDueNotifications() {
  if (!("Notification" in window) || Notification.permission !== "granted")
    return;
  const now = Date.now();
  state.items.forEach((item) => {
    if (item.done || !item.dueDate || notifiedIds.has(item.id)) return;
    const due = new Date(item.dueDate).getTime();
    if (due <= now && due > now - 5 * 60000) {
      // due within the last 5 minutes, not missed by too much
      new Notification("Due now: " + item.title, {
        body: item.sub || "Tap to open Everything",
        icon: "",
      });
      notifiedIds.add(item.id);
      localStorage.setItem("notified_ids", JSON.stringify([...notifiedIds]));
    }
  });
}
/* ---------- Init ---------- */
document.getElementById("hamburger").style.display =
  window.innerWidth < 900 ? "flex" : "none";
window.addEventListener("resize", () => {
  document.getElementById("hamburger").style.display =
    window.innerWidth < 900 ? "flex" : "none";
});
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
updateNotifBtn();
renderQuote();
initShortcuts();
applyLaunchShortcut();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker
    .register("./sw.js", { scope: "./" })
    .catch((err) => console.warn("Service worker registration failed:", err));
}
setInterval(checkDueNotifications, 30000);
setInterval(renderToday, 60000);
