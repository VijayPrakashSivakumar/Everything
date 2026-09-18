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
  const now = Date.now();
  return {
    items: [
      {id:cid(), kind:'task', title:'Call Ravi', sub:'Ask about quotation. He promised to send drawings today.', priority:'high', person:'Ravi', due:'Tomorrow, 10:00 AM', status:'Today', project:'Website Design', created: now - 86400000*0.3, done:false},
      {id:cid(), kind:'task', title:'Send quotation', sub:'Finalize pricing and send to Ravi', priority:'high', person:'', due:'Today', status:'Today', project:'Website Design', created: now - 86400000*0.8, done:false},
      {id:cid(), kind:'task', title:'Review project', sub:'Go through latest deliverables', priority:'medium', person:'', due:'Today', status:'Today', project:'', created: now - 86400000*1.2, done:false},
      {id:cid(), kind:'event', title:'Team meeting', sub:'Weekly sync', priority:'', person:'', due:'3:00 PM Today', status:'Work', project:'', created: now - 86400000*0.5, done:false},
      {id:cid(), kind:'waiting', title:"Waiting for Ravi's drawings", sub:'Since Monday', priority:'', person:'Ravi', due:'', status:'Waiting for', project:'Website Design', created: now - 86400000*4, done:false},
      {id:cid(), kind:'memory', title:'Ravi prefers WhatsApp instead of email.', sub:'Memory', priority:'', person:'Ravi', due:'', status:'', project:'', created: now - 3600000*2, done:false},
      {id:cid(), kind:'project', title:'Project house renovation', sub:'Project', priority:'', person:'', due:'', status:'', project:'', created: now - 86400000*1, done:false},
      {id:cid(), kind:'openloop', title:'Laptop options - need to decide', sub:'Open loop', priority:'', person:'', due:'', status:'', project:'', created: now - 86400000*1, done:false},
      {id:cid(), kind:'file', title:'Website design reference', sub:'File', priority:'', person:'', due:'', status:'', project:'Website Design', created: now - 86400000*1, done:false},
    ],
    events: [
      {id:cid(), title:'Call Ravi', day:2, time:'10:00 AM'},
      {id:cid(), title:'Project Review', day:2, time:'11:00 AM'},
      {id:cid(), title:'Team Meeting', day:3, time:'3:00 PM'},
      {id:cid(), title:'Gym', day:4, time:'5:30 PM'},
    ],
    projects: [
      {id:cid(), name:'Website Design', created: now - 86400000*3},
    ],
    goals: [
      {id:cid(), title:'Launch business idea', done:false, created: now - 86400000*5},
    ],
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
  if(col){ await col.doc(item.id).set(item); } else { save(); renderAll(); }
}
async function dbDeleteItem(id){
  const item = state.items.find(i=>i.id===id);
  const col = item ? itemCollectionFor(item) : (db ? db.collection('items') : null);
  if(col){ await col.doc(id).delete(); } else { state.items = state.items.filter(i=>i.id!==id); save(); renderAll(); }
}
async function dbSaveProject(p){ if(db){ await db.collection('projects').doc(p.id).set(p); } else { save(); renderProjects(); renderNav(); } }
async function dbSaveGoal(g){ if(db){ await db.collection('goals').doc(g.id).set(g); } else { save(); renderGoals(); renderReports(); } }

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
  const todays = state.items.filter(i=> (i.kind==='task'||i.kind==='event'||i.kind==='waiting') );
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
  const names = [...new Set(state.items.filter(i=>i.person).map(i=>i.person))];
  const el = document.getElementById('peopleList');
  if(!names.length){ el.innerHTML = '<p class="empty">No people linked yet.</p>'; return; }
  el.innerHTML = names.map(n=>{
    const related = state.items.filter(i=>i.person===n).length;
    return `<div class="task-row"><div class="avatar" style="width:32px;height:32px;font-size:12px;">${n.charAt(0)}</div><div class="task-meta"><div class="task-title">${escapeHtml(n)}</div><div class="task-sub">${related} related item${related>1?'s':''}</div></div></div>`;
  }).join('');
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
  item.dueDate = document.getElementById('editDueDate').value ? new Date(document.getElementById('editDueDate').value).toISOString() : '';
  item.recurrence = document.getElementById('editRecurrence').value;
  item.person = document.getElementById('editPerson').value.trim();
  item.project = document.getElementById('editProject').value;
  const editDueVal = document.getElementById('editDueDate').value;
  item.dueDate = editDueVal ? new Date(editDueVal).toISOString() : '';
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
  {id:'text', label:'📝 Text'}, {id:'task', label:'✓ Task'}, {id:'event', label:'📅 Event'}, {id:'memory', label:'💭 Memory'}
];
let captureAutoDetected = false;
let captureScope = 'shared';
function pickScope(scope){
  captureScope = scope;
  document.querySelectorAll('#visibilityRow .type-chip').forEach(el=>el.classList.toggle('active', el.dataset.scope===scope));
}
function openCapture(){
  captureType = 'text';
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
  setTimeout(()=>document.getElementById('captureText').focus(), 50);
}
function populateProjectSelect(){
  const sel = document.getElementById('captureProject');
  sel.innerHTML = '<option value="">No project</option>' + state.projects.map(p=>`<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)}</option>`).join('');
}
function pickType(id, manual){
  captureType = id;
  if(manual) captureAutoDetected = false;
  document.querySelectorAll('.type-chip').forEach(el=>el.classList.toggle('active', el.dataset.type===id));
}
function detectType(text){
  const t = text.toLowerCase();
  if(/\b(tomorrow|today|at \d|am|pm|meeting|call|deadline|due|schedule)\b/.test(t) && /\b(meeting|call|event|appointment|sync|demo)\b/.test(t)) return 'event';
  if(/\b(todo|to-do|task|need to|have to|remind me|follow up|send|finish|complete|call|email)\b/.test(t)) return 'task';
  return 'memory';
}
function onCaptureInput(){
  const text = document.getElementById('captureText').value;
  document.getElementById('captureHint').textContent = '';
  if(!text.trim() || captureAutoDetected) { if(!text.trim()){captureAutoDetected=false;} return; }
  const guessed = detectType(text);
  if(guessed !== captureType){
    pickType(guessed, false);
    document.getElementById('captureHint').textContent = `Detected as ${guessed} — tap a type above to change it.`;
  }
}
function closeCapture(){ document.getElementById('captureModal').classList.remove('open'); }
async function saveCapture(){
  const text = document.getElementById('captureText').value.trim();
  if(!text) return closeCapture();
  const kindMap = {text:'memory', task:'task', event:'event', memory:'memory'};
  const kind = kindMap[captureType] || 'memory';
  const project = document.getElementById('captureProject').value;
  const dueVal = document.getElementById('captureDueDate').value;
  const dueISO = dueVal ? new Date(dueVal).toISOString() : '';
  const recurrence = document.getElementById('captureRecurrence').value;
  const newItem = {
    id:cid(), kind, title:text, sub: kind==='task' ? 'Captured task' : (kind==='event' ? 'Captured event' : 'Memory'),
    priority: kind==='task' ? 'medium':'', person:'',
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
  try{
    sample = await window.claude?.use('sample');
  }catch(e){ sample = null; }
  if(!sample){
    const matches = state.items.filter(i => (i.title+' '+(i.sub||'')+' '+(i.person||'')).toLowerCase().includes(q.toLowerCase()));
    slot.innerHTML = matches.length
      ? `<div class="ask-answer"><b>Answer:</b> Based on what you've captured — ${escapeHtml(matches.slice(0,3).map(m=>m.title).join('; '))}.</div>`
      : `<div class="ask-answer">AI answers aren't available in this preview. Showing keyword matches instead.</div>`;
    return;
  }
  const context = state.items.slice(0,60).map(i=>`- [${i.kind}${i.priority?'/'+i.priority:''}] ${i.title}${i.sub?': '+i.sub:''}${i.person?' (person: '+i.person+')':''}${i.due?' (due: '+i.due+')':''}`).join('\n');
  const prompt = `You are the "Ask" assistant inside a personal productivity app called Everything. Answer the user's question using ONLY the captured items below as context. Be concise (2-4 sentences).\n\nContext:\n${context}\n\nQuestion: ${q}`;
  try{
    const result = await sample(prompt, {
      modelTier: 'quick',
      onText: ({text}) => { slot.innerHTML = `<div class="ask-answer">${escapeHtml(text)}</div>`; }
    });
    slot.innerHTML = `<div class="ask-answer">${escapeHtml(result.text)}</div>`;
  }catch(err){
    slot.innerHTML = `<div class="ask-answer">Couldn't reach the AI just now (${escapeHtml(err && err.code || 'error')}). Showing your matches above instead.</div>`;
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
initMultiUser();
updateNotifBtn();
setInterval(checkDueNotifications, 30000);
