const SUPABASE_URL = 'https://fyikavzqkezjykvxhqnz.supabase.co';       // e.g. https://xxxx.supabase.co
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ5aWthdnpxa2V6anlrdnhocW56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk4MTA3NDAsImV4cCI6MjEwNTM4Njc0MH0.nNI8-lKsVJCo1vTYCsmQNchBkaOOkJ5ur0FQz_d4QeI';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
const VAPID_PUBLIC_KEY = 'BHWGWugtw2V9RIk_4mItF_ef3sx0ZJBTPuKZVjTEDfOY-o80jJcXXurZlYBhTJAyhqNQzmtBIjDdEguHwyb0hoU';

async function authSignUp(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const authError = document.getElementById('authError');

  if(!email || !password){
    authError.textContent = 'Enter both email and password.';
    return;
  }

  try {
    const { error } = await sb.auth.signUp({ email, password });
    authError.textContent = error ? error.message : 'Check your email to confirm, then sign in.';
  } catch (err) {
    authError.textContent = err?.message || 'Could not create the account.';
  }
}
async function authSignIn(){
  const email = document.getElementById('authEmail').value.trim();
  const password = document.getElementById('authPassword').value;
  const authError = document.getElementById('authError');

  if(!email || !password){
    authError.textContent = 'Enter both email and password.';
    return;
  }

  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    authError.textContent = error ? error.message : '';
  } catch (err) {
    authError.textContent = err?.message || 'Could not sign in.';
  }
}
function togglePasswordVisibility(inputId, toggleId){
  const input = document.getElementById(inputId);
  const toggle = document.getElementById(toggleId);
  const isHidden = input.type === 'password';
  input.type = isHidden ? 'text' : 'password';
  toggle.textContent = isHidden ? '🙈' : '👁️';
}

function showForgotPassword(){
  document.getElementById('authFormNormal').style.display = 'none';
  document.getElementById('authFormForgot').style.display = 'block';
}
function showNormalAuth(){
  document.getElementById('authFormForgot').style.display = 'none';
  document.getElementById('authFormNormal').style.display = 'block';
}

async function authForgotPassword(){
  const email = document.getElementById('forgotEmail').value.trim();
  const msg = document.getElementById('forgotMessage');
  if(!email){ msg.style.color = 'var(--red-fg)'; msg.textContent = 'Enter your email first.'; return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
  msg.style.color = error ? 'var(--red-fg)' : 'var(--accent)';
  msg.textContent = error ? error.message : 'Check your email for a reset link.';
}

async function authUpdatePassword(){
  const pw = document.getElementById('newPassword').value;
  const err = document.getElementById('newPasswordError');
  if(pw.length < 6){ err.textContent = 'Password must be at least 6 characters.'; return; }
  const { error } = await sb.auth.updateUser({ password: pw });
  if(error){ err.textContent = error.message; return; }
  err.style.color = 'var(--accent)';
  err.textContent = 'Password updated — signing you in…';
  setTimeout(() => window.location.href = window.location.origin, 1200);
}
async function authSignOut(){
  const authError = document.getElementById('authError');
  if(authError) authError.textContent = '';
  await sb.auth.signOut();
}
let sbUser = null;
let sbChannel = null;

function itemToRow(item){
  return {
    id: item.id, owner_id: sbUser, scope: item.scope || 'shared', kind: item.kind,
    title: item.title, sub: item.sub || '', priority: item.priority || '', person: item.person || '',
    due: item.due || '', due_date: item.dueDate || null, recurrence: item.recurrence || 'none',
    status: item.status || '', project: item.project || '', created: item.created, done: !!item.done, notified: !!item.notified,
    household_id: currentHouseholdId
  };
}
function rowToItem(row){
  return {
    id: row.id, scope: row.scope, kind: row.kind, title: row.title, sub: row.sub,
    priority: row.priority, person: row.person, due: row.due, dueDate: row.due_date,
    recurrence: row.recurrence, status: row.status, project: row.project,
    created: row.created, done: row.done, notified: row.notified
  };
}
async function startSupabaseSync(userId){
  await ensureHousehold(userId);
  sbUser = userId;
  const { data, error } = await sb.from('items').select('*').eq('household_id', currentHouseholdId).order('created', {ascending:false});
  if(!error && data){
    state.items = data.map(rowToItem);
    if(!state.projects) state.projects = [];
    if(!state.goals) state.goals = [];
    renderAll();
  }
  if(sbChannel) sb.removeChannel(sbChannel);
  sbChannel = sb.channel('items-sync')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'items', filter: `household_id=eq.${currentHouseholdId}` }, payload => {
      if(payload.eventType === 'DELETE'){
        state.items = state.items.filter(i => i.id !== payload.old.id);
      } else {
        const updated = rowToItem(payload.new);
        const idx = state.items.findIndex(i => i.id === updated.id);
        if(idx >= 0) state.items[idx] = updated; else state.items.unshift(updated);
      }
      renderAll();
    })
    .subscribe();

  const { data: projData } = await sb.from('projects').select('*').eq('household_id', currentHouseholdId).order('created', {ascending:false});
  if(projData) state.projects = projData;
  const { data: goalData } = await sb.from('goals').select('*').eq('household_id', currentHouseholdId).order('created', {ascending:false});
  if(goalData) state.goals = goalData;
  const { data: peopleData } = await sb.from('people').select('*').eq('household_id', currentHouseholdId).order('created', {ascending:false});
  if(peopleData) state.people = peopleData;
  renderProjects(); renderGoals(); renderNav(); renderReports();

  sb.channel('projects-sync').on('postgres_changes', { event:'*', schema:'public', table:'projects', filter: `household_id=eq.${currentHouseholdId}` }, payload => {
    if(payload.eventType === 'DELETE') state.projects = state.projects.filter(p => p.id !== payload.old.id);
    else { const idx = state.projects.findIndex(p => p.id === payload.new.id); if(idx>=0) state.projects[idx]=payload.new; else state.projects.unshift(payload.new); }
    renderProjects(); renderNav();
  }).subscribe();

  sb.channel('goals-sync').on('postgres_changes', { event:'*', schema:'public', table:'goals', filter: `household_id=eq.${currentHouseholdId}` }, payload => {
    if(payload.eventType === 'DELETE') state.goals = state.goals.filter(g => g.id !== payload.old.id);
    else { const idx = state.goals.findIndex(g => g.id === payload.new.id); if(idx>=0) state.goals[idx]=payload.new; else state.goals.unshift(payload.new); }
    renderGoals(); renderReports();
  }).subscribe();

  sb.channel('people-sync').on('postgres_changes', { event:'*', schema:'public', table:'people', filter: `household_id=eq.${currentHouseholdId}` }, payload => {
    if(payload.eventType === 'DELETE') state.people = state.people.filter(p => p.id !== payload.old.id);
    else { const idx = state.people.findIndex(p => p.id === payload.new.id); if(idx>=0) state.people[idx]=payload.new; else state.people.unshift(payload.new); }
    renderPeople();
  }).subscribe();
}
let currentHouseholdId = null;

