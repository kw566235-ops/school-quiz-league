'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const demo = require('./demo');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'db.json');
const COUNTDOWN_MS = 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'], setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.get('/api/info', (req, res) => res.json({ urls: lanUrls() }));
app.get('/api/qr', async (req, res) => {
  try {
    const svg = await QRCode.toString(String(req.query.u || ''), { type: 'svg', margin: 1, color: { dark: '#0b1023', light: '#ffffff' } });
    res.type('image/svg+xml').send(svg);
  } catch { res.status(400).end(); }
});

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

// ---------------------------------------------------------------- persistence
const uid = () => crypto.randomBytes(5).toString('hex');
const clean = (s, max = 300) => String(s ?? '').trim().slice(0, max);
const clamp = (n, lo, hi, def) => { n = Number(n); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : def; };
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

function emptyDb() {
  return { classes: [], tournaments: [], activeTournamentId: null, players: {}, questionStats: {}, history: [] };
}
function loadDb() {
  try { return Object.assign(emptyDb(), JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); } catch { return emptyDb(); }
}
let db = loadDb();
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250); }
function flush() {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DATA_FILE);
}
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { flush(); } finally { process.exit(0); } });

const getClass = (id) => db.classes.find((c) => c.id === id);
const getT = (id) => db.tournaments.find((t) => t.id === id);
const className = (id) => getClass(id)?.name || '—';
const classInfo = (id) => { const c = getClass(id); return c ? { id: c.id, name: c.name, grade: c.grade } : null; };
const sortClasses = (list) => list.sort((a, b) => a.grade - b.grade || String(a.section).localeCompare(String(b.section), 'en', { numeric: true }));
const classList = () => sortClasses([...db.classes]).map((c) => ({ id: c.id, name: c.name, grade: c.grade }));

// ---------------------------------------------------------------- classes & questions
function createClass({ grade, section }) {
  grade = clamp(grade, 1, 12, null);
  section = clean(section, 10);
  if (!grade || !section) throw new Error('أدخل الصف ورقم الفصل');
  const name = `${grade}/${section}`;
  if (db.classes.some((c) => c.name === name)) throw new Error(`الفصل ${name} موجود مسبقاً`);
  const c = { id: uid(), grade, section, name, questions: [], cursor: 0 };
  db.classes.push(c);
  return c;
}

function normalizeQuestion(q, i) {
  const text = clean(q.text, 500);
  const correct = clean(q.correct, 200);
  const wrong = (Array.isArray(q.wrong) ? q.wrong : []).map((w) => clean(w, 200)).filter(Boolean).slice(0, 5);
  if (!text) throw new Error(`السؤال رقم ${i + 1}: نص السؤال فارغ`);
  if (!correct) throw new Error(`السؤال رقم ${i + 1}: الإجابة الصحيحة فارغة`);
  if (!wrong.length) throw new Error(`السؤال رقم ${i + 1}: أضف خياراً خاطئاً واحداً على الأقل`);
  return { id: clean(q.id, 20) || uid(), text, correct, wrong, time: clamp(q.time, 5, 120, 20) };
}

// ---------------------------------------------------------------- tournaments
function roundName(count) {
  return { 1: 'النهائي', 2: 'نصف النهائي', 4: 'ربع النهائي', 8: 'دور الـ16', 16: 'دور الـ32' }[count] || `دور الـ${count * 2}`;
}
const mkMatch = (a, b, bye = false) => ({ id: uid(), a, b, bye, winner: null, result: null });

