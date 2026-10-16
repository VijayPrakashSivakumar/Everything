/* ---------- Support tickets ---------- */
// Support is where a person goes when the app did not do what they expected. The whole
// surface has to survive being used: signing out, having no client (the CDN blocked) and the
// server answering badly must all leave one honest message on screen instead of a dead form.
// That is why every state here says what to do next, not merely what failed.

const ticketState = {
  tickets: [],
  loaded: false,
  loading: false,
  submitting: false,
};

const TICKET_STATUS_LABEL = {
  open: 'Open',
  in_progress: 'In progress',
  resolved: 'Resolved',
};

const TICKET_CATEGORY_LABEL = {
  bug: 'Bug',
  feature: 'Feature request',
  question: 'Question',
  other: 'Other',
};

const TICKET_PRIORITY_LABEL = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
};

function ticketMessage(text, tone) {
  const el = document.getElementById('ticketMessage');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('error', tone === 'error');
  el.classList.toggle('ok', tone === 'ok');
}

function ticketBusy(busy) {
  const btn = document.getElementById('ticketSubmit');
  const label = document.getElementById('ticketSubmitLabel');
  if (!btn || !label) return;
  btn.disabled = busy;
  btn.setAttribute('aria-busy', busy ? 'true' : 'false');
  label.textContent = busy ? 'Sending…' : 'Send to dev team';
}

const TICKET_CATEGORIES = new Set(['bug', 'feature', 'question', 'other']);
const TICKET_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);
const TICKET_STATUS_ORDER = { open: 1, in_progress: 2, resolved: 3 };

function ticketDbError(error, fallback) {
  console.error('Support ticket request failed:', error);
  return error && error.message ? error.message : fallback;
}

async function fetchTicketsSupabase() {
  if (!sb) return { data: null, error: 'Support is unavailable because the database client did not load. Refresh and try again.' };
  if (!sbUser) return { data: null, error: 'Sign in to view your support tickets.' };

  try {
    let query = sb
      .from('tickets')
      .select('*')
      .eq('user_id', sbUser);
    // The deployed schema is mixed (`created` on the older prototype tables, `created_at` on the
    // later ones), so ordering by a name the table lacks errors out and the tickets silently
    // disappear. Probe once via the shared resolver, then use what actually exists.
    const orderColumn = typeof structuredCreatedColumn === 'function'
      ? await structuredCreatedColumn('tickets')
      : 'created_at';
    if (orderColumn) query = query.order(orderColumn, { ascending: false });
    const { data, error } = await query.limit(200);
    if (error) return { data: null, error: ticketDbError(error, 'Could not load your tickets.') };
    return { data: { tickets: data || [] }, error: null };
  } catch (error) {
    return { data: null, error: ticketDbError(error, 'Could not connect to support. Check your connection and try again.') };
  }
}