async function ensureHousehold(userId){
  const { data: membership } = await sb.from('household_members').select('household_id').eq('user_id', userId).limit(1);
  if(membership && membership.length){ currentHouseholdId = membership[0].household_id; return; }
  const { data: newHouse } = await sb.from('households').insert({ created_by: userId, created: Date.now() }).select().single();
  if(newHouse){
    currentHouseholdId = newHouse.id;
    await sb.from('household_members').insert({ household_id: newHouse.id, user_id: userId, role:'owner' });
  }
}

async function getInviteCode(){
  const { data } = await sb.from('households').select('invite_code').eq('id', currentHouseholdId).single();
  return data ? data.invite_code : null;
}

async function showInviteCode(){
  const code = await getInviteCode();
  document.getElementById('inviteCodeDisplay').textContent = code || '—';
}

async function joinHousehold(){
  const code = document.getElementById('joinCodeInput').value.trim();
  const msg = document.getElementById('joinMessage');
  if(!code){ msg.textContent = 'Enter a code.'; return; }
  const { data: house } = await sb.from('households').select('id').eq('invite_code', code).single();
  if(!house){ msg.style.color='var(--red-fg)'; msg.textContent = 'Invalid invite code.'; return; }
  await sb.from('household_members').delete().eq('user_id', sbUser);
  await sb.from('household_members').insert({ household_id: house.id, user_id: sbUser, role:'member' });
  currentHouseholdId = house.id;
  msg.style.color='var(--accent)'; msg.textContent = 'Joined! Reloading your data…';
  await startSupabaseSync(sbUser);
  showInviteCode();
}
function toggleAvatarMenu(){
  const menu = document.getElementById('avatarMenu');
  menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('avatarMenu');
  const wrap = document.getElementById('avatarWrap');
  if(menu && menu.style.display === 'block' && !menu.contains(e.target) && e.target !== wrap && !wrap.contains(e.target)){
    menu.style.display = 'none';
  }
});
function confirmSignOut(){
  if(confirm('Sign out of Everything?')){
    authSignOut();
  }
  document.getElementById('avatarMenu').style.display = 'none';
}

let syncedUserId = null;

sb.auth.onAuthStateChange((event, session) => {
  const authScreen = document.getElementById('authScreen');
  if(event === 'PASSWORD_RECOVERY'){
    authScreen.style.display = 'flex';
    document.getElementById('authFormNormal').style.display = 'none';
    document.getElementById('authFormForgot').style.display = 'none';
    document.getElementById('authFormNewPassword').style.display = 'block';
    return;
  }
  if(session){
    authScreen.style.display = 'none';
    if(syncedUserId !== session.user.id){
      syncedUserId = session.user.id;
      startSupabaseSync(session.user.id);
      showInviteCode();
    }
    const name = session.user.email.split('@')[0];
    const greetEl = document.getElementById('greeting');
    if(greetEl) greetEl.textContent = `${greetingText()}, ${name}!`;
    const av = document.getElementById('avatarInitial');
    if(av) av.textContent = name.charAt(0).toUpperCase();
    document.getElementById('avatarMenuEmail').textContent = session.user.email;
  } else {
    syncedUserId = null;
    authScreen.style.display = 'flex';
  }
});

/* ---------- Data model ---------- */
const NAV = [
  {id:'today', icon:'🏠', label:'Today'},
  {id:'inbox', icon:'📥', label:'Inbox', badgeKey:'inboxCount'},
  {id:'tasks', icon:'✅', label:'Tasks', badgeKey:'taskCount'},
  {id:'schedule', icon:'📅', label:'Schedule'},
  {id:'memory', icon:'🧠', label:'Memory'},
  {id:'people', icon:'👥', label:'People'},
  {id:'projects', icon:'📁', label:'Projects'},
  {id:'goals', icon:'🎯', label:'Goals'},
  {id:'reports', icon:'📊', label:'Reports'},
  {id:'insights', icon:'✨', label:'Insights'},
  {id:'settings', icon:'⚙️', label:'Settings'},
];

let state = null;
let currentItemId = null;
let captureType = 'text';

function seedData(){
  return {
    items: [],
    events: [],
    projects: [],
    goals: [],
    people: [],
    theme: 'light',
  };
}