function createTournament({ name, classIds, questionsPerMatch, order }) {
  const teams = (Array.isArray(classIds) ? classIds : []).map(getClass).filter(Boolean);
  if (teams.length < 2) throw new Error('اختر فصلين على الأقل');
  if (order === 'random') shuffle(teams); else sortClasses(teams);
  const n = teams.length;
  let size = 1;
  while (size < n) size *= 2;
  const byes = size - n;
  // Spread byes evenly so two direct-qualifiers don't meet in round two when avoidable.
  const r0 = [];
  let i = 0;
  const slots = size / 2;
  const byeAt = new Set();
  for (let k = 0; k < byes; k++) byeAt.add(Math.floor((k * slots) / byes));
  for (let s = 0; s < slots; s++) {
    if (byeAt.has(s)) r0.push(mkMatch(teams[i++].id, null, true));
    else { r0.push(mkMatch(teams[i].id, teams[i + 1].id)); i += 2; }
  }
  const rounds = [r0];
  let cnt = r0.length;
  while (cnt > 1) { cnt /= 2; rounds.push(Array.from({ length: cnt }, () => mkMatch(null, null))); }
  const t = {
    id: uid(), name: clean(name, 80) || 'دوري المسابقات', questionsPerMatch: clamp(questionsPerMatch, 1, 50, 5),
    rounds, createdAt: Date.now(), championId: null,
  };
  recompute(t);
  db.tournaments.push(t);
  db.activeTournamentId = t.id;
  return t;
}

function recompute(t) {
  t.rounds[0].forEach((m) => { if (m.bye) m.winner = m.a; });
  for (let r = 1; r < t.rounds.length; r++) {
    t.rounds[r].forEach((m, i) => {
      const a = t.rounds[r - 1][2 * i].winner || null;
      const b = t.rounds[r - 1][2 * i + 1].winner || null;
      if (m.a !== a || m.b !== b) { m.a = a; m.b = b; m.winner = null; m.result = null; }
    });
  }
  t.championId = t.rounds[t.rounds.length - 1][0].winner || null;
}

function findMatch(t, mid) {
  for (let r = 0; r < t.rounds.length; r++) {
    const m = t.rounds[r].find((x) => x.id === mid);
    if (m) return { m, r, roundName: roundName(t.rounds[r].length) };
  }
  return null;
}

function matchStatus(m) {
  if (m.bye) return 'bye';
  if (m.winner) return 'done';
  if (m.result) return 'tie';
  if (live.matchId === m.id && live.phase !== 'idle') return 'live';
  return m.a && m.b ? 'ready' : 'pending';
}

function tView(t) {
  if (!t) return null;
  return {
    id: t.id, name: t.name, questionsPerMatch: t.questionsPerMatch, createdAt: t.createdAt,
    champion: classInfo(t.championId),
    rounds: t.rounds.map((r) => ({
      name: roundName(r.length),
      matches: r.map((m) => ({
        id: m.id, bye: m.bye, winner: m.winner, status: matchStatus(m),
        a: classInfo(m.a), b: classInfo(m.b),
        scores: m.result ? [m.result.scores[m.a]?.avg ?? 0, m.result.scores[m.b]?.avg ?? 0] : null,
      })),
    })),
  };
}

// ---------------------------------------------------------------- live game
const players = new Map(); // playerId -> { id, name, classId, socketId, connected }
const adminTokens = new Set();
let displayView = 'auto';
let timer = null;
let live = idleLive();

function idleLive() {
  return {
    phase: 'idle', tournamentId: null, matchId: null, roundName: '', teams: [], sets: {},
    qIndex: -1, qCount: 0, countdownEndsAt: 0, qStartedAt: 0, qEndsAt: 0, qDuration: 0,
    answers: {}, pstats: {}, result: null,
  };
}

function prepQuestion(q) {
  const opts = shuffle([{ t: q.correct, c: true }, ...q.wrong.map((w) => ({ t: w, c: false }))]);
  return { id: q.id, text: q.text, time: q.time, options: opts.map((o) => o.t), correctIndex: opts.findIndex((o) => o.c) };
}

function pickQuestions(c, n) {
  const out = [];
  const start = c.cursor || 0;
  for (let i = 0; i < n; i++) out.push(prepQuestion(c.questions[(start + i) % c.questions.length]));
  return out;
}

function ensureParticipant(p) {
  if (live.phase === 'idle') return;
  const existing = live.pstats[p.id];
  if (existing && existing.classId !== p.classId) delete live.pstats[p.id];
  if (!live.teams.includes(p.classId)) return;
  if (!live.pstats[p.id]) {
    live.pstats[p.id] = { id: p.id, name: p.name, classId: p.classId, score: 0, correct: 0, answered: 0, streak: 0, totalMs: 0, lastPoints: 0, lastCorrect: null };
  } else live.pstats[p.id].name = p.name;
}

const participantsOf = (cid) => Object.values(live.pstats).filter((p) => p.classId === cid);
const isConnected = (pid) => !!players.get(pid)?.connected;

