// =============================================================
// supabase/functions/admin — 관리자 도구 JSON API
//
//   관리자 화면(HTML)은 앱의 admin.html. Supabase 가 Edge Function 의
//   HTML 응답을 sandbox/text-plain 으로 강제해서, 이 함수는 JSON API 만 한다.
//
//   GET  /functions/v1/admin                  → 안내 JSON
//   POST /functions/v1/admin?action=auth      → 비밀번호 확인만
//   POST /functions/v1/admin?action=seasons   → 공연 목록 (할인 드롭다운용)
//   POST /functions/v1/admin?action=venues    → 극장 목록 (좌석배치도 드롭다운용)
//   POST /functions/v1/admin?action=parse         → 할인표 이미지 → Gemini → [{name,rate,type}]
//   POST /functions/v1/admin?action=save          → 검토된 할인 목록 → seasons.discounts
//   POST /functions/v1/admin?action=parse-seatmap → 좌석배치도 이미지 → Gemini → {floors, restricted_seats}
//   POST /functions/v1/admin?action=save-seatmap  → 검토된 배치도 → venues.base_geometry / restricted_seats
//
// 인증: POST 는 헤더 x-admin-password 가 ADMIN_PASSWORD 시크릿과 일치해야 통과.
//       별도 계정 없음. GET(페이지)은 무인증 — 그래서 이 함수는 "Verify JWT" 를 꺼야 한다.
//
// 필요한 env (Edge Function Secrets):
//   ADMIN_PASSWORD   ← 직접 등록. 폰에서 입력할 공유 비밀번호 하나.
//   GEMINI_API_KEY   ← 직접 등록 (aistudio.google.com)
//   GEMINI_MODEL     ← 선택, 기본 gemini-2.0-flash
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY ← 자동 주입됨
// =============================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_PASSWORD = Deno.env.get("ADMIN_PASSWORD") ?? "";
const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GEMINI_MODEL = Deno.env.get("GEMINI_MODEL") ?? "gemini-3.6-flash";

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-admin-password",
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

function timingSafeEqual(a: string, b: string) {
  const enc = new TextEncoder();
  const ba = enc.encode(a), bb = enc.encode(b);
  if (ba.length !== bb.length) return false;
  let out = 0;
  for (let i = 0; i < ba.length; i++) out |= ba[i] ^ bb[i];
  return out === 0;
}

function requireAdmin(req: Request) {
  if (!ADMIN_PASSWORD) throw new HttpError(500, "ADMIN_PASSWORD 시크릿이 설정되지 않았어요.");
  const given = req.headers.get("x-admin-password") ?? "";
  if (!timingSafeEqual(given, ADMIN_PASSWORD)) throw new HttpError(401, "비밀번호가 틀렸어요.");
}

// 블록 side → 통로/벽 위치. 기존 seed.js 규칙과 동일:
//   좌블 = 좌석번호 큰 쪽이 통로, 작은 쪽이 벽 / 우블은 반대 / 중블은 둘 다 없음
function blockDefaults(side: string) {
  if (side === "left") return { aisle_end: "max", wall_end: "min" };
  if (side === "right") return { aisle_end: "min", wall_end: "max" };
  return { aisle_end: null, wall_end: null };
}
type GradeZone = {
  floor: number;
  row_from: string | null;
  row_to: string | null;
  seat_from: number | null;
  seat_to: number | null;
  grade: string;
  source: string;
};