function cid(){ return 'i_' + Math.random().toString(36).slice(2,10); }
function formatDueDisplay(iso){
  if(!iso) return '';
  const d = new Date(iso), now = new Date();
  const timeStr = d.toLocaleTimeString(undefined,{hour:'numeric', minute:'2-digit'});
  if(d.toDateString() === now.toDateString()) return 'Today, ' + timeStr;
  const tmrw = new Date(now); tmrw.setDate(now.getDate()+1);
  if(d.toDateString() === tmrw.toDateString()) return 'Tomorrow, ' + timeStr;
  return d.toLocaleDateString(undefined,{month:'short', day:'numeric'}) + ', ' + timeStr;
}
function nextOccurrence(iso, recurrence){
  const d = new Date(iso);
  if(recurrence === 'daily') d.setDate(d.getDate()+1);
  else if(recurrence === 'weekly') d.setDate(d.getDate()+7);
  else if(recurrence === 'monthly') d.setMonth(d.getMonth()+1);
  return d.toISOString();
}
function isToday(dueDate){
  if(!dueDate) return false;
  return new Date(dueDate).toDateString() === new Date().toDateString();
}
function isOverdue(item){
  return !!item.dueDate && !item.done && new Date(item.dueDate).getTime() < Date.now() && !isToday(item.dueDate);
}
function greetingText(){
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : (h < 17 ? 'Good afternoon' : 'Good evening');
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

function mergeItems(){
  state.items = [...sharedItems, ...privateItems];
}

async function initMultiUser(){
  db = await window.claude?.use('db');
  const user = await window.claude?.use('user');

  if(user){
    try{
      const me = await user.me();
      currentUserId = me.id;
      document.getElementById('greeting').textContent = `Good morning, ${me.name || 'there'}!`;
      const av = document.getElementById('avatarInitial');
      if(av) av.textContent = (me.name || 'V').charAt(0).toUpperCase();
    }catch(e){ /* no identity available in this view — keep defaults */ }
  }

  if(!db){
    try{
      const raw = localStorage.getItem('everything_state_v1');
      state = raw ? JSON.parse(raw) : seedData();
    }catch(e){ state = seedData(); }
    if(!state.projects) state.projects = [];
    if(!state.goals) state.goals = [];
    if(!state.people) state.people = [];
    sharedItems = state.items; privateItems = [];
    if(state.theme) document.documentElement.setAttribute('data-theme', state.theme);
    renderAll();
    return;
  }

  const itemsCol = db.collection('items');
  const projCol  = db.collection('projects');
  const goalCol  = db.collection('goals');

  const existing = await itemsCol.get();
  if(existing.empty){
    const seed = seedData();
    for(const it of seed.items)   await itemsCol.doc(it.id).set(it);
    for(const p of seed.projects) await projCol.doc(p.id).set(p);
    for(const g of seed.goals)    await goalCol.doc(g.id).set(g);
  }

  state = { items: [], projects: [], goals: [], theme: 'light' };

  itemsCol.onSnapshot(snap => { sharedItems = snap.docs.map(d => ({...d.data(), scope:'shared'})); mergeItems(); renderAll(); });
  projCol.onSnapshot (snap => { state.projects = snap.docs.map(d => d.data()); renderProjects(); renderNav(); });
  goalCol.onSnapshot (snap => { state.goals    = snap.docs.map(d => d.data()); renderGoals(); renderReports(); });

  // Per-person private items — only visible to the signed-in viewer who created them
  if(currentUserId){
    const privateItemsCol = db.doc(`data/users/${currentUserId}/profile`).collection('items');
    privateItemsCol.onSnapshot(snap => { privateItems = snap.docs.map(d => ({...d.data(), scope:'private'})); mergeItems(); renderAll(); });
  }
}

/* Use these instead of save() whenever items/projects/goals are mutated.
   item.scope must be 'shared' (default) or 'private'. */
function itemCollectionFor(item){
  if(!db) return null;
  if(item.scope === 'private' && currentUserId) return db.doc(`data/users/${currentUserId}/profile`).collection('items');
  return db.collection('items');
}
async function dbSaveItem(item){
  if(!item.scope) item.scope = 'shared';
  const col = itemCollectionFor(item);
  if(col){
    await col.doc(item.id).set(item);
  } else if(sbUser){
    const { error } = await sb.from('items').upsert(itemToRow(item));
    if(error) console.error('Supabase save failed:', error.message);
  } else {
    save();
  }
  renderAll();
}
async function dbDeleteItem(id){
  const item = state.items.find(i=>i.id===id);
  const col = item ? itemCollectionFor(item) : (db ? db.collection('items') : null);
  if(col){
    await col.doc(id).delete();
  } else if(sbUser){
    const { error } = await sb.from('items').delete().eq('id', id).eq('household_id', currentHouseholdId);
    if(error) console.error('Supabase delete failed:', error.message);
  } else {
    state.items = state.items.filter(i=>i.id!==id);
    save();
  }
  renderAll();
}
async function dbSaveProject(p){
  if(db){ await db.collection('projects').doc(p.id).set(p); }
  else if(sbUser){ await sb.from('projects').upsert({...p, household_id: currentHouseholdId}); }
  else { save(); renderProjects(); renderNav(); }
}
async function dbSaveGoal(g){
  if(db){ await db.collection('goals').doc(g.id).set(g); }
  else if(sbUser){ await sb.from('goals').upsert({...g, household_id: currentHouseholdId}); }
  else { save(); renderGoals(); renderReports(); }
}
async function dbSavePerson(p){
  if(db){ await db.collection('people').doc(p.id).set(p); }
  else if(sbUser){ await sb.from('people').upsert({...p, household_id: currentHouseholdId}); }
  else { save(); renderPeople(); }
}

function save(){
  try{ localStorage.setItem('everything_state_v1', JSON.stringify(state)); }catch(e){ console.error('save failed', e); }
}
function resetData(){
  if(db){ alert('Reset is disabled in multi-user mode — delete items individually instead.'); return; }
  state = seedData();

  save();
  renderAll();
}

/* ---------- Nav & routing ---------- */
function renderNav(){
  const nav = document.getElementById('navList');
  nav.innerHTML = '';
  NAV.forEach(item=>{
    const el = document.createElement('div');
    el.className = 'nav-item' + (item.id===activeView ? ' active':'');
    let badge = '';
    if(item.id==='inbox') badge = state.items.length;
    if(item.id==='tasks') badge = state.items.filter(i=>i.kind==='task' && !i.done).length;
    el.innerHTML = `<div class="left"><span class="nav-icon">${item.icon}</span>${item.label}</div>${badge?`<span class="nav-badge">${badge}</span>`:''}`;
    el.onclick = ()=>switchView(item.id);
    nav.appendChild(el);
  });
}

let activeView = 'today';

function switchView(id){
  activeView = id;
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+id).classList.add('active');
  renderNav();
  if(document.getElementById('sidebar').classList.contains('open')) toggleSidebar();
  if(id==='schedule') renderCalendar();
  if(id==='reports') renderReports();
  if(id==='projects') renderProjects();
  if(id==='goals') renderGoals();
  if(id==='tasks') renderTasks();
  if(id==='inbox') renderInbox();
  if(id==='memory') renderMemory();
  if(id==='people') renderPeople();
}

function toggleSidebar(){ document.getElementById('sidebar').classList.toggle('open'); }

/* ---------- Rendering ---------- */
function timeAgo(ts){
  const diff = Date.now()-ts;
  const h = Math.floor(diff/3600000);
  if(h < 1) return 'Just now';
  if(h < 24) return h+' hour'+(h>1?'s':'')+' ago';
  const d = Math.floor(h/24);
  if(d===1) return 'Yesterday';
  return d+' days ago';
}

function kindIcon(kind){
  return {task:'✓', event:'📅', waiting:'⏳', memory:'💭', project:'📁', openloop:'🔴', file:'📄'}[kind] || '•';
}
function kindColor(kind){
  return {task:['var(--blue-bg)','var(--blue-fg)'], event:['var(--purple-bg)','var(--purple-fg)'], waiting:['var(--amber-bg)','var(--amber-fg)'],
    memory:['var(--green-bg)','var(--green-fg)'], project:['var(--blue-bg)','var(--blue-fg)'], openloop:['var(--red-bg)','var(--red-fg)'], file:['var(--purple-bg)','var(--purple-fg)']}[kind] || ['var(--bg)','var(--text)'];
}

