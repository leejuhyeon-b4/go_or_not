-- 엘리자벳 6연 (season_id: 6elisabeth) 수동 입력
-- Supabase SQL Editor 에 붙여넣고 Run  →  그다음 터미널:  npm run pull
-- 출처: NOL(인터파크) 공식 공지 tickets.interpark.com/contents/notice/detail/14348 (2026-08-27 확인)
-- 미수집(할인/좌석배치도/취소규정)은 컬럼에서 뺐고 DB 기본값(null)으로 들어간다.

insert into venues (venue_id, name, row_label_system, base_geometry)
values (
  'bluesquare-woori',
  '블루스퀘어 우리은행홀',
  'NUMERIC',
  '{"is_estimate":true,"note":"대극장 프로시니엄 배치 추정","floors":{"1":[{"name":"OL","side":"left","seat_min":1,"seat_max":6,"aisle_end":"max","wall_end":"min","aliases":["ol","좌","왼","왼쪽","좌블","좌측","l"]},{"name":"C","side":"center","seat_min":7,"seat_max":32,"aisle_end":null,"wall_end":null,"aliases":["c","중","중앙","센터","가운데","중블"]},{"name":"OR","side":"right","seat_min":33,"seat_max":38,"aisle_end":"min","wall_end":"max","aliases":["or","우","오","오른","오른쪽","우블","우측","r"]}]}}'::jsonb
)
on conflict (venue_id) do update set
  name = excluded.name,
  row_label_system = excluded.row_label_system,
  base_geometry = excluded.base_geometry;

insert into seasons (season_id, work_title, season_label, venue_id,
                     open_date, close_date, running_time, has_intermission,
                     prices, prices_verified, discount_proof_policy, source)
values (
  '6elisabeth',
  '엘리자벳',
  '6연',
  'bluesquare-woori',
  '2026-08-16',
  '2026-11-15',
  170,
  true,
  '{"VIP":180000,"R":150000,"S":120000,"A":90000}'::jsonb,
  true,
  'UNKNOWN',
  'NOL/인터파크 공식 공지 (2026-08-27 확인)'
)
on conflict (season_id) do update set
  work_title = excluded.work_title,
  season_label = excluded.season_label,
  venue_id = excluded.venue_id,
  open_date = excluded.open_date,
  close_date = excluded.close_date,
  running_time = excluded.running_time,
  has_intermission = excluded.has_intermission,
  prices = excluded.prices,
  prices_verified = excluded.prices_verified,
  discount_proof_policy = excluded.discount_proof_policy,
  source = excluded.source;
