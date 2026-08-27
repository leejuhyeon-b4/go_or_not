/* =============================================================
   data/kopis.js — KOPIS 공연예술통합전산망에서 작품 정보 조회
                    → 화면 출력 + data/kopis-import.sql 생성 (의존성 0)

   실행:  node data/kopis.js 엘리자벳
          node data/kopis.js "엘리자벳" 2026             (연도 힌트, 선택)
          node data/kopis.js "엘리자벳" 2026 6elisabeth  (season_id 지정, 결과 1건일 때)

   ▶ 흐름
     1) pblprfr 목록 조회 (공연명 검색)
     2) 각 결과의 상세(pblprfr/{id}) + 공연시설(prfplc/{id}) 조회
     3) 사람이 읽을 요약을 출력
     4) 우리 스키마(venues/seasons)에 맞춘 INSERT 문을 data/kopis-import.sql 로 저장
        → Supabase SQL Editor 에 붙여넣고 Run → `npm run pull`

   ▶ KOPIS OpenAPI 키는 .env 의 KOPIS_API_KEY_LIST / KOPIS_API_KEY_DETAIL
     (data.go.kr 은 API 별로 키가 다름). 승인까지 시간이 걸리며,
     'SERVICE KEY IS NOT REGISTERED ERROR' 가 나오면 아직 활성화 전이다.
     https://www.kopis.or.kr → 마이페이지 → OpenAPI 인증키 현황 에서 확인.
   ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(__dirname, 'kopis-import.sql');
const BASE = 'http://kopis.or.kr/openApi/restful';

/* ---- .env ---------------------------------------------------- */
function env(name) {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) fail('.env 가 없습니다.');
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && m[1] === name) return m[2].replace(/^['"]|['"]$/g, '');
  }
  return '';
}
function fail(msg) { console.error('✗ ' + msg); process.exitCode = 1; throw new Error(msg); }

/* ---- 아주 작은 flat-XML 파서 -------------------------------- */
// KOPIS 응답은 <db>…</db> 반복에 자식이 한 겹뿐이라 정규식으로 충분하다.
function decode(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').trim();
}
function rows(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) {
    const rec = {};
    const inner = m[1];
    let f;
    const fre = /<([a-zA-Z0-9]+)>([\s\S]*?)<\/\1>/g;
    while ((f = fre.exec(inner))) rec[f[1]] = decode(f[2]);
    out.push(rec);
  }
  return out;
}

async function get(url, soft) {
  const bail = (m) => { if (soft) throw new Error(m); fail(m); };
  const res = await fetch(url, { headers: { Connection: 'close' } });
  const text = await res.text();
  const err = /<errmsg>([\s\S]*?)<\/errmsg>/.exec(text);
  if (err) bail(`KOPIS: ${decode(err[1])}`);
  if (!res.ok) bail(`KOPIS HTTP ${res.status}`);
  return text;
}

