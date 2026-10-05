(() => {
  const { socket, $, $$, esc, fmt, emit, icons, SHAPES, logo, toast, syncClock, renderBracket, joinUrl } = App;
  const GRADES = { 9: 'الصف التاسع', 10: 'الصف العاشر', 11: 'الصف الحادي عشر', 12: 'الصف الثاني عشر' };
  const TOKEN = 'quiz-admin-token';
  const root = $('#root');
  let data = null, st = null, tab = 'live', editor = null, selT = null, authed = false, url = '';
  joinUrl().then((u) => { url = u; });

  // ------------------------------------------------------------ auth
  socket.on('connect', async () => {
    const token = localStorage.getItem(TOKEN);
    if (token) {
      const r = await emit('admin:login', { token });
      if (r.ok) { authed = true; return; }
      localStorage.removeItem(TOKEN);
    }
    authed = false;
    renderLogin();
  });
  function renderLogin() {
    root.innerHTML = `<div class="login"><form class="card fade-in" id="loginForm" style="width:min(420px,100%);display:flex;flex-direction:column;gap:16px">
      ${logo}<div><h1 style="font-size:1.6rem">لوحة الأدمن</h1><p class="muted" style="margin:4px 0 0">أدخل كلمة المرور للمتابعة</p></div>
      <input class="input" type="password" id="pw" placeholder="كلمة المرور" autofocus>
      <button class="btn pri lg">${icons.shield} دخول</button><a href="/" class="muted" style="text-align:center;font-size:.9rem">العودة للرئيسية</a></form></div>`;
    $('#loginForm').onsubmit = async (e) => {
      e.preventDefault();
      const r = await emit('admin:login', { password: $('#pw').value });
      if (!r.ok) return toast(r.error, 'error');
      localStorage.setItem(TOKEN, r.token);
      authed = true;
    };
  }

  socket.on('data', (d) => {
    data = d;
    if (!selT || !data.tournaments.some((t) => t.id === selT)) selT = data.activeTournamentId;
    if (!$('.layout')) shell();
    if (tab !== 'live' && !(tab === 'classes' && editor)) renderTab();
    renderNav();
  });
  socket.on('state', (s) => { syncClock(s.now); st = s; if (tab === 'live' && $('.layout')) renderTab(); });

  // ------------------------------------------------------------ shell
  const TABS = [
    ['live', 'التحكم المباشر', icons.bolt],
    ['classes', 'الفصول والأسئلة', icons.book],
    ['tournaments', 'الدوري والجولات', icons.sitemap],
    ['stats', 'الإحصائيات', icons.chart],
    ['settings', 'الإعدادات', icons.gear],
  ];
  function shell() {
    root.innerHTML = `<div class="layout"><aside id="nav"></aside><main class="content" id="main"></main></div>`;
    renderNav();
    renderTab();
    $('#main').addEventListener('click', onClick);
    $('#main').addEventListener('input', onInput);
    $('#main').addEventListener('change', onInput);
  }
  function renderNav() {
    const nav = $('#nav');
    if (!nav) return;
    nav.innerHTML = `${logo}${TABS.map(([id, t, ic]) => `<button class="nav ${tab === id ? 'on' : ''}" data-tab="${id}">${ic}<span style="white-space:nowrap">${t}</span>${id === 'live' && st && st.phase !== 'idle' ? '<span class="live-dot" title="مباشر"></span>' : ''}</button>`).join('')}
      <div style="margin-top:auto;display:flex;flex-direction:column;gap:8px">
        <span class="badge ok" style="justify-content:center">${icons.users} ${data?.stats.totals.online ?? 0} طالب متصل</span>
        <a class="btn sm" href="/display" target="_blank">${icons.monitor} فتح شاشة العرض</a></div>`;
    $$('[data-tab]', nav).forEach((b) => (b.onclick = () => {
      if (editor && editor.dirty && !confirm('لديك تغييرات غير محفوظة على الأسئلة. المتابعة بدون حفظ؟')) return;
      if (b.dataset.tab !== 'classes') editor = null;
      tab = b.dataset.tab; renderNav(); renderTab();
    }));
  }
  function renderTab() {
    const main = $('#main');
    if (!main || !data) return;
    const views = { live: viewLive, classes: viewClasses, tournaments: viewTournaments, stats: viewStats, settings: viewSettings };
    const y = scrollY;
    main.innerHTML = views[tab]();
    scrollTo(0, y);
  }
  async function act(ev, d, okMsg) {
    const r = await emit(ev, d);
    if (!r.ok) toast(r.error || 'حدث خطأ', 'error');
    else if (okMsg) toast(okMsg, 'success');
    return r;
  }
  const head = (title, extra = '') => `<div class="phead"><h1>${title}</h1><div class="row">${extra}</div></div>`;
  const tById = (id) => data.tournaments.find((t) => t.id === id);

  // ------------------------------------------------------------ live
  function viewLive() {
    if (!st) return head('التحكم المباشر') + '<div class="spinner"></div>';
    const t = st.tournament;
    return head('التحكم المباشر', t ? `<span class="badge">${icons.sitemap} ${esc(t.name)}</span>` : '') + `
      <div class="cols">
        <div class="card">${liveControl()}</div>
        <div class="grid">
          <div class="card"><div class="sec-title">${icons.monitor} ما تعرضه الشاشة الكبيرة</div>
            <div class="vbtns">${[['auto', 'تلقائي (حسب المباراة)'], ['bracket', 'شجرة الدوري'], ['leaderboard', 'ترتيب الطلاب'], ['standings', 'ترتيب الفصول']]
              .map(([v, l]) => `<button class="btn sm ${st.view === v ? 'on' : ''}" data-view="${v}">${l}</button>`).join('')}</div>
            <a class="btn sm ghost" style="width:100%;margin-top:10px" href="/display" target="_blank">${icons.expand} فتح شاشة العرض في نافذة جديدة</a></div>
          <div class="card"><div class="sec-title">${icons.users} رابط دخول الطلاب</div>
            <div class="row" style="flex-wrap:nowrap">${url ? `<img src="/api/qr?u=${encodeURIComponent(url)}" style="width:96px;height:96px;border-radius:10px;background:#fff">` : ''}
            <div><b class="ltr" style="display:block;word-break:break-all">${esc(url)}</b><span class="muted" style="font-size:.85rem">يجب أن تكون الأجهزة على نفس الشبكة</span></div></div></div>
        </div>
      </div>
      <div class="card" style="margin-top:20px" data-tid="${t?.id || ''}"><div class="sec-title">${icons.sitemap} جدول المباريات — اضغط "فتح المباراة" لبدء أي مواجهة</div>${renderBracket(t, { admin: true })}</div>`;
  }

  function vsHeader() {
    const [a, b] = st.match.teams;
    const ts = st.teamScores || {};
    const t = (x, cls) => `<div class="team ${cls}" style="padding:14px"><h2 style="font-size:2rem">${esc(x.name)}</h2>
      <div class="muted" style="font-size:.9rem">${ts[x.id]?.players || 0} طالب · ${ts[x.id]?.connected || 0} متصل</div>
      ${st.phase !== 'lobby' ? `<div style="font-size:1.5rem;font-weight:900">${fmt(ts[x.id]?.avg)}</div><div class="muted" style="font-size:.8rem">متوسط النقاط</div>` : ''}</div>`;
    return `<div class="vs" style="margin-bottom:16px">${t(a, 'teamA')}<div class="vs-badge" style="width:56px;height:56px;font-size:1.1rem">VS</div>${t(b, 'teamB')}</div>`;
  }

  function liveQuestions() {
    const [a, b] = st.match.teams;
    const panel = (t, cls) => {
      const q = st.questions?.[t.id];
      if (!q) return '';
      const n = st.participants?.[t.id]?.length || 0;
      return `<div class="lq ${cls}"><div class="row" style="justify-content:space-between;margin-bottom:8px"><b>${esc(t.name)}</b><span class="badge">أجاب ${st.answered?.[t.id] || 0}/${n}</span></div>
        <div style="font-weight:800;margin-bottom:10px">${esc(q.text)}</div>
        <div class="options">${q.options.map((o, i) => `<div class="opt o${i} ${i === q.correctIndex ? 'correct' : st.phase === 'reveal' ? 'dim' : ''}"><span class="shape">${SHAPES[i]}</span><span>${esc(o)}</span><span class="cnt" style="font-size:1rem">${q.dist?.[i] ?? ''}</span></div>`).join('')}</div></div>`;
    };
    return `<div class="lpanel">${panel(a, 'teamA')}${panel(b, 'teamB')}</div>`;
  }

  function lbTable(list) {
    if (!list?.length) return '';
    const [a] = st.match.teams;
    return `<table class="table" style="margin-top:14px"><thead><tr><th>#</th><th>الطالب</th><th>الفصل</th><th>صحيحة</th><th>النقاط</th></tr></thead><tbody>
      ${list.map((p, i) => `<tr><td><span class="rank ${i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span></td><td><b>${esc(p.name)}</b></td><td><span class="dot-team" style="background:${p.classId === a.id ? 'var(--teamA)' : 'var(--teamB)'}"></span> ${esc(p.className)}</td><td>${p.correct}</td><td><b>${fmt(p.score)}</b></td></tr>`).join('')}</tbody></table>`;
  }

  function liveControl() {
    const p = st.phase;
    if (p === 'idle') {
      const ready = [];
      st.tournament?.rounds.forEach((r) => r.matches.forEach((m) => { if (m.status === 'ready') ready.push({ ...m, round: r.name }); }));
      return `<div class="sec-title">${icons.bolt} لا توجد مباراة جارية</div>
        ${!st.tournament ? `<div class="empty">أنشئ دورياً أولاً من تبويب "الدوري والجولات"</div>` : st.tournament.champion
          ? `<div class="champion has">${icons.trophy}<span>${esc(st.tournament.champion.name)}</span><div class="muted">بطل ${esc(st.tournament.name)}</div></div>`
          : ready.length ? `<p class="muted">المباريات الجاهزة للعب:</p><div class="grid">${ready.map((m) => `<div class="ccard"><div><div class="muted" style="font-size:.8rem">${esc(m.round)}</div><b style="font-size:1.3rem">${esc(m.a.name)} <span class="muted">ضد</span> ${esc(m.b.name)}</b></div><button class="btn pri" data-openm="${m.id}">${icons.play} فتح المباراة</button></div>`).join('')}</div>`
          : '<div class="empty">لا توجد مباريات جاهزة — حدّد الفائزين في المباريات المتعادلة</div>'}`;
    }
    const head = `<div class="row" style="justify-content:space-between;margin-bottom:14px"><div class="sec-title" style="margin:0">${esc(st.match.roundName)}</div>
      <span class="badge ${p === 'finished' ? 'ok' : 'live'}">${{ lobby: 'استقبال الطلاب', countdown: 'استعداد', question: 'السؤال مفتوح', reveal: 'عرض الإجابة', finished: 'انتهت' }[p]}</span></div>`;
    const cancel = `<button class="btn bad" data-cancel>${icons.x} إلغاء المباراة</button>`;
    if (p === 'lobby') {
      const empty = st.match.teams.filter((t) => !st.participants[t.id]?.length);
      return head + vsHeader() + `
        <div class="lpanel">${st.match.teams.map((t, i) => `<div class="lq ${i ? 'teamB' : 'teamA'}"><b>${esc(t.name)}</b><div class="chips" style="justify-content:flex-start;margin-top:8px">${(st.participants[t.id] || []).map((x) => `<span class="chip ${x.connected ? '' : 'off'}">${esc(x.name)}</span>`).join('') || '<span class="muted">لم ينضم أحد بعد</span>'}</div></div>`).join('')}</div>
        ${empty.length ? `<p class="badge warn" style="margin-top:14px">لم ينضم أي طالب من: ${empty.map((t) => esc(t.name)).join('، ')}</p>` : ''}
        <p class="muted">عدد الأسئلة: ${st.qCount} لكل فصل</p>
        <div class="row" style="margin-top:16px"><button class="btn ok xl" data-start>${icons.play} ابدأ المسابقة</button>${cancel}</div>`;
    }
    if (p === 'countdown') {
      return head + vsHeader() + `<div style="text-align:center"><div class="muted">السؤال ${st.qIndex + 1} من ${st.qCount} يبدأ خلال</div><div class="big-count grad-text" style="font-size:5rem" data-ends="${st.countdownEndsAt}" data-dur="3000">3</div></div>${liveQuestions()}`;
    }
    if (p === 'question') {
      return head + vsHeader() + `<div class="row" style="justify-content:space-between;margin-bottom:14px"><b>السؤال ${st.qIndex + 1} / ${st.qCount}</b><div class="ring" style="width:70px;height:70px" data-ends="${st.endsAt}" data-dur="${st.duration}"><b style="font-size:1.5rem"></b></div></div>
        ${liveQuestions()}<div class="row" style="margin-top:16px"><button class="btn warn lg" data-reveal>إظهار الإجابة الآن</button>${cancel}</div>`;
    }
    if (p === 'reveal') {
      const last = st.qIndex + 1 >= st.qCount;
      return head + vsHeader() + liveQuestions() + lbTable(st.leaderboard) + `
        <div class="row" style="margin-top:16px"><button class="btn ${last ? 'ok' : 'pri'} lg" data-next>${last ? `${icons.trophy} إنهاء المباراة وإعلان النتيجة` : `السؤال التالي (${st.qIndex + 2}/${st.qCount})`}</button>${cancel}</div>`;
    }
    if (p === 'finished') {
      const r = st.result;
      const w = st.match.teams.find((t) => t.id === r.winner);
      return head + vsHeader() + (w
        ? `<div class="champion has" style="margin-bottom:14px">${icons.trophy}<span>${esc(w.name)}</span><div class="muted">${st.match.roundName === 'النهائي' ? 'بطل الدوري' : 'يتأهل للدور التالي'}</div></div>`
        : `<div class="card" style="border-color:var(--warn);margin-bottom:14px"><b>تعادل كامل!</b> اختر الفصل المتأهل:<div class="row" style="margin-top:10px">${st.match.teams.map((t) => `<button class="btn warn" data-tiewin="${t.id}">تأهيل ${esc(t.name)}</button>`).join('')}</div></div>`)
        + lbTable(r.top) + `<div class="row" style="margin-top:16px"><button class="btn pri lg" data-close ${w ? '' : 'disabled'}>إغلاق والعودة لجدول الدوري</button></div>`;
    }
    return '';
  }

  // ------------------------------------------------------------ classes & questions
  function viewClasses() {
    if (editor) return viewEditor();
    const byGrade = {};
    data.classes.forEach((c) => (byGrade[c.grade] ||= []).push(c));
    const grades = [...new Set([9, 10, 11, 12, ...Object.keys(byGrade).map(Number)])].sort((a, b) => a - b);
    return head('الفصول والأسئلة') + `
      <div class="card" style="margin-bottom:20px"><div class="sec-title">${icons.plus} إضافة فصول</div>
        <div class="row" style="align-items:flex-end">
          <div><label class="lbl">الصف</label><select class="input" id="cGrade" style="width:180px">${[9, 10, 11, 12].map((g) => `<option value="${g}">${GRADES[g]}</option>`).join('')}</select></div>
          <div><label class="lbl">رقم الفصل</label><input class="input" id="cSection" placeholder="مثال: 1" style="width:120px"></div>
          <button class="btn pri" data-addclass>${icons.plus} إضافة فصل</button>
          <span class="muted">أو</span>
          <div><label class="lbl">عدد الفصول في هذا الصف</label><input class="input" id="cCount" type="number" min="1" max="15" value="3" style="width:120px"></div>
          <button class="btn" data-addmany>إنشاء الفصول دفعة واحدة</button>
        </div></div>
      <div class="grade-cols">${grades.map((g) => `<div class="card"><div class="sec-title">${GRADES[g] || 'الصف ' + g}</div>
        ${(byGrade[g] || []).map((c) => `<div class="ccard"><div><h3>${esc(c.name)}</h3><span class="${c.questions.length ? 'muted' : 'badge warn'}" style="font-size:.85rem;white-space:nowrap">${c.questions.length} سؤال</span></div>
          <div class="row" style="gap:6px"><button class="btn sm pri" data-editq="${c.id}">${icons.edit} الأسئلة</button><button class="btn sm bad" data-delclass="${c.id}" title="حذف">${icons.trash}</button></div></div>`).join('') || '<div class="empty" style="padding:16px">لا توجد فصول</div>'}
      </div>`).join('')}</div>`;
  }

  const blankQ = () => ({ text: '', correct: '', wrong: ['', '', ''], time: 20 });
  function openEditor(id) {
    const c = data.classes.find((x) => x.id === id);
    editor = { classId: id, name: c.name, dirty: false, questions: c.questions.map((q) => ({ ...q, wrong: [...q.wrong] })) };
    if (!editor.questions.length) editor.questions = Array.from({ length: 5 }, blankQ);
    renderTab();
  }

  function viewEditor() {
    const others = data.classes.filter((c) => c.id !== editor.classId);
    return head(`أسئلة الفصل <span class="grad-text">${esc(editor.name)}</span>`, `
        ${editor.dirty ? '<span class="badge warn">تغييرات غير محفوظة</span>' : ''}
        <button class="btn ghost" data-closeeditor>رجوع</button><button class="btn ok" data-saveq>${icons.check} حفظ الأسئلة</button>`) + `
      <div class="card" style="margin-bottom:18px"><div class="row" style="align-items:flex-end;justify-content:space-between">
        <div class="row" style="align-items:flex-end"><div><label class="lbl">عدد الأسئلة المراد إضافتها</label><input class="input" type="number" id="addN" min="1" max="50" value="5" style="width:130px"></div>
        <button class="btn pri" data-addq>${icons.plus} إضافة</button></div>
        <details style="min-width:280px"><summary class="btn sm" style="list-style:none">${icons.copy} نسخ هذه الأسئلة إلى فصول أخرى</summary>
          <div class="card" style="margin-top:8px;padding:14px"><div class="checks">${others.map((c) => `<label><input type="checkbox" value="${c.id}" class="copyTo"> ${esc(c.name)}</label>`).join('') || '<span class="muted">لا توجد فصول أخرى</span>'}</div>
          <button class="btn sm pri" style="margin-top:10px" data-copyq>نسخ (بعد الحفظ)</button></div></details>
      </div><p class="muted" style="margin:10px 0 0;font-size:.9rem">اكتب السؤال، ثم الإجابة الصحيحة (بالأخضر)، ثم الخيارات الخاطئة (بالأحمر). سيتم خلط ترتيب الخيارات تلقائياً للطلاب.</p></div>
      ${editor.questions.map((q, i) => `<div class="qcard">
        <div class="row" style="justify-content:space-between;margin-bottom:12px"><div class="row"><span class="qn">${i + 1}</span><b>السؤال ${i + 1}</b></div>
          <div class="row" style="gap:6px"><label class="muted" style="font-size:.85rem">الوقت</label><select class="input" data-q="${i}" data-f="time" style="width:110px;padding:6px 10px">${[10, 15, 20, 30, 45, 60, 90].map((s) => `<option value="${s}" ${+q.time === s ? 'selected' : ''}>${s} ثانية</option>`).join('')}</select>
          <button class="btn sm ghost" data-moveq="${i}" data-dir="-1" ${i === 0 ? 'disabled' : ''} title="أعلى">▲</button><button class="btn sm ghost" data-moveq="${i}" data-dir="1" ${i === editor.questions.length - 1 ? 'disabled' : ''} title="أسفل">▼</button>
          <button class="btn sm bad" data-delq="${i}">${icons.trash}</button></div></div>
        <textarea class="input" rows="2" data-q="${i}" data-f="text" placeholder="نص السؤال">${esc(q.text)}</textarea>
        <div style="margin-top:10px"><label class="lbl" style="color:#86efac">${icons.check} الإجابة الصحيحة</label><input class="input ans-ok" data-q="${i}" data-f="correct" value="${esc(q.correct)}" placeholder="الإجابة الصحيحة"></div>
        <label class="lbl" style="color:#fca5a5;margin-top:10px">${icons.x} الخيارات الخاطئة</label>
        <div class="wrong-grid">${q.wrong.map((w, j) => `<input class="input ans-bad" data-q="${i}" data-f="wrong" data-j="${j}" value="${esc(w)}" placeholder="خيار خاطئ ${j + 1}">`).join('')}
          ${q.wrong.length < 5 ? `<button class="btn sm ghost" data-addwrong="${i}">${icons.plus} خيار</button>` : ''}</div>
      </div>`).join('')}
      <div class="row"><button class="btn" data-addone>${icons.plus} إضافة سؤال</button><button class="btn ok lg" data-saveq>${icons.check} حفظ الأسئلة</button></div>`;
  }

  // ------------------------------------------------------------ tournaments
  function viewTournaments() {
    const byGrade = {};
    data.classes.forEach((c) => (byGrade[c.grade] ||= []).push(c));
    const t = tById(selT);
    return head('الدوري والجولات') + `
      <div class="cols">
        <div class="card"><div class="sec-title">${icons.sitemap} ${t ? esc(t.name) : 'شجرة الدوري'}
          ${t && t.id === data.activeTournamentId ? '<span class="badge ok">النشط</span>' : ''}</div>
          <div data-tid="${t?.id || ''}">${renderBracket(t, { admin: true })}</div>
          ${data.tournaments.length ? `<div class="sec-title" style="margin-top:20px">كل الدوريات</div>
          ${data.tournaments.map((x) => `<div class="ccard"><div><b style="font-size:1.1rem">${esc(x.name)}</b>
            <div class="muted" style="font-size:.85rem">${x.rounds.length} جولات · ${x.questionsPerMatch} أسئلة للمباراة ${x.champion ? `· البطل: ${esc(x.champion.name)}` : ''}</div></div>
            <div class="row" style="gap:6px">${x.id === data.activeTournamentId ? '<span class="badge ok">نشط</span>' : `<button class="btn sm" data-activate="${x.id}">تفعيل</button>`}
            <button class="btn sm ${x.id === selT ? 'pri' : ''}" data-selt="${x.id}">عرض</button><button class="btn sm bad" data-delt="${x.id}">${icons.trash}</button></div></div>`).join('')}` : ''}
        </div>
        <div class="card"><div class="sec-title">${icons.plus} إنشاء دوري جديد</div>
          <div class="grid" style="gap:12px">
            <div><label class="lbl">اسم الدوري</label><input class="input" id="tName" placeholder="مثال: دوري المسابقات الثقافية"></div>
            <div class="row" style="flex-wrap:nowrap"><div style="flex:1"><label class="lbl">عدد الأسئلة في كل مباراة</label><input class="input" id="tQ" type="number" min="1" max="50" value="5"></div>
            <div style="flex:1"><label class="lbl">ترتيب المواجهات</label><select class="input" id="tOrder"><option value="grade">حسب الصف (10/1 ضد 10/2…)</option><option value="random">قرعة عشوائية</option></select></div></div>
            <div><div class="row" style="justify-content:space-between"><label class="lbl">الفصول المشاركة</label><button class="btn sm ghost" data-checkall>تحديد الكل</button></div>
              ${Object.keys(byGrade).sort((a, b) => a - b).map((g) => `<div style="margin-bottom:10px"><div class="row" style="justify-content:space-between;margin-bottom:6px"><b class="muted" style="font-size:.85rem">${GRADES[g] || 'الصف ' + g}</b><button class="btn sm ghost" data-checkgrade="${g}">الكل</button></div>
              <div class="checks">${byGrade[g].map((c) => `<label><input type="checkbox" class="tc" data-grade="${g}" value="${c.id}"> ${esc(c.name)} <small class="muted">(${c.questions.length})</small></label>`).join('')}</div></div>`).join('') || '<div class="empty">أنشئ فصولاً أولاً</div>'}
            </div>
            <p class="muted" style="font-size:.85rem;margin:0">نظام خروج المغلوب: كل فصلين يتواجهان والفائز يتأهل للجولة التالية حتى يبقى بطل واحد. إذا كان العدد فردياً يتأهل بعض الفصول مباشرة.</p>
            <button class="btn pri lg" data-createt>${icons.sitemap} إنشاء الدوري</button>
          </div></div>
      </div>`;
  }

  // ------------------------------------------------------------ stats
  function viewStats() {
    const s = data.stats, T = s.totals;
    const kpi = (v, l, ic) => `<div class="card kpi"><span>${ic} ${l}</span><b>${fmt(v)}</b></div>`;
    return head('الإحصائيات', `<button class="btn sm" data-csv>${icons.copy} تصدير ترتيب الطلاب (CSV)</button>`) + `
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(170px,1fr));margin-bottom:20px">
        ${kpi(T.classes, 'الفصول', icons.book)}${kpi(T.questions, 'الأسئلة', icons.edit)}${kpi(T.matches, 'مباريات منتهية', icons.sitemap)}${kpi(T.players, 'طلاب شاركوا', icons.users)}${kpi(T.online, 'متصل الآن', icons.bolt)}
      </div>
      <div class="cols">
        <div class="card"><div class="sec-title">${icons.chart} ترتيب الفصول</div>
          <table class="table"><thead><tr><th>#</th><th>الفصل</th><th>لعب</th><th>فوز</th><th>خسارة</th><th>النقاط</th><th>الدقة</th></tr></thead><tbody>
          ${s.standings.map((c, i) => `<tr><td><span class="rank ${i < 3 && c.played ? 'r' + (i + 1) : ''}">${i + 1}</span></td><td><b>${esc(c.name)}</b></td><td>${c.played}</td><td style="color:#86efac">${c.wins}</td><td style="color:#fca5a5">${c.losses}</td><td>${fmt(c.points)}</td><td>${c.accuracy}%</td></tr>`).join('') || '<tr><td colspan="7" class="muted">لا توجد بيانات</td></tr>'}
          </tbody></table></div>
        <div class="card"><div class="sec-title">${icons.x} أصعب الأسئلة</div>
          ${s.hardest.map((q) => `<div style="margin-bottom:12px"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span style="font-weight:700">${esc(q.text)}</span><span class="badge">${esc(q.className)}</span></div>
          <div class="row" style="flex-wrap:nowrap;margin-top:6px"><div class="bar" style="flex:1"><i style="width:${q.accuracy}%"></i></div><b>${q.accuracy}%</b></div></div>`).join('') || '<div class="empty">لا توجد بيانات بعد</div>'}</div>
      </div>
      <div class="card" style="margin-top:20px"><div class="sec-title">${icons.star} ترتيب الطلاب</div>
        <table class="table"><thead><tr><th>#</th><th>الطالب</th><th>الفصل</th><th>المباريات</th><th>صحيحة</th><th>الدقة</th><th>النقاط</th></tr></thead><tbody>
        ${s.top.map((p, i) => `<tr><td><span class="rank ${i < 3 ? 'r' + (i + 1) : ''}">${i + 1}</span></td><td><b>${esc(p.name)}</b></td><td>${esc(p.className)}</td><td>${p.matches}</td><td>${p.correct}/${p.questions}</td><td>${p.accuracy}%</td><td><b>${fmt(p.score)}</b></td></tr>`).join('') || '<tr><td colspan="7" class="muted">لا توجد بيانات</td></tr>'}
        </tbody></table></div>
      <div class="card" style="margin-top:20px"><div class="sec-title">${icons.sitemap} سجل المباريات</div>
        <table class="table"><thead><tr><th>التاريخ</th><th>الدوري</th><th>الجولة</th><th>المباراة</th><th>النتيجة</th><th>الفائز</th></tr></thead><tbody>
        ${data.history.map((h) => `<tr><td class="muted">${new Date(h.date).toLocaleString('ar', { dateStyle: 'short', timeStyle: 'short' })}</td><td>${esc(h.tournament)}</td><td>${esc(h.roundName)}</td><td><b>${esc(h.teams[0])}</b> ضد <b>${esc(h.teams[1])}</b></td><td>${fmt(h.scores[0])} - ${fmt(h.scores[1])}</td><td>${h.winner ? `<span class="badge ok">${esc(h.winner)}</span>` : '<span class="badge warn">تعادل</span>'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">لا توجد مباريات بعد</td></tr>'}
        </tbody></table></div>`;
  }

  // ------------------------------------------------------------ settings
  function viewSettings() {
    return head('الإعدادات') + `<div class="cols">
      <div class="card"><div class="sec-title">${icons.users} روابط الدخول</div>
        ${(data.urls.length ? data.urls : [location.origin]).map((u) => `<div class="ccard"><div><b class="ltr" style="display:block">${esc(u)}/play</b><span class="muted" style="font-size:.85rem">صفحة الطالب</span></div><img src="/api/qr?u=${encodeURIComponent(u + '/play')}" style="width:80px;height:80px;border-radius:8px;background:#fff"></div>`).join('')}
        <p class="muted" style="font-size:.9rem">شاشة العرض: <b class="ltr">/display</b> — لوحة الأدمن: <b class="ltr">/admin</b></p>
        <div class="sec-title" style="margin-top:18px">${icons.gear} تغيير كلمة مرور الأدمن</div>
        <div class="row" style="display:flex;gap:10px"><input class="input" id="newpw" type="password" placeholder="كلمة المرور الجديدة (6 أحرف على الأقل)" autocomplete="new-password" style="flex:1"><button class="btn primary" data-setpw>حفظ</button></div></div>
      <div class="card"><div class="sec-title">${icons.gear} البيانات</div><div class="grid" style="gap:10px">
        <button class="btn" data-demo>تحميل بيانات تجريبية (8 فصول + أسئلة + دوري)</button>
        <button class="btn warn" data-resetstats>تصفير الإحصائيات وترتيب الطلاب</button>
        <button class="btn bad" data-resetall>${icons.trash} حذف كل البيانات</button>
        <button class="btn ghost" data-logout>${icons.logout} تسجيل الخروج</button></div></div></div>`;
  }

  // ------------------------------------------------------------ events
  function onInput(e) {
    const el = e.target;
    if (!editor || el.dataset.q == null) return;
    const q = editor.questions[+el.dataset.q];
    if (el.dataset.f === 'wrong') q.wrong[+el.dataset.j] = el.value;
    else q[el.dataset.f] = el.dataset.f === 'time' ? +el.value : el.value;
    if (!editor.dirty) { editor.dirty = true; const h = $('.phead .row'); if (h && !$('.phead .badge.warn')) h.insertAdjacentHTML('afterbegin', '<span class="badge warn">تغييرات غير محفوظة</span>'); }
  }

  async function onClick(e) {
    const el = e.target.closest('button,[data-view]');
    if (!el) return;
    const d = el.dataset;
    const tid = el.closest('[data-tid]')?.dataset.tid;

    if (d.view) return act('display:view', { view: d.view });
    if (d.open) return act('match:open', { tournamentId: tid, matchId: d.open }).then((r) => { if (r.ok && tab !== 'live') { tab = 'live'; renderNav(); renderTab(); } });
    if (d.openm) return act('match:open', { tournamentId: st.tournament.id, matchId: d.openm });
    if (d.win) { if (confirm('تأهيل هذا الفصل يدوياً؟')) act('match:setWinner', { tournamentId: tid, matchId: d.win, winner: d.team }, 'تم التأهيل'); return; }
    if (d.reset) { if (confirm('إعادة تعيين هذه المباراة؟ ستُلغى نتيجتها ونتائج الجولات التي تليها.')) act('match:reset', { tournamentId: tid, matchId: d.reset }); return; }
    if ('start' in d) return act('match:start');
    if ('reveal' in d) return act('match:reveal');
    if ('next' in d) return act('match:next');
    if ('cancel' in d) { if (confirm('إلغاء المباراة الحالية بدون حفظ النتيجة؟')) act('match:cancel'); return; }
    if ('close' in d) return act('match:close');
    if (d.tiewin) return act('match:setWinner', { tournamentId: st.match.tournamentId, matchId: st.match.id, winner: d.tiewin }, 'تم التأهيل');

    if ('addclass' in d) return act('class:create', { grade: $('#cGrade').value, section: $('#cSection').value }, 'تمت إضافة الفصل');
    if ('addmany' in d) {
      const g = $('#cGrade').value, n = Math.min(15, Math.max(1, +$('#cCount').value || 0));
      let ok = 0;
      for (let i = 1; i <= n; i++) if ((await emit('class:create', { grade: g, section: String(i) })).ok) ok++;
      return toast(`تم إنشاء ${ok} فصل`, 'success');
    }
    if (d.delclass) { if (confirm('حذف الفصل وكل أسئلته؟')) act('class:delete', { id: d.delclass }); return; }
    if (d.editq) return openEditor(d.editq);

    if (editor) {
      if ('closeeditor' in d) { if (!editor.dirty || confirm('الخروج بدون حفظ؟')) { editor = null; renderTab(); } return; }
      if ('addq' in d) { const n = Math.min(50, Math.max(1, +$('#addN').value || 1)); for (let i = 0; i < n; i++) editor.questions.push(blankQ()); editor.dirty = true; return renderTab(); }
      if ('addone' in d) { editor.questions.push(blankQ()); editor.dirty = true; return renderTab(); }
      if (d.delq) { editor.questions.splice(+d.delq, 1); editor.dirty = true; return renderTab(); }
      if (d.addwrong) { editor.questions[+d.addwrong].wrong.push(''); return renderTab(); }
      if (d.moveq) { const i = +d.moveq, j = i + +d.dir; const qs = editor.questions; [qs[i], qs[j]] = [qs[j], qs[i]]; editor.dirty = true; return renderTab(); }
      if ('saveq' in d) {
        const qs = editor.questions.filter((q) => q.text.trim() || q.correct.trim() || q.wrong.some((w) => w.trim()));
        const r = await act('class:saveQuestions', { id: editor.classId, questions: qs }, `تم حفظ ${qs.length} سؤال`);
        if (r.ok) { editor.questions = qs.length ? qs : [blankQ()]; editor.dirty = false; renderTab(); }
        return;
      }
      if ('copyq' in d) {
        if (editor.dirty) return toast('احفظ الأسئلة أولاً', 'error');
        const toIds = $$('.copyTo:checked').map((x) => x.value);
        if (!toIds.length) return toast('اختر فصلاً واحداً على الأقل', 'error');
        return act('class:copyQuestions', { fromId: editor.classId, toIds }, 'تم نسخ الأسئلة');
      }
    }

    if ('checkall' in d) { const all = $$('.tc'); const v = all.some((x) => !x.checked); all.forEach((x) => (x.checked = v)); return; }
    if (d.checkgrade) { const all = $$(`.tc[data-grade="${d.checkgrade}"]`); const v = all.some((x) => !x.checked); all.forEach((x) => (x.checked = v)); return; }
    if ('createt' in d) {
      const classIds = $$('.tc:checked').map((x) => x.value);
      const r = await act('tournament:create', { name: $('#tName').value, questionsPerMatch: $('#tQ').value, order: $('#tOrder').value, classIds }, 'تم إنشاء الدوري');
      if (r.ok) selT = r.id;
      return;
    }
    if (d.selt) { selT = d.selt; return renderTab(); }
    if (d.activate) return act('tournament:activate', { id: d.activate }, 'تم تفعيل الدوري');
    if (d.delt) { if (confirm('حذف هذا الدوري نهائياً؟')) act('tournament:delete', { id: d.delt }); return; }

    if ('csv' in d) {
      const rows = [['#', 'الطالب', 'الفصل', 'المباريات', 'صحيحة', 'الأسئلة', 'الدقة %', 'النقاط'], ...data.stats.top.map((p, i) => [i + 1, p.name, p.className, p.matches, p.correct, p.questions, p.accuracy, p.score])];
      const csv = '\ufeff' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'ترتيب-الطلاب.csv';
      a.click();
      return;
    }
    if ('setpw' in d) {
      const pw = document.getElementById('newpw').value;
      act('admin:password', { password: pw }, 'تم تغيير كلمة المرور').then((r) => { if (r.ok) localStorage.removeItem(TOKEN); });
      return;
    }
    if ('demo' in d) return act('data:demo', {}, 'تم تحميل البيانات التجريبية');
    if ('resetstats' in d) { if (confirm('تصفير كل الإحصائيات وترتيب الطلاب؟')) act('stats:reset', {}, 'تم التصفير'); return; }
    if ('resetall' in d) { if (confirm('سيتم حذف كل الفصول والأسئلة والدوريات. متأكد؟') && confirm('تأكيد أخير: حذف كل البيانات؟')) act('data:reset', {}, 'تم حذف كل البيانات'); return; }
    if ('logout' in d) { localStorage.removeItem(TOKEN); location.reload(); }
  }
})();