function renderToday(){
  document.getElementById('todayDate').textContent = new Date().toLocaleDateString(undefined,{weekday:'long', year:'numeric', month:'long', day:'numeric'});
  const todays = state.items.filter(i => !i.done && (
  ((i.kind==='task'||i.kind==='event') && (isToday(i.dueDate) || isOverdue(i) || (!i.dueDate && i.due==='Today')))
  || i.kind==='waiting'
  ));
  document.getElementById('statTasks').textContent = state.items.filter(i=>i.kind==='task'&&!i.done).length;
  document.getElementById('statEvents').textContent = state.items.filter(i=>i.kind==='event').length;
  document.getElementById('statWaiting').textContent = state.items.filter(i=>i.kind==='waiting').length;
  document.getElementById('statOpen').textContent = state.items.filter(i=>i.kind==='openloop').length;

  const list = document.getElementById('todayList');
  list.innerHTML = '';
  todays.forEach(item=>{ list.appendChild(taskRow(item)); });

  const recent = document.getElementById('recentList');
  recent.innerHTML = '';
  [...state.items].sort((a,b)=>b.created-a.created).slice(0,4).forEach(item=>{
    const [bg,fg] = kindColor(item.kind);
    const el = document.createElement('div');
    el.className = 'recent-item';
    el.onclick = ()=>openPanel(item.id);
    el.innerHTML = `<div class="recent-dot" style="background:${bg};color:${fg};">${kindIcon(item.kind)}</div>
      <div><div class="recent-text">${escapeHtml(item.title)}</div><div class="recent-tag">${item.kind.charAt(0).toUpperCase()+item.kind.slice(1)}</div></div>
      <div class="recent-time">${timeAgo(item.created)}</div>`;
    recent.appendChild(el);
  });

  const insights = document.getElementById('insightsList');
  const insightData = getInsights();
  insights.innerHTML = insightData.map(i=>`<div class="insight-item"><span>${i.icon}</span><div><div class="insight-title">${i.title}</div><div class="insight-sub">${i.sub}</div></div></div>`).join('');
  document.getElementById('insightsFull').innerHTML = insights.innerHTML || '<p class="empty">Nothing to show yet.</p>';
}

function getInsights(){
  const waiting = state.items.filter(i=>i.kind==='waiting');
  const openLoops = state.items.filter(i=>i.kind==='openloop' || i.kind==='waiting');
  const arr = [];
  if(openLoops.length) arr.push({icon:'✨', title:`You have ${openLoops.length} open loop${openLoops.length>1?'s':''}`, sub: openLoops.map(o=>o.title).join(', ')});
  arr.push({icon:'📈', title:'You\'re most productive', sub:'Tue, Wed, Thu (9 AM – 12 PM)'});
  const dueTasks = state.items.filter(i=>i.kind==='task' && !i.done);
  if(dueTasks.length) arr.push({icon:'⏰', title:'Upcoming deadline', sub:'Finish: '+dueTasks[0].title});
  return arr;
}

function taskRow(item){
  const row = document.createElement('div');
  row.className = 'task-row' + (item.done?' done':'');
  row.onclick = (e)=>{ if(e.target.closest('.checkbox')) return; openPanel(item.id); };
  const check = document.createElement('div');
  check.className = 'checkbox' + (item.done?' checked':'');
  check.textContent = item.done?'✓':'';
  check.onclick = ()=>toggleDone(item.id);
  row.appendChild(check);

  const meta = document.createElement('div');
  meta.className = 'task-meta';
  meta.innerHTML = `<div class="task-title">${item.scope==='private'?'🔒 ':''}${escapeHtml(item.title)}</div><div class="task-sub">${escapeHtml(item.sub||'')}${item.person?' · <span>👤 '+escapeHtml(item.person)+'</span>':''}</div>`;
  row.appendChild(meta);

  if(item.due){
    const t = document.createElement('div');
    t.className = 'task-time';
    t.textContent = (item.recurrence && item.recurrence!=='none' ? '🔁 ' : '') + item.due;
    row.appendChild(t);
  }
  const badgeText = item.priority || item.status || item.kind;
  if(badgeText){
    const b = document.createElement('span');
    b.className = 'badge ' + (item.priority || item.kind);
    b.textContent = item.priority ? item.priority.charAt(0).toUpperCase()+item.priority.slice(1) : badgeText;
    row.appendChild(b);
  }
  return row;
}

async function toggleDone(id){
  const item = state.items.find(i=>i.id===id);
  if(!item) return;
  item.done = !item.done;
  await dbSaveItem(item);
  if(item.done && item.recurrence && item.recurrence !== 'none' && item.dueDate){
    const nextDue = nextOccurrence(item.dueDate, item.recurrence);
    const next = { ...item, id: cid(), done:false, dueDate: nextDue, due: formatDueDisplay(nextDue), created: Date.now() };
    state.items.unshift(next);
    await dbSaveItem(next);
  }
}

function renderInbox(filter){
  filter = filter || 'all';
  const tabs = [['all','All'],['task','Tasks'],['memory','Memory'],['file','Files'],['event','Events']];
  const tabRow = document.getElementById('inboxTabs');
  tabRow.innerHTML = tabs.map(([id,label])=>`<div class="tab ${id===filter?'active':''}" onclick="renderInbox('${id}')">${label}</div>`).join('');
  const list = document.getElementById('inboxList');
  list.innerHTML = '';
  const items = [...state.items].sort((a,b)=>b.created-a.created).filter(i=> filter==='all' || i.kind===filter);
  if(!items.length){ list.innerHTML = '<p class="empty">Nothing here yet.</p>'; return; }
  items.forEach(item=>list.appendChild(taskRow(item)));
}

function renderTasks(){
  const list = document.getElementById('tasksList');
  const tasks = state.items.filter(i=>i.kind==='task');
  list.innerHTML = '';
  if(!tasks.length){ list.innerHTML = '<p class="empty">No tasks yet. Capture one!</p>'; return; }
  tasks.forEach(t=>list.appendChild(taskRow(t)));
}

function renderMemory(){
  const list = document.getElementById('memoryList');
  const mem = state.items.filter(i=>i.kind==='memory');
  list.innerHTML = mem.length ? '' : '<p class="empty">No memories captured yet.</p>';
  mem.forEach(m=>list.appendChild(taskRow(m)));
}