async function createTicketSupabase(method, body) {
  if (!sb) return { error: 'Support is unavailable because the database client did not load. Refresh and try again.' };
  if (!sbUser) return { error: 'Sign in to create or update a support ticket.' };
  const input = body && typeof body === 'object' ? body : {};

  try {
    if (method === 'POST') {
      const title = String(input.title || '').trim();
      const description = String(input.description || '').trim();
      const category = String(input.category || 'question').trim().toLowerCase();
      const priority = String(input.priority || 'normal').trim().toLowerCase();
      if (!title) return { error: 'Enter a short title for your ticket.' };
      if (!description) return { error: 'Describe what happened so the team can help.' };
      if (!TICKET_CATEGORIES.has(category)) return { error: 'Choose a category that best describes the issue.' };
      if (!TICKET_PRIORITIES.has(priority)) return { error: 'Choose a priority level.' };

      const { data, error } = await sb.from('tickets').insert({
        user_id: sbUser,
        title,
        description,
        category,
        priority,
        status: 'open',
      }).select().maybeSingle();
      if (error) return { error: ticketDbError(error, 'Could not save your ticket.') };
      if (!data) return { error: 'Could not save your ticket because no ticket was returned.' };
      return { data: { ticket: data }, error: null };
    }

    if (method === 'PATCH') {
      const id = String(input.id || '').trim();
      const status = String(input.status || '').trim().toLowerCase();
      if (!id) return { error: 'Ticket id is required.' };
      if (!Object.hasOwn(TICKET_STATUS_ORDER, status)) return { error: 'Choose a valid status.' };

      const current = await sb.from('tickets')
        .select('id, status')
        .eq('id', id)
        .eq('user_id', sbUser)
        .maybeSingle();
      if (current.error) return { error: ticketDbError(current.error, 'Could not find that ticket.') };
      if (!current.data) return { error: 'Ticket not found.' };
      if (!Object.hasOwn(TICKET_STATUS_ORDER, current.data.status) ||
          TICKET_STATUS_ORDER[status] <= TICKET_STATUS_ORDER[current.data.status]) {
        return { error: 'You cannot move a ticket backwards.' };
      }

      const { data, error } = await sb.from('tickets')
        .update({ status })
        .eq('id', id)
        .eq('user_id', sbUser)
        .select()
        .maybeSingle();
      if (error) return { error: ticketDbError(error, 'Could not update the ticket.') };
      if (!data) return { error: 'The ticket could not be updated because it no longer exists.' };
      return { data: { ticket: data }, error: null };
    }

    return { error: 'Unsupported ticket operation.' };
  } catch (error) {
    return { error: ticketDbError(error, 'Could not connect to support. Check your connection and try again.') };
  }
}

function ticketRelativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!iso || Number.isNaN(then)) return '';
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString();
}

function ticketEsc(s) {
  return String(s == null ? '' : s).replace(/</g, '&lt;');
}

function ticketUpdateItems(t) {
  if (!Array.isArray(t.updates) || !t.updates.length) return '';
  const items = t.updates.map((u) => {
    const when = ticketRelativeTime(u.created_at);
    const note = ticketEsc(u.note);
    const status = u.status ? TICKET_STATUS_LABEL[u.status] || u.status : '';
    return `<li class="ticket-update">
      <span class="ticket-update-time">${when}</span>
      <span>${status ? `<strong>${status}</strong> — ` : ''}${note}</span>
    </li>`;
  }).join('');
  return `<ul class="ticket-updates">${items}</ul>`;
}

function renderTicketList() {
  const list = document.getElementById('ticketList');
  const empty = document.getElementById('ticketEmpty');
  if (!list) return;

  if (ticketState.loading || !ticketState.loaded) {
    if (empty) empty.textContent = 'Loading your tickets…';
    list.innerHTML = '';
    return;
  }

  if (!ticketState.tickets.length) {
    if (empty) {
      empty.hidden = false;
      empty.textContent = 'No tickets yet. When you report something, the dev team will answer here.';
    }
    list.innerHTML = '';
    return;
  }

  if (empty) empty.hidden = true;

  list.innerHTML = ticketState.tickets.map((t) => {
    const status = TICKET_STATUS_LABEL[t.status] || t.status || 'Open';
    const priority = TICKET_PRIORITY_LABEL[t.priority] || t.priority || 'Normal';
    const category = TICKET_CATEGORY_LABEL[t.category] || t.category || 'Question';
    const when = ticketRelativeTime(t.created_at);
    const resolution = t.resolution_note
      ? `<p class="ticket-updated">Dev team: ${ticketEsc(t.resolution_note)}</p>`
      : '';
    const next = t.status === 'open' ? 'in_progress' : t.status === 'in_progress' ? 'resolved' : '';
    const advanceBtn = next
      ? `<button class="btn ghost small" type="button" data-ticket-advance="${ticketEsc(t.id)}" data-next="${next}">
           <span>Mark ${TICKET_STATUS_LABEL[next].toLowerCase()}</span>
         </button>`
      : '';
    return `<article class="ticket" data-ticket-id="${ticketEsc(t.id)}">
      <div class="ticket-head">
        <span class="ticket-title">${ticketEsc(t.title)}</span>
        <div class="ticket-actions">
          <span class="badge ${ticketEsc(t.status)}">${status}</span>
        </div>
      </div>
      ${t.description ? `<p class="ticket-updated">${ticketEsc(t.description)}</p>` : ''}
      <div class="ticket-meta">
        <span class="badge ${ticketEsc(t.priority)}">${priority}</span>
        <span>${category}</span>
        <time datetime="${ticketEsc(t.created_at)}">${when}</time>
      </div>
      ${ticketUpdateItems(t)}
      ${resolution}
      <div class="ticket-update-form">${advanceBtn}</div>
    </article>`;
  }).join('');
}

