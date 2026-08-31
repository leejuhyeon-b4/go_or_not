-- =============================================================
-- data/schema.sql — Supabase 스키마 (PRD §8.4 · §8.5)
--
-- 실행: Supabase 대시보드 → SQL Editor → 아래 전체 붙여넣고 Run
--
-- 설계 메모
--   · 프로토타입 소비 계층(data.js)은 중첩 객체를 통째로 읽는다.
--     그래서 여기서도 과도하게 정규화하지 않고, 중첩 부분은 jsonb 로 둔다.
--     컬럼명 = data/seed.js 의 키와 1:1 (스네이크케이스) → pull.js 가 이름을
--     바꿀 필요가 없다.
--   · RLS: publishable(anon) 키로는 SELECT 만. 쓰기는 대시보드/service_role 로.
-- =============================================================

-- ---------- 극장 (PRD §8.4) --------------------------------------------------
create table if not exists venues (
  venue_id                      text primary key,
  name                          text not null,
  nearest_station               text,
  last_transit_time             int,
  row_label_system              text,            -- 'ALPHA' | 'NUMERIC'
  alpha_continues_across_floors boolean default false,
  specs                         jsonb  default '{}'::jsonb,   -- { "1": {stage_to_row1_distance,...}, ... }
  base_geometry                 jsonb  default '{}'::jsonb,   -- { is_estimate, note, floors:{ "1":[blocks] } }
  verified_seats                jsonb  default '[]'::jsonb,   -- [{ floor,row,number,is_aisle,zone,source }]
  restricted_seats              jsonb  default '[]'::jsonb,
  collected                     boolean default false,
  created_at                    timestamptz default now()
);

-- ---------- 작품·시즌 (PRD §8.5, 2단 구조를 시즌 한 줄로 평탄화) ------------
create table if not exists seasons (
  season_id             text primary key,
  work_title            text not null,
  season_label          text,
  venue_id              text references venues(venue_id),
  open_date             date,
  close_date            date,
  running_time          int,
  has_intermission      boolean,
  prices                jsonb   default '{}'::jsonb,   -- { "R": 70000 }
  prices_verified       boolean default false,
  discounts             jsonb,                          -- [{name,rate,type,applies_to?,grades?,note?}] · null=미수집, []=할인없음
                                                        --   applies_to: ALL(기본)|MATINEE|EVENING  grades: ["R","S"] 없으면 전체등급
                                                        --   note: 적용기간·조건 원문(참고용). 대상별 율/등급 다르면 별도 항목
  discounts_verified    boolean default false,
  discounts_updated_at  timestamptz,                    -- 관리자 도구가 할인 목록 저장한 시각 (UI 표시용)
  discount_proof_policy text,                           -- FULL_PRICE | GRADE_CHANGE | UNKNOWN
  seat_grades           jsonb   default '[]'::jsonb,    -- 등급 구역: [{floor, row_from?, row_to?, seat_from?, seat_to?, grade, source}]
                                                        --   같은 열 가운데 VIP·양끝 R 같은 경우를 seat 범위로. 구식 {floor,row,grade} 도 지원. 좁은 구역 우선
  aisle_seats           jsonb   default '[]'::jsonb,    -- 통로 인접 좌석: [{floor, row_from?, row_to?, row_parity?, numbers:[...]}] · 관리자 입력
  restricted_seats      jsonb   default '[]'::jsonb,    -- [레거시] 시야제한석은 이제 seat_grades 의 "시야제한" 등급. data.js 가 옛 데이터 호환으로만 읽음
  side_seats            jsonb   default '[]'::jsonb,    -- 극싸/사이드(수동): [{floor, row_from?, row_to?, row_parity?, numbers:[...], zone:'EDGE'|'SIDE'}] · 그 층에 있으면 명단 밖은 일반
  wheelchair_seats      jsonb   default '[]'::jsonb,    -- 장애인석: [{floor, row_from?, row_to?, row_parity?, numbers:[...]}] · 관리자 좌석배치도에서 표시
  cross_aisles          jsonb   default '[]'::jsonb,    -- 고속도로(가로통로): [{floor, after_row}] · 그 열 바로 뒤에 좌석 없이 가로지르는 통로
  cancellation_policy   jsonb,
  source                text,
  created_at            timestamptz default now()
);

