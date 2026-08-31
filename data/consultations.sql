-- =============================================================
-- consultations — 상담 기록 (PRD §8 · §10.1 피드백/RAG 루프의 앵커)
-- Supabase SQL Editor 에 붙여넣고 Run.
--
-- 사전 설정: Authentication → Providers → Email → "Confirm email" 끄기
--            (file:// 에서 이메일 확인 링크를 못 여니까)
-- =============================================================

create table if not exists consultations (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade default auth.uid(),
  work_title   text,
  season_id    text,
  season_label text,
  seat         jsonb,          -- {floor,row,number,block,grade,is_restricted,is_wheelchair,side_zone,...}
  paid         integer,        -- 지불액
  verdict      text,           -- GO | NO_GO | ...
  axis_scores  jsonb,          -- {DEOKSIM,SIYA,COST,EVENT,CONDITION}  (muted 는 null)
  session_date date,           -- 관람일
  consulted_at timestamptz not null default now(),
  outcome      jsonb           -- 사후 피드백(나중): {result:'WENT'|'GAVE'|'SKIP', seat_sat:0-4, gift_sat:0-4}
);

create index if not exists consultations_user_idx on consultations (user_id, consulted_at desc);

alter table consultations enable row level security;

drop policy if exists "own consultations" on consultations;
create policy "own consultations" on consultations
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
