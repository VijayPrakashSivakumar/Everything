/* ---------- Calendar ---------- */
let calViewDate = new Date();
let calMode = "week";

function getScheduledItems() {
  return state.items.filter((i) => i.dueDate && !i.done && !isArchived(i));
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
  // The day view moves one day, the week a week, the month a month. Sharing the "week" branch
  // for the day view jumped a whole week per tap, which made a single day unreachable.
  if (calMode === "day") calViewDate.setDate(calViewDate.getDate() + dir);
  else if (calMode === "week") calViewDate.setDate(calViewDate.getDate() + dir * 7);
  else calViewDate.setMonth(calViewDate.getMonth() + dir);
  renderCalendar();
}

function renderCalendar() {
  // Re-rendering rebuilds every event element, so an open peek would be left anchored to a node that
  // no longer exists, hovering over a cell whose contents have changed underneath it.
  closeMonthEventPeek();
  const dayTab = document.getElementById("calTabDay");
  const wTab = document.getElementById("calTabWeek");
  const mTab = document.getElementById("calTabMonth");
  if (dayTab) dayTab.classList.toggle("active", calMode === "day");
  if (wTab) wTab.classList.toggle("active", calMode === "week");
  if (mTab) mTab.classList.toggle("active", calMode === "month");
  // Every container is toggled from the one place that knows which mode is on. Setting only the two
  // that the original week/month pair knew about left the day container on screen underneath the
  // month grid, so both views were readable at once.
  document.getElementById("calDayView").style.display = calMode === "day" ? "block" : "none";
  document.getElementById("calWeekView").style.display =
    calMode === "week" ? "block" : "none";
  document.getElementById("calGrid").style.display =
    calMode === "month" ? "grid" : "none";
  if (calMode === "day") renderDayView();
  else if (calMode === "week") renderWeekView();
  else renderMonthView();
}

/* The hours a calendar shows, and the pixels each one is tall. Both the day and the week grid are
   built from these, so an event dropped at 3pm lands on the 3pm row in either view instead of
   needing its own arithmetic per view. */
const CAL_START_HOUR = 7;
const CAL_END_HOUR = 20;
const CAL_ROW_HEIGHT = 50;
function calHours() {
  const hours = [];
  for (let h = CAL_START_HOUR; h <= CAL_END_HOUR; h++) hours.push(h);
  return hours;
}
function calHourLabel(h) {
  return h === 12 ? "12 PM" : h < 12 ? h + " AM" : h - 12 + " PM";
}

/* Lays a day's items into lanes so simultaneous ones sit side by side instead of stacking on top of
   each other. The week view had this inline; the day view needs the same answer, and two copies of
   the packing algorithm drift, so it is one function. */
function packCalendarLanes(entries) {
  const laneEnds = [];
  entries.forEach((e) => {
    let lane = laneEnds.findIndex((end) => end <= e.start);
    if (lane === -1) {
      laneEnds.push(e.start + 1);
      lane = laneEnds.length - 1;
    } else {
      laneEnds[lane] = e.start + 1;
    }
    e.lane = lane;
  });
  return Math.max(laneEnds.length, 1);
}

/* The scheduled items on one day, as positioned entries. Items outside the visible hours are left
   out rather than clamped, because a 6am reminder dropped into the 7am row would be a lie about
   when it is. */
function calendarEntriesFor(day) {
  return getScheduledItems()
    .map((item) => {
      const d = new Date(item.dueDate);
      return { item, d, start: d.getHours() + d.getMinutes() / 60 };
    })
    .filter((e) => e.start >= CAL_START_HOUR && e.start < CAL_END_HOUR + 1)
    .filter((e) => e.d.toDateString() === day.toDateString())
    .sort((a, b) => a.start - b.start);
}

/* One positioned event block. Shared by the day and the week grid so a block looks and behaves the
   same in both, and so the drag handle markup exists in exactly one place. */