-- 이미 seasons 테이블이 있는 프로젝트는 아래만 실행 (create 는 컬럼을 안 더한다):
--   alter table seasons
--     add column if not exists discounts_updated_at timestamptz,
--     add column if not exists aisle_seats jsonb default '[]'::jsonb,
--     add column if not exists restricted_seats jsonb default '[]'::jsonb,
--     add column if not exists side_seats jsonb default '[]'::jsonb,
--     add column if not exists wheelchair_seats jsonb default '[]'::jsonb,
--     add column if not exists cross_aisles jsonb default '[]'::jsonb;
--   (open_date / close_date / running_time / has_intermission / prices / prices_verified 는 원래 CREATE 에 있음)

-- ---------- 폐막 공연 자동 정리 (무료플랜 용량 절약) --------------------------
-- 폐막일 7일 뒤 seasons 행을 삭제한다. venues(극장 기하)·consultations(상담기록·
-- 시야만족도 outcome)는 season_id 문자열만 참조하므로 자동삭제와 무관하게 남는다.
-- (시야제한석은 이제 seat_grades 의 "시야제한" 등급이라 함께 사라진다.)
--
--   create extension if not exists pg_cron;
--   select cron.schedule(
--     'purge-closed-seasons', '17 3 * * *',        -- 매일 03:17 (KST 아님, UTC)
--     $$ delete from seasons where close_date is not null and close_date < current_date - 7 $$
--   );
-- 해제:  select cron.unschedule('purge-closed-seasons');
-- 현황:  select * from cron.job;

-- ---------- 공연별 좌석배치도 오버레이 (PRD §8.4 season_seat_maps) ----------
-- ⚠ 현재 아무 코드도 이 테이블에 쓰지 않는다 — admin.html/Edge Function 이
--   좌석 정보를 venues.base_geometry + seasons.seat_grades 로 저장하도록
--   바뀐 뒤로 미사용. data.js 의 SEATMAPS 오버레이 자리는 남겨뒀으니(향후
--   공연별로 극장 기본 배치와 다른 좌석배치를 써야 할 때) 테이블은 지우지
--   않되, 지금 당장은 항상 빈 결과다 (배포 전 점검 P0-3).
create table if not exists seatmaps (
  season_id  text primary key references seasons(season_id),
  updated_at timestamptz,                    -- NULL 이면 미갱신 → base_geometry 폴백 + ⚠️
  source     text,
  floors     jsonb default '{}'::jsonb       -- { "1":[blocks], "2":[blocks] }
);

-- ---------- RLS: publishable 키는 읽기만 --------------------------------------
alter table venues   enable row level security;
alter table seasons  enable row level security;
alter table seatmaps enable row level security;

drop policy if exists "public read venues"   on venues;
drop policy if exists "public read seasons"  on seasons;
drop policy if exists "public read seatmaps" on seatmaps;

create policy "public read venues"   on venues   for select using (true);
create policy "public read seasons"  on seasons  for select using (true);
create policy "public read seatmaps" on seatmaps for select using (true);


-- =============================================================
-- 수동 입력 예시 — 해몽가 2026 (data/seed.js 의 검증된 값과 동일)
--
-- 이 블록을 실행하면 seed.js 의 해몽가·예스24 1관이 Supabase 로 올라간다.
-- 다른 작품을 넣을 때 이 형식을 복붙해서 값만 바꾸면 된다.
-- (Table Editor 에서 행을 직접 추가해도 된다 — jsonb 칸은 JSON 그대로 입력)
-- =============================================================

insert into venues (venue_id, name, row_label_system, alpha_continues_across_floors,
                    specs, base_geometry, verified_seats, restricted_seats, collected)
