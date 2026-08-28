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
//   POST /functions/v1/admin?action=parse-seatmap → 좌석배치도 이미지 → Gemini → {memo}
//   POST /functions/v1/admin?action=parse-seatmap-grid → 배치도 이미지 → Gemini → {floors:[{floor,rows:[{label,min,max}]}]} (색칠용 뼈대)
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
  row_parity: "even" | "odd" | null;
  seat_from: number | null;
  seat_to: number | null;
  grade: string;
  source: string;
};
function parityOf(v: unknown): "even" | "odd" | null {
  return v === "even" || v === "odd" ? v : null;
}

// 등급 구역을 그대로(펼치지 않고) 정리한다. data.js resolveSeat 가 구역을 평가한다.
//   { floor, row_from?, row_to?, seat_from?, seat_to?, grade }
//   같은 열에서도 가운데 VIP·양끝 R 처럼 좌석번호로 갈리는 경우를 담기 위해 seat 범위도 받는다.
function cleanGradeZones(zones: unknown): GradeZone[] {
  if (!Array.isArray(zones)) return [];
  const out: GradeZone[] = [];
  for (const z of zones) {
    const zz = z as {
      floor?: unknown; from_row?: unknown; to_row?: unknown; row_parity?: unknown;
      from_seat?: unknown; to_seat?: unknown; grade?: unknown;
    };
    const floor = Number(zz?.floor);
    const grade = String(zz?.grade ?? "").trim().toUpperCase();
    if (!Number.isFinite(floor) || !grade) continue;
    const rowFrom = String(zz?.from_row ?? "").trim().toUpperCase();
    const rowTo = String(zz?.to_row ?? "").trim().toUpperCase();
    const posInt = (v: unknown) => {
      if (v == null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    };
    out.push({
      floor,
      row_from: rowFrom || null,
      row_to: rowTo || rowFrom || null,
      row_parity: parityOf(zz?.row_parity),
      seat_from: posInt(zz?.from_seat),
      seat_to: posInt(zz?.to_seat),
      grade,
      source: "관리자 좌석배치도 판독",
    });
  }
  return out;
}

// [{floor, row_from?/from_row?, row_to?/to_row?, numbers:[...]}] 정리 (통로·시야제한 공용)
function cleanNumberZones(zones: unknown) {
  if (!Array.isArray(zones)) return [];
  const out: Array<{ floor: number; row_from: string | null; row_to: string | null; row_parity: "even" | "odd" | null; numbers: number[]; source: string }> = [];
  for (const z of zones) {
    const zz = z as { floor?: unknown; row_from?: unknown; from_row?: unknown; row_to?: unknown; to_row?: unknown; row_parity?: unknown; numbers?: unknown };
    const floor = Number(zz?.floor);
    if (!Number.isFinite(floor)) continue;
    const nums = Array.isArray(zz?.numbers)
      ? [...new Set((zz.numbers as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))]
      : [];
    if (!nums.length) continue;
    const rf = String((zz?.row_from ?? zz?.from_row) ?? "").trim().toUpperCase();
    const rt = String((zz?.row_to ?? zz?.to_row) ?? "").trim().toUpperCase();
    out.push({ floor, row_from: rf || null, row_to: rt || rf || null, row_parity: parityOf(zz?.row_parity), numbers: nums, source: "관리자 좌석배치도 판독" });
  }
  return out;
}

// 극싸/사이드: 번호 구역 + zone('EDGE'|'SIDE')
function cleanSideZones(zones: unknown) {
  if (!Array.isArray(zones)) return [];
  const out: Array<{ floor: number; row_from: string | null; row_to: string | null; row_parity: "even" | "odd" | null; numbers: number[]; zone: "EDGE" | "SIDE"; source: string }> = [];
  for (const z of zones) {
    const zz = z as { floor?: unknown; row_from?: unknown; from_row?: unknown; row_to?: unknown; to_row?: unknown; row_parity?: unknown; numbers?: unknown; zone?: unknown };
    const floor = Number(zz?.floor);
    if (!Number.isFinite(floor)) continue;
    const nums = Array.isArray(zz?.numbers)
      ? [...new Set((zz.numbers as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))]
      : [];
    if (!nums.length) continue;
    const rf = String((zz?.row_from ?? zz?.from_row) ?? "").trim().toUpperCase();
    const rt = String((zz?.row_to ?? zz?.to_row) ?? "").trim().toUpperCase();
    const zn = String(zz?.zone ?? "").trim().toUpperCase();
    out.push({
      floor, row_from: rf || null, row_to: rt || rf || null,
      row_parity: parityOf(zz?.row_parity), numbers: nums,
      zone: zn === "EDGE" ? "EDGE" : "SIDE",
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
      // aisle_seats / restricted_seats 는 신규 컬럼 — 아직 마이그레이션 안 했어도 목록은 떠야 하므로
      // 먼저 넓게 시도하고, 실패하면 기본 컬럼만.
      const wide = await admin
        .from("seasons")
        .select("season_id, work_title, season_label, venue_id, discounts, discounts_verified, seat_grades, aisle_seats, restricted_seats, side_seats")
        .order("work_title");
      if (!wide.error) return json({ seasons: wide.data });
      const narrow = await admin
        .from("seasons")
        .select("season_id, work_title, season_label, venue_id, discounts, discounts_verified, seat_grades")
        .order("work_title");
      if (narrow.error) throw new HttpError(500, narrow.error.message);
      return json({ seasons: narrow.data, needs_migration: true });
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
          const at = ["ALL", "LIMITED"].includes(d?.applies_to) ? d.applies_to
            : (d?.applies_to === "MATINEE" || d?.applies_to === "EVENING") ? d.applies_to  // 레거시 보존
            : "ALL";
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

    // ---- 좌석배치도 판독 (저장 X) — 사람이 고칠 초안 문단을 준다 ----
    if (action === "parse-seatmap") {
      if (!GEMINI_KEY) throw new HttpError(500, "GEMINI_API_KEY 가 설정되지 않았어요.");
      const { image_base64, mime_type } = await req.json();
      if (!image_base64) throw new HttpError(400, "이미지가 없습니다.");
      const result = await geminiExtractSeatmapMemo(image_base64, mime_type ?? "image/jpeg");
      return json(result);
    }

    // ---- 좌석배치도 → 색칠용 그리드 뼈대 (층 / 열 목록 / 열별 좌석범위) ----
    if (action === "parse-seatmap-grid") {
      if (!GEMINI_KEY) throw new HttpError(500, "GEMINI_API_KEY 가 설정되지 않았어요.");
      const { image_base64, mime_type } = await req.json();
      if (!image_base64) throw new HttpError(400, "이미지가 없습니다.");
      const grid = await geminiExtractSeatmapGrid(image_base64, mime_type ?? "image/jpeg");
      return json(grid);
    }

    // ---- 좌석배치도 저장 (공연 기준 — 기하는 극장, 등급·통로·시야제한은 시즌) ----
    if (action === "save-seatmap") {
      const { season_id, floors, grade_zones, aisle_seats, restricted_zones, side_seats } = await req.json();
      if (!season_id) throw new HttpError(400, "season_id 가 필요합니다.");
      const floorsObj = (floors && typeof floors === "object") ? floors : {};
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
      for (const [f, blocks] of Object.entries(floorsObj)) {
        if (!Array.isArray(blocks)) continue;
        const fk = String(f);
        const arr = blocks
          .map((b) => {
            const side = ["left", "center", "right"].includes((b as { side?: string })?.side ?? "")
              ? (b as { side: string }).side
              : "center";
            const d = blockDefaults(side);
            const bb = b as { name?: string; seat_min?: unknown; seat_max?: unknown; row_from?: unknown; row_to?: unknown };
            const rf = String(bb?.row_from ?? "").trim().toUpperCase();
            const rt = String(bb?.row_to ?? "").trim().toUpperCase();
            const row: Record<string, unknown> = {
              name: String(bb?.name ?? "").trim(),
              side,
              seat_min: Number(bb?.seat_min),
              seat_max: Number(bb?.seat_max),
              aisle_end: d.aisle_end,
              wall_end: d.wall_end,
              aliases: aliasesFor(String(bb?.name ?? ""), side, fk),
            };
            if (rf) row.row_from = rf;
            if (rt || rf) row.row_to = rt || rf;
            return row;
          })
          .filter((b) => b.name && Number.isFinite(b.seat_min) && Number.isFinite(b.seat_max));
        if (arr.length) cleanFloors[fk] = arr;
      }
      const hasGeometry = Object.keys(cleanFloors).length > 0;

      // 블록(기하)이 있을 때만 극장 정보를 갱신한다.
      if (hasGeometry) {
        const { data: cur, error: curErr } = await admin
          .from("venues")
          .select("base_geometry")
          .eq("venue_id", venue_id)
          .single();
        if (curErr) throw new HttpError(404, `'${venue_id}' 극장이 없어요.`);

        const bg: Record<string, unknown> = (cur?.base_geometry && typeof cur.base_geometry === "object")
          ? cur.base_geometry as Record<string, unknown>
          : {};
        // 층별 병합 — 메모에 없는 층의 블록은 그대로 둔다 (한 층만 고칠 때 나머지가 안 날아감)
        const prevFloors = (bg.floors && typeof bg.floors === "object") ? bg.floors as Record<string, unknown> : {};
        bg.floors = { ...prevFloors, ...cleanFloors };
        bg.is_estimate = false;
        bg.note = "관리자 좌석배치도 판독 (검토 완료) " + new Date().toISOString().slice(0, 10);

        const { error } = await admin
          .from("venues")
          .update({ base_geometry: bg, collected: true })
          .eq("venue_id", venue_id);
        if (error) throw new HttpError(500, error.message);
      }

      // 등급·통로·시야제한 → 시즌. 배열을 명시적으로 보냈으면(빈 배열 포함) 그대로 반영.
      const seasonUpdate: Record<string, unknown> = {};
      const seatGrades = cleanGradeZones(grade_zones);
      if (Array.isArray(grade_zones)) seasonUpdate.seat_grades = seatGrades;
      const aisleZones = cleanNumberZones(aisle_seats);
      if (Array.isArray(aisle_seats)) seasonUpdate.aisle_seats = aisleZones;
      const restrZones = cleanNumberZones(restricted_zones);
      if (Array.isArray(restricted_zones)) seasonUpdate.restricted_seats = restrZones;
      const sideZones = cleanSideZones(side_seats);
      if (Array.isArray(side_seats)) seasonUpdate.side_seats = sideZones;

      if (Object.keys(seasonUpdate).length) {
        const { error: seuErr } = await admin
          .from("seasons").update(seasonUpdate).eq("season_id", season_id);
        if (seuErr) {
          if (/aisle_seats|restricted_seats|side_seats|column/i.test(seuErr.message)) {
            throw new HttpError(400,
              "seasons 에 신규 컬럼이 없어요. SQL Editor 에서:\n" +
              "alter table seasons\n" +
              "  add column if not exists aisle_seats jsonb default '[]'::jsonb,\n" +
              "  add column if not exists restricted_seats jsonb default '[]'::jsonb,\n" +
              "  add column if not exists side_seats jsonb default '[]'::jsonb;");
          }
          throw new HttpError(500, seuErr.message);
        }
      }

      if (!hasGeometry && !Object.keys(seasonUpdate).length) {
        throw new HttpError(400, "저장할 내용이 없습니다.");
      }

      return json({
        ok: true, season_id, venue_id,
        seat_grades: seatGrades.length, aisle_seats: aisleZones.length,
        restricted: restrZones.length, side_seats: sideZones.length,
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
- applies_to: "LIMITED" (프리뷰 / 문화가있는날 / "N회차에 한해" / 수·금 낮공 등 특정 회차·날짜만.
  note 에 회차 조건이 있으면 대개 LIMITED) 또는 "ALL" (제한 없음, 대부분).
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
            applies_to: { type: "STRING", enum: ["ALL", "LIMITED"] },
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

// ---- Gemini 비전: 좌석배치도 → 사람이 고칠 초안 문단 (구조화 X) --------------
// 색→등급, 통로 위치는 비전이 부정확하다. 관리자가 아래 형식으로 고쳐 다시 낸다.
async function geminiExtractSeatmapMemo(b64: string, mime: string) {
  const prompt =
`이 이미지는 한국 공연장의 좌석배치도다. 보이는 것만, 아래 형식의 줄로만 출력하라. 못 읽으면 그 줄은 생략. 설명·머리말 없이.
한 줄 = 한 층·한 열컨텍스트. 층은 단독 줄로 "1층" 처럼.

# 블록 (앞열이 좁은 부채꼴이면 열범위별로 여러 줄)
블록 좌 <시작>-<끝> / 중 <시작>-<끝> / 우 <시작>-<끝>
<시작열>-<끝열>열 블록 좌 <시작>-<끝> / 중 <시작>-<끝> / 우 <시작>-<끝>

# 등급 (열범위 생략 = 전 열, 등급만 쓰면 그 열 전체)
<시작열>-<끝열>열 <시작번>-<끝번>번 <등급> / <시작번>-<끝번>번 <등급> / <등급>

# 통로 / 시야제한 / 극싸·사이드 (그 열범위의 해당 좌석번호)
<시작열>-<끝열>열 통로 <번호>,<번호>
<시작열>-<끝열>열 시야제한 <번호>,<번호>
<시작열>-<끝열>열 극싸 <번호>,<번호>       (벽 쪽 끝 1~2자리)
<시작열>-<끝열>열 사이드 <번호>,<번호>     (벽 쪽 안쪽)

예:
1층
블록 좌 1-8 / 중 9-40 / 우 41-48
1-15열 9-14번 R / 15-34번 VIP / 35-40번 R
1-15열 통로 8,9,40,41
2층
A-M열 S`;

  const data = await geminiText(prompt, b64, mime);
  return { memo: String(data || "").trim() };
}

// ---- Gemini 비전: 좌석배치도 → 색칠용 그리드 뼈대 -------------------------
// 색·등급은 안 읽는다(비전이 부정확). 층 / 열 목록 / 열별 좌석 최소~최대 번호만.
// 사람이 그 위에 등급을 색칠하고, admin.html 이 열별 스캔으로 구역을 만든다.
async function geminiExtractSeatmapGrid(b64: string, mime: string) {
  const prompt =
`이 이미지는 한국 공연장의 좌석배치도다. 좌석의 '뼈대'만 읽어라. 색이나 등급은 읽지 마라.
- floor: 층 번호 (1, 2, 3 …). 한 층만 보이면 1.
- rows: 그 층의 열 목록을 무대에서 가까운 순으로. label 은 배치도에 적힌 그대로 ("1","2"… 또는 "A","B"…).
- 각 열의 min / max: 그 열에 실제 있는 좌석 번호의 최소·최대.
  앞열이 좁고 뒷열이 넓은 부채꼴이면 열마다 다르게 잡아라.
  번호를 정확히 못 읽으면 그 층에서 가장 넓은 열 기준으로 같은 값을 넣어라.
- 가운데 통로로 번호가 비어 있어도 min~max 는 끊지 말고 이어서 잡아라 (빈 칸은 사람이 지운다).
실제로 보이는 층·열만. 추측으로 열 수를 늘리지 마라.`;

  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: prompt }] }],
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
                rows: {
                  type: "ARRAY",
                  items: {
                    type: "OBJECT",
                    properties: {
                      label: { type: "STRING" },
                      min: { type: "INTEGER" },
                      max: { type: "INTEGER" },
                    },
                    required: ["label", "min", "max"],
                  },
                },
              },
              required: ["floor", "rows"],
            },
          },
        },
        required: ["floors"],
      },
    },
  };

  // deno-lint-ignore no-explicit-any
  const out = await geminiJson(body) as any;
  const floors = Array.isArray(out?.floors) ? out.floors : [];
  return {
    // deno-lint-ignore no-explicit-any
    floors: floors.map((f: any) => ({
      floor: Number(f?.floor) || 1,
      // deno-lint-ignore no-explicit-any
      rows: (Array.isArray(f?.rows) ? f.rows : []).map((r: any) => {
        const mn = Math.max(1, Math.round(Number(r?.min) || 1));
        let mx = Math.max(mn, Math.round(Number(r?.max) || mn));
        if (mx - mn > 200) mx = mn + 200;
        return { label: String(r?.label ?? "").trim(), min: mn, max: mx };
      // deno-lint-ignore no-explicit-any
      }).filter((r: any) => r.label),
    // deno-lint-ignore no-explicit-any
    })).filter((f: any) => f.rows.length),
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

// 이미지 + 프롬프트 → 평문 텍스트
async function geminiText(prompt: string, b64: string, mime: string): Promise<string> {
  const body = {
    contents: [{
      parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: prompt }],
    }],
  };
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (!res.ok) {
    throw new HttpError(502, `Gemini 오류 ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