// 등급 구역을 그대로(펼치지 않고) 정리한다. data.js resolveSeat 가 구역을 평가한다.
//   { floor, row_from?, row_to?, seat_from?, seat_to?, grade }
//   같은 열에서도 가운데 VIP·양끝 R 처럼 좌석번호로 갈리는 경우를 담기 위해 seat 범위도 받는다.
function cleanGradeZones(zones: unknown): GradeZone[] {
  if (!Array.isArray(zones)) return [];
  const out: GradeZone[] = [];
  for (const z of zones) {
    const zz = z as {
      floor?: unknown; from_row?: unknown; to_row?: unknown;
      from_seat?: unknown; to_seat?: unknown; grade?: unknown;
    };
    const floor = Number(zz?.floor);
    const grade = String(zz?.grade ?? "").trim().toUpperCase();
    if (!Number.isFinite(floor) || !grade) continue;
    const rowFrom = String(zz?.from_row ?? "").trim().toUpperCase();
    const rowTo = String(zz?.to_row ?? "").trim().toUpperCase();
    const sf = Number(zz?.from_seat);
    const st = Number(zz?.to_seat);
    out.push({
      floor,
      row_from: rowFrom || null,
      row_to: rowTo || rowFrom || null,
      seat_from: Number.isFinite(sf) ? sf : null,
      seat_to: Number.isFinite(st) ? st : null,
      grade,
      source: "관리자 좌석배치도 판독",
    });
  }
  return out;
}