function calendarEventHtml(item, start, lane, laneWidth, bodyHeight) {
  const top = Math.max(0, (start - CAL_START_HOUR) * CAL_ROW_HEIGHT);
  const height = Math.min(CAL_ROW_HEIGHT - 4, bodyHeight - top);
  if (height < 14) return "";
  const [bg, fg] = kindColor(item.kind);
  const time = fmtTime(item.dueDate);
  // NOT jsStr. jsStr produces a JavaScript string literal, which is right for a handler argument
  // and wrong for a DOM attribute: it left data-cal-id holding `"e1"` with the quote characters, so
  // the drag engine compared it against the real id `e1`, never matched, and every drag was a
  // silent no-op. A data attribute is HTML text, and escapeHtml is the function for that.
  const id = escapeHtml(item.id);
  return `<div class="cal-week-event cal-drag-event${item.done ? " done" : ""}" data-cal-id="${id}" title="${escapeHtml(time + " " + item.title)}" style="top:${top}px;height:${height}px;left:calc(${(lane * laneWidth).toFixed(4)}% + 4px);width:calc(${laneWidth.toFixed(4)}% - 8px);background:${bg};color:${fg};" onclick="openPanel(${jsStr(item.id)})"><b>${time}</b> ${escapeHtml(item.title)}</div>`;
}

/* The one day. It is the week view's grid with a single column, which is why an event dragged here
   behaves identically to one dragged across the week. */
function renderDayView() {
  const container = document.getElementById("calDayView");
  const day = new Date(calViewDate);
  day.setHours(0, 0, 0, 0);
  document.getElementById("calRangeLabel").textContent =
    day.toLocaleDateString(undefined, {
      weekday: "long",
      month: "long",
      day: "numeric",
    }) + (day.toDateString() === new Date().toDateString() ? " · Today" : "");

  const hours = calHours();
  const bodyHeight = hours.length * CAL_ROW_HEIGHT;
  const isToday = day.toDateString() === new Date().toDateString();
  const dayItems = calendarEntriesFor(day);
  const laneCount = packCalendarLanes(dayItems);
  const laneWidth = 100 / laneCount;

  let html = `<div class="cal-week-wrap cal-day-wrap"><div class="cal-time-col"><div class="cal-week-head-spacer"></div>`;
  hours.forEach((h) => {
    html += `<div class="cal-hour-label">${calHourLabel(h)}</div>`;
  });
  html += `</div><div class="cal-week-days cal-day-days"><div class="cal-week-day-col">`;
  html += `<div class="cal-week-day-head ${isToday ? "today" : ""}"><span>${day.toLocaleDateString(undefined, { weekday: "short" })}</span><span class="num">${day.getDate()}</span></div>`;
  html += `<div class="cal-week-day-body cal-drop-day" data-cal-date="${day.toISOString()}" style="height:${bodyHeight}px;">`;
  hours.forEach((h) => {
    // The drop target carries the hour, so dropping resolves to a real time of day rather than
    // flattening the event to midnight.
    html += `<div class="cal-hour-row" data-cal-hour="${h}"></div>`;
  });
  dayItems.forEach((e) => {
    html += calendarEventHtml(e.item, e.start, e.lane, laneWidth, bodyHeight);
  });
  html += `</div></div></div></div>`;
  container.innerHTML = html;
  attachCalendarDrag(container);
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

  const hours = calHours();
  const bodyHeight = hours.length * CAL_ROW_HEIGHT;

  let html = `<div class="cal-week-wrap"><div class="cal-time-col"><div class="cal-week-head-spacer"></div>`;
  hours.forEach((h) => {
    html += `<div class="cal-hour-label">${calHourLabel(h)}</div>`;
  });
  html += `</div><div class="cal-week-days">`;

  days.forEach((day) => {
    const isToday = day.toDateString() === new Date().toDateString();
    html += `<div class="cal-week-day-col">
      <div class="cal-week-day-head ${isToday ? "today" : ""}"><span>${day.toLocaleDateString(undefined, { weekday: "short" })}</span><span class="num">${day.getDate()}</span></div>
      <div class="cal-week-day-body cal-drop-day" data-cal-date="${day.toISOString()}" style="height:${bodyHeight}px;">`;
    hours.forEach((h) => {
      // The drop target carries the hour, so dropping resolves to a real time of day rather than
      // flattening the event to midnight.
      html += `<div class="cal-hour-row" data-cal-hour="${h}"></div>`;
    });

    // Events are placed in lanes so simultaneous items sit side by side
    // instead of stacking on top of each other, and are clamped to the body
    // so nothing spills past the 8 PM row.
    const dayItems = calendarEntriesFor(day);
    const laneCount = packCalendarLanes(dayItems);
    const laneWidth = 100 / laneCount;

    dayItems.forEach((e) => {
      html += calendarEventHtml(e.item, e.start, e.lane, laneWidth, bodyHeight);
    });
    html += `</div></div>`;
  });
  html += `</div></div>`;
  container.innerHTML = html;
  attachCalendarDrag(container);
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
    // A month cell is a day with no hour rows in it, so it carries only a date. The drop handler
    // reads data-cal-date and data-cal-hour separately, and a cell with no hour keeps the time of
    // day the event already had rather than snapping to midnight.
    c.dataset.calDate = cellDate.toISOString();
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
        ev.className = "cal-event cal-drag-event";
        ev.dataset.calId = item.id;
        ev.onclick = () => monthEventPeek(item.id, ev);
        ev.textContent = fmtTime(item.dueDate) + " " + item.title;
        c.appendChild(ev);
      });
    grid.appendChild(c);
  }
  attachCalendarDrag(grid);
}

