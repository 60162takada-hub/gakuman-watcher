#!/usr/bin/env python3
"""学生マンション.com の WEBマイソク を見て、募集中の部屋（A/B/Cタイプ）が新しく出たら Mac に通知する。

GitHub Actions（または Mac の launchd）から数分おきに起動される想定（1回実行して終了）。
状態は state.json に保存し、前回なかった募集中の部屋が出たときだけ通知する。
"""
import html
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.request
from datetime import datetime
from pathlib import Path

CODES = ["2301005428", "2301005399"]
URL = "https://www.gakuman-tokyo.com/maisoku?code={}"
# 通知する間取りタイプ（詳細の「間取り」欄。全角は半角にそろえて比較）
NOTIFY_TYPES = {"A", "B", "C"}

BASE = Path(__file__).resolve().parent
STATE_FILE = BASE / "state.json"
LOG_FILE = BASE / "watch.log"
# スマホ通知（ntfy アプリでこのトピック名を購読した端末に届く）。
# 環境変数 NTFY_TOPIC か ntfy_topic.txt から読む。どちらもなければ送らない
NTFY_TOPIC_FILE = BASE / "ntfy_topic.txt"


def ntfy_topic():
    if os.environ.get("NTFY_TOPIC"):
        return os.environ["NTFY_TOPIC"].strip()
    if NTFY_TOPIC_FILE.exists():
        return NTFY_TOPIC_FILE.read_text().strip()
    return None


def log(msg):
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    print(line)
    with LOG_FILE.open("a", encoding="utf-8") as f:
        f.write(line + "\n")


def fetch(code):
    req = urllib.request.Request(
        URL.format(code),
        headers={"User-Agent": "Mozilla/5.0 (Macintosh) gakuman-watcher"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


def text(s):
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", s)).strip()


def detail(li):
    """詳細テーブルを {見出し: 値} にする。"""
    return {
        text(th): text(td)
        for th, td in re.findall(r"<th>(.*?)</th>\s*<td>(.*?)</td>", li, re.S)
    }


def room_type(r):
    """「Dタイプ」→ "D"。読めなければ None。"""
    m = re.match(r"([A-Z])", r["detail"].get("間取り", "").upper())
    return m.group(1) if m else None


def parse(page):
    """(物件名, 待ち表示の有無, 募集中の部屋リスト[{room, price, detail}]) を返す。"""
    m = re.search(r"<h2>([^<]+)", page)
    name = text(m.group(1)) if m else "?"

    sec = re.search(
        r'<section id="maisoku-available-rooms">(.*?)</section>', page, re.S
    )
    if not sec:
        raise ValueError("空室情報セクションが見つからない（ページ構造が変わった可能性）")
    body = sec.group(1)

    waiting = "txt-waiting" in body
    rooms = []
    # 部屋ごとの <li>。入居中/成約済は class="mar-secured"、募集中はクラスなし＋lb-available
    for li in re.split(r"<li(?=[\s>])", body)[1:]:
        cls = re.match(r'[^>]*class="([^"]*)"', li)
        if cls and "mar-secured" in cls.group(1):
            continue
        h4 = re.search(r"<h4>(.*?)</h4>", li, re.S)
        if not h4:
            continue
        room = text(h4.group(1))
        price = re.search(r"<dd>\s*<p>([^<]+)</p>", li)
        rooms.append({
            "room": room,
            "price": text(price.group(1)) if price else "",
            "detail": detail(li),
        })
    return name, waiting, rooms


def notify(title, message, url):
    script = (
        f"display notification {json.dumps(message, ensure_ascii=False)} "
        f"with title {json.dumps(title, ensure_ascii=False)}"
    )
    if sys.platform == "darwin":
        subprocess.run(["osascript", "-e", script], check=False)
    push_phone(title, message, url)


def push_phone(title, message, url):
    topic = ntfy_topic()
    if not topic:
        return
    body = json.dumps({
        "topic": topic,
        "title": title,
        "message": message,
        "click": url,  # 通知をタップするとページが開く
        "tags": ["house"],
    }).encode()
    req = urllib.request.Request(
        "https://ntfy.sh/", data=body, headers={"Content-Type": "application/json"}
    )
    try:
        urllib.request.urlopen(req, timeout=30).read()
    except Exception as e:
        log(f"スマホ通知エラー {e}")


def describe(r):
    d = r["detail"]
    parts = [r["room"], d.get("間取り"), d.get("専有面積"), r["price"], d.get("入居可能月")]
    return " ".join(p for p in parts if p)


def main():
    state = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else {}
    test = "--test" in sys.argv

    for code in CODES:
        url = URL.format(code)
        try:
            name, waiting, rooms = parse(fetch(code))
        except Exception as e:
            log(f"{code}: 取得エラー {e}")
            continue

        prev = set(state.get(code, {}).get("rooms", []))
        now = {r["room"] for r in rooms}
        new = [r for r in rooms if r["room"] not in prev]
        # 間取りが読めない部屋は念のため通知する
        hits = [r for r in new if room_type(r) in NOTIFY_TYPES or room_type(r) is None]

        summary = "空室待ち" if waiting else f"募集中 {len(rooms)}室"
        log(f"{code} {name}: {summary} {[describe(r) for r in rooms]}")
        for r in new:
            if r not in hits:
                log(f"{code}: {describe(r)} は対象外タイプなので通知しない")

        if hits or test:
            msg = " / ".join(describe(r) for r in hits or rooms) or "(テスト通知)"
            notify(f"空室が出ました：{name}", msg, url)
            log(f"{code}: 通知 -> {msg}")
        elif not waiting and not rooms and state.get(code, {}).get("waiting"):
            # 「空室待ち」が消えたのに部屋が読めない＝表示形式が変わった可能性があるので一応知らせる
            notify(f"空室情報が変わりました：{name}", "ページを確認してください", url)
            log(f"{code}: 空室待ち表示が消えた")

        state[code] = {"name": name, "waiting": waiting, "rooms": sorted(now)}

    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
