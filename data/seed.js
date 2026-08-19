/* =============================================================
   data/seed.js — 1회성 수집 데이터 (PRD §9.1 레이어 1·2, §9.2)

   PRD §9.2: 좌석배치도·좌석→등급 매핑·등급별 정가·시야제한석·취소 규정은
   전부 "공연 오픈 시 1회 수집으로 충분한 정적 데이터"다. 상담 시점에는
   크롤링하지 않고 이 파일을 조회만 한다.

   ▶ 이 파일은 크롤러/수동 수집의 출력물이 들어가는 자리다.
     지금 담긴 값은 test_cases.md에서 실제 관람으로 확인된 것만이며,
     확인되지 않은 항목은 채우지 않고 비워 둔다(PRD 원칙 6 — 검증된
     사실이 아니면 말하지 않는다). 비어 있으면 엔진이 missing_info에
     기록하고 confidence를 낮춘다. 추측값을 넣지 말 것.

   ⚠ file:// 로 열리는 프로토타입이라 .json + fetch 는 CORS에 막힌다.
     그래서 JSON이 아니라 전역에 붙이는 .js 로 둔다. 서버가 생기면
     같은 구조 그대로 API 응답으로 바꾸면 된다.

   스키마: PRD §8.4 (theaters / theater_specs / seat_blocks)
          PRD §8.5 (works / seasons / season_prices / season_seat_grades)
   ============================================================= */

/* -------------------------------------------------------------
   극장 — PRD §9.1 레이어 1 (물리 스펙, 1회성 수동 구축)
              레이어 2 (좌석배치도, 오픈 시 1회 크롤링)

   verified_seats 는 "이 좌석에 대해 확인된 사실"의 목록이다.
   전체 좌석배치도가 아니라 확인된 점만 담는다. 목록에 없는 좌석은
   `false`가 아니라 **모름**으로 취급한다.
------------------------------------------------------------- */
window.GON_VENUES = {

  'yes24-stage-1': {
    venue_id: 'yes24-stage-1',
    name: '예스24스테이지 1관',
    nearest_station: null,
    last_transit_time: null,

    // 열 표기 체계 — 좌석 입력 파싱에 직접 쓰인다
    row_label_system: 'ALPHA',            // A, B, C …
    alpha_continues_across_floors: true,  // 2층이 Q열로 이어진다 (CASE 6에서 확인)

    specs: {
      1: { stage_to_row1_distance:null, row_count:null, row_spacing:null,
           tier_start_row:null, has_orchestra_pit:null, balcony_overhang_row:null },
      2: { stage_to_row1_distance:null, row_count:null, row_spacing:null,
           tier_start_row:null, has_orchestra_pit:null, balcony_overhang_row:null }
    },

    verified_seats: [
      { floor:1, row:'B', number:16, is_aisle:true,
        source:'test_cases.md CASE 2 — 실제 관람에서 통로석 확인' },
      { floor:1, row:'J', number:13, is_aisle:false, zone:'중블 중앙',
        source:'test_cases.md CASE 5' },
      { floor:2, row:'Q', number:7, angle_note:'오글 사용 시 살짝 정수리뷰',
        source:'test_cases.md CASE 6 — 실제 관람자 진술' }
    ],

    restricted_seats: [],   // 시야제한석 명단 — 미수집
    collected: false        // 좌석배치도 전체 수집 전
  },

  'nol-uniplex-1': {
    venue_id: 'nol-uniplex-1',
    name: 'NOL 유니플렉스 1관',
    nearest_station: null,
    last_transit_time: null,

    row_label_system: 'NUMERIC',          // 1, 2, 3 …
    alpha_continues_across_floors: false,

    specs: {
      1: { stage_to_row1_distance:null, row_count:null, row_spacing:null,
           tier_start_row:null, has_orchestra_pit:null, balcony_overhang_row:null }
    },

    verified_seats: [
      { floor:1, row:'6', number:7, is_aisle:true,
        source:'test_cases.md CASE 1 — 배우가 통로로 내려왔을 때 코앞이었음' }
    ],

    restricted_seats: [],
    collected: false
  },

  'charlotte-theater': {
    venue_id: 'charlotte-theater',
    name: '샤롯데씨어터',
    nearest_station: null,
    last_transit_time: null,

    row_label_system: 'NUMERIC',
    alpha_continues_across_floors: false,

    specs: {
      1: { stage_to_row1_distance:null, row_count:null, row_spacing:null,
           tier_start_row:null, has_orchestra_pit:null, balcony_overhang_row:null }
    },

    verified_seats: [
      { floor:1, row:'6', number:25, zone:'중오블',
        sightline_note:'6열에서 매직 카펫 씬이 잘 보였음',
        source:'test_cases.md CASE 3' }
    ],

    restricted_seats: [],
    collected: false
  }
};