/* ---- 파싱 도우미 ------------------------------------------- */
const ymd = (s) => (s || '').replace(/\./g, '-') || null;         // 2026.06.25 → 2026-06-25
function minutes(s) {
  // KOPIS 형식: "1시간 30분" / "2시간" / "170분" 모두 대응
  s = s || '';
  const h = /(\d+)\s*시간/.exec(s);
  const m = /(\d+)\s*분/.exec(s);
  const total = (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
  return total || null;
}
function parsePrices(guide) {
  // "VIP석 170,000원, R석 140,000원" → { VIP:170000, R:140000 }
  const out = {};
  const re = /([A-Za-z가-힣0-9]+)\s*석?\s*[:\s]*([\d,]+)\s*원/g;
  let m;
  while ((m = re.exec(guide || ''))) {
    const grade = m[1].replace(/석$/, '').toUpperCase();
    out[grade] = Number(m[2].replace(/,/g, ''));
  }
  return out;
}
const q = (v) => (v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`);
const j = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-|-$/g, '');

/* ---- 메인 -------------------------------------------------- */
(async () => {
  const name = process.argv[2];
  const yearHint = process.argv[3];
  const seasonIdArg = process.argv[4];   // 결과 1건일 때 season_id 를 이 값으로 고정
  if (!name) fail('사용법: node data/kopis.js <공연명> [연도] [season_id]');

  // data.go.kr 은 활용신청 API 별로 키가 다르게 나온다. LIST/DETAIL 따로 받되,
  // 옛 단일 KOPIS_API_KEY 만 있으면 그걸 양쪽에 쓴다.
  // (이미 %-인코딩된 Encoding 키면 그대로, 아니면 인코딩 — 순수 UUID 는 무변화)
  const enc = (r) => (/%[0-9A-Fa-f]{2}/.test(r) ? r : encodeURIComponent(r));
  const single = env('KOPIS_API_KEY');
  const listRaw = env('KOPIS_API_KEY_LIST') || single;
  const detailRaw = env('KOPIS_API_KEY_DETAIL') || single;
  if (!listRaw || !detailRaw) {
    fail('.env 에 KOPIS_API_KEY_LIST / KOPIS_API_KEY_DETAIL 를 채우세요.');
  }
  const keyList = enc(listRaw);
  const keyDetail = enc(detailRaw);

  const st = (yearHint ? yearHint : '2023') + '0101';
  const ed = (yearHint ? yearHint : String(new Date().getFullYear() + 1)) + '1231';
  const listUrl = `${BASE}/pblprfr?service=${keyList}&stdate=${st}&eddate=${ed}`
    + `&shprfnm=${encodeURIComponent(name)}&cpage=1&rows=50`;

  console.log(`· 검색: "${name}"  (${st}~${ed})`);
  const list = rows(await get(listUrl), 'db');
  if (!list.length) fail('KOPIS 에서 결과가 없습니다. 공연명을 정확히 적어보세요.');

  console.log(`· ${list.length}건 발견 — 상세 조회\n`);
  const sqls = [];
  const seenVenue = new Set();

  for (const item of list) {
    const d = rows(await get(`${BASE}/pblprfr/${item.mt20id}?service=${keyDetail}`), 'db')[0] || {};
    let venue = {};
    if (d.mt10id) {
      // 공연시설상세는 부가정보(가까운 역 등). 이 API 미승인·오류여도 진행한다.
      try {
        venue = rows(await get(`${BASE}/prfplc/${d.mt10id}?service=${keyDetail}`, true), 'db')[0] || {};
      } catch { venue = {}; }
    }

    const open = ymd(d.prfpdfrom);
    const close = ymd(d.prfpdto);
    const year = (open || '').slice(0, 4) || item.prfpdfrom.slice(0, 4);
    const prices = parsePrices(d.pcseguidance);
    const venueId = d.mt10id ? `kopis-${d.mt10id}` : null;
    const seasonId = (seasonIdArg && list.length === 1)
      ? seasonIdArg
      : `${slug(d.prfnm || name)}-${year}`;

    console.log(`■ ${d.prfnm}  [${year}]`);
    console.log(`  기간   ${open} ~ ${close}`);
    console.log(`  극장   ${d.fcltynm || '?'}${venue.adres ? '  (' + venue.adres + ')' : ''}`);
    console.log(`  런타임 ${d.prfruntime || '?'}   (${minutes(d.prfruntime) ?? '?'}분)`);
    console.log(`  가격   ${d.pcseguidance || '?'}`);
    console.log(`  상태   ${d.prfstate || '?'}   출연: ${(d.prfcast || '').slice(0, 60)}`);
    console.log(`  mt20id ${item.mt20id}   mt10id ${d.mt10id || '-'}\n`);

    if (venueId && !seenVenue.has(venueId)) {
      seenVenue.add(venueId);
      sqls.push(
`insert into venues (venue_id, name, nearest_station, row_label_system, base_geometry, collected)
values (${q(venueId)}, ${q(d.fcltynm)}, ${q(venue.subwayname || null)}, null, '{}'::jsonb, false)
on conflict (venue_id) do update set name = excluded.name;`);
    }
    sqls.push(
`insert into seasons (season_id, work_title, season_label, venue_id, open_date, close_date,
                     running_time, has_intermission, prices, prices_verified,
                     discounts, discounts_verified, discount_proof_policy, source)
values (${q(seasonId)}, ${q(d.prfnm)}, ${q(year)}, ${q(venueId)}, ${q(open)}, ${q(close)},
        ${minutes(d.prfruntime) ?? 'null'}, null, ${j(prices)}, false,
        null, false, 'UNKNOWN', ${q('KOPIS ' + item.mt20id)})
on conflict (season_id) do update set
  work_title=excluded.work_title, venue_id=excluded.venue_id,
  open_date=excluded.open_date, close_date=excluded.close_date,
  running_time=excluded.running_time, prices=excluded.prices, source=excluded.source;`);
  }

  const header =
`-- 자동 생성: node data/kopis.js "${name}"  @ ${new Date().toISOString()}
-- 검토 후 Supabase SQL Editor 에 붙여넣고 Run → 그다음 'npm run pull'
-- ⚠ KOPIS 는 정가/기간/극장만 준다. 할인(discounts)·좌석배치도·인터미션은
--   여기 없다 — 예매처에서 따로 확인해 채운다 (PRD 원칙 6).

`;
  fs.writeFileSync(OUT, header + sqls.join('\n\n') + '\n');
  console.log(`✓ ${path.relative(ROOT, OUT)} 생성 (${list.length} 시즌)`);
})().catch(() => { /* fail() 이 이미 메시지+exitCode 처리 */ });