/* ---------- Month event peek ----------

   A month cell on a phone is about 50px wide, so the title in it is truncated to a few characters.
   The fix for that is not smaller text; it is not showing the title in the cell at all. Tapping an
   event now opens this - a small card with the whole title and enough context to recognise it -
   and tapping anywhere else puts it away.

   It deliberately does not open the editing panel. A panel is for changing something, and this is
   for reading something; sending every tap on a calendar entry to an editor made the month view feel
   like a form. Opening the panel stays one tap away, for the times you do mean to edit.

   The card is a child of the body rather than of the cell. The grid clips its own overflow, and a
   peek anchored inside a clipped box is a peek that loses its own edges near the bottom of a month -
   which is exactly where a calendar is most full. Fixed positioning off the anchor's rectangle also
   means no recalculation when the calendar scrolls underneath it. */

let monthPeekEl = null;

function closeMonthEventPeek() {
  if (!monthPeekEl) return;
  monthPeekEl.remove();
  monthPeekEl = null;
  document.removeEventListener("pointerdown", monthPeekOutside, true);
  document.removeEventListener("keydown", monthPeekOnKey, true);
  // The trigger is given back its focus, so the keyboard does not lose its place after a mouse tap.
  if (monthPeekReturnFocus && document.contains(monthPeekReturnFocus)) {
    monthPeekReturnFocus.focus?.();
  }
  monthPeekReturnFocus = null;
}

let monthPeekOutside = () => {};
let monthPeekOnKey = () => {};
let monthPeekReturnFocus = null;

function monthEventPeek(id, anchor) {
  const item = state.items.find((i) => i.id === id);
  if (!item) return;
  closeMonthEventPeek();

  const card = document.createElement("div");
  card.className = "month-peek";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-label", item.title);
  card.tabIndex = -1;

  const time = fmtTime(item.dueDate);
  const when = item.dueDate
    ? new Date(item.dueDate).toLocaleDateString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
      })
    : "";
  const bits = [item.kind, item.person, item.project]
    .filter(Boolean)
    .map((v) => String(v).charAt(0).toUpperCase() + String(v).slice(1));

  card.innerHTML = `
    <div class="month-peek-title">${escapeHtml(item.title)}</div>
    <div class="month-peek-when">${escapeHtml([when, time].filter(Boolean).join(" · "))}</div>
    ${bits.length ? `<div class="month-peek-meta">${escapeHtml(bits.join(" · "))}</div>` : ""}
    <div class="month-peek-actions">
      <button type="button" class="btn btn-sm" data-peek-open>Open</button>
      <button type="button" class="btn btn-sm" data-peek-close>Close</button>
    </div>`;
  card.querySelector("[data-peek-open]").onclick = () => {
    closeMonthEventPeek();
    openPanel(id);
  };
  card.querySelector("[data-peek-close]").onclick = closeMonthEventPeek;

  document.body.appendChild(card);
  monthPeekEl = card;
  monthPeekReturnFocus = anchor;

  /* Placed against the anchor's box and then flipped when it would run past an edge. A card that
     hangs off the bottom of the screen is a card nobody reads, and the bottom row of a month is
     where the entries are. */
  const a = anchor.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  const pad = 8;
  let left = a.left;
  if (left + r.width > window.innerWidth - pad) left = window.innerWidth - r.width - pad;
  if (left < pad) left = pad;
  let top = a.bottom + 6;
  if (top + r.height > window.innerHeight - pad) {
    const above = a.top - r.height - 6;
    top = above >= pad ? above : Math.max(pad, window.innerHeight - r.height - pad);
  }
  card.style.left = `${Math.round(left)}px`;
  card.style.top = `${Math.round(top)}px`;

  monthPeekOutside = (event) => {
    if (card.contains(event.target)) return;
    closeMonthEventPeek();
  };
  monthPeekOnKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMonthEventPeek();
    }
  };
  document.addEventListener("pointerdown", monthPeekOutside, true);
  document.addEventListener("keydown", monthPeekOnKey, true);
  card.focus();
}

