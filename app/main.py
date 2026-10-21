import asyncio
import io
import json
import math
import os
import random
import re
import secrets
import socket as pysocket
import time
from contextlib import asynccontextmanager
from pathlib import Path

import qrcode
import qrcode.image.svg
import socketio
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
PORT = int(os.environ.get("PORT", "8000"))
DEFAULT_DATA = Path("/data/db.json") if Path("/data").is_dir() else ROOT / "data" / "db.json"
DATA_FILE = Path(os.environ.get("DATA_FILE", str(DEFAULT_DATA)))
COUNTDOWN_MS = 3000


def initial_password():
    if os.environ.get("ADMIN_PASSWORD"):
        return os.environ["ADMIN_PASSWORD"]
    f = Path(__file__).parent / "admin_password.txt"
    if f.exists() and f.read_text().strip():
        return f.read_text().strip()
    return "admin123"


class Err(Exception):
    pass


def now_ms():
    return int(time.time() * 1000)


def uid():
    return secrets.token_hex(5)


def jround(x):
    return int(math.floor(x + 0.5))


def clean(s, mx=300):
    return ("" if s is None else str(s)).strip()[:mx]


def clamp(n, lo, hi, default):
    try:
        n = float(n)
    except (TypeError, ValueError):
        return default
    if not math.isfinite(n):
        return default
    return min(hi, max(lo, jround(n)))


def natkey(s):
    return [(0, int(p), "") if p.isdigit() else (1, 0, p) for p in re.split(r"(\d+)", str(s)) if p]


# ---------------------------------------------------------------- persistence
def empty_db():
    return {"classes": [], "tournaments": [], "activeTournamentId": None, "players": {}, "questionStats": {}, "history": [], "adminPassword": None}


def load_db():
    d = empty_db()
    try:
        d.update(json.loads(DATA_FILE.read_text(encoding="utf-8")))
    except Exception:
        pass
    return d


db = load_db()
save_handle = None


def flush():
    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(db, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, DATA_FILE)


def save():
    global save_handle
    if save_handle:
        save_handle.cancel()
    save_handle = asyncio.get_event_loop().call_later(0.25, flush)


def admin_password():
    return db.get("adminPassword") or initial_password()


def get_class(cid):
    return next((c for c in db["classes"] if c["id"] == cid), None)


def get_t(tid):
    return next((t for t in db["tournaments"] if t["id"] == tid), None)


def class_name(cid):
    c = get_class(cid)
    return c["name"] if c else "—"


def class_info(cid):
    c = get_class(cid)
    return {"id": c["id"], "name": c["name"], "grade": c["grade"]} if c else None


def sort_classes(lst):
    return sorted(lst, key=lambda c: (c["grade"], natkey(c["section"])))


def class_list():
    return [{"id": c["id"], "name": c["name"], "grade": c["grade"]} for c in sort_classes(db["classes"])]


# ---------------------------------------------------------------- classes & questions
def create_class(d):
    grade = clamp(d.get("grade"), 1, 12, None)
    section = clean(d.get("section"), 10)
    if not grade or not section:
        raise Err("أدخل الصف ورقم الفصل")
    name = f"{grade}/{section}"
    if any(c["name"] == name for c in db["classes"]):
        raise Err(f"الفصل {name} موجود مسبقاً")
    c = {"id": uid(), "grade": grade, "section": section, "name": name, "questions": [], "cursor": 0}
    db["classes"].append(c)
    return c


def normalize_question(q, i):
    q = q if isinstance(q, dict) else {}
    text = clean(q.get("text"), 500)
    correct = clean(q.get("correct"), 200)
    wrong = [clean(w, 200) for w in (q.get("wrong") if isinstance(q.get("wrong"), list) else [])]
    wrong = [w for w in wrong if w][:5]
    if not text:
        raise Err(f"السؤال رقم {i + 1}: نص السؤال فارغ")
    if not correct:
        raise Err(f"السؤال رقم {i + 1}: الإجابة الصحيحة فارغة")
    if not wrong:
        raise Err(f"السؤال رقم {i + 1}: أضف خياراً خاطئاً واحداً على الأقل")
    return {"id": clean(q.get("id"), 20) or uid(), "text": text, "correct": correct, "wrong": wrong, "time": clamp(q.get("time"), 5, 120, 20)}


# ---------------------------------------------------------------- tournaments
def round_name(count):
    return {1: "النهائي", 2: "نصف النهائي", 4: "ربع النهائي", 8: "دور الـ16", 16: "دور الـ32"}.get(count, f"دور الـ{count * 2}")


def mk_match(a, b, bye=False):
    return {"id": uid(), "a": a, "b": b, "bye": bye, "winner": None, "result": None}


