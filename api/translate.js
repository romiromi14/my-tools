// ============================================================
// プロンプト対訳ツール用の「和訳」中継 — Vercel版（東京リージョン）
// ------------------------------------------------------------
// なぜ中継が要るか:
//   Sarashina API は日本国内IP以外を 403 で弾く。かつブラウザから
//   直接叩くと CORS で通らない。そこで、東京(hnd1)で動くVercelの
//   関数を経由させる。APIキーは関数の環境変数に置くのでブラウザに出ない。
//
// 【置き場所】 GitHub リポジトリ ocean-worktools/toolbox に
//       api/translate.js   ← このファイル
//   vercel.json は既存のまま（"regions": ["hnd1"]）でOK。
//   一言ジェネレーター用の api/rephrase.js と同じプロジェクトに同居できる。
//
// 【必要な環境変数】（Vercel の Settings → Environment Variables）
//   SARASHINA_API_KEY = Sarashina のAPIキー（rephrase と共用でOK）
//   ALLOW_ORIGIN      = 呼び出し元のオリジン。カンマ区切りで複数OK。
//                       HTMLをローカルファイルで開く場合は Origin が null になるため、
//                       まずは * で試すのが早い（公開URLに載せたら、そのオリジンだけに絞る）。
//
// 【送る/返る】
//   送信: POST { "text": "英文1文" }
//   成功: {"ok":true,"text":"和訳"}
//   失敗: {"ok":false,"error":"...","status":429,"detail":...}
//   GET で開くと状態確認。?diag=1 を付けると実際に1回叩いて結果を見せる。
//
// 【モデル】 nano は 60リクエスト/分（mini は 6）。1行＝1リクエストで
//   使う想定なので nano を既定にしている。変えるなら MODEL の1行だけ。
// ============================================================

// 使うモデル。nano＝高速・大量処理向け（60 RPM）。
const MODEL = "sarashina3-nano";

// OpenAI互換のチャットエンドポイント。ベースURLは https://api.sarashina.ai/v1
const ENDPOINT = "https://api.sarashina.ai/v1/chat/completions";

// 和訳の指示。nano は mini と違って「厳格な指示追従」が公式に明記されていないので、
// 「訳文だけを返す」ところを特に強く書いておく（前置きが混ざる事故を防ぐ）。
const INSTRUCTION = [
  "あなたは、画像生成プロンプトの英日翻訳アシスタントです。",
  "渡された英文を、日本語に翻訳してください。",
  "ルール:",
  "- 出力は訳文だけ。前置き・説明・引用符・かっこ書きは一切書かない。",
  "- 英文1文を、日本語1文に訳す。改行は入れない。",
  "- 元の英文の情報を足さない・削らない。意訳しすぎない。",
  "- 語の対応が追える、直訳寄りの自然な日本語にする。",
  "- カメラ・照明・構図などの用語は、日本語の一般的な訳語を使う。",
  "- 原文が体言止めや語句の羅列なら、それに近い形のまま訳す。"
].join("\n");

// --- CORS ヘッダー（rephrase と同じ考え方） ---
// ALLOW_ORIGIN に許可するオリジンを入れる（カンマ区切りで複数OK）。
// "*" を入れると全部許可。origin が許可リストに無いときは allow[0] を返す。
function corsHeaders(req) {
  const allow = (process.env.ALLOW_ORIGIN || "*")
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(Boolean);
  const origin = (req.headers && req.headers.origin) || "";
  let allowOrigin = "*";
  if (allow.indexOf("*") === -1) {
    allowOrigin = allow.indexOf(origin) !== -1 ? origin : allow[0];
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    // 429 のときブラウザ側から待ち秒数ヘッダを読めるようにする
    "Access-Control-Expose-Headers": "Retry-After",
    "Vary": "Origin"
  };
}

