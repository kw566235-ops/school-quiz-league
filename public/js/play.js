(() => {
  const { socket, $, esc, fmt, emit, icons, SHAPES, logo, toast, syncClock, confetti } = App;
  const GRADES = { 9: 'التاسع', 10: 'العاشر', 11: 'الحادي عشر', 12: 'الثاني عشر' };
  const KEY = 'quiz-player';
  const app = $('#app'), top = $('#top');
  let classes = [], me = null, st = null, grade = null, classId = null, lastKey = '', celebrated = null;
  const saved = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };

  socket.on('classes', (list) => { classes = list; if (!me) renderJoin(); });
  socket.on('connect', () => { const s = saved(); if (s) join(s, true); });
  socket.on('me', (s) => { syncClock(s.now); st = s; render(); });
  socket.on('kicked', () => {
    me = null; st = null; lastKey = '';
    top.innerHTML = '';
    app.innerHTML = `<div class="center"><h2>تم تسجيل الدخول بهذا الحساب من جهاز آخر</h2><button class="btn pri" onclick="location.reload()">إعادة الدخول</button></div>`;
  });

  async function join(data, silent) {
    const r = await emit('player:join', { name: data.name, classId: data.classId, playerId: data.id });
    if (!r.ok) {
      if (silent) { localStorage.removeItem(KEY); renderJoin(); } else toast(r.error, 'error');
      return;
    }
    me = r;
    localStorage.setItem(KEY, JSON.stringify({ id: r.id, name: r.name, classId: r.classId }));
  }

  function renderJoin() {
    if (me) return;
    top.innerHTML = `<div class="topbar">${logo}<a class="btn sm ghost" href="/">الرئيسية</a></div>`;
    const prevName = $('#name')?.value || saved()?.name || '';
    const grades = [...new Set(classes.map((c) => c.grade))].sort((a, b) => a - b);
    if (grade == null && grades.length) grade = grades[0];
    const list = classes.filter((c) => c.grade === grade);
    if (!list.some((c) => c.id === classId)) classId = null;
    app.innerHTML = `<div class="card join fade-in">
      <h1 style="font-size:1.9rem;font-weight:900">انضم إلى <span class="grad-text">المسابقة</span></h1>
      <p class="muted" style="margin:6px 0 0">اختر صفك وفصلك واكتب اسمك (أو اسم فريقك)</p>
      ${!classes.length ? '<div class="empty" style="margin-top:22px">لم يُنشئ الأدمن أي فصول بعد</div>' : `
      <div class="step"><h4>١. الصف</h4><div class="pick">${grades.map((g) => `<button data-grade="${g}" class="${g === grade ? 'on' : ''}">${GRADES[g] || 'الصف ' + g}</button>`).join('')}</div></div>
      <div class="step"><h4>٢. الفصل</h4><div class="pick">${list.map((c) => `<button data-class="${c.id}" class="${c.id === classId ? 'on' : ''}">${esc(c.name)}</button>`).join('')}</div></div>
      <div class="step"><h4>٣. الاسم</h4><input id="name" class="input" maxlength="30" placeholder="مثال: أحمد سالم" value="${esc(prevName)}" autocomplete="off"></div>
      <button id="go" class="btn pri lg" style="width:100%;margin-top:22px">${icons.play} دخول</button>`}
    </div>`;
  }

  app.addEventListener('click', (e) => {
    const g = e.target.closest('[data-grade]');
    if (g) { grade = +g.dataset.grade; renderJoin(); return; }
    const c = e.target.closest('[data-class]');
    if (c) { classId = c.dataset.class; renderJoin(); $('#name')?.focus(); return; }
    if (e.target.closest('#go')) {
      const name = $('#name').value.trim();
      if (!classId) return toast('اختر فصلك أولاً', 'error');
      if (!name) return toast('اكتب اسمك', 'error');
      join({ name, classId, id: saved()?.id });
      return;
    }
    const o = e.target.closest('[data-choice]');
    if (o && st?.phase === 'question' && !st.myAnswer) {
      const choice = +o.dataset.choice;
      socket.emit('player:answer', { choice });
      st = { ...st, myAnswer: { choice } };
      render();
    }
  });
  app.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'name') $('#go')?.click(); });

  function topbar() {
    const initials = esc(me.name.trim().slice(0, 1));
    top.innerHTML = `<div class="topbar">
      <div class="me"><div class="avatar">${initials}</div><div><b>${esc(st.me.name)}</b><div class="muted" style="font-size:.85rem">فصل ${esc(st.me.className)}</div></div></div>
      <div class="row">${st.stats ? `<span class="score-pill">${fmt(st.stats.score)} <small class="muted">نقطة</small></span>` : ''}
      <button class="btn sm ghost" id="leave" title="تسجيل الخروج">${icons.logout}</button></div></div>`;
    $('#leave').onclick = () => {
      if (!confirm('تسجيل الخروج؟')) return;
      socket.emit('player:leave');
      localStorage.removeItem(KEY);
      me = null; st = null; lastKey = '';
      renderJoin();
    };
  }

  const teamClass = (id) => (st.match?.teams[0]?.id === id ? 'teamA' : 'teamB');
  function miniVs() {
    const [a, b] = st.match.teams;
    const t = (x) => `<span class="t ${teamClass(x?.id)} ${x?.id === st.me.classId ? 'mine' : ''}">${esc(x?.name || '—')}</span>`;
    return `<div class="mini-vs">${t(a)}<span class="muted" style="font-size:1rem">ضد</span>${t(b)}</div>`;
  }

  function render() {
    if (!me || !st) return;
    const keyObj = { ...st, now: 0 };
    if (st.phase === 'question' || st.phase === 'countdown') keyObj.stats = null;
    const key = JSON.stringify(keyObj);
    if (key === lastKey) return;
    lastKey = key;
    topbar();
    const p = st.phase;
    if (!st.inMatch || p === 'idle') return (app.innerHTML = waiting());
    if (p === 'lobby') return (app.innerHTML = lobby());
    if (p === 'countdown') return (app.innerHTML = countdown());
    if (p === 'question') return (app.innerHTML = st.myAnswer ? answered() : question());
    if (p === 'reveal') return (app.innerHTML = reveal());
    if (p === 'finished') return (app.innerHTML = finished());
  }

  function nextInfo() {
    const n = st.next;
    if (!n) return '<p class="muted">لا توجد مباريات قادمة لفصلك في الدوري الحالي</p>';
    if (n.champion) return `<div class="badge ok" style="font-size:1rem;padding:8px 16px">${icons.trophy} فصلك بطل الدوري!</div>`;
    return `<div class="card" style="padding:14px 22px"><span class="muted">مباراتكم القادمة — ${esc(n.roundName)}</span><div style="font-size:1.3rem;font-weight:900;margin-top:4px">ضد ${n.opponent ? esc(n.opponent.name) : 'الفائز من المباراة السابقة'}</div></div>`;
  }

  function waiting() {
    if (st.match && st.phase !== 'idle') {
      return `<div class="center fade-in"><span class="badge live">مباراة جارية</span><h2>${esc(st.match.roundName)}</h2>${miniVs()}
        <p class="muted" style="max-width:420px">فصلك ليس طرفاً في هذه المباراة. تابع الشاشة الكبيرة وشجّع!</p>${nextInfo()}</div>`;
    }
    return `<div class="center fade-in"><div class="spinner"></div><h2>أهلاً ${esc(st.me.name)}!</h2>
      <p class="muted">أنت مسجّل في فصل <b>${esc(st.me.className)}</b>. انتظر حتى يفتح المعلم المباراة.</p>${nextInfo()}</div>`;
  }

  const lobby = () => `<div class="center fade-in"><span class="badge ok">${esc(st.match.roundName)}</span>${miniVs()}
    <h2>أنت جاهز!</h2><p class="muted">انتظر حتى يبدأ المعلم المسابقة… ركّز، السرعة تصنع الفرق</p><div class="spinner"></div></div>`;

  const countdown = () => `<div class="center"><h2 class="muted">السؤال ${st.qIndex + 1} من ${st.qCount}</h2>
    <div class="big-count grad-text" data-ends="${st.countdownEndsAt}" data-dur="3000">3</div><h3>استعد!</h3></div>`;

  function question() {
    const q = st.question;
    if (!q) return waiting();
    return `<div class="fade-in">
      <div class="qhead"><span class="badge">السؤال ${st.qIndex + 1} / ${st.qCount}</span><span class="badge"><span data-ends="${st.endsAt}" data-dur="${st.duration}"></span> ث</span></div>
      <div class="timerbar" data-ends="${st.endsAt}" data-dur="${st.duration}"><i></i></div>
      <div class="card qtext">${esc(q.text)}</div>
      <div class="options">${q.options.map((o, i) => `<button class="opt o${i}" data-choice="${i}"><span class="shape">${SHAPES[i]}</span><span>${esc(o)}</span></button>`).join('')}</div>
    </div>`;
  }

  function answered() {
    const c = st.myAnswer.choice;
    return `<div class="center fade-in"><div class="timerbar" style="width:100%;max-width:520px" data-ends="${st.endsAt}" data-dur="${st.duration}"><i></i></div>
      <div class="opt o${c}" style="pointer-events:none;min-width:260px"><span class="shape">${SHAPES[c]}</span><span>${esc(st.question?.options[c] || '')}</span></div>
      <h2>تم إرسال إجابتك</h2><p class="muted">انتظر ظهور الإجابة الصحيحة…</p><div class="spinner"></div></div>`;
  }

  function teamMini() {
    if (!st.teamScores || !st.match) return '';
    const [a, b] = st.match.teams;
    const sa = st.teamScores[a.id]?.avg || 0, sb = st.teamScores[b.id]?.avg || 0;
    return `<div class="card" style="width:100%;max-width:520px;padding:16px">
      <div class="muted" style="font-size:.85rem;margin-bottom:8px">متوسط نقاط الفصل</div>
      <div class="scorebar"><div class="a" style="flex-grow:${sa + 1}">${esc(a.name)} · ${fmt(sa)}</div><div class="b" style="flex-grow:${sb + 1}">${fmt(sb)} · ${esc(b.name)}</div></div></div>`;
  }

  function reveal() {
    const s = st.stats, q = st.question;
    const ok = s.lastCorrect === true, late = s.lastCorrect == null;
    const ico = ok ? `<div class="result-ico ok">${icons.check}</div>` : late ? `<div class="result-ico late">${icons.x}</div>` : `<div class="result-ico bad">${icons.x}</div>`;
    const title = ok ? 'إجابة صحيحة!' : late ? 'انتهى الوقت' : 'إجابة خاطئة';
    return `<div class="center fade-in">${ico}<h1 style="font-size:2.2rem">${title}</h1>
      ${ok ? `<div class="pts grad-text">+${fmt(s.lastPoints)}</div>` : ''}
      ${ok && s.streak > 1 ? `<span class="badge warn">${icons.flame} سلسلة ${s.streak} إجابات صحيحة</span>` : ''}
      ${!ok && q ? `<p class="muted">الإجابة الصحيحة: <b style="color:#fff">${esc(q.options[q.correctIndex])}</b></p>` : ''}
      <div class="stat-row"><div class="card"><div class="muted">مركزك</div><b style="font-size:1.6rem">#${s.rank} <small class="muted">من ${s.total}</small></b></div>
      <div class="card"><div class="muted">نقاطك</div><b style="font-size:1.6rem">${fmt(s.score)}</b></div></div>
      ${teamMini()}</div>`;
  }

  function finished() {
    const r = st.result, s = st.stats;
    const mine = r.winner === st.me.classId;
    if (mine && celebrated !== st.match.id) { celebrated = st.match.id; setTimeout(() => confetti(), 200); }
    const winnerName = st.match.teams.find((t) => t.id === r.winner)?.name;
    const head = r.tie ? '<h1>تعادل!</h1><p class="muted">بانتظار قرار لجنة المسابقة</p>'
      : mine ? `<div class="result-ico ok" style="background:radial-gradient(circle,#fbbf24,#b45309);box-shadow:0 0 70px rgba(251,191,36,.6)">${icons.trophy}</div><h1 style="font-size:2.4rem">مبروك! فصلكم تأهل</h1>`
      : `<h1>انتهت المباراة</h1><p class="muted">الفائز: <b style="color:#fff">${esc(winnerName || '')}</b> — حظاً أوفر في المرة القادمة</p>`;
    return `<div class="center fade-in">${head}
      <div class="stat-row"><div class="card"><div class="muted">مركزك</div><b style="font-size:1.6rem">#${s.rank}</b></div>
      <div class="card"><div class="muted">نقاطك</div><b style="font-size:1.6rem">${fmt(s.score)}</b></div>
      <div class="card"><div class="muted">إجابات صحيحة</div><b style="font-size:1.6rem">${s.correct}/${st.qCount}</b></div></div>${teamMini()}</div>`;
  }
})();