function openMatch({ tournamentId, matchId }) {
  if (!['idle', 'finished'].includes(live.phase)) throw new Error('هناك مباراة جارية حالياً');
  const t = getT(tournamentId);
  const f = t && findMatch(t, matchId);
  if (!f) throw new Error('المباراة غير موجودة');
  const { m } = f;
  if (m.bye || !m.a || !m.b) throw new Error('المباراة غير جاهزة بعد');
  if (m.winner || m.result) throw new Error('المباراة انتهت — أعد تعيينها أولاً');
  const ca = getClass(m.a), cb = getClass(m.b);
  if (!ca || !cb) throw new Error('أحد الفصول محذوف');
  for (const c of [ca, cb]) if (!c.questions.length) throw new Error(`لا توجد أسئلة للفصل ${c.name}`);
  const n = Math.min(t.questionsPerMatch, ca.questions.length, cb.questions.length);
  clearTimeout(timer);
  live = { ...idleLive(), phase: 'lobby', tournamentId, matchId, roundName: f.roundName, teams: [m.a, m.b], qCount: n,
    sets: { [m.a]: pickQuestions(ca, n), [m.b]: pickQuestions(cb, n) } };
  db.activeTournamentId = tournamentId;
  for (const p of players.values()) ensureParticipant(p);
}

function startQuestion(i) {
  clearTimeout(timer);
  live.qIndex = i;
  live.answers = {};
  live.phase = 'countdown';
  live.countdownEndsAt = Date.now() + COUNTDOWN_MS;
  live.qDuration = Math.max(...live.teams.map((c) => live.sets[c][i].time)) * 1000;
  timer = setTimeout(() => {
    live.phase = 'question';
    live.qStartedAt = Date.now();
    live.qEndsAt = live.qStartedAt + live.qDuration;
    timer = setTimeout(reveal, live.qDuration + 400);
    broadcast();
  }, COUNTDOWN_MS);
}

function answer(p, choice) {
  if (live.phase !== 'question') return;
  const ps = live.pstats[p.id];
  if (!ps || live.answers[p.id]) return;
  const now = Date.now();
  if (now > live.qEndsAt + 500) return;
  const q = live.sets[p.classId][live.qIndex];
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.options.length) return;
  const ms = Math.max(0, now - live.qStartedAt);
  const correct = choice === q.correctIndex;
  let points = 0;
  if (correct) {
    ps.streak++;
    ps.correct++;
    points = Math.round(1000 * (1 - Math.min(ms, live.qDuration) / live.qDuration / 2)) + Math.min(ps.streak - 1, 3) * 100;
  } else ps.streak = 0;
  ps.score += points;
  ps.answered++;
  ps.totalMs += ms;
  ps.lastPoints = points;
  ps.lastCorrect = correct;
  live.answers[p.id] = { choice, correct, ms, points };
  const waiting = Object.values(live.pstats).some((x) => isConnected(x.id) && !live.answers[x.id]);
  if (!waiting) { clearTimeout(timer); timer = setTimeout(reveal, 700); }
  broadcast();
}

function reveal() {
  if (live.phase !== 'question') return;
  clearTimeout(timer);
  live.phase = 'reveal';
  for (const ps of Object.values(live.pstats)) {
    if (!live.answers[ps.id]) { ps.streak = 0; ps.lastPoints = 0; ps.lastCorrect = null; }
  }
  for (const cid of live.teams) {
    const q = live.sets[cid][live.qIndex];
    const ps = participantsOf(cid);
    const st = db.questionStats[q.id] || (db.questionStats[q.id] = { text: q.text, classId: cid, asked: 0, correct: 0 });
    st.text = q.text;
    st.asked += ps.length;
    st.correct += ps.filter((p) => live.answers[p.id]?.correct).length;
  }
  save();
  broadcast();
}

