/* =============================================================
   data/pull.js — Supabase → data/seed.remote.js 생성 (의존성 0, 순수 node)

   실행:  npm run pull        (= node data/pull.js)

   ▶ 무엇을 하나
     .env 의 SUPABASE_URL + publishable 키로 REST(PostgREST)를 읽어
     venues / seasons 두 테이블을 당긴 뒤,
     브라우저가 <script> 로 읽는 data/seed.remote.js 를 새로 쓴다.
     (seatmaps 테이블은 안 읽는다 — 아무도 안 써서 항상 비어 있다. seed.live.js 참고.)

   ▶ 왜 이런 구조인가 (PRD §9.2)
     "상담 시점에는 크롤링하지 않고 DB 조회만 한다."
     data.js 는 window.GON_* 를 동기적으로 읽으므로, 네트워크는
     여기(빌드 시점)서 끝내고 브라우저에는 정적 파일만 남긴다.
     file:// 로 열어도, 회귀 하네스(test/run.js)를 돌려도 그대로 동작한다.

   ▶ 병합 규칙
     seed.js(폴백) 위에 Supabase 값을 덮는다. venue_id / season_id 가
     같으면 교체, 없으면 추가. seed.js 에만 있는 항목은 유지 → 테스트 픽스처
     (해몽가 B16 통로석 등)가 깨지지 않는다.
   ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'seed.remote.js');

/* ---- .env 파서 (외부 패키지 없이) ------------------------------- */
function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) die('.env 가 없습니다. .env.example 을 복사해서 채우세요.');
  const env = {};
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return env;
}

// process.exit() 를 fetch 대기 중에 부르면 Windows/undici 에서 libuv assertion 이
// 난다. 그래서 즉시 종료하지 않고 exitCode 만 세운 뒤 예외를 던져 위로 전파한다.
function die(msg) { const e = new Error(msg); e.isDie = true; throw e; }

/* ---- REST 조회 --------------------------------------------------- */
async function rest(base, key, table) {
  const url = `${base.replace(/\/$/, '')}/rest/v1/${table}?select=*`;
  const res = await fetch(url, {
    headers: { apikey: key, Authorization: `Bearer ${key}`, Connection: 'close' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    die(`${table} 조회 실패 (HTTP ${res.status}) ${body.slice(0, 300)}`);
  }
  return res.json();
}

/* ---- 행 → seed.js 형태 ---------------------------------------- */
const VENUE_KEYS = ['venue_id', 'name', 'nearest_station', 'last_transit_time',
  'row_label_system', 'alpha_continues_across_floors', 'specs', 'base_geometry',
  'verified_seats', 'restricted_seats', 'collected'];
const SEASON_KEYS = ['season_id', 'work_title', 'season_label', 'venue_id',
  'open_date', 'close_date', 'running_time', 'has_intermission', 'prices',
  'prices_verified', 'discounts', 'discounts_verified', 'discounts_updated_at',
  'discount_proof_policy', 'seat_grades', 'aisle_seats', 'restricted_seats', 'side_seats',
  'cross_aisles', 'cancellation_policy', 'source'];

const pick = (row, keys) => {
  const o = {};
  for (const k of keys) if (k in row) o[k] = row[k];
  return o;
};

(async () => {
  const env = loadEnv();
  const base = env.SUPABASE_URL;
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY;
  if (!base || !key) die('SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY 를 .env 에 채우세요.');

  console.log('· Supabase:', base);
  // 순차 조회 — 첫 실패에서 나머지 요청이 붕 뜬 채 종료되는 것을 피한다.
  const venues = await rest(base, key, 'venues');
  const seasons = await rest(base, key, 'seasons');
  console.log(`· venues ${venues.length} · seasons ${seasons.length}`);
  if (!venues.length && !seasons.length) {
    die('테이블이 비어 있습니다. data/schema.sql 을 먼저 실행하고 작품을 넣으세요.');
  }

  const V = {};
  for (const r of venues) V[r.venue_id] = pick(r, VENUE_KEYS);
  const S = seasons.map((r) => pick(r, SEASON_KEYS));

  const banner =
`/* ⚠ 자동 생성 — 직접 편집 금지. 'npm run pull' 이 Supabase 에서 새로 씁니다.
   생성 시각: ${new Date().toISOString()}
   출처: ${base}
   병합: seed.js(폴백) 위에 venue_id / season_id 단위로 덮어씀. */`;

  const body =
`${banner}
(function () {
  "use strict";
  var V = ${JSON.stringify(V, null, 2)};
  var S = ${JSON.stringify(S, null, 2)};

  window.GON_VENUES = Object.assign({}, window.GON_VENUES || {}, V);

  var byId = {};
  (window.GON_SEASONS || []).forEach(function (s) { byId[s.season_id] = s; });
  S.forEach(function (s) { byId[s.season_id] = s; });
  window.GON_SEASONS = Object.keys(byId).map(function (k) { return byId[k]; });

  if (typeof console !== "undefined") {
    console.info("[GON] Supabase 오버레이 적용:",
      Object.keys(V).length + " venues, " + S.length + " seasons");
  }
})();
`;

  fs.writeFileSync(OUT, body);
  console.log('✓ ' + path.relative(ROOT, OUT) + ' 갱신');
})().catch((e) => {
  console.error('✗ ' + (e && e.isDie ? e.message : (e && e.stack) || e));
  process.exitCode = 1;
});