def create_tournament(d):
    if live["phase"] != "idle" or any(game["phase"] != "idle" for game in class_games.values()):
        raise Err("أغلق المسابقات الجارية قبل إنشاء مسابقة جديدة")
    ids = d.get("classIds") if isinstance(d.get("classIds"), list) else []
    teams = [c for c in (get_class(i) for i in ids) if c]
    if d.get("type") == "independent":
        teams = sort_classes(teams)
        if not teams:
            raise Err("اختر فصلاً واحداً على الأقل")
        if any(not c["questions"] for c in teams):
            raise Err("أضف الأسئلة لكل فصل مشارك أولاً")
        t = {"id": uid(), "name": clean(d.get("name"), 80) or "مسابقات الفصول", "type": "independent",
             "classIds": [c["id"] for c in teams], "results": {}, "createdAt": now_ms()}
        db["tournaments"].append(t)
        db["activeTournamentId"] = t["id"]
        return t
    if len(teams) < 2:
        raise Err("اختر فصلين على الأقل")
    if d.get("order") == "random":
        random.shuffle(teams)
    else:
        teams = sort_classes(teams)
    n = len(teams)
    size = 1
    while size < n:
        size *= 2
    byes = size - n
    slots = size // 2
    bye_at = {(k * slots) // byes for k in range(byes)} if byes else set()
    r0, i = [], 0
    for s in range(slots):
        if s in bye_at:
            r0.append(mk_match(teams[i]["id"], None, True))
            i += 1
        else:
            r0.append(mk_match(teams[i]["id"], teams[i + 1]["id"]))
            i += 2
    rounds = [r0]
    cnt = len(r0)
    while cnt > 1:
        cnt //= 2
        rounds.append([mk_match(None, None) for _ in range(cnt)])
    t = {"id": uid(), "name": clean(d.get("name"), 80) or "دوري المسابقات", "questionsPerMatch": clamp(d.get("questionsPerMatch"), 1, 50, 5),
         "rounds": rounds, "createdAt": now_ms(), "championId": None}
    recompute(t)
    db["tournaments"].append(t)
    db["activeTournamentId"] = t["id"]
    return t


def recompute(t):
    for m in t["rounds"][0]:
        if m["bye"]:
            m["winner"] = m["a"]
    for r in range(1, len(t["rounds"])):
        for i, m in enumerate(t["rounds"][r]):
            a = t["rounds"][r - 1][2 * i]["winner"]
            b = t["rounds"][r - 1][2 * i + 1]["winner"]
            if m["a"] != a or m["b"] != b:
                m.update(a=a, b=b, winner=None, result=None)
    t["championId"] = t["rounds"][-1][0]["winner"]


def find_match(t, mid):
    for r in t["rounds"]:
        for m in r:
            if m["id"] == mid:
                return m, round_name(len(r))
    return None


def match_status(m):
    if m["bye"]:
        return "bye"
    if m["winner"]:
        return "done"
    if m["result"]:
        return "tie"
    if live["matchId"] == m["id"] and live["phase"] != "idle":
        return "live"
    return "ready" if m["a"] and m["b"] else "pending"


def t_view(t):
    if not t:
        return None
    if t.get("type") == "independent":
        results = t.get("results") or {}
        classes = []
        for cid in t.get("classIds", []):
            c = get_class(cid)
            if c:
                classes.append({"class": class_info(cid), "questionCount": len(c["questions"]), "result": results.get(cid)})
        classes.sort(key=lambda x: (
            x["result"] is None,
            -(x["result"] or {}).get("avg", 0),
            -(x["result"] or {}).get("accuracy", 0),
            (x["result"] or {}).get("avgFinishMs") or float("inf"),
            (x["result"] or {}).get("avgMs") or float("inf"),
            natkey(x["class"]["name"]),
        ))
        return {"id": t["id"], "name": t["name"], "type": "independent", "createdAt": t["createdAt"], "classes": classes}

    def mv(m):
        sc = None
        if m["result"]:
            s = m["result"]["scores"]
            sc = [(s.get(m["a"]) or {}).get("avg", 0), (s.get(m["b"]) or {}).get("avg", 0)]
        return {"id": m["id"], "bye": m["bye"], "winner": m["winner"], "status": match_status(m), "a": class_info(m["a"]), "b": class_info(m["b"]), "scores": sc}

    return {"id": t["id"], "name": t["name"], "questionsPerMatch": t["questionsPerMatch"], "createdAt": t["createdAt"],
            "champion": class_info(t["championId"]),
            "rounds": [{"name": round_name(len(r)), "matches": [mv(m) for m in r]} for r in t["rounds"]]}


# ---------------------------------------------------------------- live game
players = {}
admin_tokens = set()
sessions = {}
display_view = "auto"
timer_handles = {}
class_games = {}


def idle_live():
    return {"phase": "idle", "mode": "league", "tournamentId": None, "matchId": None, "roundName": "", "teams": [], "sets": {},
            "qIndex": -1, "qCount": 0, "countdownEndsAt": 0, "qStartedAt": 0, "qEndsAt": 0, "qDuration": 0,
            "answers": {}, "pstats": {}, "result": None}


live = idle_live()


def set_timer(sec, fn, key=None):
    clear_timer(key)
    state = live
    timer_key = (id(state), key)

    def run():
        global live
        timer_handles.pop(timer_key, None)
        previous = live
        live = state
        try:
            fn()
        finally:
            live = previous

    timer_handles[timer_key] = asyncio.get_event_loop().call_later(sec, run)


def clear_timer(key=None):
    handle = timer_handles.pop((id(live), key), None)
    if handle:
        handle.cancel()


def clear_game_timers(state):
    state_id = id(state)
    for timer_key, handle in list(timer_handles.items()):
        if timer_key[0] == state_id:
            handle.cancel()
            timer_handles.pop(timer_key, None)


def prep_question(q):
    opts = [{"t": q["correct"], "c": True}] + [{"t": w, "c": False} for w in q["wrong"]]
    random.shuffle(opts)
    return {"id": q["id"], "text": q["text"], "time": q["time"], "options": [o["t"] for o in opts], "correctIndex": next(i for i, o in enumerate(opts) if o["c"])}


def pick_questions(c, n):
    start = c.get("cursor") or 0
    return [prep_question(c["questions"][(start + i) % len(c["questions"])]) for i in range(n)]


def ensure_participant(p):
    if live["phase"] == "idle":
        return
    ex = live["pstats"].get(p["id"])
    if ex and ex["classId"] != p["classId"]:
        del live["pstats"][p["id"]]
    if p["classId"] not in live["teams"]:
        return
    if p["id"] not in live["pstats"]:
        live["pstats"][p["id"]] = {"id": p["id"], "name": p["name"], "classId": p["classId"], "score": 0, "correct": 0, "answered": 0,
                                   "streak": 0, "totalMs": 0, "lastPoints": 0, "lastCorrect": None,
                                   "qIndex": -1, "playerPhase": "lobby", "startedAt": None, "qStartedAt": 0,
                                   "qEndsAt": 0, "qDuration": 0, "completedAt": None, "lastAnswer": None}
    else:
        live["pstats"][p["id"]]["name"] = p["name"]


def ensure_player_participant(p):
    global live
    game = class_games.get(p["classId"])
    if game and game["phase"] != "idle":
        previous = live
        live = game
        try:
            existing = p["id"] in live["pstats"]
            if live["phase"] == "lobby" or existing:
                ensure_participant(p)
            class_games[p["classId"]] = live
        finally:
            live = previous
        return
    ensure_participant(p)


def participants_of(cid):
    return [p for p in live["pstats"].values() if p["classId"] == cid]


def is_connected(pid):
    p = players.get(pid)
    return bool(p and p.get("connected"))


def open_match(d):
    global live
    if live["phase"] not in ("idle", "finished"):
        raise Err("هناك مباراة جارية حالياً")
    t = get_t(d.get("tournamentId"))
    f = t and find_match(t, d.get("matchId"))
    if not f:
        raise Err("المباراة غير موجودة")
    m, rname = f
    if m["bye"] or not m["a"] or not m["b"]:
        raise Err("المباراة غير جاهزة بعد")
    if m["winner"] or m["result"]:
        raise Err("المباراة انتهت — أعد تعيينها أولاً")
    ca, cb = get_class(m["a"]), get_class(m["b"])
    if not ca or not cb:
        raise Err("أحد الفصول محذوف")
    if any(game["phase"] != "idle" for game in class_games.values()):
        raise Err("أغلق مسابقات الفصول المنفصلة قبل بدء مباراة الدوري")
    for c in (ca, cb):
        if not c["questions"]:
            raise Err(f"لا توجد أسئلة للفصل {c['name']}")
    n = min(t["questionsPerMatch"], len(ca["questions"]), len(cb["questions"]))
    clear_timer()
    live = idle_live()
    live.update(phase="lobby", tournamentId=t["id"], matchId=m["id"], roundName=rname, teams=[m["a"], m["b"]], qCount=n,
                sets={m["a"]: pick_questions(ca, n), m["b"]: pick_questions(cb, n)})
    db["activeTournamentId"] = t["id"]
    for p in players.values():
        ensure_participant(p)


def open_independent_class(d):
    global live
    if live["phase"] not in ("idle", "finished"):
        raise Err("هناك مسابقة جارية حالياً")
    t = get_t(d.get("tournamentId"))
    cid = d.get("classId")
    if not t or t.get("type") != "independent" or cid not in t.get("classIds", []):
        raise Err("مسابقة الفصل غير موجودة")
    c = get_class(cid)
    if not c or not c["questions"]:
        raise Err("لا توجد أسئلة لهذا الفصل")
    if live["phase"] != "idle":
        raise Err("أغلق مباراة الدوري قبل بدء مسابقات الفصول")
    if cid in (t.get("results") or {}):
        raise Err("اكتملت مسابقة هذا الفصل — أعد تعيين نتيجته أولاً")
    clear_timer()
    live = idle_live()
    live.update(mode="independent", phase="lobby", tournamentId=t["id"], matchId=f"{t['id']}:{cid}",
                roundName=f"مسابقة الفصل {c['name']}", teams=[cid], qCount=len(c["questions"]),
                sets={cid: [prep_question(q) for q in c["questions"]]})
    db["activeTournamentId"] = t["id"]
    for p in players.values():
        ensure_participant(p)
    class_games[cid] = live


def reset_independent_result(d):
    t = get_t(d.get("tournamentId"))
    cid = d.get("classId")
    if not t or t.get("type") != "independent" or cid not in t.get("classIds", []):
        raise Err("مسابقة الفصل غير موجودة")
    game = class_games.get(cid)
    if game and game["tournamentId"] == t["id"] and game["phase"] != "idle":
        raise Err("أغلق المسابقة الحالية أولاً")
    results = t.setdefault("results", {})
    if cid not in results:
        raise Err("لا توجد نتيجة محفوظة لهذا الفصل")
    del results[cid]


def start_question(i):
    live["qIndex"] = i
    live["answers"] = {}
    live["phase"] = "countdown"
    live["countdownEndsAt"] = now_ms() + COUNTDOWN_MS
    live["qDuration"] = max(live["sets"][c][i]["time"] for c in live["teams"]) * 1000

    def go():
        live["phase"] = "question"
        live["qStartedAt"] = now_ms()
        live["qEndsAt"] = live["qStartedAt"] + live["qDuration"]
        set_timer((live["qDuration"] + 400) / 1000, reveal)
        broadcast()

    set_timer(COUNTDOWN_MS / 1000, go)


def start_independent_competition():
    if live["phase"] != "lobby":
        raise Err("افتح مسابقة الفصل أولاً")
    cid = live["teams"][0]
    active = [p for p in participants_of(cid) if is_connected(p["id"])]
    if not active:
        raise Err("يجب أن ينضم طالب واحد على الأقل من الفصل قبل البدء")
    active_ids = {p["id"] for p in active}
    live["pstats"] = {pid: ps for pid, ps in live["pstats"].items() if pid in active_ids}
    now = now_ms()
    for ps in active:
        ps.update(qIndex=0, playerPhase="question", startedAt=now, qStartedAt=now,
                  qDuration=live["sets"][cid][0]["time"] * 1000,
                  qEndsAt=now + live["sets"][cid][0]["time"] * 1000, completedAt=None)
        set_timer(ps["qDuration"] / 1000, lambda pid=ps["id"]: advance_independent_player(pid), ps["id"])
    live.update(phase="question", qIndex=0, qStartedAt=now,
                qDuration=max(live["sets"][cid][0]["time"] * 1000, 1),
                qEndsAt=now + live["sets"][cid][0]["time"] * 1000)


def independent_team_score(cid):
    ps = participants_of(cid)
    questions = live["qCount"]
    possible = len(ps) * questions
    answered = sum(p["answered"] for p in ps)
    total = sum(p["score"] for p in ps)
    correct = sum(p["correct"] for p in ps)
    durations = [p["completedAt"] - p["startedAt"] for p in ps if p["completedAt"] is not None and p["startedAt"] is not None]
    return {
        "players": len(ps), "connected": sum(1 for p in ps if is_connected(p["id"])),
        "total": total, "correct": correct,
        "avg": round(total / possible, 2) if possible else 0,
        "accuracy": jround(100 * correct / possible) if possible else 0,
        "avgMs": jround(sum(p["totalMs"] for p in ps) / answered) if answered else None,
        "avgFinishMs": jround(sum(durations) / len(durations)) if durations else None,
        "finished": sum(1 for p in ps if p["playerPhase"] == "finished"),
    }


def finish_independent_competition():
    if live["phase"] != "question" or not live["pstats"]:
        return
    if any(ps["playerPhase"] != "finished" for ps in live["pstats"].values()):
        return
    clear_game_timers(live)
    cid = live["teams"][0]
    score = independent_team_score(cid)
    top = sorted(live["pstats"].values(), key=lambda p: (-p["score"], p["completedAt"] - p["startedAt"]))
    leaderboard = [{"id": p["id"], "name": p["name"], "classId": p["classId"],
                    "className": class_name(p["classId"]), "score": p["score"],
                    "correct": p["correct"], "streak": p["streak"],
                    "completionMs": p["completedAt"] - p["startedAt"]} for p in top[:10]]
    result = {**score, "qCount": live["qCount"], "date": now_ms(), "top": leaderboard}
    tournament = get_t(live["tournamentId"])
    if tournament:
        tournament.setdefault("results", {})[cid] = result
    live["qIndex"] = live["qCount"] - 1
    live["phase"] = "finished"
    live["result"] = {"scores": {cid: score}, "winner": None, "tie": False,
                      "top": leaderboard, "qCount": live["qCount"], "date": result["date"],
                      "mode": "independent"}
    db["history"].insert(0, {"id": uid(), "tournament": tournament["name"] if tournament else "",
                             "roundName": live["roundName"], "date": result["date"],
                             "teams": [class_name(cid)], "scores": [score["avg"]],
                             "winner": None, "type": "independent"})
    db["history"] = db["history"][:200]
    save()
    push_admin_data()


def advance_independent_player(player_id, choice=None):
    ps = live["pstats"].get(player_id)
    if live["mode"] != "independent" or live["phase"] != "question" or not ps or ps["playerPhase"] != "question":
        return
    cid = ps["classId"]
    q_index = ps["qIndex"]
    q = live["sets"][cid][q_index]
    now = now_ms()
    elapsed = max(0, min(now - ps["qStartedAt"], ps["qDuration"]))
    correct = choice == q["correctIndex"] if choice is not None else False
    if correct:
        ps["streak"] += 1
        ps["correct"] += 1
        points = round(5 * (1 - elapsed / ps["qDuration"]), 2)
    else:
        ps["streak"] = 0
        points = 0
    ps["score"] += points
    ps["answered"] += 1
    ps["totalMs"] += elapsed
    ps["lastPoints"] = points
    ps["lastCorrect"] = correct
    ps["lastAnswer"] = {"correct": correct, "points": points, "timedOut": choice is None}
    st = db["questionStats"].setdefault(q["id"], {"text": q["text"], "classId": cid, "asked": 0, "correct": 0})
    st["text"] = q["text"]
    st["asked"] += 1
    st["correct"] += int(correct)
    clear_timer(player_id)
    next_index = q_index + 1
    if next_index >= live["qCount"]:
        ps["playerPhase"] = "finished"
        ps["completedAt"] = now
        finish_independent_competition()
    else:
        ps["qIndex"] = next_index
        ps["qStartedAt"] = now
        ps["qDuration"] = live["sets"][cid][next_index]["time"] * 1000
        ps["qEndsAt"] = now + ps["qDuration"]
        set_timer(ps["qDuration"] / 1000,
                  lambda pid=player_id: advance_independent_player(pid), player_id)
    broadcast()


def answer(p, choice):
    if live["phase"] != "question":
        return
    ps = live["pstats"].get(p["id"])
    if not ps:
        return
    if live["mode"] == "independent":
        if ps["playerPhase"] != "question":
            return
        q = live["sets"][p["classId"]][ps["qIndex"]]
        if not isinstance(choice, int) or isinstance(choice, bool) or choice < 0 or choice >= len(q["options"]):
            return
        if now_ms() > ps["qEndsAt"] + 500:
            return
        advance_independent_player(p["id"], choice)
        return
    if p["id"] in live["answers"]:
        return
    now = now_ms()
    if now > live["qEndsAt"] + 500:
        return
    q = live["sets"][p["classId"]][live["qIndex"]]
    if not isinstance(choice, int) or isinstance(choice, bool) or choice < 0 or choice >= len(q["options"]):
        return
    ms = max(0, now - live["qStartedAt"])
    correct = choice == q["correctIndex"]
    points = 0
    if correct:
        ps["streak"] += 1
        ps["correct"] += 1
        if live["mode"] == "independent":
            points = round(5 * (1 - min(ms, live["qDuration"]) / live["qDuration"]), 2)
        else:
            points = jround(1000 * (1 - min(ms, live["qDuration"]) / live["qDuration"] / 2)) + min(ps["streak"] - 1, 3) * 100
    else:
        ps["streak"] = 0
    ps["score"] += points
    ps["answered"] += 1
    ps["totalMs"] += ms
    ps["lastPoints"] = points
    ps["lastCorrect"] = correct
    live["answers"][p["id"]] = {"choice": choice, "correct": correct, "ms": ms, "points": points}
    waiting = any(is_connected(x["id"]) and x["id"] not in live["answers"] for x in live["pstats"].values())
    if not waiting:
        set_timer(0.7, reveal)
    broadcast()


def reveal():
    if live["phase"] != "question":
        return
    clear_timer()
    live["phase"] = "reveal"
    for ps in live["pstats"].values():
        if ps["id"] not in live["answers"]:
            ps.update(streak=0, lastPoints=0, lastCorrect=None)
    for cid in live["teams"]:
        q = live["sets"][cid][live["qIndex"]]
        ps = participants_of(cid)
        st = db["questionStats"].setdefault(q["id"], {"text": q["text"], "classId": cid, "asked": 0, "correct": 0})
        st["text"] = q["text"]
        st["asked"] += len(ps)
        st["correct"] += sum(1 for p in ps if (live["answers"].get(p["id"]) or {}).get("correct"))
    save()
    broadcast()


def team_scores():
    res = {}
    for cid in live["teams"]:
        if live["mode"] == "independent":
            res[cid] = independent_team_score(cid)
            continue
        ps = participants_of(cid)
        total = sum(p["score"] for p in ps)
        correct = sum(p["correct"] for p in ps)
        answered = sum(p["answered"] for p in ps)
        asked = live["qIndex"] if live["phase"] in ("lobby", "countdown") else live["qIndex"] + 1
        average = total / len(ps) if ps else 0
        if live["mode"] == "independent" and ps and asked > 0:
            average /= asked
        res[cid] = {"players": len(ps), "connected": sum(1 for p in ps if is_connected(p["id"])), "total": total, "correct": correct,
                    "avg": round(average, 2) if live["mode"] == "independent" else jround(average),
                    "accuracy": jround(100 * correct / (len(ps) * asked)) if ps and asked > 0 else 0,
                    "avgMs": jround(sum(p["totalMs"] for p in ps) / answered) if answered else None}
    return res


def match_leaderboard(limit=10):
    lst = sorted(live["pstats"].values(), key=lambda p: (-p["score"], p["totalMs"]))[:limit]
    return [{"id": p["id"], "name": p["name"], "classId": p["classId"], "className": class_name(p["classId"]), "score": p["score"],
             "correct": p["correct"], "streak": p["streak"]} for p in lst]


def finish():
    clear_timer()
    t = get_t(live["tournamentId"])
    f = t and live["mode"] != "independent" and find_match(t, live["matchId"])
    live["qIndex"] = live["qCount"] - 1
    live["phase"] = "finished"
    scores = team_scores()
    if live["mode"] == "independent":
        cid = live["teams"][0]
        result = scores[cid]
        tournament = get_t(live["tournamentId"])
        if tournament:
            tournament.setdefault("results", {})[cid] = {
                "avg": result["avg"], "total": result["total"], "correct": result["correct"],
                "accuracy": result["accuracy"], "avgMs": result["avgMs"], "players": result["players"],
                "qCount": live["qCount"], "date": now_ms(), "top": match_leaderboard(10),
            }
        live["result"] = {"scores": scores, "winner": None, "tie": False, "top": match_leaderboard(10),
                          "qCount": live["qCount"], "date": now_ms(), "mode": "independent"}
        a = cid
        A = result
        B = None
        f = None
        t = tournament
    else:
        a, b = live["teams"]
        A, B = scores[a], scores[b]
        cmp = (A["avg"] - B["avg"]) or (A["accuracy"] - B["accuracy"]) or ((B["avgMs"] if B["avgMs"] is not None else 1e12) - (A["avgMs"] if A["avgMs"] is not None else 1e12))
        if not A["players"] and not B["players"]:
            cmp = 0
        winner = a if cmp > 0 else b if cmp < 0 else None
        live["result"] = {"scores": scores, "winner": winner, "tie": not winner, "top": match_leaderboard(10), "qCount": live["qCount"], "date": now_ms()}
    if live["mode"] != "independent":
        for ps in live["pstats"].values():
            key = f"{ps['classId']}:{ps['name'].strip().lower()}"
            s = db["players"].setdefault(key, {"name": ps["name"], "classId": ps["classId"], "score": 0, "correct": 0, "questions": 0, "matches": 0})
            s["name"] = ps["name"]
            s["score"] += ps["score"]
            s["correct"] += ps["correct"]
            s["questions"] += live["qCount"]
            s["matches"] += 1
    if live["mode"] == "independent":
        db["history"].insert(0, {"id": uid(), "tournament": t["name"] if t else "", "roundName": live["roundName"], "date": now_ms(),
                                 "teams": [class_name(a)], "scores": [A["avg"]], "winner": None, "type": "independent"})
    else:
        for cid in live["teams"]:
            c = get_class(cid)
            if c and c["questions"]:
                c["cursor"] = ((c.get("cursor") or 0) + live["qCount"]) % len(c["questions"])
        if f:
            f[0]["result"] = live["result"]
            f[0]["winner"] = winner
            recompute(t)
        db["history"].insert(0, {"id": uid(), "tournament": t["name"] if t else "", "roundName": live["roundName"], "date": now_ms(),
                                 "teams": [class_name(a), class_name(b)], "scores": [A["avg"], B["avg"]], "winner": class_name(winner) if winner else None})
    db["history"] = db["history"][:200]
    save()


def set_winner(d):
    t = get_t(d.get("tournamentId"))
    f = t and find_match(t, d.get("matchId"))
    if not f:
        raise Err("المباراة غير موجودة")
    m, rname = f
    if live["matchId"] == m["id"] and live["phase"] not in ("idle", "finished"):
        raise Err("المباراة جارية حالياً")
    w = d.get("winner")
    if not w or w not in (m["a"], m["b"]):
        raise Err("الفائز يجب أن يكون أحد طرفي المباراة")
    m["winner"] = w
    if live["matchId"] == m["id"] and live["result"]:
        live["result"]["winner"] = w
        live["result"]["tie"] = False
    h = next((x for x in db["history"] if x["roundName"] == rname and class_name(w) in x["teams"] and not x["winner"]), None)
    if h:
        h["winner"] = class_name(w)
    recompute(t)


def reset_match(d):
    t = get_t(d.get("tournamentId"))
    f = t and find_match(t, d.get("matchId"))
    if not f:
        raise Err("المباراة غير موجودة")
    if live["matchId"] == f[0]["id"] and live["phase"] != "idle":
        raise Err("أغلق المباراة الحالية أولاً")
    f[0]["winner"] = None
    f[0]["result"] = None
    recompute(t)


# ---------------------------------------------------------------- views
def standings():
    mp = {c["id"]: {"id": c["id"], "name": c["name"], "grade": c["grade"], "played": 0, "wins": 0, "losses": 0, "points": 0, "correct": 0, "accuracySum": 0}
          for c in db["classes"]}
    for t in db["tournaments"]:
        if t.get("type") == "independent":
            continue
        for r in t["rounds"]:
            for m in r:
                if not m["result"]:
                    continue
                for cid in (m["a"], m["b"]):
                    st, s = mp.get(cid), m["result"]["scores"].get(cid)
                    if not st or not s:
                        continue
                    st["played"] += 1
                    st["points"] += s["avg"]
                    st["correct"] += s["correct"]
                    st["accuracySum"] += s["accuracy"]
                    if m["winner"] == cid:
                        st["wins"] += 1
                    elif m["winner"]:
                        st["losses"] += 1
    out = [{**s, "accuracy": jround(s["accuracySum"] / s["played"]) if s["played"] else 0} for s in mp.values()]
    return sorted(out, key=lambda s: (-s["wins"], -s["points"], s["grade"]))


def top_players(limit=10):
    lst = sorted(db["players"].values(), key=lambda p: -p["score"])[:limit]
    return [{**p, "className": class_name(p["classId"]), "accuracy": jround(100 * p["correct"] / p["questions"]) if p["questions"] else 0} for p in lst]


def hardest_questions(limit=10):
    lst = [{"id": k, **s, "className": class_name(s["classId"]), "accuracy": jround(100 * s["correct"] / s["asked"])}
           for k, s in db["questionStats"].items() if s["asked"] > 0]
    return sorted(lst, key=lambda s: (s["accuracy"], -s["asked"]))[:limit]


def match_info():
    if not live["matchId"]:
        return None
    t = get_t(live["tournamentId"])
    return {"id": live["matchId"], "tournamentId": live["tournamentId"], "tournament": t["name"] if t else "", "roundName": live["roundName"], "type": live["mode"],
            "teams": [class_info(c) for c in live["teams"]]}


def question_view(cid, with_answer, with_dist, q_index=None):
    qs = live["sets"].get(cid) or []
    q_index = live["qIndex"] if q_index is None else q_index
    if not 0 <= q_index < len(qs):
        return None
    q = qs[q_index]
    v = {"text": q["text"], "options": q["options"], "time": q["time"]}
    if with_answer:
        v["correctIndex"] = q["correctIndex"]
    if with_dist:
        v["dist"] = [0] * len(q["options"])
        for p in participants_of(cid):
            a = live["answers"].get(p["id"])
            if a:
                v["dist"][a["choice"]] += 1
    return v


def _public_state_current(for_admin):
    t = get_t(db["activeTournamentId"])
    s = {"now": now_ms(), "phase": live["phase"], "view": display_view, "match": match_info(), "qIndex": live["qIndex"], "qCount": live["qCount"],
         "countdownEndsAt": live["countdownEndsAt"], "endsAt": live["qEndsAt"], "duration": live["qDuration"],
         "tournament": t_view(t), "overall": {"top": top_players(10), "standings": standings()}}
    if live["phase"] != "idle":
        s["participants"], s["answered"] = {}, {}
        for cid in live["teams"]:
            ps = participants_of(cid)
            s["participants"][cid] = [{"name": p["name"], "connected": is_connected(p["id"]), "answered": p["id"] in live["answers"]} for p in ps]
            s["answered"][cid] = sum(1 for p in ps if p["id"] in live["answers"])
        s["teamScores"] = team_scores()
        if live["phase"] in ("question", "reveal") or (for_admin and live["phase"] == "countdown"):
            s["questions"] = {cid: question_view(cid, for_admin or live["phase"] == "reveal", live["phase"] == "reveal" or for_admin) for cid in live["teams"]}
        if live["phase"] in ("reveal", "finished") or for_admin:
            s["leaderboard"] = match_leaderboard(10)
        if live["phase"] == "finished":
            s["result"] = live["result"]
    return s


def public_state(for_admin):
    global live
    previous = live
    state = _public_state_current(for_admin)
    games = []
    try:
        for cid, game in list(class_games.items()):
            live = game
            c = class_info(cid)
            participants = participants_of(cid)
            scores = team_scores()
            games.append({
                "classId": cid, "phase": game["phase"], "match": match_info(),
                "qCount": game["qCount"], "qIndex": max((ps["qIndex"] for ps in participants), default=-1),
                "teamScores": scores,
                "participants": {cid: [{"name": ps["name"], "connected": is_connected(ps["id"]),
                                        "answered": ps["playerPhase"] == "finished",
                                        "qIndex": ps["qIndex"], "playerPhase": ps["playerPhase"]}
                                       for ps in participants]},
                "answered": {cid: sum(1 for ps in participants if ps["playerPhase"] == "finished")},
                "result": game["result"], "class": c,
            })
    finally:
        live = previous
    state["classGames"] = games
    return state


def next_match_for(cid):
    t = get_t(db["activeTournamentId"])
    if not t:
        return None
    if t.get("type") == "independent":
        return None
    for r in t["rounds"]:
        for m in r:
            if not m["bye"] and not m["winner"] and not m["result"] and cid in (m["a"], m["b"]):
                return {"roundName": round_name(len(r)), "opponent": class_info(m["b"] if m["a"] == cid else m["a"])}
    return {"champion": True} if t["championId"] == cid else None


def _player_state_current(p):
    ps = live["pstats"].get(p["id"])
    independent = live["mode"] == "independent"
    player_phase = ps["playerPhase"] if independent and ps else live["phase"]
    phase = "finished" if independent and live["phase"] == "finished" else "playerFinished" if independent and ps and player_phase == "finished" else player_phase
    q_index = ps["qIndex"] if independent and ps else live["qIndex"]
    show_q = bool(ps) and (player_phase == "question" if independent else live["phase"] in ("question", "reveal"))
    revealed = live["phase"] in ("reveal", "finished")
    ans = live["answers"].get(p["id"])
    rank = sum(1 for x in live["pstats"].values() if x["score"] > ps["score"]) + 1 if ps else None
    return {"now": now_ms(), "phase": phase, "inMatch": bool(ps), "match": match_info(),
            "me": {"id": p["id"], "name": p["name"], "classId": p["classId"], "className": class_name(p["classId"])},
            "qIndex": q_index, "qCount": live["qCount"], "countdownEndsAt": live["countdownEndsAt"],
            "endsAt": ps["qEndsAt"] if independent and ps else live["qEndsAt"],
            "duration": ps["qDuration"] if independent and ps else live["qDuration"],
            "question": question_view(p["classId"], live["phase"] == "reveal", False, q_index) if show_q else None,
            "myAnswer": (ans if revealed else {"choice": ans["choice"]}) if ans else None,
            "lastAnswer": ps["lastAnswer"] if independent and ps else None,
            "stats": {"score": ps["score"], "correct": ps["correct"], "streak": ps["streak"], "rank": rank, "total": len(live["pstats"]),
                      "lastPoints": ps["lastPoints"] if independent or revealed else None,
                      "lastCorrect": ps["lastCorrect"] if independent or revealed else None} if ps else None,
            "teamScores": team_scores() if (revealed or independent) else None,
            "result": {"winner": live["result"]["winner"], "tie": live["result"]["tie"]} if live["phase"] == "finished" and live["result"] else None,
            "next": next_match_for(p["classId"])}


def player_state(p):
    global live
    game = class_games.get(p["classId"])
    if not game or game["phase"] == "idle":
        return _player_state_current(p)
    previous = live
    live = game
    try:
        return _player_state_current(p)
    finally:
        live = previous


def lan_urls():
    if os.environ.get("PUBLIC_URL"):
        return [os.environ["PUBLIC_URL"].rstrip("/")]
    if os.environ.get("FLY_APP_NAME"):
        return []
    try:
        s = pysocket.socket(pysocket.AF_INET, pysocket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return [f"http://{ip}:{PORT}"] if not ip.startswith("127.") else []
    except Exception:
        return []


def admin_data():
    return {"classes": sort_classes(db["classes"]), "tournaments": [t_view(t) for t in db["tournaments"]], "activeTournamentId": db["activeTournamentId"],
            "history": db["history"][:50],
            "stats": {"top": top_players(100), "standings": standings(), "hardest": hardest_questions(10),
                      "totals": {"classes": len(db["classes"]), "questions": sum(len(c["questions"]) for c in db["classes"]),
                                 "matches": sum(1 for t in db["tournaments"] if t.get("type") != "independent" for r in t["rounds"] for m in r if m["result"])
                                            + sum(len(t.get("results") or {}) for t in db["tournaments"] if t.get("type") == "independent"),
                                 "players": len(db["players"]), "online": sum(1 for p in players.values() if p.get("connected"))}},
            "urls": lan_urls()}


# ---------------------------------------------------------------- sockets
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*", ping_interval=20, ping_timeout=30)
b_handle = None


def spawn(coro):
    asyncio.get_event_loop().create_task(coro)


async def do_broadcast():
    global b_handle
    b_handle = None
    await sio.emit("state", public_state(False), room="display")
    await sio.emit("state", public_state(True), room="admin")
    for p in list(players.values()):
        if p.get("connected") and p.get("sid"):
            await sio.emit("me", player_state(p), to=p["sid"])


def broadcast():
    global b_handle
    if b_handle:
        return
    b_handle = asyncio.get_event_loop().call_later(0.05, lambda: spawn(do_broadcast()))


def push_admin_data():
    spawn(sio.emit("data", admin_data(), room="admin"))


def h_class_delete(d):
    if live["phase"] != "idle" and d.get("id") in live["teams"]:
        raise Err("الفصل يلعب الآن")
    if any(game["phase"] != "idle" and d.get("id") in game["teams"] for game in class_games.values()):
        raise Err("الفصل لديه مسابقة جارية")
    db["classes"] = [c for c in db["classes"] if c["id"] != d.get("id")]


def h_save_questions(d):
    c = get_class(d.get("id"))
    if not c:
        raise Err("الفصل غير موجود")
    qs = d.get("questions") if isinstance(d.get("questions"), list) else []
    c["questions"] = [normalize_question(q, i) for i, q in enumerate(qs)]
    if c.get("cursor", 0) >= len(c["questions"]):
        c["cursor"] = 0


def h_copy_questions(d):
    src = get_class(d.get("fromId"))
    if not src:
        raise Err("الفصل غير موجود")
    n = 0
    for cid in d.get("toIds") or []:
        c = get_class(cid)
        if not c or c["id"] == src["id"]:
            continue
        c["questions"].extend({**q, "wrong": list(q["wrong"]), "id": uid()} for q in src["questions"])
        n += 1
    return {"copied": n}


def h_tournament_delete(d):
    tid = d.get("id")
    if live["tournamentId"] == tid and live["phase"] != "idle":
        raise Err("هناك مباراة جارية في هذا الدوري")
    if any(game["tournamentId"] == tid and game["phase"] != "idle" for game in class_games.values()):
        raise Err("هناك مسابقات جارية في هذا الدوري")
    db["tournaments"] = [t for t in db["tournaments"] if t["id"] != tid]
    if db["activeTournamentId"] == tid:
        db["activeTournamentId"] = db["tournaments"][-1]["id"] if db["tournaments"] else None


def h_activate(d):
    if not get_t(d.get("id")):
        raise Err("الدوري غير موجود")
    if d["id"] != db["activeTournamentId"] and (live["phase"] != "idle" or any(game["phase"] != "idle" for game in class_games.values())):
        raise Err("أغلق المسابقات الجارية قبل تغيير المسابقة النشطة")
    db["activeTournamentId"] = d["id"]


def h_start(d):
    if live["mode"] == "independent":
        start_independent_competition()
        return
    if live["phase"] != "lobby":
        raise Err("افتح مباراة أولاً")
    start_question(0)


def h_reveal(d):
    if live["mode"] == "independent":
        raise Err("أسئلة هذا النمط تنتقل تلقائياً بعد إجابة كل طالب")
    if live["phase"] != "question":
        raise Err("لا يوجد سؤال مفتوح")
    reveal()


def h_next(d):
    if live["mode"] == "independent":
        raise Err("كل طالب ينتقل تلقائياً إلى السؤال التالي")
    if live["phase"] != "reveal":
        raise Err("أظهر الإجابة أولاً")
    if live["qIndex"] + 1 < live["qCount"]:
        start_question(live["qIndex"] + 1)
    else:
        finish()


def h_cancel(d):
    global live
    clear_game_timers(live)
    live = idle_live()


def h_close(d):
    global live
    if live["phase"] != "finished":
        raise Err("المباراة لم تنتهِ")
    clear_game_timers(live)
    live = idle_live()


def h_view(d):
    global display_view
    if d.get("view") in ("auto", "bracket", "leaderboard", "standings"):
        display_view = d["view"]


def h_stats_reset(d):
    db.update(players={}, questionStats={}, history=[])


def h_data_reset(d):
    global db
    if live["phase"] != "idle" or any(game["phase"] != "idle" for game in class_games.values()):
        raise Err("أغلق المباراة الحالية أولاً")
    pw = db.get("adminPassword")
    db = empty_db()
    db["adminPassword"] = pw
    class_games.clear()


def h_password(d):
    pw = clean(d.get("password"), 100)
    if len(pw) < 6:
        raise Err("كلمة المرور يجب أن تكون 6 أحرف على الأقل")
    db["adminPassword"] = pw
    admin_tokens.clear()


ADMIN_HANDLERS = {
    "class:create": lambda d: create_class(d) and None, "class:delete": h_class_delete, "class:saveQuestions": h_save_questions, "class:copyQuestions": h_copy_questions,
    "tournament:create": lambda d: {"id": create_tournament(d)["id"]}, "tournament:delete": h_tournament_delete, "tournament:activate": h_activate,
    "match:open": open_match, "classCompetition:open": open_independent_class, "classCompetition:reset": reset_independent_result,
    "match:start": h_start, "match:reveal": h_reveal, "match:next": h_next, "match:cancel": h_cancel, "match:close": h_close,
    "match:setWinner": set_winner, "match:reset": reset_match, "display:view": h_view, "stats:reset": h_stats_reset,
    "data:reset": h_data_reset, "admin:password": h_password,
}


@sio.event
async def connect(sid, environ, auth=None):
    sessions[sid] = {}
    await sio.emit("classes", class_list(), to=sid)


@sio.on("display:join")
async def display_join(sid, data=None):
    await sio.enter_room(sid, "display")
    await sio.emit("state", public_state(False), to=sid)


@sio.on("admin:login")
async def admin_login(sid, d=None):
    d = d if isinstance(d, dict) else {}
    token = d.get("token")
    ok_token = bool(token) and token in admin_tokens
    if d.get("password") != admin_password() and not ok_token:
        await asyncio.sleep(0.5)
        return {"ok": False, "error": "كلمة المرور غير صحيحة"}
    tk = token if ok_token else secrets.token_hex(16)
    admin_tokens.add(tk)
    sessions.setdefault(sid, {})["admin"] = True
    await sio.enter_room(sid, "admin")
    spawn(sio.emit("data", admin_data(), to=sid))
    spawn(sio.emit("state", public_state(True), to=sid))
    return {"ok": True, "token": tk}


@sio.on("player:join")
async def player_join(sid, d=None):
    d = d if isinstance(d, dict) else {}
    name = clean(d.get("name"), 30)
    c = get_class(d.get("classId"))
    if not name:
        return {"ok": False, "error": "اكتب اسمك أو اسم فريقك"}
    if not c:
        return {"ok": False, "error": "اختر فصلك"}
    p = players.get(d.get("playerId"))
    if not p:
        p = {"id": secrets.token_hex(10)}
        players[p["id"]] = p
    if p.get("sid") and p["sid"] != sid:
        spawn(sio.emit("kicked", to=p["sid"]))
    p.update(name=name, classId=c["id"], sid=sid, connected=True)
    sessions.setdefault(sid, {})["playerId"] = p["id"]
    ensure_player_participant(p)
    push_admin_data()
    broadcast()
    return {"ok": True, "id": p["id"], "name": p["name"], "classId": p["classId"]}


@sio.on("player:answer")
async def player_answer(sid, d=None):
    p = players.get(sessions.get(sid, {}).get("playerId"))
    if p and p.get("sid") == sid:
        game = class_games.get(p["classId"])
        if game and game["phase"] != "idle":
            global live
            previous = live
            live = game
            try:
                answer(p, (d or {}).get("choice") if isinstance(d, dict) else None)
            finally:
                class_games[p["classId"]] = live
                live = previous
        else:
            answer(p, (d or {}).get("choice") if isinstance(d, dict) else None)


@sio.on("player:leave")
async def player_leave(sid, d=None):
    s = sessions.get(sid, {})
    p = players.get(s.get("playerId"))
    if not p:
        return
    game = class_games.get(p["classId"])
    if game and game["phase"] != "idle":
        if p["id"] in game["pstats"] and game["phase"] == "lobby":
            del game["pstats"][p["id"]]
    elif p["id"] in live["pstats"] and live["phase"] == "lobby":
        del live["pstats"][p["id"]]
    players.pop(p["id"], None)
    s["playerId"] = None
    push_admin_data()
    broadcast()


@sio.event
async def disconnect(sid, *args):
    s = sessions.pop(sid, {})
    p = players.get(s.get("playerId"))
    if p and p.get("sid") == sid:
        p["connected"] = False
        push_admin_data()
        broadcast()


def make_admin_handler(fn):
    async def handler(sid, d=None):
        global live
        if not sessions.get(sid, {}).get("admin"):
            return {"ok": False, "error": "غير مصرح"}
        d = d if isinstance(d, dict) else {}
        class_id = d.get("classId")
        if not isinstance(class_id, str):
            class_id = None
        use_class_game = class_id in class_games or fn is open_independent_class or fn is reset_independent_result
        previous = live
        if fn is open_independent_class and previous["phase"] != "idle":
            return {"ok": False, "error": "أغلق مباراة الدوري قبل بدء مسابقات الفصول"}
        try:
            if use_class_game:
                live = class_games.get(class_id, idle_live())
            try:
                r = fn(d)
            except Err as e:
                return {"ok": False, "error": str(e)}
        except Err as e:
            return {"ok": False, "error": str(e)}
        finally:
            if use_class_game:
                if live["phase"] == "idle":
                    class_games.pop(class_id, None)
                else:
                    class_games[class_id] = live
                live = previous
        save()
        push_admin_data()
        spawn(sio.emit("classes", class_list()))
        broadcast()
        return {"ok": True, **(r if isinstance(r, dict) else {})}
    return handler


for _ev, _fn in ADMIN_HANDLERS.items():
    sio.on(_ev, make_admin_handler(_fn))


# ---------------------------------------------------------------- http
class NoCacheStatic(StaticFiles):
    def file_response(self, *args, **kwargs):
        r = super().file_response(*args, **kwargs)
        r.headers["Cache-Control"] = "no-cache"
        return r


@asynccontextmanager
async def lifespan(_app):
    yield
    try:
        flush()
    except Exception:
        pass


sio_asgi = socketio.ASGIApp(sio)


class SocketIOMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] in ("http", "websocket") and scope.get("path", "").startswith("/socket.io"):
            return await sio_asgi(scope, receive, send)
        return await self.app(scope, receive, send)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(SocketIOMiddleware)


@app.get("/healthz")
async def healthz():
    return {"ok": True}


@app.get("/api/info")
async def api_info():
    return {"urls": lan_urls()}


@app.get("/api/qr")
async def api_qr(u: str = ""):
    if not u or len(u) > 500:
        return Response(status_code=400)
    img = qrcode.make(u, image_factory=qrcode.image.svg.SvgPathFillImage, border=1)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=3600"})


for _page in ("play", "admin", "display", "index", "about"):
    def _mk(page):
        async def serve():
            return FileResponse(PUBLIC / f"{page}.html", headers={"Cache-Control": "no-cache"})
        return serve
    app.add_api_route(f"/{_page}", _mk(_page), methods=["GET"], include_in_schema=False)

app.mount("/", NoCacheStatic(directory=PUBLIC, html=True), name="static")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=PORT)