function teamScores() {
  const res = {};
  for (const cid of live.teams) {
    const ps = participantsOf(cid);
    const total = sum(ps, (p) => p.score);
    const correct = sum(ps, (p) => p.correct);
    const answered = sum(ps, (p) => p.answered);
    const askedSoFar = live.phase === 'lobby' || live.phase === 'countdown' ? live.qIndex : live.qIndex + 1;
    res[cid] = {
      players: ps.length,
      connected: ps.filter((p) => isConnected(p.id)).length,
      total, correct,
      avg: ps.length ? Math.round(total / ps.length) : 0,
      accuracy: ps.length && askedSoFar > 0 ? Math.round((100 * correct) / (ps.length * askedSoFar)) : 0,
      avgMs: answered ? Math.round(sum(ps, (p) => p.totalMs) / answered) : null,
    };
  }
  return res;
}

function matchLeaderboard(limit = 10) {
  return Object.values(live.pstats)
    .sort((a, b) => b.score - a.score || a.totalMs - b.totalMs)
    .slice(0, limit)
    .map((p) => ({ id: p.id, name: p.name, classId: p.classId, className: className(p.classId), score: p.score, correct: p.correct, streak: p.streak }));
}

function finish() {
  clearTimeout(timer);
  const t = getT(live.tournamentId);
  const f = t && findMatch(t, live.matchId);
  live.qIndex = live.qCount - 1;
  live.phase = 'finished';
  const scores = teamScores();
  const [a, b] = live.teams;
  const A = scores[a], B = scores[b];
  let cmp = A.avg - B.avg || A.accuracy - B.accuracy || (B.avgMs ?? 1e12) - (A.avgMs ?? 1e12);
  if (!A.players && !B.players) cmp = 0;
  const winner = cmp > 0 ? a : cmp < 0 ? b : null;
  live.result = { scores, winner, tie: !winner, top: matchLeaderboard(10), qCount: live.qCount, date: Date.now() };

  for (const ps of Object.values(live.pstats)) {
    const key = `${ps.classId}:${ps.name.trim().toLowerCase()}`;
    const s = db.players[key] || (db.players[key] = { name: ps.name, classId: ps.classId, score: 0, correct: 0, questions: 0, matches: 0 });
    s.name = ps.name;
    s.score += ps.score;
    s.correct += ps.correct;
    s.questions += live.qCount;
    s.matches += 1;
  }
  for (const cid of live.teams) {
    const c = getClass(cid);
    if (c && c.questions.length) c.cursor = ((c.cursor || 0) + live.qCount) % c.questions.length;
  }
  if (f) { f.m.result = live.result; f.m.winner = winner; recompute(t); }
  db.history.unshift({
    id: uid(), tournament: t?.name || '', roundName: live.roundName, date: Date.now(),
    teams: [className(a), className(b)], scores: [A.avg, B.avg], winner: winner ? className(winner) : null,
  });
  db.history = db.history.slice(0, 200);
  save();
}

function setWinner({ tournamentId, matchId, winner }) {
  const t = getT(tournamentId);
  const f = t && findMatch(t, matchId);
  if (!f) throw new Error('المباراة غير موجودة');
  if (live.matchId === matchId && !['idle', 'finished'].includes(live.phase)) throw new Error('المباراة جارية حالياً');
  if (![f.m.a, f.m.b].includes(winner) || !winner) throw new Error('الفائز يجب أن يكون أحد طرفي المباراة');
  f.m.winner = winner;
  if (live.matchId === matchId && live.result) { live.result.winner = winner; live.result.tie = false; }
  const h = db.history.find((x) => x.roundName === f.roundName && x.teams.includes(className(winner)) && !x.winner);
  if (h) h.winner = className(winner);
  recompute(t);
}

function resetMatch({ tournamentId, matchId }) {
  const t = getT(tournamentId);
  const f = t && findMatch(t, matchId);
  if (!f) throw new Error('المباراة غير موجودة');
  if (live.matchId === matchId && live.phase !== 'idle') throw new Error('أغلق المباراة الحالية أولاً');
  f.m.winner = null;
  f.m.result = null;
  recompute(t);
}

