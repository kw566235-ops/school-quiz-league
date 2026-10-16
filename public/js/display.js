(() => {
  const { socket, $, esc, fmt, icons, SHAPES, logo, syncClock, renderBracket, confetti, joinUrl } = App;
  const head = $('#head'), stage = $('#stage');
  let st = null, url = '', lastKey = '', lastHead = '', celebrated = null;

  $('#fs').innerHTML = icons.expand;
  $('#fs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());
  $('#openingLogo').innerHTML = icons.trophy;
  $('#openingStart').onclick = startOpening;
  joinUrl().then((u) => { url = u; lastHead = ''; renderHead(); });

  async function startOpening() {
    const button = $('#openingStart');
    button.disabled = true;
    const content = $('#siteContent'), opening = $('#opening');
    content.hidden = false;
    requestAnimationFrame(() => content.classList.add('is-revealed'));
    opening.classList.add('is-closing');
    await new Promise((resolve) => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 420));
    opening.hidden = true;
  }

  socket.on('connect', () => socket.emit('display:join'));
  socket.on('state', (s) => { syncClock(s.now); st = s; renderHead(); render(); });

  const teamCls = (id) => (st.match?.teams[0]?.id === id ? 'teamA' : 'teamB');

  function renderHead() {
    if (!st) return;
    const m = st.match;
    const activeClassGames = (st.classGames || []).filter((game) => game.phase !== 'idle').length;
    const mid = activeClassGames
      ? `<span class="badge live">${activeClassGames} مسابقات فصول مباشرة</span><span>${esc(st.tournament?.name || '')}</span>`
      : m && st.phase !== 'idle'
      ? `<span class="badge live">مباشر</span><span>${esc(m.tournament)}</span><span class="muted">•</span><span>${esc(m.roundName)}</span>`
      : st.tournament ? `<span>${esc(st.tournament.name)}</span>` : '';
    const html = `${logo}<div class="mid">${mid}</div>
      <div class="joinbox"><div><div class="muted" style="font-size:.8rem">ادخل من جهازك</div><b class="ltr">${esc(url.replace(/^https?:\/\//, ''))}</b></div>${url ? `<img src="/api/qr?u=${encodeURIComponent(url)}" alt="QR">` : ''}</div>`;
    if (html !== lastHead) { head.innerHTML = html; lastHead = html; }
  }

  function render() {
    const key = JSON.stringify({ ...st, now: 0 });
    if (key === lastKey) return;
    lastKey = key;
    const runningClassGames = (st.classGames || []).filter((game) => game.phase !== 'idle');
    if (st.view === 'auto' && runningClassGames.length) {
      stage.innerHTML = concurrentGames(runningClassGames);
      return;
    }
    const mode = st.view !== 'auto' ? st.view : st.phase === 'idle' ? 'bracket' : st.phase;
    const views = { bracket, leaderboard, standings, lobby, countdown, question: questionView, reveal: questionView, finished };
    stage.innerHTML = (views[mode] || bracket)();
  }

  function concurrentGames(games) {
    const results = (st.tournament?.classes || []).filter((item) => item.result);
    return `<div class="grid2">${games.map((game) => {
      const c = game.match?.teams?.[0];
      const phase = { lobby: 'استقبال الطلاب', countdown: 'استعداد', question: 'السؤال مفتوح', reveal: 'الإجابة', finished: 'انتهت' }[game.phase];
      return `<div class="card fade-in"><div class="sectitle">${esc(c?.name || '')} <span class="badge ${game.phase === 'finished' ? 'ok' : 'live'}">${phase}</span></div>
        <div class="muted">اكتمل ${game.answered?.[c?.id] || 0} / ${game.participants?.[c?.id]?.length || 0} اختبار · الأسئلة تتقدم تلقائياً لكل طالب</div>
        ${game.teamScores?.[c?.id] && game.phase !== 'lobby' ? `<div class="badge" style="margin-top:10px">متوسط ${fmt(game.teamScores[c.id].avg)} / 5 · دقة ${game.teamScores[c.id].accuracy}%</div>` : ''}
        <div class="chips" style="justify-content:flex-start;margin-top:10px">${(game.participants?.[c?.id] || []).map((p) => `<span class="chip ${p.connected ? '' : 'off'}">${esc(p.name)}${p.answered ? ' ✓' : ''}</span>`).join('')}</div>
      </div>`;
    }).join('')}</div>${results.length ? `<div class="card" style="margin-top:1rem"><div class="sectitle">${icons.trophy} ترتيب نتائج الفصول</div>
      <table class="table"><thead><tr><th>#</th><th>الفصل</th><th>النقاط لكل سؤال</th><th>الدقة</th><th>زمن الإنهاء</th></tr></thead><tbody>
      ${results.map(({ class: c, result }, i) => `<tr><td>${i + 1}</td><td><b>${esc(c.name)}</b></td><td>${fmt(result.avg)} / 5</td><td>${result.accuracy}%</td><td>${fmt(result.avgFinishMs / 1000)} ثانية</td></tr>`).join('')}</tbody></table></div>` : ''}`;
  }

  function topList(list, limit = 10) {
    if (!list?.length) return '<div class="empty">لا توجد نتائج بعد</div>';
    return `<div class="lb">${list.slice(0, limit).map((p, i) => `<div class="lb-row" style="animation-delay:${i * 60}ms">
      <span class="rank ${i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span><span class="nm">${esc(p.name)}</span><span class="cl">${esc(p.className)}</span><span class="sc">${fmt(p.score)}</span></div>`).join('')}</div>`;
  }

  function bracket() {
    return `<div class="grid2">
      <div class="card"><div class="sectitle">${icons.sitemap} شجرة الدوري</div>${renderBracket(st.tournament)}</div>
      <div class="card"><div class="sectitle">${icons.star} أفضل الطلاب</div>${topList(st.overall.top, 8)}</div></div>`;
  }

  function leaderboard() {
    const top = st.overall.top || [];
    if (!top.length) return `<div class="card" style="flex:1"><div class="sectitle">${icons.star} ترتيب الطلاب</div><div class="empty">لا توجد نتائج بعد</div></div>`;
    const pod = (p, n) => p ? `<div class="pod p${n}"><div class="n">${esc(p.name)}</div><span class="badge">${esc(p.className)} · ${fmt(p.score)}</span><div class="blk">${n}</div></div>` : '';
    return `<div class="card" style="flex:1;display:flex;flex-direction:column"><div class="sectitle">${icons.star} ترتيب الطلاب العام</div>
      <div style="display:grid;grid-template-columns:1.2fr 1fr;gap:2rem;flex:1;align-items:end">
        <div class="podium">${pod(top[1], 2)}${pod(top[0], 1)}${pod(top[2], 3)}</div>
        <div class="lb" style="align-self:center">${top.slice(3, 10).map((p, i) => `<div class="lb-row"><span class="rank">${i + 4}</span><span class="nm">${esc(p.name)}</span><span class="cl">${esc(p.className)}</span><span class="sc">${fmt(p.score)}</span></div>`).join('')}</div>
      </div></div>`;
  }

  function standings() {
    const rows = (st.overall.standings || []).filter((s) => s.played || st.overall.standings.length <= 16);
    return `<div class="card" style="flex:1;overflow:auto"><div class="sectitle">${icons.chart} ترتيب الفصول</div>
      <table class="table"><thead><tr><th>#</th><th>الفصل</th><th>لعب</th><th>فوز</th><th>خسارة</th><th>مجموع النقاط</th><th>الدقة</th></tr></thead><tbody>
      ${rows.map((s, i) => `<tr><td><span class="rank ${i < 3 && s.played ? 'r' + (i + 1) : ''}">${i + 1}</span></td><td><b style="font-size:1.3rem">${esc(s.name)}</b></td><td>${s.played}</td><td style="color:#86efac">${s.wins}</td><td style="color:#fca5a5">${s.losses}</td><td>${fmt(s.points)}</td><td>${s.accuracy}%</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  function lobby() {
    const [a, b] = st.match.teams;
    const chips = (t) => (st.participants[t.id] || []).map((p) => `<span class="chip ${p.connected ? '' : 'off'}">${esc(p.name)}</span>`).join('') || '<span class="muted">بانتظار انضمام الطلاب…</span>';
    const team = (t, cls) => `<div class="team ${cls}"><h2>${esc(t.name)}</h2><div class="counter" style="display:inline-block;margin:.6rem 0 1rem">${icons.users} ${st.participants[t.id]?.length || 0} طالب</div><div class="chips">${chips(t)}</div></div>`;
    if (st.match.type === 'independent') {
      return `<div class="bigvs fade-in"><div style="text-align:center"><span class="badge ok" style="font-size:1.1rem;padding:.4rem 1.2rem">${esc(st.match.roundName)}</span>
        <h1 style="font-size:2.6rem;margin-top:.6rem">انضموا الآن! <span class="muted" style="font-size:1.6rem">المسابقة ستبدأ قريباً</span></h1></div>
        <div style="width:min(50rem,100%)">${team(a, 'teamA')}</div>
        ${url ? `<div style="display:flex;align-items:center;justify-content:center;gap:1.4rem"><img src="/api/qr?u=${encodeURIComponent(url)}" style="width:9rem;height:9rem;border-radius:14px;background:#fff;padding:.4rem"><div><div class="muted">امسح الرمز أو افتح الرابط</div><b class="ltr" style="font-size:2rem;display:block">${esc(url.replace(/^https?:\/\//, ''))}</b></div></div>` : ''}</div>`;
    }
    return `<div class="bigvs fade-in">
      <div style="text-align:center"><span class="badge ok" style="font-size:1.1rem;padding:.4rem 1.2rem">${esc(st.match.roundName)}</span>
      <h1 style="font-size:2.6rem;margin-top:.6rem">انضموا الآن! <span class="muted" style="font-size:1.6rem">المسابقة ستبدأ قريباً</span></h1></div>
      <div class="vs">${team(a, 'teamA')}<div class="vs-badge">VS</div>${team(b, 'teamB')}</div>
      ${url ? `<div style="display:flex;align-items:center;justify-content:center;gap:1.4rem"><img src="/api/qr?u=${encodeURIComponent(url)}" style="width:9rem;height:9rem;border-radius:14px;background:#fff;padding:.4rem"><div><div class="muted">امسح الرمز أو افتح الرابط</div><b class="ltr" style="font-size:2rem;display:block">${esc(url.replace(/^https?:\/\//, ''))}</b></div></div>` : ''}
    </div>`;
  }

  function countdown() {
    const [a, b] = st.match.teams;
    if (st.match.type === 'independent') return `<div class="center-col" style="flex:1">
      <h2 class="muted" style="font-size:2rem">${esc(a.name)} · السؤال ${st.qIndex + 1} من ${st.qCount}</h2>
      <div class="big-count grad-text" style="font-size:16rem" data-ends="${st.countdownEndsAt}" data-dur="3000">3</div></div>`;
    return `<div class="center-col" style="flex:1">
      <h2 class="muted" style="font-size:2rem">السؤال ${st.qIndex + 1} من ${st.qCount}</h2>
      <div class="big-count grad-text" style="font-size:16rem" data-ends="${st.countdownEndsAt}" data-dur="3000">3</div>
      <div class="mini-vs" style="display:flex;gap:1.4rem;font-size:2rem;font-weight:900"><span style="color:var(--teamA)">${esc(a.name)}</span><span class="muted">ضد</span><span style="color:var(--teamB)">${esc(b.name)}</span></div></div>`;
  }

  function panel(t, cls) {
    const q = st.questions?.[t.id];
    const rev = st.phase === 'reveal';
    const n = st.participants?.[t.id]?.length || 0;
    const ans = st.answered?.[t.id] || 0;
    if (!q) return `<div class="tpanel ${cls}"></div>`;
    return `<div class="tpanel ${cls}">
      <div class="th"><h2>${esc(t.name)}</h2><span class="counter">${rev ? `متوسط ${fmt(st.teamScores[t.id]?.avg)}${st.match.type === 'independent' ? ' / 5' : ''}` : `أجاب ${ans} / ${n}`}</span></div>
      <div class="card q" style="padding:1rem">${esc(q.text)}</div>
      <div class="options">${q.options.map((o, i) => {
        const c = rev ? (i === q.correctIndex ? 'correct' : 'dim') : '';
        return `<div class="opt o${i} ${c}"><span class="shape">${SHAPES[i]}</span><span>${esc(o)}</span>${rev ? `<span class="cnt">${q.dist?.[i] ?? 0}</span>` : ''}</div>`;
      }).join('')}</div></div>`;
  }

  function questionView() {
    const [a, b] = st.match.teams;
    const rev = st.phase === 'reveal';
    const mid = rev
      ? `<div class="center-col"><span class="badge ok" style="font-size:1rem">الإجابات</span><div class="muted" style="font-weight:800">السؤال ${st.qIndex + 1}/${st.qCount}</div></div>`
      : `<div class="center-col"><div class="muted" style="font-weight:800;font-size:1.2rem">السؤال ${st.qIndex + 1}/${st.qCount}</div><div class="ring" data-ends="${st.endsAt}" data-dur="${st.duration}"><b></b></div></div>`;
    let bottom = '';
    if (st.match.type === 'independent') {
      if (rev) {
        const score = st.teamScores[a.id];
        bottom = `<div class="card" style="text-align:center"><div class="muted">متوسط النقاط لكل سؤال (من 5) · الدقة ${score.accuracy}%</div>
          <b class="grad-text" style="font-size:2.2rem">${fmt(score.avg)} / 5</b></div>`;
      }
      return `<div class="two fade-in" style="grid-template-columns:1fr">${panel(a, 'teamA')}${mid}</div>${bottom}`;
    }
    if (rev) {
      const sa = st.teamScores[a.id]?.avg || 0, sb = st.teamScores[b.id]?.avg || 0;
      bottom = `<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:1.4rem;align-items:center">
        <div class="scorebar" style="height:4rem;font-size:1.5rem"><div class="a" style="flex-grow:${sa + 1}">${esc(a.name)} · ${fmt(sa)}</div><div class="b" style="flex-grow:${sb + 1}">${fmt(sb)} · ${esc(b.name)}</div></div>
        <div class="lb" style="flex-direction:row;gap:.5rem">${(st.leaderboard || []).slice(0, 3).map((p, i) => `<div class="lb-row ${teamCls(p.classId)}" style="flex:1;font-size:1rem;padding:.5rem .7rem"><span class="rank r${i + 1}">${i + 1}</span><span class="nm">${esc(p.name)}</span><span class="sc" style="font-size:1rem">${fmt(p.score)}</span></div>`).join('')}</div></div>`;
    }
    return `<div class="two fade-in">${panel(a, 'teamA')}${mid}${panel(b, 'teamB')}</div>${bottom}`;
  }

  function finished() {
    if (st.match.type === 'independent') {
      const c = st.match.teams[0], score = st.result.scores[c.id];
      const table = (st.tournament?.classes || []).filter((x) => x.result).map(({ class: cls, result }, i) =>
        `<tr><td>${i + 1}</td><td><b>${esc(cls.name)}</b></td><td>${fmt(result.avg)} / 5</td><td>${result.accuracy}%</td><td>${result.correct}/${result.qCount}</td></tr>`).join('');
      return `<div class="winner fade-in"><div class="muted" style="font-size:1.6rem;font-weight:800">نتيجة مسابقة الفصل</div><h1 class="grad-text">${esc(c.name)}</h1>
        <div class="card" style="width:min(50rem,100%);text-align:center"><div class="muted">متوسط النقاط لكل سؤال (الحد الأعلى 5) · دقة ${score.accuracy}%</div>
          <b style="font-size:3rem">${fmt(score.avg)} / 5</b><div class="muted">${score.correct} إجابة صحيحة · ${score.players} طالب</div></div>
        ${(st.result.top || []).length ? `<div class="lb" style="width:min(50rem,100%)">${st.result.top.slice(0, 5).map((p, i) => `<div class="lb-row"><span class="rank">${i + 1}</span><span class="nm">${esc(p.name)}</span><span class="cl">${esc(p.className)}</span><span class="sc">${fmt(p.score)}</span></div>`).join('')}</div>` : ''}
        <div class="card" style="width:min(50rem,100%);overflow:auto"><div class="sectitle">ترتيب الفصول في هذه المسابقة</div><table class="table"><thead><tr><th>#</th><th>الفصل</th><th>النقاط لكل سؤال</th><th>الدقة</th><th>الصحيحة</th></tr></thead><tbody>${table}</tbody></table></div></div>`;
    }
    const r = st.result, [a, b] = st.match.teams;
    const w = st.match.teams.find((t) => t.id === r.winner);
    if (w && celebrated !== st.match.id) { celebrated = st.match.id; setTimeout(() => confetti(6000), 300); }
    const isFinal = st.match.roundName === 'النهائي';
    const sa = r.scores[a.id], sb = r.scores[b.id];
    const card = (t, s, cls) => `<div class="team ${cls}" style="padding:1rem 2rem"><h2 style="font-size:2.4rem">${esc(t.name)}</h2><div style="font-size:2.6rem;font-weight:900">${fmt(s.avg)}</div><div class="muted">متوسط النقاط · دقة ${s.accuracy}% · ${s.players} طالب</div></div>`;
    const top3 = (r.top || []).slice(0, 3);
    return `<div class="winner fade-in">
      ${w ? `<svg class="tro" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4z"/><path d="M17 5h3v2a4 4 0 0 1-4 4M7 5H4v2a4 4 0 0 0 4 4"/></svg>
        <div class="muted" style="font-size:1.6rem;font-weight:800">${isFinal ? 'بطل الدوري' : 'الفائز والمتأهل للدور التالي'}</div><h1 class="grad-text">${esc(w.name)}</h1>`
        : '<h1>تعادل!</h1><div class="muted" style="font-size:1.4rem">بانتظار قرار لجنة المسابقة</div>'}
      <div class="vs" style="width:min(70rem,100%)">${card(a, sa, 'teamA')}<div class="vs-badge" style="width:4rem;height:4rem;font-size:1.2rem">VS</div>${card(b, sb, 'teamB')}</div>
      ${top3.length ? `<div class="lb" style="flex-direction:row;gap:.8rem;width:min(70rem,100%)">${top3.map((p, i) => `<div class="lb-row ${teamCls(p.classId)}" style="flex:1"><span class="rank r${i + 1}">${i + 1}</span><span class="nm">${esc(p.name)}</span><span class="cl">${esc(p.className)}</span><span class="sc">${fmt(p.score)}</span></div>`).join('')}</div>` : ''}
    </div>`;
  }
})();
