/* =============================================================
   test/run.js — 회귀 테스트 (의존성 0, 순수 node)

   실행:  node test/run.js        (또는  npm test)

   ▶ 무엇을 하나
     data/seed.js · data.js · engine.js 를 VM 컨텍스트에 얹고,
     - GON_DB 조회 함수들의 입출력 (Supabase 스왑 시 계약 유지 확인용)
     - engine.runConsult 의 결론·축 점수 스냅샷
     - 에이전트 출력 계약 (푯말 16자 / detail 100~180자 / axis 범위)
     을 검사한다.

   ▶ 네트워크 호출·API·과금 전혀 없음.
     engine.js 는 목업 규칙 엔진이라 전부 로컬 결정론 계산이다.
     runConsult 를 실제 LLM API 로 바꾸더라도, 이 테스트는 그 호출을
     타지 않도록 스텁 번들만 쓴다.

   ▶ 스냅샷 값(EXPECT_*)은 "지금 동작"을 고정한 것이다. test_cases.md 의
     "정답 축 점수"(이상값)와는 다르며, 의도한 변경이면 값을 갱신한다.
   ============================================================= */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ctx = { console, Math, Date, setTimeout, clearTimeout, location: { search: '' } };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['data/seed.js', 'data.js', 'engine.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const GON = ctx.window.GON;
const DB = ctx.window.GON_DB;

/* ---- 미니 어서션 하네스 ---------------------------------- */
let pass = 0, fail = 0;
const fails = [];
function ok(cond, msg) { if (cond) pass++; else { fail++; fails.push(msg); } }
function eq(got, want, msg) {
  ok(JSON.stringify(got) === JSON.stringify(want),
     `${msg}\n      got  ${JSON.stringify(got)}\n      want ${JSON.stringify(want)}`);
}
function section(name) { console.log('\n— ' + name); }

/* ============================================================
   1. GON_DB — 좌석/열/가격 조회 (Supabase 스왑 시 계약 유지 대상)
   ============================================================ */
section('GON_DB 유틸');

// 열 표기 해석
eq(DB.rowIndex('B', { row_label_system: 'ALPHA' }), 2, 'rowIndex ALPHA B');
eq(DB.rowIndex('6', { row_label_system: 'NUMERIC' }), 6, 'rowIndex NUMERIC 6');
eq(DB.rowIndex('다', null), 3, 'rowIndex 한글 다');
eq(DB.rowIndex('Z9', { row_label_system: 'ALPHA' }), null, 'rowIndex 잘못된 표기 → null');

// 밴드 판정 (data.js §1.4)
eq(DB.band(0), 2, 'band 0 → 2');
eq(DB.band(-10), 1, 'band -10 → 1');
eq(DB.band(-20), 0, 'band -20 → 0');
eq(DB.band(-30), -1, 'band -30 → -1');
eq(DB.band(null), null, 'band null → null');

// 할인율 역산
eq(DB.discountRate(70000, 49000), 30, 'discountRate 70000→49000 = 30%');
eq(DB.discountRate(70000, 70000), 0, 'discountRate 동일 → 0');
eq(DB.discountRate(0, 100), null, 'discountRate 정가 0 → null');

// 시즌 조회 + 진행도
const haemong = DB.findSeason('해몽가', '2026-07-30');
ok(haemong && haemong.season_id === '1haemong', 'findSeason 해몽가 2026');
eq(DB.findSeason('없는작품'), null, 'findSeason 미존재 → null');
const prog = DB.seasonProgress({ open_date: '2026-06-25', close_date: '2026-09-13' }, '2026-07-25');
ok(prog > 0.3 && prog < 0.45, `seasonProgress 한 달차 ≈ 0.37 (got ${prog})`);

// 정가 조회
const lp = DB.listPrice(haemong, 'R');
eq(lp && lp.price, 70000, 'listPrice 해몽가 R = 70000');
// 시즌에 등급이 하나뿐이면 등급을 몰라도 그것으로 폴백한다 (data.js 주석)
eq(DB.listPrice(haemong, 'ZZZ').price, 70000, 'listPrice 단일 등급 시즌 → 폴백');
eq(DB.listPrice(null, 'R'), null, 'listPrice 시즌 없음 → null');

// seat_grades 구역 매칭 — 열범위 + 좌석번호범위, 좁은 구역 우선
const gz = {
  season_id: 'gz-test', work_title: 'GZ', venue_id: 'yes24-stage-1',
  prices: { VIP: 180000, R: 150000 },
  seat_grades: [
    { floor: 1, row_from: 'A', row_to: 'V', grade: 'VIP' },           // 넓은 구역
    { floor: 1, row_from: 'A', row_to: 'V', seat_from: 1, seat_to: 2, grade: 'R' },   // 양끝
    { floor: 1, row_from: 'A', row_to: 'V', seat_from: 19, seat_to: 20, grade: 'R' },
  ],
};
eq(DB.resolveSeat(gz, { floor: 1, row: 'C', number: 10 }).grade, 'VIP', 'seat_grades 가운데 → VIP');
eq(DB.resolveSeat(gz, { floor: 1, row: 'C', number: 1 }).grade, 'R', 'seat_grades 왼쪽 끝 → R (좁은 구역 우선)');
eq(DB.resolveSeat(gz, { floor: 1, row: 'C', number: 20 }).grade, 'R', 'seat_grades 오른쪽 끝 → R');
eq(DB.resolveSeat(gz, { floor: 1, row: 'C', number: null }).grade, 'VIP', '번호 없으면 열 구역만 → VIP');
eq(DB.resolveSeat(gz, { floor: 2, row: 'C', number: 1 }).grade, null, '다른 층 → 구역 없음');
eq(DB.resolveSeat({ seat_grades: [{ floor: 1, row: 'B', grade: 'S' }] }, { floor: 1, row: 'b', number: 3 }).grade,
   'S', '구식 {floor,row,grade} 형태도 매칭');

// resolveSeat — 등급/통로/시야제한 + 사이드
const rs = DB.resolveSeat(haemong, { floor: 1, row: 'B', number: 16 });
eq(rs.is_aisle, true, 'resolveSeat B16 통로석 (verified_seats)');
eq(rs.grade, null, 'resolveSeat 등급 미수집 → null (false 아님)');

// season.aisle_seats — 관리자가 배치도 보고 적은 통로 좌석
const asz = { venue_id: 'yes24-stage-1', aisle_seats: [{ floor: 1, row_from: 'A', row_to: 'Z', numbers: [11, 12] }] };
eq(DB.resolveSeat(asz, { floor: 1, row: 'C', number: 11 }).is_aisle, true, 'aisle_seats 매칭 → true');
eq(DB.resolveSeat(asz, { floor: 1, row: 'C', number: 15 }).is_aisle, false, 'aisle_seats 명단 있으면 false 도 확정');

// season.side_seats — 관리자가 직접 표시한 극싸/사이드가 블럭 기하보다 우선
const ssz = { venue_id: 'yes24-stage-1',
  side_seats: [{ floor: 1, row_from: 'D', row_to: 'D', numbers: [4, 24], zone: 'EDGE' }] };
eq(DB.resolveSeat(ssz, { floor: 1, row: 'D', number: 4 }).side_zone, 'EDGE', 'side_seats 명단 매칭 → EDGE');
eq(DB.resolveSeat(ssz, { floor: 1, row: 'D', number: 12 }).side_zone, null, '층에 명단 있으면 명단 밖은 일반(기하 무시)');
eq(DB.resolveSeat(ssz, { floor: 1, row: 'D', number: 4 }).side_source, 'season', 'side_source = season');

// 짝수열/홀수열 — 통로 번호가 열 홀짝에 따라 1 밀리는 극장
const par = { venue_id: 'yes24-stage-1', aisle_seats: [
  { floor: 1, row_parity: 'even', numbers: [16, 32] },
  { floor: 1, row_parity: 'odd', numbers: [15, 31] },
] };
eq(DB.resolveSeat(par, { floor: 1, row: 'B', number: 16 }).is_aisle, true, '짝수열(B=2) 16번 → 통로');
eq(DB.resolveSeat(par, { floor: 1, row: 'B', number: 15 }).is_aisle, false, '짝수열 15번 → 통로 아님');
eq(DB.resolveSeat(par, { floor: 1, row: 'C', number: 15 }).is_aisle, true, '홀수열(C=3) 15번 → 통로');
ok(rs.unknown.includes('좌석 등급 (좌석배치도 미수집)'), 'resolveSeat unknown 에 등급 누락');

// 회차 제한 할인 (applies_to) → 기준선 필터
section('할인 기준선 — applies_to 회차 필터');
const seasonMat = { discounts: [
  { name: '조기예매', rate: 20, type: 'STANDING' },
  { name: '마티네',   rate: 30, type: 'STANDING', applies_to: 'MATINEE' },
] };
eq(DB.baselineRate(seasonMat, { matinee: 'MATINEE' }), 30, 'baseline 낮공 → 마티네 30 포함');
eq(DB.baselineRate(seasonMat, { matinee: 'EVENING' }), 20, 'baseline 밤공 → 마티네 제외, 20');
eq(DB.baselineRate(seasonMat, {}), 30, 'baseline 회차 모름 → 보수적으로 30 포함');
eq(DB.baselineRate({ discounts: [{ name: 'x', rate: 25, type: 'STANDING' }] }, { matinee: 'EVENING' }),
   25, 'baseline applies_to 없으면 회차 무관 25');

// 좌석등급 제한 할인 (grades) → 기준선 필터
const seasonGr = { discounts: [
  { name: '조기예매', rate: 20, type: 'STANDING' },
  { name: '대학생',   rate: 30, type: 'ELIGIBILITY', grades: ['R', 'S'] },
] };
eq(DB.baselineRate(seasonGr, { selected: seasonGr.discounts[1], grade: 'R' }), 30, 'baseline R석 → 대학생 30');
eq(DB.baselineRate(seasonGr, { selected: seasonGr.discounts[1], grade: 'A' }), 20, 'baseline A석 → 대학생 제외, 20');
eq(DB.baselineRate(seasonGr, { selected: seasonGr.discounts[1] }), 30, 'baseline 등급 모름 → 보수적 30');
eq(DB.baselineRate({ discounts: [{ name: 's', rate: 40, type: 'STANDING', grades: ['VIP'] }] }, { grade: 'R' }),
   0, 'baseline STANDING 이라도 등급 안 맞으면 0');

// 같은 이름 등급별 할인율 다른 항목 — computePayment 는 넘겨받은 객체를 그대로 쓴다
const splitSeason = { discounts: [
  { name: '조기예매 할인', rate: 10, type: 'STANDING', grades: ['VIP', 'R'] },
  { name: '조기예매 할인', rate: 20, type: 'STANDING', grades: ['S', 'A'] },
], discount_proof_policy: 'FULL_PRICE' };
const payS = DB.computePayment(splitSeason, { price: 100000, grade: 'S' },
  { paid: 80000, selected: splitSeason.discounts[1] });
eq(payS.selected_discount.rate, 20, 'computePayment S석 → 조기예매 20% 적용');
eq(payS.baseline_rate, 20, 'baseline S석 → 20 (VIP·R 10% 는 제외)');
const payR = DB.computePayment(splitSeason, { price: 100000, grade: 'R' },
  { paid: 90000, selected: splitSeason.discounts[0] });
eq(payR.baseline_rate, 10, 'baseline R석 → 10 (S·A 20% 는 제외)');

/* ============================================================
   2. 사이드 구간 분류 (PRD §5.2)
   ============================================================ */
section('사이드 구간 — sideZoneFor 스펙표');
// (width, dWall, dAisle)
const SZ = [
  [3, 3, 1, null], [3, 2, 2, null], [3, 1, 3, 'EDGE'],
  [4, 4, 1, null], [4, 3, 2, null], [4, 2, 3, 'SIDE'], [4, 1, 4, 'EDGE'],
  [5, 5, 1, null], [5, 4, 2, null], [5, 3, 3, null], [5, 2, 4, 'EDGE'], [5, 1, 5, 'EDGE'],
  [6, 3, 4, 'SIDE'], [6, 2, 5, 'EDGE'], [6, 1, 6, 'EDGE'],
  [7, 4, 4, 'SIDE'], [7, 3, 5, 'SIDE'], [7, 2, 6, 'EDGE'], [7, 1, 7, 'EDGE'],
  [2, 1, 2, 'EDGE'], [1, 1, 1, 'EDGE'],
];
for (const [w, dw, da, want] of SZ) eq(DB.sideZoneFor(w, dw, da), want, `sideZoneFor(${w},${dw},${da})`);

section('사이드 구간 — resolveSeat 경유 (예스24 OL 1-4 / C 5-20 / OR 21-24)');
const sz = s => DB.resolveSeat(haemong, s).side_zone;
eq(sz({ floor: 1, row: 'B', number: 1, block: 'OL' }), 'EDGE', 'OL n1 벽쪽 끝');
eq(sz({ floor: 1, row: 'B', number: 2, block: 'OL' }), 'SIDE', 'OL n2');
eq(sz({ floor: 1, row: 'B', number: 3, block: 'OL' }), null, 'OL n3 일반');
eq(sz({ floor: 1, row: 'B', number: 4, block: 'OL' }), null, 'OL n4 통로쪽');
eq(sz({ floor: 1, row: 'B', number: 24, block: 'OR' }), 'EDGE', 'OR n24 벽쪽 끝');
eq(sz({ floor: 1, row: 'B', number: 23, block: 'OR' }), 'SIDE', 'OR n23');
eq(sz({ floor: 1, row: 'B', number: 12, block: '중앙' }), null, 'C 중앙 → 감점 대상 아님');
eq(sz({ floor: 1, row: 'B', number: 2, block: '왼블' }), 'SIDE', '한글 "왼블" n2 → SIDE');
eq(sz({ floor: 1, row: 'B', number: 1 }), 'EDGE', '블럭표기 없이 좌석번호만 n1 → OL EDGE');

const rEdge = DB.resolveSeat(haemong, { floor: 1, row: 'B', number: 1, block: 'OL' });
eq(rEdge.side_estimate, true, 'OL EDGE — 극장 베이스 추정 플래그');
ok(rEdge.unknown.some(u => u.indexOf('사이드 구간') > -1), 'OL EDGE — 추정이라 unknown 노트');
const rC = DB.resolveSeat(haemong, { floor: 1, row: 'B', number: 12, block: '중앙' });
ok(!rC.unknown.some(u => u.indexOf('사이드 구간') > -1), '중앙석 — 사이드 노트 없음');

/* ============================================================
   3. engine.runConsult — 결론 · 축 점수 스냅샷
   ============================================================ */
section('runConsult 스냅샷');

function deepMerge(t, s) {
  for (const k in s) {
    if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) t[k] = deepMerge(t[k] || {}, s[k]);
    else t[k] = s[k];
  }
  return t;
}
function bundle(over) { return deepMerge(JSON.parse(JSON.stringify(GON.DEMO_BUNDLE)), over || {}); }