function renderPeople(){
  const el = document.getElementById('peopleList');
  if(!el) return;
  const namesFromItems = [...new Set(state.items.filter(i=>i.person).map(i=>i.person))];
  const knownNames = state.people.map(p=>p.name);
  const inferredOnly = namesFromItems.filter(n => !knownNames.includes(n));

  const rows = [
    ...state.people.map(p => ({ id:p.id, name:p.name, notes:p.notes||'', real:true })),
    ...inferredOnly.map(n => ({ id:null, name:n, notes:'', real:false }))
  ];

  if(!rows.length){ el.innerHTML = '<p class="empty">No people yet — add one below or tag someone on a task.</p>'; return; }

  el.innerHTML = rows.map(p=>{
    const count = state.items.filter(i=>i.person===p.name).length;
    return `<div class="task-row" onclick="openPersonModal(${p.id?`'${p.id}'`:'null'}, '${escapeHtml(p.name)}')">
      <div class="avatar" style="width:32px;height:32px;font-size:12px;">${p.name.charAt(0).toUpperCase()}</div>
      <div class="task-meta"><div class="task-title">${escapeHtml(p.name)}</div><div class="task-sub">${count} linked item${count!==1?'s':''}${p.notes?' · has notes':''}</div></div>
    </div>`;
  }).join('');
}
let currentPersonName = null;
function openPersonModal(id, name){
  currentPersonName = name;
  const person = state.people.find(p => p.name === name);
  document.getElementById('personModalName').textContent = name;
  document.getElementById('personNotes').value = person ? (person.notes || '') : '';
  const items = state.items.filter(i => i.person === name);
  const list = document.getElementById('personItemsList');
  list.innerHTML = items.length
    ? items.map(i => `<div class="task-row" onclick="closePersonModal();openPanel('${i.id}')"><div class="checkbox ${i.done?'checked':''}">${i.done?'✓':''}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub||'')}</div></div></div>`).join('')
    : '<p class="empty">No linked items yet.</p>';
  document.getElementById('personModal').classList.add('open');
}
function closePersonModal(){ document.getElementById('personModal').classList.remove('open'); currentPersonName = null; }
async function savePersonNotes(){
  if(!currentPersonName) return;
  let person = state.people.find(p => p.name === currentPersonName);
  const notes = document.getElementById('personNotes').value.trim();
  if(!person){
    person = { id:cid(), name: currentPersonName, notes, created: Date.now() };
    state.people.unshift(person);
  } else {
    person.notes = notes;
  }
  await dbSavePerson(person);
  closePersonModal();
}

async function addPersonManual(){
  const input = document.getElementById('newPersonInput');
  const name = input.value.trim();
  if(!name) return;
  if(state.people.some(p=>p.name.toLowerCase()===name.toLowerCase())){ input.value=''; return; }
  const p = { id:cid(), name, notes:'', created:Date.now() };
  state.people.unshift(p);
  input.value = '';
  await dbSavePerson(p);
}

/* ---------- Projects ---------- */
async function addProject(){
  const input = document.getElementById('newProjectInput');
  const name = input.value.trim();
  if(!name) return;
  const p = {id:cid(), name, created:Date.now()};
  state.projects.unshift(p);
  input.value = '';
  await dbSaveProject(p);
}
function renderProjects(){
  const el = document.getElementById('projectsList');
  if(!el) return;
  if(!state.projects.length){ el.innerHTML = '<div class="card"><p class="empty">No projects yet.</p></div>'; return; }
  el.innerHTML = state.projects.map(p=>{
    const items = state.items.filter(i=>i.project===p.name);
    const open = items.filter(i=>!i.done).length;
    return `<div class="card">
      <div class="card-head"><h3>${escapeHtml(p.name)}</h3><span class="badge task">${open} open</span></div>
      ${items.length ? items.map(i=>`<div class="task-row" onclick="openPanel('${i.id}')"><div class="checkbox ${i.done?'checked':''}">${i.done?'✓':''}</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div><div class="task-sub">${escapeHtml(i.sub||'')}</div></div></div>`).join('') : '<p class="empty">No items here yet.</p>'}
    </div>`;
  }).join('');
}

/* ---------- Goals ---------- */
async function addGoal(){
  const input = document.getElementById('newGoalInput');
  const title = input.value.trim();
  if(!title) return;
  const g = {id:cid(), title, done:false, created:Date.now()};
  state.goals.unshift(g);
  input.value = '';
  await dbSaveGoal(g);
}
async function toggleGoal(id){
  const g = state.goals.find(g=>g.id===id);
  if(g){ g.done = !g.done; await dbSaveGoal(g); }
}
function renderGoals(){
  const el = document.getElementById('goalsList');
  if(!el) return;
  if(!state.goals.length){ el.innerHTML = '<p class="empty">No goals set yet.</p>'; return; }
  el.innerHTML = state.goals.map(g=>`<div class="task-row"><div class="checkbox ${g.done?'checked':''}" onclick="toggleGoal('${g.id}')">${g.done?'✓':''}</div><div class="task-meta"><div class="task-title">${escapeHtml(g.title)}</div></div></div>`).join('');
}

/* ---------- Reports ---------- */
function renderReports(){
  const statsEl = document.getElementById('reportStats');
  if(!statsEl) return;
  const weekAgo = Date.now() - 7*86400000;
  const completed = state.items.filter(i=>i.done);
  const createdThisWeek = state.items.filter(i=>i.created >= weekAgo);
  const byType = {};
  state.items.forEach(i=>{ byType[i.kind] = (byType[i.kind]||0)+1; });

  statsEl.innerHTML = `
    <div class="stat-card"><div class="stat-icon" style="background:var(--green-bg);color:var(--green-fg);">✔</div><div><div class="stat-num">${completed.length}</div><div class="stat-label">Completed</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--blue-bg);color:var(--blue-fg);">📥</div><div><div class="stat-num">${createdThisWeek.length}</div><div class="stat-label">Captured this week</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--purple-bg);color:var(--purple-fg);">📁</div><div><div class="stat-num">${state.projects.length}</div><div class="stat-label">Projects</div></div></div>
    <div class="stat-card"><div class="stat-icon" style="background:var(--amber-bg);color:var(--amber-fg);">🎯</div><div><div class="stat-num">${state.goals.filter(g=>!g.done).length}</div><div class="stat-label">Open goals</div></div></div>
  `;

  const completedEl = document.getElementById('reportCompleted');
  completedEl.innerHTML = completed.length ? completed.slice(0,10).map(i=>`<div class="task-row"><div class="checkbox checked">✓</div><div class="task-meta"><div class="task-title">${escapeHtml(i.title)}</div></div></div>`).join('') : '<p class="empty">Nothing finished yet.</p>';

  const typeEl = document.getElementById('reportByType');
  typeEl.innerHTML = Object.keys(byType).length ? Object.entries(byType).map(([k,v])=>`<div class="field-row"><span class="field-label">${k.charAt(0).toUpperCase()+k.slice(1)}</span><span>${v}</span></div>`).join('') : '<p class="empty">No data yet.</p>';
}

