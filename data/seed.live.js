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

  window.GON_LIVE = Promise.all([get("venues"), get("seasons"), get("seatmaps")])
    .then(function (res) {
      var venues = res[0] || [], seasons = res[1] || [], seatmaps = res[2] || [];
      if (!venues.length && !seasons.length) return false;

      var V = {};
      venues.forEach(function (r) { V[r.venue_id] = r; });
      var M = {};
      seatmaps.forEach(function (r) {
        M[r.season_id] = { updated_at: r.updated_at, source: r.source, floors: r.floors || {} };
      });

      window.GON_VENUES   = Object.assign({}, window.GON_VENUES   || {}, V);
      window.GON_SEATMAPS = Object.assign({}, window.GON_SEATMAPS || {}, M);

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