function aliasesFor(name: string, side: string, floor: string) {
  const n = String(name).toLowerCase().trim();
  const bySide: Record<string, string[]> = {
    left: ["좌", "왼", "왼쪽", "좌블", "좌측", "l"],
    center: ["중", "중앙", "센터", "가운데", "중블", "중블록", "c"],
    right: ["우", "오", "오른", "오른쪽", "우블", "우측", "r"],
  };
  const set = new Set<string>([n, ...(bySide[side] ?? [])]);
  if (floor && floor !== "1") set.add(floor + "층");
  return [...set].filter(Boolean);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    // ---- 안내 (이 함수는 JSON API 만. 관리자 화면은 앱의 admin.html) ----
    if (req.method === "GET" && !action) {
      return json({
        ok: true,
        info: "이 엔드포인트는 JSON API 입니다. 관리자 화면은 앱의 admin.html 에서 여세요.",
      });
    }

    if (req.method !== "POST") return json({ error: "알 수 없는 요청" }, 404);

    // 여기부터 전부 비밀번호 필요
    requireAdmin(req);

    // ---- 비밀번호 확인만 ----
    if (action === "auth") return json({ ok: true });

    // ---- 공연 목록 ----
    if (action === "seasons") {
      const { data, error } = await admin
        .from("seasons")
        .select("season_id, work_title, season_label, venue_id, discounts, discounts_verified, seat_grades")
        .order("work_title");
      if (error) throw new HttpError(500, error.message);
      return json({ seasons: data });
    }

    // ---- 극장 목록 ----
    if (action === "venues") {
      const { data, error } = await admin
        .from("venues")
        .select("venue_id, name, collected")
        .order("name");
      if (error) throw new HttpError(500, error.message);
      return json({ venues: data });
    }

    // ---- 할인표 판독 (저장 X) ----
    if (action === "parse") {
      if (!GEMINI_KEY) throw new HttpError(500, "GEMINI_API_KEY 가 설정되지 않았어요.");
      const { image_base64, mime_type } = await req.json();
      if (!image_base64) throw new HttpError(400, "이미지가 없습니다.");
      const discounts = await geminiExtractDiscounts(image_base64, mime_type ?? "image/jpeg");
      return json({ discounts });
    }

    // ---- 할인 저장 ----
    if (action === "save") {
      const { season_id, discounts } = await req.json();
      if (!season_id || !Array.isArray(discounts)) {
        throw new HttpError(400, "season_id 와 discounts 배열이 필요합니다.");
      }
      const clean = discounts
        .map((d) => {
          const at = ["ALL", "MATINEE", "EVENING"].includes(d?.applies_to) ? d.applies_to : "ALL";
          const note = String(d?.note ?? "").trim();
          const grades = Array.isArray(d?.grades)
            ? [...new Set(d.grades.map((g: unknown) => String(g).trim().toUpperCase()).filter(Boolean))]
            : [];
          const row: Record<string, unknown> = {
            name: String(d?.name ?? "").trim(),
            rate: Number(d?.rate),
            type: ["STANDING", "ELIGIBILITY", "LOYALTY"].includes(d?.type) ? d.type : "STANDING",
          };
          // 기본값은 저장하지 않는다 — seed 와 모양을 맞춤 (없으면 ALL / 전체등급으로 읽힘)
          if (at !== "ALL") row.applies_to = at;
          if (grades.length) row.grades = grades;
          if (note) row.note = note;
          return row;
        })
        .filter((d) => d.name && Number.isFinite(d.rate as number) && (d.rate as number) >= 0 && (d.rate as number) <= 100);
      if (!clean.length) throw new HttpError(400, "저장할 유효한 할인이 없습니다.");

      const { data, error } = await admin
        .from("seasons")
        .update({
          discounts: clean,
          discounts_verified: true,
          discounts_updated_at: new Date().toISOString(),
        })
        .eq("season_id", season_id)
        .select("season_id");
      if (error) throw new HttpError(500, error.message);
      if (!data?.length) throw new HttpError(404, `'${season_id}' 시즌이 없어요. 공연을 먼저 추가하세요.`);
      return json({ ok: true, season_id, saved: clean });
    }

    // ---- 좌석배치도 판독 (저장 X) ----
    if (action === "parse-seatmap") {
      if (!GEMINI_KEY) throw new HttpError(500, "GEMINI_API_KEY 가 설정되지 않았어요.");
      const { image_base64, mime_type } = await req.json();
      if (!image_base64) throw new HttpError(400, "이미지가 없습니다.");
      const result = await geminiExtractSeatmap(image_base64, mime_type ?? "image/jpeg");
      return json(result);
    }

    // ---- 좌석배치도 저장 (공연 기준 — 기하는 극장, 등급은 시즌) ----
    if (action === "save-seatmap") {
      const { season_id, floors, grade_zones, restricted_seats } = await req.json();
      if (!season_id || !floors || typeof floors !== "object") {
        throw new HttpError(400, "season_id 와 floors 객체가 필요합니다.");
      }
      const { data: seasonRow, error: seErr } = await admin
        .from("seasons")
        .select("season_id, venue_id")
        .eq("season_id", season_id)
        .single();
      const venue_id = (seasonRow as { venue_id?: string } | null)?.venue_id;
      if (seErr || !venue_id) {
        throw new HttpError(404, `'${season_id}' 시즌 또는 그 극장을 찾을 수 없어요.`);
      }

      const cleanFloors: Record<string, unknown[]> = {};
      for (const [f, blocks] of Object.entries(floors)) {
        if (!Array.isArray(blocks)) continue;
        const fk = String(f);
        const arr = blocks
          .map((b) => {
            const side = ["left", "center", "right"].includes((b as { side?: string })?.side ?? "")
              ? (b as { side: string }).side
              : "center";
            const d = blockDefaults(side);
            const bb = b as { name?: string; seat_min?: unknown; seat_max?: unknown };
            return {
              name: String(bb?.name ?? "").trim(),
              side,
              seat_min: Number(bb?.seat_min),
              seat_max: Number(bb?.seat_max),
              aisle_end: d.aisle_end,
              wall_end: d.wall_end,
              aliases: aliasesFor(String(bb?.name ?? ""), side, fk),
            };
          })
          .filter((b) => b.name && Number.isFinite(b.seat_min) && Number.isFinite(b.seat_max));
        if (arr.length) cleanFloors[fk] = arr;
      }
      if (!Object.keys(cleanFloors).length) {
        throw new HttpError(400, "저장할 유효한 블록이 없습니다.");
      }

      // data.js 는 restricted_seats 를 { floor, row, numbers:[...] } 로 매칭한다.
      // block/reason 은 부가정보로만 남긴다 (소비 계층은 무시).
      const cleanRestricted = Array.isArray(restricted_seats)
        ? restricted_seats
            .map((r) => {
              const rr = r as
                { floor?: unknown; block?: unknown; row?: unknown; number?: unknown; numbers?: unknown; reason?: unknown };
              const nums = Array.isArray(rr?.numbers)
                ? rr.numbers
                : (rr?.number != null ? [rr.number] : []);
              return {
                floor: Number.isFinite(Number(rr?.floor)) ? Number(rr.floor) : null,
                block: rr?.block ? String(rr.block).trim() : null,
                row: rr?.row ? String(rr.row).trim().toUpperCase() : null,
                numbers: (nums as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n)),
                reason: rr?.reason ? String(rr.reason).trim() : null,
                source: "관리자 좌석배치도 판독",
              };
            })
            .filter((r) => r.floor != null || r.block)
        : [];

      const { data: cur, error: curErr } = await admin
        .from("venues")
        .select("base_geometry")
        .eq("venue_id", venue_id)
        .single();
      if (curErr) throw new HttpError(404, `'${venue_id}' 극장이 없어요.`);

      const bg: Record<string, unknown> = (cur?.base_geometry && typeof cur.base_geometry === "object")
        ? cur.base_geometry as Record<string, unknown>
        : {};
      bg.floors = cleanFloors;
      bg.is_estimate = false;
      bg.note = "관리자 좌석배치도 판독 (검토 완료) " + new Date().toISOString().slice(0, 10);

      const { data, error } = await admin
        .from("venues")
        .update({ base_geometry: bg, restricted_seats: cleanRestricted, collected: true })
        .eq("venue_id", venue_id)
        .select("venue_id");
      if (error) throw new HttpError(500, error.message);
      if (!data?.length) throw new HttpError(404, `'${venue_id}' 극장 저장 실패.`);

      // 등급 구역 → 시즌 seat_grades 에 저장 (등급 레이아웃은 공연마다 다름)
      const seatGrades = cleanGradeZones(grade_zones);
      if (seatGrades.length) {
        const { error: sgErr } = await admin
          .from("seasons")
          .update({ seat_grades: seatGrades })
          .eq("season_id", season_id);
        if (sgErr) throw new HttpError(500, sgErr.message);
      }

      return json({
        ok: true, season_id, venue_id,
        floors: cleanFloors, restricted_seats: cleanRestricted,
        seat_grades: seatGrades.length,
      });
    }

    return json({ error: "알 수 없는 요청" }, 404);
  } catch (e) {
    const err = e as HttpError;
    return json({ error: err?.message ?? String(e) }, err?.status ?? 500);
  }
});