/* ---------- Calendar ---------- */
function renderCalendar(){
  const now = new Date();
  document.getElementById('calMonthLabel').textContent = now.toLocaleDateString(undefined,{month:'long', year:'numeric'});
  const grid = document.getElementById('calGrid');
  grid.innerHTML = '';
  ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].forEach(d=>{
    const h = document.createElement('div'); h.className='cal-day-head'; h.textContent=d; grid.appendChild(h);
  });
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOffset = firstDay.getDay();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  for(let i=0;i<startOffset;i++){
    const c = document.createElement('div'); c.className='cal-cell'; grid.appendChild(c);
  }
  for(let d=1; d<=daysInMonth; d++){
    const c = document.createElement('div');
    c.className = 'cal-cell' + (d===now.getDate() ? ' today':'');
    const num = document.createElement('div'); num.className='num'; num.textContent=d;
    c.appendChild(num);
    state.events.filter(e=>e.day===d).forEach(e=>{
      const ev = document.createElement('div');
      ev.className = 'cal-event';
      ev.textContent = e.time+' '+e.title;
      c.appendChild(ev);
    });
    grid.appendChild(c);
  }
}

/* ---------- Task detail panel ---------- */
function openPanel(id){
  currentItemId = id;
  const item = state.items.find(i=>i.id===id);
  if(!item) return;
  document.getElementById('panelTitle').textContent = item.title;
  document.getElementById('panelDesc').textContent = item.sub || '';
  document.getElementById('panelType').textContent = item.kind.charAt(0).toUpperCase()+item.kind.slice(1);
  document.getElementById('panelDue').textContent = item.due || '—';
  document.getElementById('panelPerson').textContent = item.person || '—';
  document.getElementById('panelStatus').textContent = item.done ? 'Complete' : (item.status || 'Open');
  document.getElementById('panelVisibility').textContent = item.scope==='private' ? '🔒 Private (only you)' : '🌐 Shared';
  document.getElementById('panelCreated').textContent = new Date(item.created).toLocaleString();
  const badge = document.getElementById('panelBadge');
  badge.textContent = item.priority ? item.priority.charAt(0).toUpperCase()+item.priority.slice(1) : item.kind;
  badge.className = 'badge ' + (item.priority || item.kind);
  document.getElementById('overlay').classList.add('open');
  document.getElementById('panel').classList.add('open');
}
function closePanel(){
  document.getElementById('overlay').classList.remove('open');
  document.getElementById('panel').classList.remove('open');
  currentItemId = null;
}
function openEditModal(){
  if(!currentItemId) return;
  const item = state.items.find(i=>i.id===currentItemId);
  if(!item) return;
  document.getElementById('editTitle').value = item.title || '';
  document.getElementById('editSub').value = item.sub || '';
  document.getElementById('editPriority').value = item.priority || '';
  document.getElementById('editDueDate').value = item.dueDate ? item.dueDate.slice(0,16) : '';
  document.getElementById('editRecurrence').value = item.recurrence || 'none';
  document.getElementById('editPerson').value = item.person || '';
  const projSel = document.getElementById('editProject');
  projSel.innerHTML = '<option value="">No project</option>' + state.projects.map(p=>`<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('');
  projSel.value = item.project || '';
  document.getElementById('editModal').classList.add('open');
}
function closeEditModal(){ document.getElementById('editModal').classList.remove('open'); }
async function saveEdit(){
  const item = state.items.find(i=>i.id===currentItemId);
  if(!item) return closeEditModal();
  item.title = document.getElementById('editTitle').value.trim() || item.title;
  item.sub = document.getElementById('editSub').value.trim();
  item.priority = document.getElementById('editPriority').value;
  item.person = document.getElementById('editPerson').value.trim();
  item.project = document.getElementById('editProject').value;

  const editDueVal = document.getElementById('editDueDate').value;
  const newDueDate = editDueVal ? new Date(editDueVal).toISOString() : '';
  if(newDueDate !== item.dueDate) item.notified = false;
  item.dueDate = newDueDate;
  item.recurrence = document.getElementById('editRecurrence').value;
  if(item.dueDate) item.due = formatDueDisplay(item.dueDate);

  closeEditModal();
  closePanel();
  await dbSaveItem(item);
}
async function completeCurrent(){
  if(!currentItemId) return;
  await toggleDone(currentItemId);
  closePanel();
}
async function deleteCurrent(){
  if(!currentItemId) return;
  const id = currentItemId;
  state.items = state.items.filter(i=>i.id!==id);
  closePanel();
  await dbDeleteItem(id);
}

/* ---------- Capture modal ---------- */
const CAPTURE_TYPES = [
  {id:'text', label:'📝 Text'}, {id:'task', label:'✓ Task'}, {id:'event', label:'📅 Event'}, {id:'memory', label:'💭 Memory'},
  {id:'waiting', label:'⏳ Waiting for'}, {id:'openloop', label:'🔴 Open loop'}
];
let captureAutoDetected = false;
let captureScope = 'shared';
function pickScope(scope){
  captureScope = scope;
  document.querySelectorAll('#visibilityRow .type-chip').forEach(el=>el.classList.toggle('active', el.dataset.scope===scope));
}
function openCapture(){
  captureType = 'text';
if(document.getElementById('sidebar').classList.contains('open')) toggleSidebar();
  captureAutoDetected = false;
  captureScope = 'shared';
  pickScope('shared');
  const row = document.getElementById('typeRow');
  row.innerHTML = CAPTURE_TYPES.map(t=>`<div class="type-chip ${t.id===captureType?'active':''}" data-type="${t.id}" onclick="pickType('${t.id}', true)">${t.label}</div>`).join('');
  document.getElementById('captureText').value = '';
  document.getElementById('captureHint').textContent = '';
  populateProjectSelect();
  document.getElementById('captureModal').classList.add('open');
  document.getElementById('captureDueDate').value = '';
  document.getElementById('captureRecurrence').value = 'none';
  document.getElementById('capturePriority').value = '';
  document.getElementById('capturePerson').value = '';
  setTimeout(()=>document.getElementById('captureText').focus(), 50);
}
function populateProjectSelect(){
  const sel = document.getElementById('captureProject');
  sel.innerHTML = '<option value="">No project</option>' + state.projects.map(p=>`<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('');
}
function pickType(id, manual){
  captureType = id;
  if(manual) captureAutoDetected = true;
  document.querySelectorAll('.type-chip').forEach(el=>el.classList.toggle('active', el.dataset.type===id));
}
function detectType(text){
  const t = text.toLowerCase();
  if(/\b(tomorrow|today|at \d|am|pm|meeting|call|deadline|due|schedule)\b/.test(t) && /\b(meeting|call|event|appointment|sync|demo)\b/.test(t)) return 'event';
  if(/\b(todo|to-do|task|need to|have to|remind me|follow up|send|finish|complete|call|email)\b/.test(t)) return 'task';
  return 'memory';
}
let extractDebounce = null;
function onCaptureInput(){
  const text = document.getElementById('captureText').value;
  document.getElementById('captureHint').textContent = '';
  if(!text.trim()){ captureAutoDetected = false; return; }

  if(!captureAutoDetected){
    const guessed = detectType(text);
    if(guessed !== captureType) pickType(guessed, false);
  }

  clearTimeout(extractDebounce);
  document.getElementById('captureHint').textContent = '✨ Reading…';
  extractDebounce = setTimeout(() => extractWithAI(text), 700);
}

async function extractWithAI(text){
  let result = null;

  // Free path: Claude artifact's built-in sample capability (no cost)
  let sample;
  try{ sample = await window.claude?.use('sample'); }catch(e){ sample = null; }
  if(sample){
    const now = new Date().toISOString();
    const projectList = state.projects.map(p=>p.name).join(', ') || 'none';
    const prompt = `You extract structured data from a quick personal note for a productivity app. Current date/time: ${now}. Known projects: ${projectList}.\n\nNote: "${text}"\n\nRespond with ONLY raw JSON:\n{"kind":"task|event|memory|waiting|openloop","priority":"high|medium|low|","dueDate":"ISO 8601 datetime or empty string","person":"name or empty string","project":"one of the known projects if it clearly matches, else empty string","recurrence":"none|daily|weekly|monthly"}`;
    try{
      const res = await sample(prompt, { modelTier: 'quick' });
      result = JSON.parse(res.text.replace(/```json|```/g,'').trim());
    }catch(e){ result = null; }
  }

  // Free path: local rule-based extraction (no API, no cost) — used on the live Vercel site
  if(!result){
    result = extractLocally(text);
  }

  if(document.getElementById('captureText').value !== text) return;
  applyExtraction(result);
}

function extractLocally(text){
  const result = { kind:'', priority:'', dueDate:'', person:'', project:'', recurrence:'none' };

  // Date/time via chrono-node
  if(window.chrono){
    const parsed = window.chrono.parseDate(text, new Date());
    if(parsed) result.dueDate = parsed.toISOString();
  }

  // Person: "call/meet/with/for <Capitalized Name>"
  const personMatch = text.match(/\b(?:call|meet|with|for|from)\s+([A-Z][a-z]+)\b/);
  if(personMatch) result.person = personMatch[1];

  // Priority from urgency words
  if(/\b(urgent|asap|critical|important)\b/i.test(text)) result.priority = 'high';
  else if(/\b(sometime|eventually|whenever|low priority)\b/i.test(text)) result.priority = 'medium';

  // Recurrence
  if(/\bevery day|daily\b/i.test(text)) result.recurrence = 'daily';
  else if(/\bevery week|weekly\b/i.test(text)) result.recurrence = 'weekly';
  else if(/\bevery month|monthly\b/i.test(text)) result.recurrence = 'monthly';

  // Project — match against known project names
  const proj = state.projects.find(p => text.toLowerCase().includes(p.name.toLowerCase()));
  if(proj) result.project = proj.name;

  // Kind
  result.kind = detectType(text);
  if(/\bwaiting (on|for)\b/i.test(text)) result.kind = 'waiting';
  else if(/\b(need to decide|undecided|not sure yet)\b/i.test(text)) result.kind = 'openloop';

  return result;
}
function closeCapture(){ document.getElementById('captureModal').classList.remove('open'); }
async function saveCapture(){
  const text = document.getElementById('captureText').value.trim();
  if(!text) return closeCapture();
  const kindMap = {text:'memory', task:'task', event:'event', memory:'memory', waiting:'waiting', openloop:'openloop'};
  const kind = kindMap[captureType] || 'memory';
  const project = document.getElementById('captureProject').value;
  const dueVal = document.getElementById('captureDueDate').value;
  const dueISO = dueVal ? new Date(dueVal).toISOString() : '';
  const recurrence = document.getElementById('captureRecurrence').value;
  const priority = document.getElementById('capturePriority').value || (kind==='task' ? 'medium' : '');
  const person = document.getElementById('capturePerson').value.trim();
  const newItem = {
    id:cid(), kind, title:text, sub: kind==='task' ? 'Captured task' : (kind==='event' ? 'Captured event' : (kind==='waiting' ? 'Waiting for' : (kind==='openloop' ? 'Open loop' : 'Memory'))),
    priority, person,
    due: dueISO ? formatDueDisplay(dueISO) : (kind==='task' ? 'Today' : ''),
    dueDate: dueISO, recurrence,
    status: kind==='task' ? 'Today':'', project, created: Date.now(), done:false,
    scope: captureScope
  };
  state.items.unshift(newItem);
  closeCapture();
  await dbSaveItem(newItem);
}
async function quickCapture(){
  const input = document.getElementById('quickRemember');
  const text = input.value.trim();
  if(!text) return;
  const newItem = {id:cid(), kind:'memory', title:text, sub:'Memory', priority:'', person:'', due:'', status:'', project:'', created:Date.now(), done:false};
  state.items.unshift(newItem);
  input.value='';
  await dbSaveItem(newItem);
}
async function startNudge(){
  const newItem = {id:cid(), kind:'task', title:'Work on business idea', sub:'20-minute focus block', priority:'medium', person:'', due:'Today', status:'Today', project:'', created:Date.now(), done:false};
  state.items.unshift(newItem);
  await dbSaveItem(newItem);
  switchView('tasks');
}

/* ---------- Ask / Search ---------- */
function openAsk(){
  document.getElementById('askOverlay').classList.add('open');
  document.getElementById('askInput').value='';
  document.getElementById('askResults').innerHTML = '<p class="empty">Start typing to search your captures, tasks and notes.</p>';
  setTimeout(()=>document.getElementById('askInput').focus(), 50);
}
function closeAsk(){ document.getElementById('askOverlay').classList.remove('open'); }
let askDebounce = null;
let lastAskQuery = '';
function runAsk(q){
  lastAskQuery = q;
  const results = document.getElementById('askResults');
  if(!q.trim()){ results.innerHTML = '<p class="empty">Start typing to search your captures, tasks and notes.</p>'; return; }
  const ql = q.toLowerCase();
  const matches = state.items.filter(i => (i.title+' '+(i.sub||'')+' '+(i.person||'')).toLowerCase().includes(ql));
  let html = `<div id="aiAnswerSlot"></div>`;
  html += matches.length ? matches.map(m=>`<div class="ask-result-item" onclick="closeAsk();openPanel('${m.id}')"><b>${escapeHtml(m.title)}</b><br><span style="color:var(--muted)">${escapeHtml(m.sub||'')}</span></div>`).join('') : '<p class="empty">No matches found.</p>';
  results.innerHTML = html;

  clearTimeout(askDebounce);
  askDebounce = setTimeout(()=>{ if(lastAskQuery===q) askAI(q); }, 550);
}

async function askAI(q){
  const slot = document.getElementById('aiAnswerSlot');
  if(!slot) return;
  slot.innerHTML = `<div class="ask-answer">Thinking…</div>`;

  let sample;
  try{ sample = await window.claude?.use('sample'); }catch(e){ sample = null; }

  if(sample){
    const context = state.items.slice(0,60).map(i=>`- [${i.kind}${i.priority?'/'+i.priority:''}] ${i.title}${i.sub?': '+i.sub:''}${i.person?' (person: '+i.person+')':''}${i.due?' (due: '+i.due+')':''}`).join('\n');
    const prompt = `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Be concise (2-4 sentences), specific, and reference relevant items by name. If nothing in the context is relevant, say so briefly.\n\nCaptured items:\n${context}\n\nQuestion: ${q}`;
    try{
      const result = await sample(prompt, { modelTier:'quick', onText: ({text}) => { slot.innerHTML = `<div class="ask-answer">${escapeHtml(text)}</div>`; } });
      slot.innerHTML = `<div class="ask-answer">${escapeHtml(result.text)}</div>`;
      return;
    }catch(err){ /* fall through to API below */ }
  }

  try{
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, items: state.items })
    });
    const data = await res.json();
    slot.innerHTML = `<div class="ask-answer">${escapeHtml(data.answer || data.error || 'No answer.')}</div>`;
  }catch(err){
    const matches = state.items.filter(i => (i.title+' '+(i.sub||'')+' '+(i.person||'')).toLowerCase().includes(q.toLowerCase()));
    slot.innerHTML = matches.length
      ? `<div class="ask-answer"><b>Answer:</b> Based on what you've captured — ${escapeHtml(matches.slice(0,3).map(m=>m.title).join('; '))}.</div>`
      : `<div class="ask-answer">Couldn't reach the AI right now.</div>`;
  }
}

