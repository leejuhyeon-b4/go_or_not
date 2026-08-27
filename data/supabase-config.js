/* =============================================================
   data/supabase-config.js — 브라우저용 Supabase 접속 정보

   URL 과 publishable 키는 "브라우저에 공개되는" 것이 전제인 값이라
   커밋해도 된다. RLS 가 실제 접근을 통제한다.

   ⚠ service_role(secret) 키는 절대 여기 넣지 말 것 — 서버(Edge Function) 전용.
   ============================================================= */
window.GON_SUPABASE = {
  url: "https://ewemqbatkrmvzevmlteo.supabase.co",
  key: "sb_publishable_kCXhDJNpVFREK8saoLRTFQ_egt0b2l1"
};