// --- Sarashina API を叩く ---
// 戻り値は { status, ok, data, raw, retryAfter }。
// status を見れば 403（海外IP）/ 401（キー違い）/ 429（回数超過）/ 200 が分かる。
async function callSarashina(text) {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // キーは環境変数から読む。ブラウザには出さない。
      "Authorization": "Bearer " + (process.env.SARASHINA_API_KEY || "")
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: INSTRUCTION },
        { role: "user", content: text }
      ],
      // 翻訳なのでブレさせない。※「未対応」で400が返ったら、この行を消すだけでOK。
      temperature: 0
    })
  });
  const raw = await res.text();
  let data = null;
  try { data = JSON.parse(raw); } catch (e) { data = null; }
  return {
    status: res.status,
    ok: res.ok,
    data: data,
    raw: raw.slice(0, 500),
    // 429 のときは「次のカウント期間までの待ち秒」がヘッダで返る。
    // ヘッダ名は公式ドキュメントでは伏せられていたので Retry-After を想定。
    retryAfter: res.headers.get("retry-after") || null
  };
}

// ==========================================================
// 本体（Vercel の Node.js 関数）
// ==========================================================
module.exports = async function handler(req, res) {
  const cors = corsHeaders(req);

  // ブラウザの事前確認（プリフライト）にはヘッダーだけ返して終了
  if (req.method === "OPTIONS") {
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(204).end();
    return;
  }

  // --- 診断用: ブラウザで開くと状態を教えてくれる ---
  // ?diag=1 を付けると、Sarashina を実際に1回叩いて結果を見せる。
  if (req.method === "GET") {
    const info = {
      keySet: !!process.env.SARASHINA_API_KEY,
      model: MODEL,
      endpoint: ENDPOINT,
      allowOrigin: process.env.ALLOW_ORIGIN || null,
      region: process.env.VERCEL_REGION || null   // hnd1 なら東京で動いてる証拠
    };
    const q = (req.url || "").split("?")[1] || "";
    if (new URLSearchParams(q).get("diag") === "1") {
      try {
        const r = await callSarashina("a woman standing by the window");
        info.probe = {
          status: r.status,
          body: (r.data ? JSON.stringify(r.data) : r.raw).slice(0, 400)
        };
      } catch (e) {
        info.probe = { status: null, body: String(e) };
      }
    }
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(200).json({ ok: true, info: info });
    return;
  }

  // POST 以外は弾く
  if (req.method !== "POST") {
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(405).json({ ok: false, error: "POST only" });
    return;
  }

  try {
    // Vercel は JSON の本文を自動で req.body に入れてくれる
    const text = (req.body && req.body.text ? String(req.body.text) : "").trim();
    if (!text) {
      Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
      res.status(400).json({ ok: false, error: "text is required" });
      return;
    }

    // Translate API は1リクエスト5,000文字まで（改行も1文字）。念のため先に弾く。
    if (text.length > 4900) {
      Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
      res.status(413).json({ ok: false, error: "text too long", length: text.length });
      return;
    }

    const r = await callSarashina(text);

    if (!r.ok) {
      Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
      // 429 はブラウザ側が待ち時間を読めるように、待ち秒数も添えて返す。
      // （中継の中で待つと Vercel の実行時間を食うので、待つのは呼び出し側に任せる）
      if (r.status === 429 && r.retryAfter) {
        res.setHeader("Retry-After", String(r.retryAfter));
      }
      res.status(502).json({
        ok: false,
        error: "Sarashina API error (" + r.status + ")",
        status: r.status,
        retryAfter: r.retryAfter,
        detail: r.data || r.raw
      });
      return;
    }

    // 訳文は choices[0].message.content に入っている
    let out = (r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message)
      ? String(r.data.choices[0].message.content || "").trim()
      : "";

    // 保険: 前置きや引用符が混ざったときの簡易クリーニング。
    // 「はい、承知しました。」のような前置きが別行で来た場合に備えて、
    // 複数行だったら「いちばん長い行」を訳文とみなす（前置きは普通もっと短いため）。
    // ※完全な対策ではないので、実際の出力は ?diag=1 で目視確認すること。
    out = out.replace(/^["'「『]+|["'」』]+$/g, "").trim();
    const lines = out.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (lines.length > 1) {
      out = lines.reduce(function (a, b) { return b.length > a.length ? b : a; }, "");
    }

    if (!out) {
      Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
      res.status(502).json({ ok: false, error: "empty response", detail: r.data });
      return;
    }

    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(200).json({ ok: true, text: out });

  } catch (e) {
    Object.keys(cors).forEach(function (k) { res.setHeader(k, cors[k]); });
    res.status(500).json({ ok: false, error: String(e) });
  }
};