/* ---------- Theme ---------- */
function toggleTheme(){
  const root = document.documentElement;
  const cur = root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = cur === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', next);
  state.theme = next;
  save();
}

/* ---------- Utility ---------- */
function escapeHtml(str){
  return (str||'').replace(/[&<>"']/g, s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[s]));
}

function renderAll(){
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
  if(activeView==='schedule') renderCalendar();
}
let notifiedIds = new Set(JSON.parse(localStorage.getItem('notified_ids') || '[]'));

function requestNotifications(){
  if(!('Notification' in window)){
    alert('Notifications aren\'t supported in this browser.');
    return;
  }

  Notification.requestPermission().then(perm => {
    updateNotifBtn();
    if(perm === 'granted'){
      new Notification('Everything', { body: 'Reminders are on — you\'ll get notified when tasks are due.' });
    }
  });
}
function getNotificationItems(){
  return state.items.filter(i => !i.done && ((i.dueDate && (isToday(i.dueDate) || isOverdue(i))) || i.kind === 'waiting'));
}
function renderNotifDot(){
  const dot = document.getElementById('notifDot');
  if(dot) dot.style.display = getNotificationItems().length ? 'block' : 'none';
}
function toggleNotifPanel(){
  const panel = document.getElementById('notifPanel');
  const opening = panel.style.display !== 'block';
  panel.style.display = opening ? 'block' : 'none';
  if(opening) renderNotifPanel();
}
function renderNotifPanel(){
  const items = getNotificationItems();
  document.getElementById('notifList').innerHTML = items.length ? items.map(i => `
    <div class="task-row" style="padding:9px 14px;" onclick="toggleNotifPanel();openPanel('${i.id}')">
      <div class="task-meta"><div class="task-title">${isOverdue(i)?'⚠️ ':''}${escapeHtml(i.title)}</div>
      <div class="task-sub">${isOverdue(i) ? 'Overdue' : (i.due || 'Waiting for')}</div></div>
    </div>`).join('') : '<p class="empty" style="padding:14px;">Nothing needs attention right now.</p>';
}
document.addEventListener('click', (e) => {
  const panel = document.getElementById('notifPanel');
  if(panel && panel.style.display==='block' && !panel.contains(e.target) && !e.target.closest('.icon-btn')){
    panel.style.display = 'none';
  }
});

function urlBase64ToUint8Array(base64String){
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g,'+').replace(/_/g,'/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function enablePushNotifications(){
  if(!('serviceWorker' in navigator) || !('PushManager' in window)){
    alert('Push notifications aren\'t supported in this browser.');
    return;
  }

  const reg = await navigator.serviceWorker.register('/sw.js');
  const perm = await Notification.requestPermission();
  if(perm !== 'granted') return;

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
  });

  if(sbUser){
    await sb.from('push_subscriptions').upsert({ user_id: sbUser, subscription: sub.toJSON(), created: Date.now() });
  }

  const btn = document.getElementById('notifBtn');
  if(btn) btn.textContent = '✓ Push enabled';
}