/* ---------- Drag to reschedule ----------
   Pointer events rather than the native HTML5 drag-and-drop, for the same reason the list reordering
   engine uses them: a native drag cancels the pointer stream, swallows the click that opens the
   panel, and behaves differently on every platform. One engine here, shared by all three calendar
   views, so an event dragged in the day grid and the same event dragged in the week grid do the
   same thing. */

const calDrag = { id: null, ghost: null, moved: false, source: null, x: 0, y: 0 };

function calDragStart(event) {
  // A press on a text selection is a selection, not a drag. Starting one there destroyed the
  // person's selection every time they tried to copy an event title.
  if (event.target.closest("input, textarea, select")) return;
  const handle = event.target.closest(".cal-drag-event");
  if (!handle) return;
  const item = state.items.find((i) => i.id === handle.dataset.calId);
  if (!item || isArchived(item) || item.done) return;

  calDrag.id = item.id;
  calDrag.moved = false;
  calDrag.x = event.clientX;
  calDrag.y = event.clientY;
  calDrag.source = handle;
  handle.classList.add("cal-dragging");

  calDrag.ghost = handle.cloneNode(true);
  calDrag.ghost.classList.add("cal-drag-ghost");
  calDrag.ghost.style.width = `${handle.offsetWidth}px`;
  document.body.appendChild(calDrag.ghost);
  moveCalGhost(calDrag.x, calDrag.y);

  document.addEventListener("pointermove", calDragMove, { passive: false });
  document.addEventListener("pointerup", calDragEnd);
  document.addEventListener("pointercancel", calDragEnd);
  showCalDropHint(true);
  // Suppress the click that follows the release, or the panel opens on top of the new date.
  event.preventDefault();
}

function moveCalGhost(x, y) {
  if (!calDrag.ghost) return;
  calDrag.ghost.style.left = `${x + 12}px`;
  calDrag.ghost.style.top = `${y + 12}px`;
}

function calDragMove(event) {
  if (!calDrag.id) return;
  if (event.cancelable) event.preventDefault();
  calDrag.moved = true;
  // The release point is remembered as it moves, because pointerup carries no coordinates on every
  // browser and a drop resolved from a stale position lands on the wrong day.
  calDrag.x = event.clientX;
  calDrag.y = event.clientY;
  moveCalGhost(calDrag.x, calDrag.y);
  highlightCalDropTarget(calDrag.x, calDrag.y);
}

/* Paints the row or cell under the pointer. The target is resolved by the same function the drop
   uses, so the highlight and the write can never disagree about where the pointer is.

   The hour row is read before the day body, because the row is nested inside the body: resolving the
   body first found the parent every time, and the drop then had no hour and kept the event's old
   one. The pointer sat visibly on the 4pm line and the event stayed at 10am. */
function calendarDropTargetAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  // The hour row is nested inside the day body, so closest("[data-cal-date]") finds the body whether
  // the pointer is on a row or on the body itself. The body is both the highlight and the drop zone.
  return el.closest("[data-cal-date]") || null;
}

