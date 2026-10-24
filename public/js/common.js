/* Shared helpers for all pages. */
window.App = (() => {
  const socket = io();
  let offset = 0;
  const syncClock = (serverNow) => { if (serverNow) offset = serverNow - Date.now(); };
  const now = () => Date.now() + offset;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => Number(n || 0).toLocaleString('en-US');
  const emit = (ev, data) => new Promise((res) => socket.emit(ev, data, (r) => res(r || { ok: false })));

  const I = (p, extra = '') => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${p}</svg>`;
  const icons = {
    trophy: I('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a4 4 0 0 1-4 4M7 5H4v2a4 4 0 0 0 4 4"/>'),
    bolt: I('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>'),
    users: I('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
    monitor: I('<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>'),
    shield: I('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
    play: I('<path d="M6 4l14 8-14 8V4z"/>'),
    check: I('<path d="M20 6 9 17l-5-5"/>'),
    x: I('<path d="M18 6 6 18M6 6l12 12"/>'),
    plus: I('<path d="M12 5v14M5 12h14"/>'),
    trash: I('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    edit: I('<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>'),
    chart: I('<path d="M3 3v18h18M7 15l4-4 3 3 5-6"/>'),
    book: I('<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5v14z"/><path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>'),
    gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
    sitemap: I('<rect x="3" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="9.5" width="6" height="5" rx="1"/><path d="M9 5.5h3v13H9M12 12h3"/>'),
    expand: I('<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    logout: I('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
    copy: I('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
    flame: I('<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>'),
    star: I('<path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/>'),
  };
  const SHAPES = [
    '<svg viewBox="0 0 24 24"><path d="M12 3 22 20H2z"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 2 22 12 12 22 2 12z"/></svg>',
    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/></svg>',
    '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>',
    '<svg viewBox="0 0 24 24"><path d="M12 21s-8-5.3-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.7-8 11-8 11z"/></svg>',
  ];
  const logo = `<div class="logo" aria-label="ضفاف العربية"><div class="mark"><img src="/images/logo.png" alt=""></div><span>ضفاف العربية</span></div>`;

  function toast(msg, type = 'info') {
    let box = $('#toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    box.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // Elements with data-ends (server ms timestamp) and data-dur (ms) are updated every frame.
  function tick() {
    const n = now();
    for (const el of $$('[data-ends]')) {
      const ends = +el.dataset.ends, dur = +el.dataset.dur || 1;
      const left = Math.max(0, ends - n);
      const secs = Math.ceil(left / 1000);
      const p = Math.max(0, Math.min(1, left / dur));
      if (el.classList.contains('timerbar')) { el.firstElementChild.style.transform = `scaleX(${p})`; el.classList.toggle('low', p < 0.25); }
      else if (el.classList.contains('ring')) { el.style.setProperty('--p', p); el.querySelector('b').textContent = secs; el.classList.toggle('low', p < 0.25); }
      else el.textContent = secs;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  function teamCell(info, m, score) {
    const cls = m.winner ? (info && m.winner === info.id ? 'win' : 'lose') : '';
    return `<div class="b-team ${cls}"><span>${info ? esc(info.name) : '<i>بانتظار المتأهل</i>'}</span><b>${score != null ? fmt(score) : ''}</b></div>`;
  }
  function renderBracket(t, opt = {}) {
    if (!t) return '<div class="empty">لا يوجد دوري نشط حالياً</div>';
    if (t.type === 'independent') {
      return `<div class="grid">${t.classes.map(({ class: c, questionCount, result }, i) => `<div class="ccard">
        <div><b style="font-size:1.15rem">${i + 1}. ${esc(c.name)}</b><div class="muted" style="font-size:.85rem">${questionCount} سؤال${result ? ` · النتيجة ${fmt(result.avg)} / 5 · ${result.accuracy}%` : ' · لم تُلعب بعد'}</div>
          ${result ? `<div class="muted" style="font-size:.8rem">${result.correct} إجابة صحيحة من ${result.qCount} · ${result.players} طالب${result.avgFinishMs != null ? ` · متوسط الإنهاء ${fmt(result.avgFinishMs / 1000)} ثانية` : ''}</div>` : ''}</div>
        ${opt.admin ? `<div class="row" style="gap:6px">${result
          ? `<button class="btn sm" data-reset-class="${c.id}">إعادة تعيين</button>`
          : `<button class="btn sm pri" data-open-class="${c.id}">${icons.play} فتح المسابقة</button>`}</div>` : ''}</div>`).join('') || '<div class="empty">لا توجد فصول مشاركة</div>'}</div>`;
    }
    const actions = (m) => {
      if (!opt.admin) return '';
      const b = [];
      if (m.status === 'ready') b.push(`<button class="btn sm pri" data-open="${m.id}">${icons.play} فتح المباراة</button>`);
      if (m.status === 'tie' || m.status === 'ready') {
        b.push(`<button class="btn sm" data-win="${m.id}" data-team="${m.a.id}" title="تأهيل يدوي">تأهيل ${esc(m.a.name)}</button>`);
        b.push(`<button class="btn sm" data-win="${m.id}" data-team="${m.b.id}" title="تأهيل يدوي">تأهيل ${esc(m.b.name)}</button>`);
      }
      if (m.status === 'done' || m.status === 'tie') b.push(`<button class="btn sm ghost" data-reset="${m.id}">إعادة</button>`);
      return b.length ? `<div class="b-actions">${b.join('')}</div>` : '';
    };
    const card = (m) => `<div class="b-match st-${m.status}">
        ${m.status === 'live' ? '<span class="badge live b-live">مباشر</span>' : ''}
        ${teamCell(m.a, m, m.scores?.[0])}
        ${m.bye ? '<div class="b-team bye">تأهل مباشر</div>' : teamCell(m.b, m, m.scores?.[1])}
        ${actions(m)}
      </div>`;
    return `<div class="bracket">
      ${t.rounds.map((r) => `<div class="b-round"><div class="b-round-title">${esc(r.name)}</div><div class="b-matches">${r.matches.map(card).join('')}</div></div>`).join('')}
      <div class="b-round" style="min-width:180px"><div class="b-round-title">البطل</div><div class="b-matches">
        <div class="champion ${t.champion ? 'has' : ''}">${icons.trophy}<span>${t.champion ? esc(t.champion.name) : '؟'}</span></div>
      </div></div>
    </div>`;
  }

  function confetti(ms = 4500) {
    let c = $('#confetti');
    if (!c) { c = document.createElement('canvas'); c.id = 'confetti'; document.body.appendChild(c); }
    const ctx = c.getContext('2d');
    c.width = innerWidth; c.height = innerHeight;
    const colors = ['#fbbf24', '#7c5cff', '#22d3ee', '#f97316', '#22c55e', '#ef4444', '#ffffff'];
    const parts = Array.from({ length: 220 }, () => ({
      x: Math.random() * c.width, y: -20 - Math.random() * c.height * 0.6, w: 6 + Math.random() * 8, h: 8 + Math.random() * 10,
      vx: -2 + Math.random() * 4, vy: 2 + Math.random() * 4, r: Math.random() * 6, vr: -0.2 + Math.random() * 0.4, col: colors[(Math.random() * colors.length) | 0],
    }));
    const end = Date.now() + ms;
    (function frame() {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.r += p.vr; p.vy += 0.03;
        if (p.y > c.height && Date.now() < end) { p.y = -20; p.x = Math.random() * c.width; p.vy = 2 + Math.random() * 3; }
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.col; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); ctx.restore();
      }
      if (Date.now() < end + 3000) requestAnimationFrame(frame); else ctx.clearRect(0, 0, c.width, c.height);
    })();
  }

  async function joinUrl() {
    const origin = location.origin;
    if (!/localhost|127\.0\.0\.1/.test(location.hostname)) return `${origin}/play`;
    try { const r = await (await fetch('/api/info')).json(); if (r.urls?.length) return `${r.urls[0]}/play`; } catch {}
    return `${origin}/play`;
  }

  return { socket, syncClock, now, $, $$, esc, fmt, emit, icons, SHAPES, logo, toast, renderBracket, confetti, joinUrl };
})();