function updateNotifBtn(){
  const btn = document.getElementById('notifBtn');
  if(!btn || !('Notification' in window)) return;
  const perm = Notification.permission;
  btn.textContent = perm === 'granted' ? '✓ Enabled' : (perm === 'denied' ? 'Blocked — check browser settings' : 'Enable notifications');
}
function checkDueNotifications(){
  if(!('Notification' in window) || Notification.permission !== 'granted') return;
  const now = Date.now();
  state.items.forEach(item => {
    if(item.done || !item.dueDate || notifiedIds.has(item.id)) return;
    const due = new Date(item.dueDate).getTime();
    if(due <= now && due > now - 5*60000){ // due within the last 5 minutes, not missed by too much
      new Notification('Due now: ' + item.title, { body: item.sub || 'Tap to open Everything', icon: '' });
      notifiedIds.add(item.id);
      localStorage.setItem('notified_ids', JSON.stringify([...notifiedIds]));
    }
  });
}
/* ---------- Init ---------- */
document.getElementById('hamburger').style.display = window.innerWidth<900 ? 'flex':'none';
window.addEventListener('resize', ()=>{ document.getElementById('hamburger').style.display = window.innerWidth<900 ? 'flex':'none'; });
if(window.claude){ initMultiUser(); }
else { state = { items:[], events:[], projects:[], goals:[], people:[], theme: localStorage.getItem('theme')||'light' }; if(state.theme) document.documentElement.setAttribute('data-theme', state.theme); }
updateNotifBtn();
setInterval(checkDueNotifications, 30000);
setInterval(renderToday, 60000);
