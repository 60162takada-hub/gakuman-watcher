// 学生マンション.com の WEBマイソク を1分おきに見て、
// 募集中の部屋（A/B/Cタイプ）が新しく出たら LINE でスマホに通知する。
// （LINE_TOKEN がなければ ntfy。ただし ntfy.sh は Cloudflare の共有IPだと回数制限で弾かれやすい）
// 状態は KV（STATE）に保存し、変化したときだけ書き込む。

const CODES = ["2301005428", "2301005399"];
const URL = (code) => `https://www.gakuman-tokyo.com/maisoku?code=${code}`;
// 通知する間取りタイプ（詳細の「間取り」欄。全角は半角にそろえて比較）
const NOTIFY_TYPES = new Set(["A", "B", "C"]);

function text(s) {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
}

// 詳細テーブルを {見出し: 値} にする
function detail(li) {
  const d = {};
  for (const m of li.matchAll(/<th>([\s\S]*?)<\/th>\s*<td>([\s\S]*?)<\/td>/g)) {
    d[text(m[1])] = text(m[2]);
  }
  return d;
}

// 「Dタイプ」→ "D"。読めなければ null
function roomType(r) {
  const m = (r.detail["間取り"] || "").toUpperCase().match(/^([A-Z])/);
  return m ? m[1] : null;
}

function describe(r) {
  const d = r.detail;
  return [r.room, d["間取り"], d["専有面積"], r.price, d["入居可能月"]]
    .filter(Boolean)
    .join(" ");
}

function parse(page) {
  const h2 = page.match(/<h2>([^<]+)/);
  const name = h2 ? text(h2[1]) : "?";

  const sec = page.match(/<section id="maisoku-available-rooms">([\s\S]*?)<\/section>/);
  if (!sec) throw new Error("空室情報セクションが見つからない（ページ構造が変わった可能性）");
  const body = sec[1];

  const waiting = body.includes("txt-waiting");
  const rooms = [];
  // 部屋ごとの <li>。入居中/成約済は class="mar-secured"、募集中はクラスなし＋lb-available
  for (const li of body.split(/<li(?=[\s>])/).slice(1)) {
    const cls = li.match(/^[^>]*class="([^"]*)"/);
    if (cls && cls[1].includes("mar-secured")) continue;
    const h4 = li.match(/<h4>([\s\S]*?)<\/h4>/);
    if (!h4) continue;
    const price = li.match(/<dd>\s*<p>([^<]+)<\/p>/);
    rooms.push({ room: text(h4[1]), price: price ? text(price[1]) : "", detail: detail(li) });
  }
  return { name, waiting, rooms };
}

// 送れたら true。一時的なエラーに備えて数回やり直す
async function pushPhone(env, title, message, url) {
  for (let i = 0; i < 3; i++) {
    if (i) await new Promise((r) => setTimeout(r, 5000));
    try {
      if (await pushOnce(env, title, message, url)) return true;
    } catch (e) {
      console.log(`スマホ通知エラー ${e.message}`);
    }
  }
  return false;
}

async function pushOnce(env, title, message, url) {
  const res = env.LINE_TOKEN
    ? // 公式アカウントを友だち追加した全員に送る
      await fetch("https://api.line.me/v2/bot/message/broadcast", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.LINE_TOKEN.trim()}`,
        },
        body: JSON.stringify({ messages: [{ type: "text", text: `🏠 ${title}\n${message}\n${url}` }] }),
      })
    : await fetch("https://ntfy.sh/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, click: url, tags: ["house"] }),
      });
  if (!res.ok) console.log(`スマホ通知エラー ${res.status} ${await res.text()}`);
  return res.ok;
}

async function check(env, { test = false } = {}) {
  const before = (await env.STATE.get("state", "json")) || {};
  const state = structuredClone(before);

  for (const code of CODES) {
    const url = URL(code);
    let parsed;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 gakuman-watcher" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      parsed = parse(await res.text());
    } catch (e) {
      console.log(`${code}: 取得エラー ${e.message}`);
      continue;
    }
    const { name, waiting, rooms } = parsed;

    const prev = new Set(state[code]?.rooms || []);
    const fresh = rooms.filter((r) => !prev.has(r.room));
    // 間取りが読めない部屋は念のため通知する
    const hits = fresh.filter((r) => NOTIFY_TYPES.has(roomType(r)) || roomType(r) === null);

    console.log(`${code} ${name}: ${waiting ? "空室待ち" : `募集中 ${rooms.length}室`} ${JSON.stringify(rooms.map(describe))}`);
    for (const r of fresh) {
      if (!hits.includes(r)) console.log(`${code}: ${describe(r)} は対象外タイプなので通知しない`);
    }

    let unsent = [];
    if (hits.length || test) {
      const msg = (hits.length ? hits : rooms).map(describe).join(" / ") || "(テスト通知)";
      const ok = await pushPhone(env, `${test ? "[テスト] " : ""}空室が出ました：${name}`, msg, url);
      console.log(`${code}: 通知${ok ? "" : "失敗（次回やり直す）"} -> ${msg}`);
      // 送れなかった部屋は「まだ知らせていない」扱いにして次の実行で再送する
      if (!ok) unsent = hits.map((r) => r.room);
    } else if (!waiting && !rooms.length && state[code]?.waiting) {
      // 「空室待ち」が消えたのに部屋が読めない＝表示形式が変わった可能性があるので一応知らせる
      await pushPhone(env, `空室情報が変わりました：${name}`, "ページを確認してください", url);
      console.log(`${code}: 空室待ち表示が消えた`);
    }

    state[code] = {
      name,
      waiting,
      rooms: rooms.map((r) => r.room).filter((r) => !unsent.includes(r)).sort(),
    };
  }

  if (JSON.stringify(state) !== JSON.stringify(before)) {
    await env.STATE.put("state", JSON.stringify(state));
  }
}

export default {
  async scheduled(event, env, ctx) {
    // KV に "test" キーを置くと、次の実行で1回だけテスト通知を送る
    const test = (await env.STATE.get("test")) !== null;
    if (test) await env.STATE.delete("test");
    await check(env, { test });
  },
};

export { check };