async function loadTickets() {
  if (ticketState.loading) return;
  ticketState.loading = true;
  renderTicketList();
  const { data, error } = await fetchTicketsSupabase();
  ticketState.loading = false;
  ticketState.loaded = true;
  if (error) {
    ticketState.tickets = [];
    renderTicketList();
    const empty = document.getElementById('ticketEmpty');
    if (empty) { empty.hidden = false; empty.textContent = error; }
    return;
  }
  ticketState.tickets = (data && data.tickets) || [];
  renderTicketList();
}


async function submitTicket(e) {
  e.preventDefault();
  if (ticketState.submitting) return;

  const title = document.getElementById('ticketTitle');
  const body = document.getElementById('ticketBody');
  const category = document.getElementById('ticketCategory');
  const priority = document.getElementById('ticketPriority');
  if (!title || !body) return;

  const titleText = title.value.trim();
  const bodyText = body.value.trim();
  if (!titleText) {
    ticketMessage('Give the ticket a short title so the team can spot it.', 'error');
    title.focus();
    return;
  }
  if (!bodyText) {
    ticketMessage('Describe what happened so the team knows where to look.', 'error');
    body.focus();
    return;
  }

  ticketState.submitting = true;
  ticketBusy(true);
  ticketMessage('Sending to the dev team…');

  const { error } = await createTicketSupabase('POST', {
    title: titleText,
    description: bodyText,
    category: category ? category.value : 'question',
    priority: priority ? priority.value : 'normal',
  });

  ticketState.submitting = false;
  ticketBusy(false);

  if (error) {
    ticketMessage(error, 'error');
    return;
  }

  ticketMessage('Sent. The dev team has your ticket and will keep you posted here.', 'ok');
  const form = document.getElementById('ticketForm');
  if (form) form.reset();
  await loadTickets();
}

async function advanceTicket(id, next) {
  const { error } = await createTicketSupabase('PATCH', { id, status: next });
  if (error) {
    ticketMessage(error, 'error');
    return;
  }
  ticketMessage(`Ticket marked ${TICKET_STATUS_LABEL[next].toLowerCase()}.`, 'ok');
  await loadTickets();
}

/* One delegated listener covers the list: cards are re-rendered on every refresh, so wiring
   each button as it is built would attach a listener to an element that no longer exists. */
function onTicketListClick(e) {
  const btn = e.target.closest('[data-ticket-advance]');
  if (!btn) return;
  e.preventDefault();
  advanceTicket(btn.getAttribute('data-ticket-advance'), btn.getAttribute('data-next'));
}

/* The entry point the app router calls when the Support view is opened. Rendering nothing
   until then keeps the empty state honest: an app that is not signed in still says why. */
function renderSupport() {
  ticketState.loaded = false;
  ticketState.loading = false;
  ticketState.tickets = [];
  renderTicketList();
  ticketMessage('');
  loadTickets();
}

/* "Help & demo" from the avatar menu and the touch target both land here: one place that
   opens the tour, so there is exactly one definition of what the help button does. */
function supportOpen() {
  if (typeof window.toggleDemo === 'function') window.toggleDemo();
  else if (typeof window.__showOnboardingDeck === 'function') window.__showOnboardingDeck();
}

function initSupport() {
  const form = document.getElementById('ticketForm');
  if (form) form.addEventListener('submit', submitTicket);

  const list = document.getElementById('ticketList');
  if (list) list.addEventListener('click', onTicketListClick);
}

window.renderSupport = renderSupport;
window.supportOpen = supportOpen;
window.initSupport = initSupport;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initSupport);
} else {
  initSupport();
}