/* -------------------------------------------------------------
   작품 / 시즌 — PRD §8.5 2단 스키마

   ⚠ 시즌마다 극장·캐스팅·연출·가격·이벤트가 전부 다르다.
     전 시즌 정보로 이번 시즌을 추론하지 않는다 (CASE 1 오답 원인).

   prices_verified:false 는 "추정값이며 확인되지 않았다"는 뜻이다.
   엔진은 이 경우 확신을 낮추고 사용자에게도 그렇게 말한다.

   ── 할인 사다리 (changelog v2.1 §1.2 · §4.1) ────────────────
   discounts 는 개막 시 예매처 공연 페이지에서 1회 수집한다.
   type 은 파싱 단계에서 할인명·설명을 보고 붙인다.

     STANDING     상시, 누구나 (조예할·문화가있는날·마티네)  → 항상 기준선에 포함
     ELIGIBILITY  자격 보유자 (청소년·대학생·경로·장애인)    → 해당 권종 선택 시 포함
     LOYALTY      재관람자 전용 (재관람 할인권·도장·쿠폰팩)  → 자첫이면 제외

   LIMITED 타입은 두지 않는다. 타임세일·쿠폰팩 같은 기간 한정 할인은
   개막 시점 목록에 없을 수 있고, 그건 "목록에 없는 할인"으로 처리한다.
   애매하면 STANDING 으로 둔다(기준선이 높아져 판정이 보수적이 된다).

   ⚠ discounts_verified:false = 개발용 임시 사다리다. 실제 예매처에서
     확인된 값이 아니다. 크롤러가 붙으면 통째로 교체된다.
     확인된 항목만 남기고 싶으면 이 플래그를 보고 걸러내면 된다.

   discount_proof_policy — 권종 증빙 실패 시 처리 방식 (v2.1 §4.4)
     FULL_PRICE    정가 차액 강제
     GRADE_CHANGE  권종 변경 후 차액. 대체 권종은 사용자가 고른다
     UNKNOWN       양쪽 시나리오 병기, confidence 하향
------------------------------------------------------------- */
window.GON_SEASONS = [
  {
    season_id: 'haemong-2026',
    work_title: '해몽가',
    season_label: '2026',
    venue_id: 'yes24-stage-1',
    open_date: '2026-06-25',
    close_date: '2026-09-13',
    running_time: 100,
    has_intermission: false,
    prices: { R: 70000 },
    prices_verified: true,
    // 조예할 30%만 CASE 5에서 확인됐다. 나머지는 개발용 임시값
    discounts: [
      { name: '조기예매 할인', rate: 30, type: 'STANDING'    },
      { name: '청소년 할인',   rate: 50, type: 'ELIGIBILITY' },
      { name: '재관람 할인',   rate: 40, type: 'LOYALTY'     }
    ],
    discounts_verified: false,
    discount_proof_policy: 'GRADE_CHANGE',
    seat_grades: [],                 // 좌석→등급 매핑 미수집
    cancellation_policy: null,       // 예매처 공지 미수집 → 기본 규정 사용
    source: 'test_cases.md CASE 2·5'
  },
  {
    season_id: 'rachmaninoff-2025',
    work_title: '라흐마니노프',
    season_label: '2025',
    venue_id: 'yes24-stage-1',
    open_date: '2025-09-20',
    close_date: '2025-12-14',
    running_time: 90,
    has_intermission: false,
    prices: { S: 55000 },
    prices_verified: true,
    // 청소년 50%만 CASE 6에서 확인됐다. 나머지는 개발용 임시값
    discounts: [
      { name: '청소년 할인',   rate: 50, type: 'ELIGIBILITY' },
      { name: '조기예매 할인', rate: 20, type: 'STANDING'    },
      { name: '재관람 할인',   rate: 30, type: 'LOYALTY'     }
    ],
    discounts_verified: false,
    discount_proof_policy: 'FULL_PRICE',
    seat_grades: [
      { floor:2, row:'Q', grade:'S', source:'test_cases.md CASE 6' }
    ],
    cancellation_policy: null,
    source: 'test_cases.md CASE 6'
  },
  {
    season_id: 'aladdin-2024',
    work_title: '알라딘',
    season_label: '한국 초연',
    venue_id: 'charlotte-theater',
    open_date: '2024-11-22',
    close_date: '2025-06-22',
    running_time: 150,
    has_intermission: true,
    prices: { VIP: 190000 },
    prices_verified: true,
    // 대극장이라 할인 폭이 좁다 — 사다리가 짧으면 20%가 최대치가 된다.
    // 전부 개발용 임시값
    discounts: [
      { name: '조기예매 할인', rate: 20, type: 'STANDING'    },
      { name: '청소년 할인',   rate: 40, type: 'ELIGIBILITY' }
    ],
    discounts_verified: false,
    discount_proof_policy: 'FULL_PRICE',
    seat_grades: [
      { floor:1, row:'6', grade:'VIP', source:'test_cases.md CASE 3' }
    ],
    cancellation_policy: null,
    source: 'test_cases.md CASE 3'
  },
  {
    season_id: 'western-2026',
    work_title: '웨스턴 스토리',
    season_label: '2026',
    venue_id: 'nol-uniplex-1',
    open_date: '2026-07-01',
    close_date: '2026-09-27',
    running_time: null,
    has_intermission: null,
    // ⚠ 88,000은 지불액과 할인율에서 역산한 추정치다. 예매처에서 확인되지 않았다.
    prices: { R: 88000 },
    prices_verified: false,
    // 소극장이라 사다리가 길다 — 같은 30%가 대극장과 정반대 의미가 되는
    // 케이스(v2.1 §1 변경 배경 1)를 재현하려고 둔 대조군. 전부 개발용 임시값
    discounts: [
      { name: '조기예매 할인', rate: 30, type: 'STANDING' },
      { name: '마티네 할인',   rate: 25, type: 'STANDING' },
      { name: '문화가있는날',  rate: 20, type: 'STANDING' },
      { name: '재관람 할인',   rate: 40, type: 'LOYALTY'  }
    ],
    discounts_verified: false,
    discount_proof_policy: 'UNKNOWN',
    seat_grades: [],
    cancellation_policy: null,
    source: 'test_cases.md CASE 1 (list_price_estimated)'
  },
  {
    season_id: 'elisabeth-2026',
    work_title: '엘리자벳',
    season_label: '2026',
    venue_id: null,                  // 극장 미확인 — 추측하지 않는다
    open_date: null,
    close_date: null,
    running_time: null,
    has_intermission: null,
    prices: {},
    prices_verified: false,
    discounts: null,                 // 미수집. []는 "할인이 없다"는 뜻이라 다르다
    discounts_verified: false,
    discount_proof_policy: 'UNKNOWN',
    seat_grades: [],
    cancellation_policy: null,
    source: 'test_cases.md CASE 4 (극장 미기재)'
  }
];
