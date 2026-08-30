-- =============================================================
-- data/admin_rate_limit.sql — 관리자 로그인 시도 레이트리밋
--
--   배포 전 점검 S-1(레이트리밋 전무) 대응. supabase/functions/admin 이
--   비밀번호 확인마다 이 테이블에 IP·시각을 남기고, 15분에 8회를 넘으면
--   429 로 막는다 (index.ts requireAdmin/checkRateLimit 참고).
--
--   이 SQL 을 아직 안 돌렸어도 함수는 안 죽는다 — 테이블이 없으면
--   레이트리밋 없이 통과시키도록 index.ts 가 짜여 있다. 다만 그동안은
--   무차별 대입 방어가 없는 상태이므로, admin Edge Function 을 재배포하기
--   전에 SQL Editor 에서 이 파일을 한 번 실행해 둘 것.
--
--   실행: Supabase 대시보드 → SQL Editor → 이 파일 내용 붙여넣고 Run.
-- =============================================================

create table if not exists admin_auth_attempts (
  id           bigint generated always as identity primary key,
  ip           text not null,
  attempted_at timestamptz not null default now()
);

create index if not exists admin_auth_attempts_ip_time_idx
  on admin_auth_attempts (ip, attempted_at);

-- service_role(Edge Function) 만 쓴다. RLS 는 켜두고 정책은 만들지 않는다 —
-- anon/authenticated 로는 읽기·쓰기 전부 막힌다 (venues/seasons/seatmaps 와 같은 패턴).
alter table admin_auth_attempts enable row level security;
