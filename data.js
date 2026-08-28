/* =============================================================
   data.js — 수집 데이터 조회 계층 (PRD §9.2)

   "상담 시점에는 크롤링하지 않는다. DB 조회만 한다."
   이 파일이 그 조회다. data/seed.js 가 DB 자리를 대신하고 있으며,
   서버가 생기면 이 모듈의 내부만 fetch 로 바꾸면 된다.

   ▶ 핵심 규칙: 모르는 것은 null 로 돌려준다. false 로 돌려주지 않는다.
     "통로석이 아니다"와 "통로석인지 모른다"는 완전히 다른 정보이고,
     둘을 섞으면 CASE 1·5에서 났던 종류의 오답이 다시 난다.
   ============================================================= */
window.GON_DB = (function(){
  "use strict";

  const VENUES   = window.GON_VENUES   || {};
  const SEASONS  = window.GON_SEASONS  || [];
  const SEATMAPS = window.GON_SEATMAPS || {};

  const HANGUL_ROWS = '가나다라마바사아자차카타파하';

  /* ---------------------------------------------------------
     시즌·극장 찾기

     작품 단위가 아니라 **시즌 단위**로 잡는다 (PRD §8.5).
     같은 작품이라도 시즌마다 극장·가격이 전부 다르다.
  --------------------------------------------------------- */
  function findSeason(workTitle, sessionDate){
    if(!workTitle) return null;
    const title = String(workTitle).trim();
    const matches = SEASONS.filter(s => s.work_title === title);
    if(!matches.length) return null;
    if(matches.length === 1) return matches[0];

    // 여러 시즌이 있으면 관람일이 공연 기간에 들어가는 시즌을 고른다
    if(sessionDate){
      const d = String(sessionDate).slice(0,10);
      const inRange = matches.find(s => s.open_date && s.close_date &&
                                        d >= s.open_date && d <= s.close_date);
      if(inRange) return inRange;
    }
    return null;   // 시즌을 특정할 수 없으면 추측하지 않는다
  }

  function findVenue(venueId){
    return venueId ? (VENUES[venueId] || null) : null;
  }

  // seat_grades 구역이 얼마나 구체적인가 — 좁은 구역이 넓은 구역을 이긴다
  // (예: "양끝 R" 이 "이 열은 VIP" 보다 우선)
  function zoneSpecificity(z){
    return (z.row != null ? 2 : 0)
      + (z.row_from != null || z.row_to != null ? 1 : 0)
      + (z.row_parity ? 1 : 0)
      + (z.seat_from != null || z.seat_to != null ? 2 : 0)
      + (z.numbers && z.numbers.length ? 3 : 0);
  }

  // 구역 { floor?, row?|row_from?/row_to?, row_parity?('even'|'odd'), seat_from?/seat_to?, numbers?[] }
  // 에 좌석이 드는가
  function seatInZone(z, seat, venue){
    if(z.floor != null && z.floor !== seat.floor) return false;
    var rIdx = rowIndex(seat.row, venue);
    if(z.row != null){
      return String(z.row).toUpperCase() === String(seat.row).toUpperCase();
    }
    if(z.row_from != null || z.row_to != null){
      if(rIdx == null) return false;
      var rf = z.row_from != null ? rowIndex(z.row_from, venue) : null;
      var rt = z.row_to   != null ? rowIndex(z.row_to, venue)   : null;
      if(rf != null && rIdx < rf) return false;
      if(rt != null && rIdx > rt) return false;
    }
    if(z.row_parity){
      if(rIdx == null) return false;
      if(z.row_parity === 'even' && rIdx % 2 !== 0) return false;
      if(z.row_parity === 'odd'  && rIdx % 2 !== 1) return false;
    }
    if(z.numbers && z.numbers.length){
      return seat.number != null && z.numbers.indexOf(seat.number) > -1;
    }
    var sf = (z.seat_from != null && z.seat_from > 0) ? z.seat_from : null;
    var st = (z.seat_to   != null && z.seat_to   > 0) ? z.seat_to   : null;
    if(sf != null || st != null){
      if(seat.number == null) return false;
      if(sf != null && seat.number < sf) return false;
      if(st != null && seat.number > st) return false;
    }
    return true;
  }

  /* ---------------------------------------------------------
     열 표기 해석 — 극장마다 체계가 다르다
  --------------------------------------------------------- */
  function rowIndex(rowLabel, venue){
    if(rowLabel == null) return null;
    const s = String(rowLabel).trim().toUpperCase();

    if(venue && venue.row_label_system === 'NUMERIC'){
      return /^\d+$/.test(s) ? Number(s) : null;
    }
    if(venue && venue.row_label_system === 'ALPHA'){
      return /^[A-Z]$/.test(s) ? s.charCodeAt(0) - 64 : null;
    }
    // 극장 정보가 없으면 표기만 보고 추론한다
    if(/^\d+$/.test(s)) return Number(s);
    if(/^[A-Z]$/.test(s)) return s.charCodeAt(0) - 64;
    const h = HANGUL_ROWS.indexOf(String(rowLabel).trim());
    return h > -1 ? h + 1 : null;
  }

  /* 해당 층 안에서 몇 번째 열인가.
     알파벳이 층을 넘어 이어지는 극장은 그 층의 시작 열을 알아야 계산된다.
     모르면 null — 2층 Q열을 "17번째 열"로 오해하지 않게 한다. */
  function rowIndexWithinFloor(rowLabel, floor, venue){
    const abs = rowIndex(rowLabel, venue);
    if(abs == null) return null;
    if(!venue) return floor === 1 ? abs : null;
    if(floor === 1) return abs;
    if(!venue.alpha_continues_across_floors) return abs;
    const spec = venue.specs && venue.specs[floor];
    const start = spec && spec.tier_start_row;
    return start ? (abs - start + 1) : null;
  }

  /* ---------------------------------------------------------
     사이드 구간 분류 — PRD §5.2

     한 열을 통로석부터 세 구간으로 나눈다 (겹침 없는 분할):
       ≤4석 박스 : [일반 1~2] [SIDE 3번째] [EDGE 벽쪽 끝 1석]
       5석 이상  : [일반 1~3] [SIDE 4번째~끝에서 3번째] [EDGE 벽쪽 끝 2석]
     경계가 모호하면 더 센 쪽(EDGE) 우선 — 아래 순서가 그 규칙이다.

     dWall  = 벽 쪽 끝에서 이 좌석까지 (끝좌석이면 1)
     dAisle = 통로 쪽 끝에서 이 좌석까지 (통로석이면 1)
  --------------------------------------------------------- */
  function sideZoneFor(width, dWall, dAisle){
    if(width == null || dWall == null || dAisle == null) return null;
    if(width <= 2) return 'EDGE';
    if(width <= 4){
      if(dWall <= 1) return 'EDGE';
      if(dAisle >= 3) return 'SIDE';
      return null;
    }
    // width >= 5
    if(dWall <= 2) return 'EDGE';
    if(dAisle >= 4) return 'SIDE';
    return null;
  }

  // 사이드처럼 보이는 블럭 표기인가 (배치도가 없을 때 "판단 보류 + ⚠️" 여부 판정)
  const SIDE_HINT = /좌|왼|우측|오른|오블|좌블|사이드|벽|op|ol|or|(^|[^a-z])[lr]([^a-z]|$)/i;

  function classifySide(venue, season, seat){
    // determined = 이 좌석의 사이드 구간을 확정했는가 (null=일반 도 확정에 포함).
    // sideish && !determined 이면 "사이드 같은데 못 정함" → ⚠️
    const out = { zone:null, block_label:null, source:null, estimate:false,
                  sideish:false, determined:false };
    if(!seat || seat.floor == null) return out;

    const hint = String(seat.zone || seat.block || '').toLowerCase().trim();
    const looksSide = !!hint && SIDE_HINT.test(hint);

    // ① 공연 좌석배치도 오버레이가 있으면 그것, 없으면 극장 기본 베이스(추정)
    let blocks = null;
    const smap = season && SEATMAPS[season.season_id];
    if(smap && smap.updated_at && smap.floors && smap.floors[seat.floor]){
      blocks = smap.floors[seat.floor]; out.source = 'season'; out.estimate = false;
    } else if(venue && venue.base_geometry && venue.base_geometry.floors &&
              venue.base_geometry.floors[seat.floor]){
      blocks = venue.base_geometry.floors[seat.floor];
      out.source = 'venue';
      out.estimate = venue.base_geometry.is_estimate !== false;
    }
    if(!blocks){
      if(looksSide) out.sideish = true;   // 사이드 같은데 배치도가 없음 → ⚠️
      out.source = null;
      return out;
    }

    // ② 블럭 매칭 — 표기(zone/block) 우선, 실패 시 좌석번호가 드는 범위
    let blk = null;
    if(hint){
      blk = blocks.find(bk =>
        (bk.name && hint === String(bk.name).toLowerCase()) ||
        (bk.aliases || []).some(a => a && hint.indexOf(a) > -1));
    }
    if(!blk && seat.number != null){
      blk = blocks.find(bk => bk.seat_min != null &&
        seat.number >= bk.seat_min && seat.number <= bk.seat_max);
    }
    if(!blk){
      if(looksSide) out.sideish = true;
      out.source = null; out.estimate = false;
      return out;
    }

    out.block_label = blk.name || null;

    // ③ 중앙 블럭 → 감점 대상 아님 (확정)
    if(blk.wall_end == null){ out.determined = true; return out; }
    out.sideish = true;

    // ④ 사이드 블럭 — 좌석번호가 있어야 구간을 잰다
    if(seat.number == null || seat.number < blk.seat_min || seat.number > blk.seat_max){
      return out;   // determined:false, sideish:true → ⚠️
    }
    const width  = blk.seat_max - blk.seat_min + 1;
    const dWall  = blk.wall_end  === 'min' ? (seat.number - blk.seat_min + 1)
                                           : (blk.seat_max - seat.number + 1);
    const dAisle = blk.aisle_end === 'min' ? (seat.number - blk.seat_min + 1)
                 : blk.aisle_end === 'max' ? (blk.seat_max - seat.number + 1)
                                           : null;
    out.zone = sideZoneFor(width, dWall, dAisle);
    out.determined = true;
    return out;
  }

  /* ---------------------------------------------------------
     좌석 조회 — 등급 / 시야제한 / 사이드 구간
  --------------------------------------------------------- */
  function resolveSeat(season, seat){
    const out = {
      grade: null,
      is_aisle: null,
      is_restricted: null,
      zone: null,
      side_zone: null,          // 'EDGE' | 'SIDE' | null (PRD §5.2)
      side_block: null,
      side_source: null,        // 'season' | 'venue' | null
      side_estimate: false,
      notes: [],
      sources: [],
      unknown: []
    };
    if(!seat) return out;

    const venue = season ? findVenue(season.venue_id) : null;

    // ① 좌석 → 등급 (season_seat_grades)
    //   구역(zone)은 { floor, row_from?, row_to?, seat_from?, seat_to?, grade } 형태.
    //   같은 열에서도 가운데 VIP·양끝 R 처럼 좌석번호로 갈리는 극장이 있어 seat 범위까지 본다.
    //   구식 { floor, row, grade } (열 단위) 도 그대로 지원.
    if(season && season.seat_grades && season.seat_grades.length){
      const zones = season.seat_grades.slice().sort((a, b) => zoneSpecificity(b) - zoneSpecificity(a));
      const g = zones.find(function(z){ return seatInZone(z, seat, venue); });
      if(g){ out.grade = g.grade; if(g.source) out.sources.push(g.source); }
    }
    if(out.grade == null) out.unknown.push('좌석 등급 (좌석배치도 미수집)');

    // ② 통로 인접 — 관리자가 배치도 보고 적은 좌석번호 (season.aisle_seats).
    //    명단이 있으면 false 도 확정. verified_seats 가 있으면 그게 우선.
    if(season && season.aisle_seats && season.aisle_seats.length){
      out.is_aisle = season.aisle_seats.some(function(z){ return seatInZone(z, seat, venue); });
    }
    if(venue && venue.verified_seats){
      const v = venue.verified_seats.find(x =>
        x.floor === seat.floor &&
        String(x.row).toUpperCase() === String(seat.row).toUpperCase() &&
        x.number === seat.number);
      if(v){
        if(typeof v.is_aisle === 'boolean') out.is_aisle = v.is_aisle;
        if(v.zone) out.zone = v.zone;
        if(v.angle_note) out.notes.push(v.angle_note);
        if(v.sightline_note) out.notes.push(v.sightline_note);
        out.sources.push(v.source);
      }
    }
    if(out.is_aisle == null) out.unknown.push('통로 인접 여부 (좌석배치도 미수집)');

    // ③ 시야제한석 — 공연/극장 명단이 있으면 false 도 확정할 수 있다
    const restrList = (season && season.restricted_seats && season.restricted_seats.length)
      ? season.restricted_seats
      : ((venue && venue.collected) ? (venue.restricted_seats || []) : null);
    if(restrList){
      out.is_restricted = restrList.some(function(z){
        if(z.row_from != null || z.row_to != null) return seatInZone(z, seat, venue);
        return z.floor === seat.floor &&
          String(z.row).toUpperCase() === String(seat.row).toUpperCase() &&
          (z.numbers || []).indexOf(seat.number) > -1;
      });
    } else {
      out.unknown.push('시야제한석 명단 (미수집)');
    }

    // ④ 사이드 구간 (PRD §5.2)
    const sc = classifySide(venue, season, seat);
    out.side_zone     = sc.zone;
    out.side_block    = sc.block_label;
    out.side_source   = sc.source;
    out.side_estimate = sc.estimate;
    if(sc.zone && sc.estimate){
      out.unknown.push('사이드 구간 (이 공연 좌석배치도 미갱신 — 극장 기본 배치 기준)');
    } else if(sc.sideish && !sc.determined){
      out.unknown.push('사이드 구간 (좌석배치도 미수집)');
    }

    out.sources = out.sources.filter(Boolean);
    return out;
  }

  /* ---------------------------------------------------------
     정가 / 할인율 — PRD §5.3 ①, CASE 5 오답의 직접 원인이었던 부분
  --------------------------------------------------------- */
  function listPrice(season, grade){
    if(!season || !season.prices) return null;
    if(grade && season.prices[grade] != null){
      return { price: season.prices[grade], grade: grade, verified: !!season.prices_verified };
    }
    // 등급을 모를 때: 시즌에 등급이 하나뿐이면 그것으로 본다.
    // 여러 등급이 있는데 어느 것인지 모르면 추측하지 않는다.
    const keys = Object.keys(season.prices);
    if(keys.length === 1){
      return { price: season.prices[keys[0]], grade: keys[0], verified: !!season.prices_verified };
    }
    return null;
  }

  /* ---------------------------------------------------------
     할인 사다리 — changelog v2.1 §1

     "정가 대비 몇 % 할인받았는가"가 아니라
     "이 사람이 받을 수 있었던 최선 대비 어느 위치인가"를 본다.

     소극장은 할인이 다양해 30%가 아쉬운 수준이고, 대극장은 20%가
     최대치다. 절대 할인율로 보면 같은 30%가 정반대 의미가 된다.
     사다리 길이가 극장 성격을 이미 담고 있어서 대/소극장 분류가
     따로 필요 없다.

     단위는 전부 퍼센트 포인트(0~100)다. 0~1 분수를 섞지 않는다.
  --------------------------------------------------------- */
  function discounts(season){
    return (season && season.discounts) || null;
  }

  // 할인 목록을 관리자 도구로 마지막 갱신한 시각 (ISO). 없으면 null.
  function discountsUpdatedAt(season){
    return (season && season.discounts_updated_at) || null;
  }

  function findDiscount(season, name){
    const ds = discounts(season);
    if(!ds || !name) return null;
    return ds.find(d => d.name === name) || null;
  }

  // 회차 제한 할인(마티네/밤공 전용)이 이 회차에 적용되는가.
  // applies_to 없으면 ALL. 회차(matinee)를 모르면 거르지 않는다 — 보수적 유지.
  function discountAppliesToSession(d, matinee){
    const at = d && d.applies_to;
    if(!at || at === 'ALL') return true;
    if(!matinee) return true;
    if(at === 'MATINEE') return matinee === 'MATINEE';
    if(at === 'EVENING') return matinee === 'EVENING';
    return true;
  }

  // 좌석등급 제한 할인(대학생 R·S만, 초중고 전석 등)이 이 좌석에 적용되는가.
  // grades 비었으면 전체. 내 좌석등급을 모르면 거르지 않는다 — 보수적 유지.
  function discountAppliesToGrade(d, grade){
    const g = d && d.grades;
    if(!g || !g.length) return true;
    if(!grade) return true;
    const G = String(grade).toUpperCase();
    return g.some(function(x){ return String(x).toUpperCase() === G; });
  }

  // §1.3 기준선 = max(STANDING 최댓값,
  //                  선택한 ELIGIBILITY 권종의 값,
  //                  자첫이 아니면 LOYALTY 최댓값)
  // 같은 공연이라도 사용자마다 다르다. 자첫 여부는 R-6에 이미 있다.
  // 회차(마티네 전용)·좌석등급(대학생 R·S만) 제한에 안 맞는 할인은 기준선에서 뺀다.
  function baselineRate(season, opts){
    const ds = discounts(season);
    if(!ds || !ds.length) return null;
    const o = opts || {};
    function usable(d){
      return discountAppliesToSession(d, o.matinee) && discountAppliesToGrade(d, o.grade);
    }
    let base = 0;
    ds.forEach(function(d){
      if(!usable(d)) return;
      const rate = Number(d.rate) || 0;
      if(d.type === 'STANDING') base = Math.max(base, rate);
      else if(d.type === 'LOYALTY' && !o.firstWatch) base = Math.max(base, rate);
    });
    if(o.selected && o.selected.type === 'ELIGIBILITY' && usable(o.selected)){
      base = Math.max(base, Number(o.selected.rate) || 0);
    }
    return base;
  }

  // 권종 적용가 — 정가에 그 권종의 할인율을 먹인 값
  function priceForDiscount(listPriceWon, rate){
    if(listPriceWon == null) return null;
    return Math.round(listPriceWon * (1 - (Number(rate) || 0) / 100));
  }

  // §1.4 밴드. gap = 실제 할인율 - 기준선 (%p)
  // 구간이 10%p 단위라 예매수수료·포인트 같은 소액 차이는 판정을 바꾸지 않는다.
  function band(gap){
    if(gap == null) return null;
    if(gap >= -5)  return 2;      // 초과도 포함
    if(gap >= -15) return 1;
    if(gap >= -25) return 0;
    return -1;
  }

  // 실제 부담액이 정가에서 몇 %p 깎인 값인지. 퍼센트 포인트로 돌려준다.
  function discountRate(listPriceWon, burden){
    if(!listPriceWon || burden == null) return null;
    const rate = (1 - burden / listPriceWon) * 100;
    if(Math.abs(rate) < 0.05) return 0;
    return Math.round(rate * 10) / 10;
  }

  /* ---------------------------------------------------------
     §1.7 결제 정보 확정 — 전 과정이 결정론적이므로 즉시 계산된다.

     band 까지 여기서 확정해서 넘긴다. 엔진은 산수를 하지 않고
     푯말 문구와 설명만 쓴다.

     input = { paid, selected, isOther, firstWatch, proofStatus, altName, matinee }
       selected     : 사다리에서 고른 할인 객체 {name,rate,type,...}. null = 정가
                      (같은 이름이 등급별로 여러 개일 수 있어 이름 아닌 객체로 받는다)
       isOther      : "목록에 없는 할인" 선택 여부
       proofStatus  : NOT_REQUIRED | AVAILABLE | UNAVAILABLE | null
       altName      : GRADE_CHANGE 로 바꿀 대체 권종명
       matinee      : MATINEE | EVENING | null — 회차 제한 할인 필터
       (좌석등급은 list.grade 에서 읽어 등급 제한 할인 필터에 쓴다)
  --------------------------------------------------------- */
  function computePayment(season, list, input){
    const inp   = input || {};
    const paid  = Number(inp.paid) || 0;
    const lp    = list ? list.price : null;
    const sel   = inp.isOther ? null : (inp.selected || null);
    const policy = (season && season.discount_proof_policy) || null;

    // 권종 적용가 — "목록에 없는 할인"이면 역산할 근거가 없으므로 결제액 그대로 본다.
    // 역산은 이 경우에만 쓴다. 어느 할인인지 알 필요가 없어 겹침 문제가 없다.
    const expected = sel ? priceForDiscount(lp, sel.rate) : lp;

    // §1.6 증빙 불가 시 추가결제
    // 증빙을 못 하면 그 권종은 애초에 못 쓴 것이 된다. 기준선도 실제로 쓰게 된
    // 권종으로 다시 잡아야 한다 — 청소년 50%를 증빙 못 해 조예할 30%로 바꿨으면
    // 기준선은 50이 아니라 30이다 (§1.6 계산 예).
    let surcharge = 0;
    let burden    = paid;
    let effective = sel;
    if(inp.proofStatus === 'UNAVAILABLE' && lp != null){
      const alt = (policy === 'GRADE_CHANGE') ? findDiscount(season, inp.altName) : null;
      effective = alt;                                    // null 이면 정가로 되돌아간 것
      const target = alt ? priceForDiscount(lp, alt.rate) : lp;
      surcharge = target - paid;
      burden    = target;
    }

    const rate     = discountRate(lp, burden);
    const baseline = baselineRate(season, {
      firstWatch: !!inp.firstWatch, selected: effective,
      matinee: inp.matinee || null,
      grade: (list && list.grade) || null
    });

    let bandVal = null;
    let gap = null;
    if(rate != null && baseline != null){
      gap = Math.round((rate - baseline) * 10) / 10;
      bandVal = rate === 0 ? -2 : band(gap);   // 정가는 사다리 위치와 무관하게 -2
    }

    // §1.5 차액의 정체는 추정하지 않는다. 음수여도(예매수수료) 정상이다.
    // 다만 20% 이상 벌어지면 입력을 다시 보라고만 말한다.
    const diff = (expected != null) ? expected - paid : null;
    const mismatch = !!(expected && diff != null && Math.abs(diff) / expected >= 0.20);

    return {
      total_paid: paid,
      list_price: lp,
      list_price_grade: list ? list.grade : null,
      list_price_verified: list ? list.verified : null,
      grade: list ? list.grade : null,
      selected_discount: sel ? { name: sel.name, rate: sel.rate, type: sel.type } : null,
      selected_other: !!inp.isOther,
      proof_status: inp.proofStatus || null,
      surcharge: surcharge,
      actual_burden: burden,
      expected_price: expected,
      diff: diff,
      mismatch_warn: mismatch,
      discount_rate: rate,
      baseline_rate: baseline,
      gap: gap,
      band: bandVal,
      discount_proof_policy: policy,
      discounts_verified: season ? !!season.discounts_verified : null,
      cancellation_fee: null   // 엔진이 계산 (PRD §5.3 ③)
    };
  }

  /* ---------------------------------------------------------
     시즌 위치 — changelog v2.1 §3.2

     폐막일과 오늘 날짜만으로 계산된다. 크롤링 실패와 무관하다.
     초반이면 오늘의 대체불가성이 실제로 낮다는 뜻이라 덕심이 무게를 낮춘다.
  --------------------------------------------------------- */
  function seasonProgress(season, today){
    if(!season || !season.open_date || !season.close_date) return null;
    const open  = Date.parse(season.open_date);
    const close = Date.parse(season.close_date);
    const now   = today ? Date.parse(new Date(today).toISOString().slice(0,10)) : Date.now();
    if(!(close > open)) return null;
    const p = (now - open) / (close - open);
    return Math.round(Math.max(0, Math.min(1, p)) * 100) / 100;
  }

  /* ---------------------------------------------------------
     취소 규정 — 예매처·공연마다 다르므로 시즌에 저장해 둔다.
     수집 전이면 null 을 돌려주고 엔진이 기본 규정을 쓴다.
  --------------------------------------------------------- */
  function cancellationPolicy(season){
    return (season && season.cancellation_policy) || null;
  }

  /* ---------------------------------------------------------
     이 상담에서 DB가 얼마나 채워졌는가 — confidence 산출용
  --------------------------------------------------------- */
  function coverage(season, seatInfo){
    const venue = season ? findVenue(season.venue_id) : null;
    return {
      has_season: !!season,
      has_venue: !!venue,
      has_price: !!(season && Object.keys(season.prices || {}).length),
      price_verified: !!(season && season.prices_verified),
      has_discounts: !!(season && season.discounts),
      discounts_verified: !!(season && season.discounts_verified),
      has_grade: !!(seatInfo && seatInfo.grade),
      has_aisle: !!(seatInfo && seatInfo.is_aisle !== null),
      seat_map_collected: !!(venue && venue.collected),
      side_source: seatInfo ? seatInfo.side_source : null   // 'season' | 'venue' | null
    };
  }

  return {
    findSeason: findSeason,
    findVenue: findVenue,
    rowIndex: rowIndex,
    rowIndexWithinFloor: rowIndexWithinFloor,
    resolveSeat: resolveSeat,
    classifySide: classifySide,
    sideZoneFor: sideZoneFor,
    listPrice: listPrice,
    discounts: discounts,
    discountsUpdatedAt: discountsUpdatedAt,
    discountAppliesToGrade: discountAppliesToGrade,
    discountAppliesToSession: discountAppliesToSession,
    findDiscount: findDiscount,
    baselineRate: baselineRate,
    priceForDiscount: priceForDiscount,
    band: band,
    discountRate: discountRate,
    computePayment: computePayment,
    seasonProgress: seasonProgress,
    cancellationPolicy: cancellationPolicy,
    coverage: coverage,
    VENUES: VENUES,
    SEASONS: SEASONS
  };
})();