values (
  'yes24-stage-1',
  '예스24스테이지 1관',
  'ALPHA',
  true,
  '{"1":{"stage_to_row1_distance":null,"row_count":null,"row_spacing":null,"tier_start_row":null,"has_orchestra_pit":null,"balcony_overhang_row":null},
    "2":{"stage_to_row1_distance":null,"row_count":null,"row_spacing":null,"tier_start_row":null,"has_orchestra_pit":null,"balcony_overhang_row":null}}'::jsonb,
  '{"is_estimate":true,
    "note":"표준 프로시니엄 배치 추정 — 실측 좌석배치도 아님",
    "floors":{
      "1":[
        {"name":"OL","side":"left","seat_min":1,"seat_max":4,"aisle_end":"max","wall_end":"min","aliases":["ol","좌","왼","왼쪽","좌블","좌측","l"]},
        {"name":"C","side":"center","seat_min":5,"seat_max":20,"aisle_end":null,"wall_end":null,"aliases":["c","중","중앙","센터","가운데","중블","중블록"]},
        {"name":"OR","side":"right","seat_min":21,"seat_max":24,"aisle_end":"min","wall_end":"max","aliases":["or","우","오","오른","오른쪽","우블","우측","r"]}
      ],
      "2":[
        {"name":"2OL","side":"left","seat_min":1,"seat_max":3,"aisle_end":"max","wall_end":"min","aliases":["2ol","2층좌","좌","왼"]},
        {"name":"2C","side":"center","seat_min":4,"seat_max":15,"aisle_end":null,"wall_end":null,"aliases":["2c","2층중","중","중앙","센터"]},
        {"name":"2OR","side":"right","seat_min":16,"seat_max":18,"aisle_end":"min","wall_end":"max","aliases":["2or","2층우","우","오른"]}
      ]
    }}'::jsonb,
  '[{"floor":1,"row":"B","number":16,"is_aisle":true,"source":"test_cases.md CASE 2 — 실제 관람에서 통로석 확인"},
    {"floor":1,"row":"J","number":13,"is_aisle":false,"zone":"중블 중앙","source":"test_cases.md CASE 5"},
    {"floor":2,"row":"Q","number":7,"angle_note":"오글 사용 시 살짝 정수리뷰","source":"test_cases.md CASE 6 — 실제 관람자 진술"}]'::jsonb,
  '[]'::jsonb,
  false
)
on conflict (venue_id) do update set
  name = excluded.name, row_label_system = excluded.row_label_system,
  alpha_continues_across_floors = excluded.alpha_continues_across_floors,
  specs = excluded.specs, base_geometry = excluded.base_geometry,
  verified_seats = excluded.verified_seats, restricted_seats = excluded.restricted_seats,
  collected = excluded.collected;

insert into seasons (season_id, work_title, season_label, venue_id, open_date, close_date,
                     running_time, has_intermission, prices, prices_verified,
                     discounts, discounts_verified, discount_proof_policy, seat_grades,
                     cancellation_policy, source)
values (
  'haemong-2026',
  '해몽가',
  '2026',
  'yes24-stage-1',
  '2026-06-25',
  '2026-09-13',
  100,
  false,
  '{"R":70000}'::jsonb,
  true,
  '[{"name":"조기예매 할인","rate":30,"type":"STANDING"},
    {"name":"청소년 할인","rate":50,"type":"ELIGIBILITY"},
    {"name":"재관람 할인","rate":40,"type":"LOYALTY"}]'::jsonb,
  false,
  'GRADE_CHANGE',
  '[]'::jsonb,
  null,
  'test_cases.md CASE 2·5'
)
on conflict (season_id) do update set
  work_title = excluded.work_title, season_label = excluded.season_label,
  venue_id = excluded.venue_id, open_date = excluded.open_date, close_date = excluded.close_date,
  running_time = excluded.running_time, has_intermission = excluded.has_intermission,
  prices = excluded.prices, prices_verified = excluded.prices_verified,
  discounts = excluded.discounts, discounts_verified = excluded.discounts_verified,
  discount_proof_policy = excluded.discount_proof_policy, seat_grades = excluded.seat_grades,
  cancellation_policy = excluded.cancellation_policy, source = excluded.source;
