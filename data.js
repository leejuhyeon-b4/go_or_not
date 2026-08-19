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

  const VENUES  = window.GON_VENUES  || {};
  const SEASONS = window.GON_SEASONS || [];

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
     좌석 조회 — 등급 / 통로 / 시야제한
  --------------------------------------------------------- */
  function resolveSeat(season, seat){
    const out = {
      grade: null,
      is_aisle: null,
      is_restricted: null,
      zone: null,
      notes: [],
      sources: [],
      unknown: []
    };
    if(!seat) return out;

    const venue = season ? findVenue(season.venue_id) : null;

    // ① 좌석 → 등급 (season_seat_grades)
    if(season && season.seat_grades && season.seat_grades.length){
      const g = season.seat_grades.find(x =>
        x.floor === seat.floor && String(x.row).toUpperCase() === String(seat.row).toUpperCase());
      if(g){ out.grade = g.grade; out.sources.push(g.source); }
    }
    if(out.grade == null) out.unknown.push('좌석 등급 (좌석배치도 미수집)');

    // ② 통로 인접 — 확인된 좌석만. 목록에 없으면 모르는 것이다
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

    // ③ 시야제한석 — 명단을 수집한 극장에서만 false 라고 말할 수 있다
    if(venue && venue.collected){
      out.is_restricted = (venue.restricted_seats || []).some(x =>
        x.floor === seat.floor &&
        String(x.row).toUpperCase() === String(seat.row).toUpperCase() &&
        (x.numbers || []).indexOf(seat.number) > -1);
    } else {
      out.unknown.push('시야제한석 명단 (미수집)');
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

  function discountRate(list, paid){
    if(!list || !list.price || !paid) return null;
    const rate = 1 - (paid / list.price);
    if(rate <= 0.001) return 0;
    return Math.round(rate * 100) / 100;
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
      has_grade: !!(seatInfo && seatInfo.grade),
      has_aisle: !!(seatInfo && seatInfo.is_aisle !== null),
      seat_map_collected: !!(venue && venue.collected)
    };
  }

  return {
    findSeason: findSeason,
    findVenue: findVenue,
    rowIndex: rowIndex,
    rowIndexWithinFloor: rowIndexWithinFloor,
    resolveSeat: resolveSeat,
    listPrice: listPrice,
    discountRate: discountRate,
    cancellationPolicy: cancellationPolicy,
    coverage: coverage,
    VENUES: VENUES,
    SEASONS: SEASONS
  };
})();