// ---------------------------------------------------------------- views
function standings() {
  const map = {};
  for (const c of db.classes) map[c.id] = { id: c.id, name: c.name, grade: c.grade, played: 0, wins: 0, losses: 0, points: 0, correct: 0, accuracySum: 0 };
  for (const t of db.tournaments) for (const r of t.rounds) for (const m of r) {
    if (!m.result) continue;
    for (const id of [m.a, m.b]) {
      const st = map[id];
      const s = m.result.scores[id];
      if (!st || !s) continue;
      st.played++;
      st.points += s.avg;
      st.correct += s.correct;
      st.accuracySum += s.accuracy;
      if (m.winner === id) st.wins++; else if (m.winner) st.losses++;
    }
  }
  return Object.values(map)
    .map((s) => ({ ...s, accuracy: s.played ? Math.round(s.accuracySum / s.played) : 0 }))
    .sort((a, b) => b.wins - a.wins || b.points - a.points || a.grade - b.grade);
}

function topPlayers(limit = 10) {
  return Object.values(db.players)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((p) => ({ ...p, className: className(p.classId), accuracy: p.questions ? Math.round((100 * p.correct) / p.questions) : 0 }));
}

function hardestQuestions(limit = 10) {
  return Object.entries(db.questionStats)
    .filter(([, s]) => s.asked > 0)
    .map(([id, s]) => ({ id, ...s, className: className(s.classId), accuracy: Math.round((100 * s.correct) / s.asked) }))
    .sort((a, b) => a.accuracy - b.accuracy || b.asked - a.asked)
    .slice(0, limit);
}

function matchInfo() {
  if (!live.matchId) return null;
  return { id: live.matchId, tournamentId: live.tournamentId, tournament: getT(live.tournamentId)?.name || '', roundName: live.roundName, teams: live.teams.map(classInfo) };
}

function questionView(cid, withAnswer, withDist) {
  const q = live.sets[cid]?.[live.qIndex];
  if (!q) return null;
  const v = { text: q.text, options: q.options, time: q.time };
  if (withAnswer) v.correctIndex = q.correctIndex;
  if (withDist) {
    v.dist = q.options.map(() => 0);
    for (const p of participantsOf(cid)) { const a = live.answers[p.id]; if (a) v.dist[a.choice]++; }
  }
  return v;
}

function publicState(forAdmin) {
  const t = getT(db.activeTournamentId);
  const s = {
    now: Date.now(), phase: live.phase, view: displayView, match: matchInfo(),
    qIndex: live.qIndex, qCount: live.qCount, countdownEndsAt: live.countdownEndsAt, endsAt: live.qEndsAt, duration: live.qDuration,
    tournament: tView(t), overall: { top: topPlayers(10), standings: standings() },
  };
  if (live.phase !== 'idle') {
    s.participants = {};
    s.answered = {};
    for (const cid of live.teams) {
      const ps = participantsOf(cid);
      s.participants[cid] = ps.map((p) => ({ name: p.name, connected: isConnected(p.id), answered: !!live.answers[p.id] }));
      s.answered[cid] = ps.filter((p) => live.answers[p.id]).length;
    }
    s.teamScores = teamScores();
    const showQ = ['question', 'reveal'].includes(live.phase) || (forAdmin && live.phase === 'countdown');
    if (showQ) {
      s.questions = {};
      for (const cid of live.teams) s.questions[cid] = questionView(cid, forAdmin || live.phase === 'reveal', live.phase === 'reveal' || forAdmin);
    }
    if (['reveal', 'finished'].includes(live.phase) || forAdmin) s.leaderboard = matchLeaderboard(10);
    if (live.phase === 'finished') s.result = live.result;
  }
  return s;
}

function nextMatchFor(classId) {
  const t = getT(db.activeTournamentId);
  if (!t) return null;
  for (const r of t.rounds) for (const m of r) {
    if (!m.bye && !m.winner && !m.result && (m.a === classId || m.b === classId)) {
      const other = m.a === classId ? m.b : m.a;
      return { roundName: roundName(r.length), opponent: classInfo(other) };
    }
  }
  return t.championId === classId ? { champion: true } : null;
}