async function runAll(b) {
  const r = GON.runConsult(JSON.parse(JSON.stringify(b)));
  const agents = {};
  for (const k of Object.keys(r.agents)) {
    const o = await r.agents[k];
    agents[k] = o;
  }
  const lead = await r.lead;
  return { agents, lead };
}

const BUNDLES = {
  // CASE 1 (웨스턴) — 데모 번들 그대로. 애배+자첫, 컨디션 없음
  demo_case1: GON.DEMO_BUNDLE,

  // CASE 5 형 — 컨디션 부담 4개 누적 → veto
  veto_condition: bundle({
    season: { id: 'haemong-2026', work_title: '해몽가', venue_id: 'yes24-stage-1',
              venue_name: '예스24스테이지 1관', open_date: '2026-06-25', close_date: '2026-09-13' },
    session: { date: '2026-08-14', datetime: '2026-08-14T20:00:00', now: '2026-08-10T11:00:00' },
    seat: { floor: 1, block: '중블 중앙', row: 'J', number: 13, grade: null, is_aisle: false,
            is_restricted: null, zone: '중블 중앙', row_index: 10, row_index_in_floor: 10,
            side_zone: null, side_block: 'C', side_source: 'venue', side_estimate: true,
            notes: [], sources: [], unknown: ['좌석 등급 (좌석배치도 미수집)', '시야제한석 명단 (미수집)'] },
    payment: { total_paid: 51000, list_price: 70000, list_price_grade: 'R', list_price_verified: true,
               grade: 'R', selected_discount: { name: '조기예매 할인', rate: 30, type: 'STANDING' },
               selected_other: false, proof_status: null, surcharge: 0, actual_burden: 51000,
               expected_price: 49000, diff: -2000, mismatch_warn: false, discount_rate: 27.1,
               baseline_rate: 30, gap: -2.9, band: 2, discount_proof_policy: 'GRADE_CHANGE',
               discounts_verified: false, cancellation_fee: null },
    season_progress: 0.62, disposal_options: ['TRANSFERABLE'],
    casting: { has_favorite_actor: true }, first_watch: false, work_affinity: 'LIKE',
    seat_preference: { first: 'FRONT', second: null, actor_path_side: null },
    opera_glass: false,
    events: [{ type: 'GIFT', label: '폴라로이드 증정', photo_allowed: false, is_actor_mediated: false,
               certainty_class: 'FIXED', user_appeal: 4, user_scarcity: 'NONE' }],
    free_text: '공연 시간 전 2시간 반 붕뜸, 집까지 1시간 반 예상으로 늦은 밤 귀가, 평소 밤공 보고도 늦은 밤 귀가는 흔하지만 청소도 해야 하고 다음날 아침 체력 소모 약속 있음',
  }),

  // 사이드 감점 — EDGE 좌석 (선호 없음). 데모(FRONT 선호)와 달리 감점이 실제로 먹는다
  side_edge_no_pref: bundle({
    seat: { side_zone: 'EDGE', side_block: 'OL', side_source: 'venue', side_estimate: true },
    seat_preference: { first: 'CENTER', second: null, actor_path_side: null },
  }),
};