// ---- Gemini 비전: 할인표 → [{name, rate, type, applies_to, note}] ---------
async function geminiExtractDiscounts(b64: string, mime: string) {
  const prompt =
`이 이미지는 한국 공연 예매처의 '할인 정보' 화면이다. 화면에 실제로 보이는 할인 항목만 추출하라.
- name: 할인명 그대로 (예: "조기예매 할인", "청소년")
- rate: 할인율. 정수 퍼센트만 (예: 30). "%" 제외. 범위로 적혀 있으면 낮은 값.
- type:
  - STANDING     조건 없이 누구나·상시 (조기예매/조조/문화가있는날/마티네/멤버십)
  - ELIGIBILITY  자격 증빙 필요 (청소년/대학생/경로/장애인/국가유공자/다자녀)
  - LOYALTY      재관람자 전용 (재관람 할인/도장/쿠폰팩)
- applies_to: 특정 회차에만 적용되면 표시.
  - MATINEE   낮공(마티네) 전용
  - EVENING   밤공 전용
  - ALL       회차 제한 없음 (대부분)
- grades: 특정 좌석등급에만 적용되면 그 등급 코드 배열 (예 ["R","S"], ["S","A"]). 전 좌석이면 빈 배열 [].
- note: 적용 기간·조건이 적혀 있으면 그 문구를 짧게 그대로 (예 "2/28까지", "월·수 공연", "학생증 지참"). 없으면 빈 문자열.

**중요 — 같은 할인이라도 등급별로 할인율이 다르면 각 등급 구간을 별도 항목으로 쪼개라:**
- 예1) "조기예매 할인: VIP·R석 10%, S·A석 20%"
  → { name:"조기예매 할인", rate:10, grades:["VIP","R"], ... } 와
    { name:"조기예매 할인", rate:20, grades:["S","A"], ... } 두 개
- 예2) "초·중·고 할인: S·A석만 50%"
  → { name:"초중고 할인", rate:50, type:"ELIGIBILITY", grades:["S","A"], ... } 한 개 (grades 채움)
- 대학생과 초중고는 조건이 달라 항상 별도 항목.

- 애매하면 type=STANDING, applies_to=ALL, grades=[]. 이미지에 없는 항목은 만들지 마라.`;

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
            applies_to: { type: "STRING", enum: ["ALL", "MATINEE", "EVENING"] },
            grades: { type: "ARRAY", items: { type: "STRING" } },
            note: { type: "STRING" },
          },
          required: ["name", "rate", "type", "applies_to", "grades", "note"],
        },
      },
    },
  };

  const arr = await geminiJson(body);
  return Array.isArray(arr) ? arr : [];
}