function playerState(p) {
  const ps = live.pstats[p.id];
  const inMatch = !!ps;
  const showQ = inMatch && ['question', 'reveal'].includes(live.phase);
  const revealed = ['reveal', 'finished'].includes(live.phase);
  const ans = live.answers[p.id];
  let rank = null;
  if (ps) rank = Object.values(live.pstats).filter((x) => x.score > ps.score).length + 1;
  return {
    now: Date.now(), phase: live.phase, inMatch, match: matchInfo(),
    me: { id: p.id, name: p.name, classId: p.classId, className: className(p.classId) },
    qIndex: live.qIndex, qCount: live.qCount, countdownEndsAt: live.countdownEndsAt, endsAt: live.qEndsAt, duration: live.qDuration,
    question: showQ ? questionView(p.classId, live.phase === 'reveal', false) : null,
    myAnswer: ans ? (revealed ? ans : { choice: ans.choice }) : null,
    stats: ps ? { score: ps.score, correct: ps.correct, streak: ps.streak, rank, total: Object.keys(live.pstats).length,
      lastPoints: revealed ? ps.lastPoints : null, lastCorrect: revealed ? ps.lastCorrect : null } : null,
    teamScores: revealed && live.phase !== 'idle' ? teamScores() : null,
    result: live.phase === 'finished' ? { winner: live.result.winner, tie: live.result.tie } : null,
    next: nextMatchFor(p.classId),
  };
}

function adminData() {
  return {
    classes: sortClasses([...db.classes]),
    tournaments: db.tournaments.map(tView),
    activeTournamentId: db.activeTournamentId,
    history: db.history.slice(0, 50),
    stats: {
      top: topPlayers(100), standings: standings(), hardest: hardestQuestions(10),
      totals: {
        classes: db.classes.length,
        questions: sum(db.classes, (c) => c.questions.length),
        matches: sum(db.tournaments, (t) => sum(t.rounds, (r) => r.filter((m) => m.result).length)),
        players: Object.keys(db.players).length,
        online: [...players.values()].filter((p) => p.connected).length,
      },
    },
    urls: lanUrls(),
  };
}

// ---------------------------------------------------------------- broadcast
let bTimer = null;
function broadcast() {
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = null;
    io.to('display').emit('state', publicState(false));
    io.to('admin').emit('state', publicState(true));
    for (const p of players.values()) if (p.connected && p.socketId) io.to(p.socketId).emit('me', playerState(p));
  }, 50);
}
function pushAdminData() { io.to('admin').emit('data', adminData()); }

// ---------------------------------------------------------------- sockets
const adminHandlers = {
  'class:create': (d) => { createClass(d); },
  'class:delete': ({ id }) => {
    if (live.phase !== 'idle' && live.teams.includes(id)) throw new Error('الفصل يلعب الآن');
    db.classes = db.classes.filter((c) => c.id !== id);
  },
  'class:saveQuestions': ({ id, questions }) => {
    const c = getClass(id);
    if (!c) throw new Error('الفصل غير موجود');
    c.questions = (Array.isArray(questions) ? questions : []).map(normalizeQuestion);
    if (c.cursor >= c.questions.length) c.cursor = 0;
  },
  'class:copyQuestions': ({ fromId, toIds }) => {
    const from = getClass(fromId);
    if (!from) throw new Error('الفصل غير موجود');
    let n = 0;
    for (const id of toIds || []) {
      const c = getClass(id);
      if (!c || c.id === from.id) continue;
      c.questions.push(...from.questions.map((q) => ({ ...q, wrong: [...q.wrong], id: uid() })));
      n++;
    }
    return { copied: n };
  },
  'tournament:create': (d) => ({ id: createTournament(d).id }),
  'tournament:delete': ({ id }) => {
    if (live.tournamentId === id && live.phase !== 'idle') throw new Error('هناك مباراة جارية في هذا الدوري');
    db.tournaments = db.tournaments.filter((t) => t.id !== id);
    if (db.activeTournamentId === id) db.activeTournamentId = db.tournaments[db.tournaments.length - 1]?.id || null;
  },
  'tournament:activate': ({ id }) => { if (!getT(id)) throw new Error('الدوري غير موجود'); db.activeTournamentId = id; },
  'match:open': (d) => openMatch(d),
  'match:start': () => { if (live.phase !== 'lobby') throw new Error('افتح مباراة أولاً'); startQuestion(0); },
  'match:reveal': () => { if (live.phase !== 'question') throw new Error('لا يوجد سؤال مفتوح'); reveal(); },
  'match:next': () => {
    if (live.phase !== 'reveal') throw new Error('أظهر الإجابة أولاً');
    if (live.qIndex + 1 < live.qCount) startQuestion(live.qIndex + 1); else finish();
  },
  'match:cancel': () => { clearTimeout(timer); live = idleLive(); },
  'match:close': () => { if (live.phase !== 'finished') throw new Error('المباراة لم تنتهِ'); live = idleLive(); },
  'match:setWinner': (d) => setWinner(d),
  'match:reset': (d) => resetMatch(d),
  'display:view': ({ view }) => { if (['auto', 'bracket', 'leaderboard', 'standings'].includes(view)) displayView = view; },
  'data:demo': () => {
    if (live.phase !== 'idle') throw new Error('أغلق المباراة الحالية أولاً');
    for (const c of demo.classes) {
      if (db.classes.some((x) => x.name === `${c.grade}/${c.section}`)) continue;
      const nc = createClass(c);
      nc.questions = c.questions.map((q, i) => normalizeQuestion(q, i));
    }
    if (!db.tournaments.length) {
      createTournament({ name: 'دوري المسابقات الثقافية', classIds: db.classes.map((c) => c.id), questionsPerMatch: 5, order: 'grade' });
    }
  },
  'stats:reset': () => { db.players = {}; db.questionStats = {}; db.history = []; },
  'data:reset': () => {
    if (live.phase !== 'idle') throw new Error('أغلق المباراة الحالية أولاً');
    db = emptyDb();
  },
};

