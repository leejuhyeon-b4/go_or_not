// =============================================================
// supabase/functions/admin — 모바일 관리자 도구
//
//   GET  /functions/v1/admin              → 관리자 페이지(HTML)
//   POST /functions/v1/admin?action=seasons → 공연 목록 (드롭다운용)
//   POST /functions/v1/admin?action=parse   → 이미지 → Gemini 판독 → 할인 목록 (저장 안 함)
//   POST /functions/v1/admin?action=save    → 검토된 할인 목록을 seasons.discounts 에 저장
//
// 인증: POST 는 Supabase Auth 로그인 필수(아무 인증 사용자나 = 관리자 1명만 만들 것).
//       GET(페이지)은 무인증 — 그래서 이 함수는 "Verify JWT" 를 꺼야 한다.
//
// 필요한 env (Edge Function Secrets):
//   GEMINI_API_KEY   ← 직접 등록 (aistudio.google.com)
//   GEMINI_MODEL     ← 선택, 기본 gemini-2.0-flash
//   SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY ← 자동 주입됨
// =============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-2.0-flash";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });

async function requireUser(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!jwt) throw new HttpError(401, "로그인이 필요합니다.");
  const anon = createClient(SUPABASE_URL, ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anon.auth.getUser(jwt);
  if (error || !data.user) throw new HttpError(401, "세션이 만료됐어요. 다시 로그인하세요.");
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    // ---- 관리자 페이지 ----
    if (req.method === "GET" && !action) {
      return new Response(PAGE(), {
        headers: { "content-type": "text/html; charset=utf-8", ...CORS },
      });
    }

    // ---- 공연 목록 ----
    if (req.method === "POST" && action === "seasons") {
      await requireUser(req);
      const { data, error } = await admin
        .from("seasons")
        .select("season_id, work_title, season_label, discounts, discounts_verified")
        .order("work_title");
      if (error) throw new HttpError(500, error.message);
      return json({ seasons: data });
    }

    // ---- 이미지 판독 (저장 X) ----
    if (req.method === "POST" && action === "parse") {
      await requireUser(req);
      if (!GEMINI_KEY) throw new HttpError(500, "GEMINI_API_KEY 가 설정되지 않았어요.");
      const { image_base64, mime_type } = await req.json();
      if (!image_base64) throw new HttpError(400, "이미지가 없습니다.");
      const discounts = await geminiExtractDiscounts(image_base64, mime_type ?? "image/jpeg");
      return json({ discounts });
    }

    // ---- 저장 ----
    if (req.method === "POST" && action === "save") {
      await requireUser(req);
      const { season_id, discounts } = await req.json();
      if (!season_id || !Array.isArray(discounts)) {
        throw new HttpError(400, "season_id 와 discounts 배열이 필요합니다.");
      }
      const clean = discounts
        .map((d) => ({
          name: String(d?.name ?? "").trim(),
          rate: Number(d?.rate),
          type: ["STANDING", "ELIGIBILITY", "LOYALTY"].includes(d?.type) ? d.type : "STANDING",
        }))
        .filter((d) => d.name && Number.isFinite(d.rate) && d.rate >= 0 && d.rate <= 100);
      if (!clean.length) throw new HttpError(400, "저장할 유효한 할인이 없습니다.");

      const { data, error } = await admin
        .from("seasons")
        .update({ discounts: clean, discounts_verified: true })
        .eq("season_id", season_id)
        .select("season_id");
      if (error) throw new HttpError(500, error.message);
      if (!data?.length) {
        throw new HttpError(404, `'${season_id}' 시즌이 없어요. 공연을 먼저 추가하세요.`);
      }
      return json({ ok: true, season_id, saved: clean });
    }

    return json({ error: "알 수 없는 요청" }, 404);
  } catch (e) {
    const err = e as HttpError;
    return json({ error: err?.message ?? String(e) }, err?.status ?? 500);
  }
});