/* The hour the pointer is over, read from the row under it. Separate from the target because the
   target is the day body that gets highlighted, while the hour is only one input to the new date.

   It has to be read here rather than off the target: the day body is the element carrying
   data-cal-date, and it has no hour of its own, so resolving the hour from it always came back
   empty and every drop kept the event's original time. */
function calendarDropHourAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const row = el.closest("[data-cal-hour]");
  if (!row) return null;
  const hour = Number(row.dataset.calHour);
  return Number.isFinite(hour) ? hour : null;
}

function highlightCalDropTarget(x, y) {
  const target = calendarDropTargetAt(x, y);
  document
    .querySelectorAll(".cal-drop-active")
    .forEach((el) => el.classList.remove("cal-drop-active"));
  if (target) target.classList.add("cal-drop-active");
}

/* Where a drop lands. A target with no hour under the pointer — a month cell, or the flat area of a
   day column — keeps the event's existing time of day; flattening a 9am appointment to midnight
   because the month view has no hour rows would be a silent data change, and a wrong one. */
function calendarDropDate(target, item, hour) {
  if (!target) return null;
  const dayIso = target.dataset.calDate;
  if (!dayIso) return null;
  const day = new Date(dayIso);
  if (Number.isNaN(day.getTime())) return null;

  if (!Number.isFinite(hour)) {
    const from = item && item.dueDate ? new Date(item.dueDate) : null;
    hour = from && !Number.isNaN(from.getTime()) ? from.getHours() : 9;
  }
  day.setHours(hour, 0, 0, 0);
  return day;
}

async function calDragEnd() {
  const id = calDrag.id;
  const moved = calDrag.moved;
  const x = calDrag.x;
  const y = calDrag.y;

  document.removeEventListener("pointermove", calDragMove);
  document.removeEventListener("pointerup", calDragEnd);
  document.removeEventListener("pointercancel", calDragEnd);
  if (calDrag.ghost) calDrag.ghost.remove();
  if (calDrag.source) calDrag.source.classList.remove("cal-dragging");
  document
    .querySelectorAll(".cal-drop-active")
    .forEach((el) => el.classList.remove("cal-drop-active"));
  showCalDropHint(false);

  calDrag.id = null;
  calDrag.ghost = null;
  calDrag.source = null;
  calDrag.moved = false;

  // A press that never moved is a click, and the click is what opens the panel. Dropping that here
  // would make it impossible to open an event by tapping it.
  if (!id || !moved) return;
  const target = calendarDropTargetAt(x, y);
  const item = state.items.find((i) => i.id === id);
  if (!item || !target) return;
  const next = calendarDropDate(target, item, calendarDropHourAt(x, y));
  if (!next || next.getTime() === new Date(item.dueDate).getTime()) return;
  await rescheduleItemTo(item, next);
}

function showCalDropHint(visible) {
  const hint = document.getElementById("calDropHint");
  if (hint) hint.hidden = !visible;
}

/* The one place a calendar drop writes. It re-arms the reminder rather than only moving the date:
   an event moved from Monday to Wednesday has a new time to remind at, and the old notification
   flag would suppress it. */
async function rescheduleItemTo(item, date) {
  if (taskMutationInFlight.has(item.id)) return;
  const previous = item.dueDate;
  applyDueToItem(item, date);
  taskMutationInFlight.add(item.id);
  try {
    await dbSaveItem(item);
  } catch (err) {
    // Put it back rather than leaving the calendar showing a date the database rejected.
    applyDueToItem(item, previous ? new Date(previous) : null);
    taskMutationInFlight.delete(item.id);
    renderCalendar();
    return;
  }
  taskMutationInFlight.delete(item.id);
  save();
  refreshReminderSchedule();
  renderCalendar();
  renderToday();
  renderTasks(activeTaskFilter);
  renderInbox(activeInboxFilter);
  if (currentItemId === item.id && document.getElementById("panel")?.classList.contains("open"))
    openPanel(item.id);
}

/* Binds the engine to a freshly rendered grid. Called by each renderer rather than once at boot,
   because the grids are replaced wholesale on every render. */
function attachCalendarDrag(container) {
  if (!container) return;
  container.addEventListener("pointerdown", calDragStart);
}
