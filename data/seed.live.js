/* =============================================================
   data/seed.live.js — 브라우저에서 직접 Supabase 조회 → 런타임 오버레이

   'npm run pull' 없이 항상 최신 데이터를 쓴다. 관리자 도구(admin.html)에서
   저장하면, 상담 앱을 새로고침하는 것만으로 반영된다.

   로드 순서: seed.js → seed.remote.js → data.js → auth.js → seed.live.js
   (data.js 뒤여야 GON_DB.reload 를 부를 수 있다.)

   병합 규칙은 pull.js 와 동일 — seed 위에 venue_id / season_id 단위로 덮는다.
   GON_SUPABASE 설정이 없거나 조회 실패면 아무것도 안 하고 기존 값을 쓴다.

   완료되면 window 'gon:data' 이벤트를 쏜다. index.html 이 폼을 다시 그린다.
   window.GON_LIVE 는 Promise<boolean> — true 면 라이브 데이터 적용됨.

   ⚠ seatmaps 테이블은 조회하지 않는다 — admin.html/Edge Function 이 좌석
     정보를 venues.base_geometry + seasons.seat_grades 에 저장하도록 바뀐
     뒤로 그 테이블엔 아무도 쓰지 않는다(배포 전 점검 P0-3). 조회해봐야
     항상 빈 배열이라 매 로드마다 헛 요청만 하나 늘던 것을 뺐다.
   ============================================================= */
(function () {
  "use strict";
  var cfg = window.GON_SUPABASE || {};
  if (!cfg.url || !cfg.key) { window.GON_LIVE = Promise.resolve(false); return; }

  var base = String(cfg.url).replace(/\/$/, "");
  var headers = { apikey: cfg.key, Authorization: "Bearer " + cfg.key };

  function get(table) {
    return fetch(base + "/rest/v1/" + table + "?select=*", { headers: headers })
      .then(function (r) { return r.ok ? r.json() : []; })
      .catch(function () { return []; });
  }

  // 같은 공연(work_title)이 seed.js 와 라이브 DB에 서로 다른 season_id 로
  // 존재하면 병합이 안 되고 관리자 저장이 조용히 무시된다 (해몽가 사고 — P0-1).
  // 재발하면 최소한 콘솔에는 뜨게 해 둔다.
  function warnIfDuplicateWorkTitle(fallbackSeasons, liveSeasons) {
    liveSeasons.forEach(function (live) {
      var dup = fallbackSeasons.find(function (s) {
        return s.season_id !== live.season_id && s.work_title === live.work_title;
      });
      if (dup && typeof console !== "undefined") {
        console.warn(
          "[GON] '" + live.work_title + "' 의 season_id 가 seed.js(" + dup.season_id +
          ")와 라이브 DB(" + live.season_id + ")에서 다릅니다 — 관리자 저장이 앱에 반영되지 않습니다. " +
          "data/seed.js 의 season_id 를 라이브 값으로 맞추세요."
        );
      }
    });
  }

  window.GON_LIVE = Promise.all([get("venues"), get("seasons")])
    .then(function (res) {
      var venues = res[0] || [], seasons = res[1] || [];
      if (!venues.length && !seasons.length) return false;

      warnIfDuplicateWorkTitle(window.GON_SEASONS || [], seasons);

      var V = {};
      venues.forEach(function (r) { V[r.venue_id] = r; });
      window.GON_VENUES = Object.assign({}, window.GON_VENUES || {}, V);

      var byId = {};
      (window.GON_SEASONS || []).forEach(function (s) { byId[s.season_id] = s; });
      seasons.forEach(function (s) { byId[s.season_id] = s; });
      window.GON_SEASONS = Object.keys(byId).map(function (k) { return byId[k]; });

      if (window.GON_DB && window.GON_DB.reload) window.GON_DB.reload();
      try { window.dispatchEvent(new Event("gon:data")); } catch (e) {}

      if (typeof console !== "undefined") {
        console.info("[GON] Supabase 라이브 조회:",
          Object.keys(V).length + " venues, " + seasons.length + " seasons");
      }
      return true;
    })
    .catch(function () { return false; });
})();