// ---- Gemini 비전: 좌석배치도 → {floors:[...], restricted_seats:[...]} ------
async function geminiExtractSeatmap(b64: string, mime: string) {
  const prompt =
`이 이미지는 한국 공연장의 좌석배치도다. 배치도에 실제로 보이는 정보만 추출하라. 못 읽으면 비운다. 추측 금지.
- floors: 층·블록 목록. 각 항목:
  - floor: 층 번호 (1, 2, 3)
  - name: 배치도에 표기된 구역명 그대로 (예 "OP", "A블록", "1층 중앙")
  - side: 무대에서 객석을 봤을 때 "left" | "center" | "right"
  - seat_min, seat_max: 그 블록의 좌석 번호 범위 (정수). 범위를 못 읽으면 그 블록은 넣지 마라.
- grade_zones: 좌석 등급(색상/범례로 구분)을 구역으로. 각 구역:
  - floor: 층 번호
  - from_row, to_row: 그 등급 구역의 열 범위 라벨 그대로 (예 "A"~"M", "1"~"12"). 전 열이면 비운다.
  - from_seat, to_seat: **같은 열에서도 좌석번호로 등급이 갈리면** 그 번호 범위 (예 가운데 3~18 = VIP,
    양끝 1~2·19~20 = R). 좌석번호 제한이 없으면 비운다.
  - grade: 등급 코드 (VIP / R / S / A / B). 범례에서 색→등급을 읽어라.
  나뉘는 방식이 여러 개면(앞뒤로도 나뉘고 좌우로도 나뉨) 구역을 여러 개로 쪼개라. 등급 정보 없으면 빈 배열.
- restricted_seats: 배치도에 '시야제한', '시야제한석', '제한관람', 'restricted' 등으로 표시된 좌석/구역:
  - floor, block(구역명), row(열), numbers(해당 열의 좌석번호 배열), reason. 행·번호가 특정되지 않으면 block 만 채운다.`;

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
        type: "OBJECT",
        properties: {
          floors: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                floor: { type: "INTEGER" },
                name: { type: "STRING" },
                side: { type: "STRING", enum: ["left", "center", "right"] },
                seat_min: { type: "INTEGER" },
                seat_max: { type: "INTEGER" },
              },
              required: ["floor", "name", "side", "seat_min", "seat_max"],
            },
          },
          grade_zones: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                floor: { type: "INTEGER" },
                from_row: { type: "STRING" },
                to_row: { type: "STRING" },
                from_seat: { type: "INTEGER" },
                to_seat: { type: "INTEGER" },
                grade: { type: "STRING" },
              },
              required: ["floor", "grade"],
            },
          },
          restricted_seats: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                floor: { type: "INTEGER" },
                block: { type: "STRING" },
                row: { type: "STRING" },
                numbers: { type: "ARRAY", items: { type: "INTEGER" } },
                reason: { type: "STRING" },
              },
              required: ["floor"],
            },
          },
        },
        required: ["floors", "grade_zones", "restricted_seats"],
      },
    },
  };

  const obj = await geminiJson(body);
  return {
    floors: Array.isArray(obj?.floors) ? obj.floors : [],
    grade_zones: Array.isArray(obj?.grade_zones) ? obj.grade_zones : [],
    restricted_seats: Array.isArray(obj?.restricted_seats) ? obj.restricted_seats : [],
  };
}

// deno-lint-ignore no-explicit-any
async function geminiJson(body: unknown): Promise<any> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new HttpError(502, `Gemini 오류 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "null";
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(502, "Gemini 응답을 해석하지 못했어요. 다시 시도해보세요.");
  }
}
