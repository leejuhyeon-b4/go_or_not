/* =============================================================
   data/auth.js — 로그인 + 상담기록 저장 (Supabase Auth / consultations)

   index.html 는 이걸로 로그인 게이트를 세우고,
   consult.html 는 판정이 나온 뒤 상담기록을 저장한다.

   file:// 두 페이지가 localStorage 를 공유하지 못하는 브라우저가 있어서,
   세션은 sessionStorage('gon:session') 로 넘긴다 (같은 탭 내비게이션은 유지됨).
   ============================================================= */
window.GON_AUTH = (function () {
  "use strict";
  var cfg = window.GON_SUPABASE || {};
  var sb = (window.supabase && cfg.url)
    ? window.supabase.createClient(cfg.url, cfg.key, {
        auth: { persistSession: true, autoRefreshToken: true }
      })
    : null;

  if (!sb && typeof console !== "undefined") {
    console.warn("[GON_AUTH] supabase-js 또는 설정이 없어 로그인 비활성.");
  }

  var SS_KEY = "gon:session";

  async function getSession() {
    if (!sb) return null;
    var r = await sb.auth.getSession();
    return r.data.session;
  }

  return {
    ready: function () { return !!sb; },
    client: sb,

    getSession: getSession,
    async user() {
      if (!sb) return null;
      var r = await sb.auth.getUser();
      return r.data.user;
    },

    signIn: function (email, pw) { return sb.auth.signInWithPassword({ email: email, password: pw }); },
    signUp: function (email, pw) { return sb.auth.signUp({ email: email, password: pw }); },
    signOut: function () { try { sessionStorage.removeItem(SS_KEY); } catch (e) {} return sb.auth.signOut(); },
    onChange: function (cb) { if (sb) sb.auth.onAuthStateChange(function (_e, s) { cb(s ? s.user : null); }); },

    /* 세션을 다른 페이지로 넘기기 (index → consult) */
    async stashSession() {
      var s = await getSession();
      if (!s) return;
      try {
        sessionStorage.setItem(SS_KEY, JSON.stringify({
          access_token: s.access_token, refresh_token: s.refresh_token
        }));
      } catch (e) {}
    },
    async adoptStashedSession() {
      if (!sb) return null;
      var raw;
      try { raw = sessionStorage.getItem(SS_KEY); } catch (e) { return null; }
      if (!raw) return null;
      var tok = JSON.parse(raw);
      if (!tok || !tok.access_token) return null;
      var r = await sb.auth.setSession(tok);
      return r.data.session || null;
    },

    /* consultations */
    saveConsultation: function (rec) {
      return sb.from("consultations").insert(rec).select().single();
    },
    listConsultations: function () {
      return sb.from("consultations").select("*").order("consulted_at", { ascending: false });
    },
    updateOutcome: function (id, outcome) {
      return sb.from("consultations").update({ outcome: outcome }).eq("id", id);
    }
  };
})();