io.on('connection', (socket) => {
  socket.emit('classes', classList());

  socket.on('display:join', () => { socket.join('display'); socket.emit('state', publicState(false)); });

  socket.on('admin:login', (d, ack) => {
    const { password, token } = d || {};
    const okToken = token && adminTokens.has(token);
    if (password !== ADMIN_PASSWORD && !okToken) return ack?.({ ok: false, error: 'كلمة المرور غير صحيحة' });
    const tk = okToken ? token : uid() + uid();
    adminTokens.add(tk);
    socket.data.admin = true;
    socket.join('admin');
    ack?.({ ok: true, token: tk });
    socket.emit('data', adminData());
    socket.emit('state', publicState(true));
  });

  socket.on('player:join', (d, ack) => {
    const name = clean(d?.name, 30);
    const c = getClass(d?.classId);
    if (!name) return ack?.({ ok: false, error: 'اكتب اسمك أو اسم فريقك' });
    if (!c) return ack?.({ ok: false, error: 'اختر فصلك' });
    let p = players.get(d?.playerId);
    if (!p) { p = { id: uid() + uid() }; players.set(p.id, p); }
    if (p.socketId && p.socketId !== socket.id) io.sockets.sockets.get(p.socketId)?.emit('kicked');
    Object.assign(p, { name, classId: c.id, socketId: socket.id, connected: true });
    socket.data.playerId = p.id;
    ensureParticipant(p);
    ack?.({ ok: true, id: p.id, name: p.name, classId: p.classId });
    pushAdminData();
    broadcast();
  });

  socket.on('player:answer', (d) => {
    const p = players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) answer(p, d?.choice);
  });

  socket.on('player:leave', () => {
    const p = players.get(socket.data.playerId);
    if (!p) return;
    if (live.pstats[p.id] && live.phase === 'lobby') delete live.pstats[p.id];
    players.delete(p.id);
    socket.data.playerId = null;
    broadcast();
  });

  socket.on('disconnect', () => {
    const p = players.get(socket.data.playerId);
    if (p && p.socketId === socket.id) { p.connected = false; broadcast(); }
  });

  for (const [ev, fn] of Object.entries(adminHandlers)) {
    socket.on(ev, (d, ack) => {
      if (!socket.data.admin) return ack?.({ ok: false, error: 'غير مصرح' });
      try {
        const r = fn(d || {});
        save();
        ack?.({ ok: true, ...(r || {}) });
        pushAdminData();
        io.emit('classes', classList());
        broadcast();
      } catch (e) {
        ack?.({ ok: false, error: e.message });
      }
    });
  }
});

server.listen(PORT, () => {
  console.log(`School Quiz League running on http://localhost:${PORT}`);
  for (const u of lanUrls()) console.log(`  LAN: ${u}`);
  if (!process.env.ADMIN_PASSWORD) console.log('  Admin password: admin123 (set ADMIN_PASSWORD to change)');
});