// ---- Gemini 비전: 할인표 → [{name, rate, type}] --------------------------
async function geminiExtractDiscounts(b64: string, mime: string) {
  const prompt =
`이 이미지는 한국 공연 예매처의 '할인 정보' 화면이다. 화면에 실제로 보이는 할인 항목만 추출하라.
- name: 할인명 그대로 (예: "조기예매 할인", "청소년")
- rate: 할인율. 정수 퍼센트만 (예: 30). "%" 제외. 범위로 적혀 있으면 낮은 값.
- type:
  - STANDING     조건 없이 누구나·상시 (조기예매/조조/문화가있는날/마티네/멤버십)
  - ELIGIBILITY  자격 증빙 필요 (청소년/대학생/경로/장애인/국가유공자/다자녀)
  - LOYALTY      재관람자 전용 (재관람 할인/도장/쿠폰팩)
- 애매하면 STANDING. 이미지에 없는 항목은 만들지 마라.`;

  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mime, data: b64 } },
        { text: prompt },
      ],
    }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            rate: { type: "INTEGER" },
            type: { type: "STRING", enum: ["STANDING", "ELIGIBILITY", "LOYALTY"] },
          },
          required: ["name", "rate", "type"],
        },
      },
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new HttpError(502, `Gemini 오류 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "[]";
  try {
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? arr : [];
  } catch {
    throw new HttpError(502, "Gemini 응답을 해석하지 못했어요. 다시 시도해보세요.");
  }
}

// ---- 관리자 페이지 (모바일 우선, 자체 완결) ---------------------------------
function PAGE() {
  return `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>갈까말까 · 관리자</title>
<style>
  :root { color-scheme: light dark; --bg:#faf9f7; --fg:#1c1a17; --mut:#6b655c; --line:#e2ddd4;
          --card:#fff; --accent:#2f6f4f; --danger:#b23b3b; }
  @media (prefers-color-scheme: dark) { :root {
    --bg:#161513; --fg:#eceae6; --mut:#9a938a; --line:#333029; --card:#211f1c; --accent:#5fbd99; --danger:#e07a7a; } }
  * { box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
  body { margin:0; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;
         background:var(--bg); color:var(--fg); padding:max(16px,env(safe-area-inset-top)) 16px 40px; }
  h1 { font-size:18px; margin:4px 0 20px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:16px; margin-bottom:14px; }
  label { display:block; font-size:13px; color:var(--mut); margin:0 0 6px; }
  input, select, button, textarea { font:inherit; width:100%; padding:12px; border-radius:10px;
         border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  button { background:var(--accent); color:#fff; border:none; font-weight:600; margin-top:10px; }
  button.ghost { background:transparent; color:var(--mut); border:1px solid var(--line); font-weight:400; }
  button:disabled { opacity:.5; }
  .row { display:grid; grid-template-columns:1fr 64px 128px 36px; gap:6px; align-items:center; margin-bottom:6px; }
  .row input, .row select { padding:9px; }
  .row .del { background:transparent; color:var(--danger); border:1px solid var(--line); padding:9px 0; margin:0; }
  .msg { font-size:14px; padding:10px 12px; border-radius:10px; margin:10px 0 0; white-space:pre-wrap; }
  .msg.err { background:color-mix(in srgb,var(--danger) 12%,transparent); color:var(--danger); }
  .msg.ok  { background:color-mix(in srgb,var(--accent) 14%,transparent); color:var(--accent); }
  .hint { font-size:12px; color:var(--mut); margin-top:8px; }
  img.preview { width:100%; border-radius:10px; margin-top:10px; display:none; }
  .hidden { display:none; }
  .between { display:flex; justify-content:space-between; align-items:baseline; }
</style></head><body>
<h1>이 회차 갈까말까 · 관리자</h1>

<div id="loginCard" class="card">
  <label for="email">이메일</label>
  <input id="email" type="email" autocomplete="username" inputmode="email">
  <label for="pw" style="margin-top:10px">비밀번호</label>
  <input id="pw" type="password" autocomplete="current-password">
  <button id="loginBtn">로그인</button>
  <div id="loginMsg" class="msg err hidden"></div>
</div>

<div id="app" class="hidden">
  <div class="card">
    <div class="between"><label for="season">공연 (시즌)</label>
      <button id="logout" class="ghost" style="width:auto;padding:4px 10px;margin:0;font-size:12px">로그아웃</button></div>
    <select id="season"></select>
    <div id="curInfo" class="hint"></div>
  </div>

  <div class="card">
    <label for="file">할인정보 스크린샷</label>
    <input id="file" type="file" accept="image/*" capture="environment">
    <img id="preview" class="preview" alt="">
    <button id="parseBtn" disabled>Gemini 로 판독</button>
    <div class="hint">예매처 '할인정보' 화면을 캡처해서 올리세요. 저장은 아래에서 확인 후.</div>
    <div id="parseMsg" class="msg hidden"></div>
  </div>

  <div id="editCard" class="card hidden">
    <div class="between"><label>판독 결과 — 확인·수정 후 저장</label>
      <button id="addRow" class="ghost" style="width:auto;padding:4px 10px;margin:0;font-size:12px">+ 행</button></div>
    <div id="rows"></div>
    <div class="hint">rate = 정수 %. type: STANDING(누구나) / ELIGIBILITY(자격증빙) / LOYALTY(재관람전용)</div>
    <button id="saveBtn">이 공연 할인으로 저장</button>
    <div id="saveMsg" class="msg hidden"></div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<script>
const SB_URL = ${JSON.stringify(SUPABASE_URL)};
const SB_ANON = ${JSON.stringify(ANON_KEY)};
const FN = SB_URL + "/functions/v1/admin";
const sb = window.supabase.createClient(SB_URL, SB_ANON);
const $ = (id) => document.getElementById(id);
const show = (el, on) => el.classList.toggle("hidden", !on);
const setMsg = (el, text, kind) => { el.textContent = text; el.className = "msg " + (kind||""); show(el, !!text); };

let TOKEN = null;

async function api(action, payload) {
  const res = await fetch(FN + "?action=" + action, {
    method: "POST",
    headers: { "content-type": "application/json", "Authorization": "Bearer " + TOKEN },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

async function boot() {
  const { data } = await sb.auth.getSession();
  if (data.session) { TOKEN = data.session.access_token; enterApp(); }
}

$("loginBtn").onclick = async () => {
  setMsg($("loginMsg"), "", "");
  $("loginBtn").disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({ email: $("email").value.trim(), password: $("pw").value });
  $("loginBtn").disabled = false;
  if (error) { setMsg($("loginMsg"), error.message, "err"); return; }
  TOKEN = data.session.access_token;
  enterApp();
};

$("logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };

async function enterApp() {
  show($("loginCard"), false);
  show($("app"), true);
  try {
    const { seasons } = await api("seasons");
    const sel = $("season");
    sel.innerHTML = "";
    seasons.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.season_id;
      const mark = s.discounts_verified ? " ✓" : (s.discounts ? " (임시)" : "");
      o.textContent = s.work_title + " " + (s.season_label || "") + mark;
      o._s = s;
      sel.appendChild(o);
    });
    sel.onchange = renderCur;
    renderCur();
  } catch (e) {
    setMsg($("parseMsg"), e.message, "err");
  }
}

function renderCur() {
  const s = $("season").selectedOptions[0]?._s;
  if (!s) return;
  const d = s.discounts;
  $("curInfo").textContent = d
    ? "현재 " + d.length + "개" + (s.discounts_verified ? " (검증됨)" : " (임시 — 덮어써도 됨)")
    : "현재 할인 정보 없음";
}

$("file").onchange = () => {
  const f = $("file").files[0];
  show($("editCard"), false);
  setMsg($("parseMsg"), "", "");
  if (!f) { $("parseBtn").disabled = true; return; }
  const img = $("preview");
  img.src = URL.createObjectURL(f);
  img.style.display = "block";
  $("parseBtn").disabled = false;
};

$("parseBtn").onclick = async () => {
  const f = $("file").files[0];
  if (!f) return;
  $("parseBtn").disabled = true;
  setMsg($("parseMsg"), "판독 중… (몇 초)", "");
  try {
    const b64 = await new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(",")[1]);
      r.onerror = () => no(new Error("이미지를 읽지 못했어요"));
      r.readAsDataURL(f);
    });
    const { discounts } = await api("parse", { image_base64: b64, mime_type: f.type });
    setMsg($("parseMsg"), discounts.length + "개 항목 판독됨. 아래에서 확인하세요.", "ok");
    renderRows(discounts);
    show($("editCard"), true);
  } catch (e) {
    setMsg($("parseMsg"), e.message, "err");
  } finally {
    $("parseBtn").disabled = false;
  }
};

function renderRows(list) {
  const box = $("rows");
  box.innerHTML = "";
  (list.length ? list : [{ name: "", rate: 0, type: "STANDING" }]).forEach(addRow);
}
function addRow(d) {
  d = d || { name: "", rate: 0, type: "STANDING" };
  const div = document.createElement("div");
  div.className = "row";
  div.innerHTML =
    '<input class="n" placeholder="할인명" value="' + escapeHtml(d.name || "") + '">' +
    '<input class="r" type="number" inputmode="numeric" value="' + (Number(d.rate) || 0) + '">' +
    '<select class="t">' +
      ['STANDING', 'ELIGIBILITY', 'LOYALTY'].map((t) =>
        '<option ' + (d.type === t ? 'selected' : '') + '>' + t + '</option>').join('') +
    '</select>' +
    '<button class="del">×</button>';
  div.querySelector(".del").onclick = () => div.remove();
  $("rows").appendChild(div);
}
$("addRow").onclick = () => addRow();

$("saveBtn").onclick = async () => {
  const season_id = $("season").value;
  const discounts = [...document.querySelectorAll("#rows .row")].map((r) => ({
    name: r.querySelector(".n").value.trim(),
    rate: Number(r.querySelector(".r").value),
    type: r.querySelector(".t").value,
  })).filter((d) => d.name);
  if (!discounts.length) { setMsg($("saveMsg"), "저장할 행이 없어요.", "err"); return; }
  $("saveBtn").disabled = true;
  setMsg($("saveMsg"), "저장 중…", "");
  try {
    await api("save", { season_id, discounts });
    setMsg($("saveMsg"), "저장 완료. 데스크탑에서 'npm run pull' 하면 앱에 반영돼요.", "ok");
    const { seasons } = await api("seasons");
    const cur = $("season").value;
    $("season").innerHTML = "";
    seasons.forEach((s) => {
      const o = document.createElement("option");
      o.value = s.season_id;
      const mark = s.discounts_verified ? " ✓" : (s.discounts ? " (임시)" : "");
      o.textContent = s.work_title + " " + (s.season_label || "") + mark;
      o._s = s; $("season").appendChild(o);
    });
    $("season").value = cur;
    renderCur();
  } catch (e) {
    setMsg($("saveMsg"), e.message, "err");
  } finally {
    $("saveBtn").disabled = false;
  }
};

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

boot();
</script>
</body></html>`;
}
