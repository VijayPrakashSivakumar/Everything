/* ---------- First-login walkthrough (demo deck) ---------- */
const SEEN_KEY = 'everything_onboarding_seen_v1';
const st = { i: 1, total: 0, open: false };
const SLIDES = [];
const host = () => document.getElementById('demoSlides');

function collect() {
  const h = host();
  if (!h) return;
  SLIDES.length = 0;
  h.querySelectorAll('.demo-slide').forEach((el) => {
    SLIDES.push({ el, idx: Number(el.dataset.demoIndex), label: el.dataset.demoLabel || 'Slide' });
  });
  st.total = SLIDES.length;
}

function show(n, focus) {
  st.i = Math.max(1, Math.min(st.total, n));
  host().querySelectorAll('.demo-slide').forEach((el) => el.classList.remove('active'));
  SLIDES[st.i - 1].el.classList.add('active');
  const s = SLIDES[st.i - 1];
  document.getElementById('demoStatus').textContent = st.i + ' / ' + st.total;
  document.getElementById('demoLabel').textContent = s.label;
  document.getElementById('demoPrev').disabled = st.i === 1;
  const next = document.getElementById('demoNext');
  const isLast = st.i === st.total;
  next.dataset.action = isLast ? 'done' : 'next';
  next.textContent = isLast ? 'Got it \u2014 back to app' : 'Next';
  document.getElementById('demoDone').hidden = !isLast;
  if (focus) {
    setTimeout(() => {
      const f = s.el.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (f) f.focus();
    }, 30);
  }
}

function dots() {
  const track = host().querySelector('.demo-dots-track');
  if (!track) return;
  track.innerHTML = '';
  for (let i = 1; i <= st.total; i += 1) {
    const d = document.createElement('button');
    d.className = 'demo-dot' + (i === st.i ? ' active' : '');
    d.setAttribute('aria-label', 'Go to slide ' + i + ': ' + SLIDES[i - 1].label);
    d.addEventListener('click', () => show(i, true));
    track.appendChild(d);
  }
  host().querySelectorAll('.demo-dot').forEach((d, k) => d.classList.toggle('active', k + 1 === st.i));
}

function bind() {
  const ov = document.getElementById('demoOverlay');
  if (!ov) return;
  const next = document.getElementById('demoNext');
  const prev = document.getElementById('demoPrev');
  const done = document.getElementById('demoDone');
  const skip = document.getElementById('demoSkip');
  const rev = document.getElementById('demoRevisit');
  const closeTop = ov.querySelector('#demoCloseTop');
  const backdrop = ov.querySelector('.demo-backdrop');
  next.addEventListener('click', () => { if (next.dataset.action === 'done') demoDone(); else show(st.i + 1, true); });
  prev.addEventListener('click', () => show(st.i - 1, true));
  done.addEventListener('click', demoDone);
  skip.addEventListener('click', demoSkip);
  rev.addEventListener('click', toggleDemo);
  closeTop.addEventListener('click', demoSkip);
  backdrop.addEventListener('click', demoSkip);
  document.addEventListener('keydown', (e) => {
    if (!st.open) return;
    if (e.key === 'ArrowRight') { if (next.dataset.action === 'done') demoDone(); else show(st.i + 1, true); }
    else if (e.key === 'ArrowLeft') show(st.i - 1, true);
    else if (e.key === 'Escape') demoSkip();
  });
}

function openDemo() {
  if (st.open) return;
  collect();
  if (!st.total) return;
  const ov = document.getElementById('demoOverlay');
  if (ov.hidden) { ov.hidden = false; ov.classList.add('open'); }
  st.open = true;
  document.body.classList.add('demo-open');
  show(1, true);
  setTimeout(() => document.getElementById('demoNext').focus(), 35);
}

function closeDemo() {
  const ov = document.getElementById('demoOverlay');
  if (!ov) return;
  ov.classList.remove('open');
  ov.hidden = true;
  document.body.classList.remove('demo-open');
  st.open = false;
}

function toggleDemo() { if (st.open) closeDemo(); else openDemo(); }

function demoDone() {
  try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* storage may be unavailable */ }
  closeDemo();
  if (typeof switchView === 'function') switchView('today', { history: 'replace' });
}

function demoSkip() { closeDemo(); }

function showOnboardingDeck() {
  if (st.open) return;
  const ov = document.getElementById('demoOverlay');
  if (!ov) return;
  collect();
  if (!st.total) return;
  if (ov.hidden) { ov.hidden = false; ov.classList.add('open'); }
  st.open = true;
  document.body.classList.add('demo-open');
  show(1, true);
  setTimeout(() => document.getElementById('demoNext').focus(), 35);
}

window.__showOnboardingDeck = showOnboardingDeck;
window.demoDone = demoDone;
window.demoSkip = demoSkip;
window.demoRevisit = toggleDemo;
window.demoNext = () => { if (document.getElementById('demoNext').dataset.action === 'done') demoDone(); else show(st.i + 1, true); };
window.demoPrev = () => show(st.i - 1, true);
window.demoGoToSlide = (n) => show(n, true);
window.demoToggle = toggleDemo;
window.demoIsSeen = () => { try { return localStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; } };
window.demoMarkSeen = () => { try { localStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* ignore */ } };

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bind);
} else {
  bind();
}