// 스냅샷 기대값 — "지금 동작" 고정 (의도한 변경이면 갱신)
const EXPECT = {
  demo_case1:        { verdict: 'GO',    DEOKSIM: 2, SIYA: 2, COST: 2, EVENT: 0, CONDITION: 'muted' },
  veto_condition:    { verdict: 'NO_GO', DEOKSIM: 2, SIYA: 2, COST: 2, EVENT: 2, CONDITION: -2 },
  side_edge_no_pref: { verdict: 'GO',    DEOKSIM: 2, SIYA: 1, COST: 2, EVENT: 0, CONDITION: 'muted' },
};

const results = {};
(async () => {
  for (const [name, b] of Object.entries(BUNDLES)) {
    const res = await runAll(b);
    results[name] = res;
    const exp = EXPECT[name];
    eq(res.lead.verdict, exp.verdict, `${name} — verdict`);
    for (const a of GON.AGENT_ORDER) {
      const o = res.agents[a];
      const got = o.is_muted ? 'muted' : o.axis_score;
      eq(got, exp[a], `${name} — ${a} axis`);
    }
  }

  /* ==========================================================
     4. 출력 계약 (PRD §7.1·§7.3) — 모든 번들의 비-muted 출력
     ========================================================== */
  section('출력 계약');
  for (const [name, res] of Object.entries(results)) {
    for (const a of GON.AGENT_ORDER) {
      const o = res.agents[a];
      if (o.is_muted) { ok(!o.detail, `${name}/${a} — muted 는 detail 없음`); continue; }
      const pl = Array.from(o.placard).length;
      const dl = Array.from(o.detail).length;
      ok(pl > 0 && pl <= 16, `${name}/${a} — 푯말 ${pl}자 (≤16)`);
      ok(dl >= 100 && dl <= 180, `${name}/${a} — detail ${dl}자 (100~180)`);
      ok(o.axis_score >= -2 && o.axis_score <= 2, `${name}/${a} — axis ${o.axis_score} ∈ [-2,2]`);
      ok(o.confidence >= 0 && o.confidence <= 1, `${name}/${a} — confidence ${o.confidence.toFixed(2)} ∈ [0,1]`);
      ok(Array.isArray(o.primary_drivers), `${name}/${a} — primary_drivers 배열`);
    }
    ok(res.lead.reasoning && Array.from(res.lead.reasoning).length > 20, `${name} — 팀장 reasoning 존재`);
  }

  /* ---- 결과 ---- */
  console.log('\n' + '='.repeat(48));
  if (fail) {
    console.log(`✗ ${fail} FAILED, ${pass} passed\n`);
    fails.forEach(m => console.log('  ✗ ' + m));
    process.exit(1);
  } else {
    console.log(`✓ all ${pass} passed`);
    process.exit(0);
  }
})().catch(e => { console.error('THREW:', e); process.exit(2); });
