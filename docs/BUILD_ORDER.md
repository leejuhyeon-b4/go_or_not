# 빌드 현황 (Supabase 연동 이후)

> 다음 세션은 이 문서를 읽고 이어서 작업한다. "빌드 순서 문서대로 이어서" 하면 **다음 작업**부터.
> 설정(설치·키·SQL)은 루트 `SETUP.md`. 관리자 도구 배포는 `supabase/functions/admin/DEPLOY.md`.

---

## 데이터 파이프라인 (터미널 없이 동작)

```
KOPIS ─(node data/kopis.js, 키 미활성)→ SQL ─┐
관리자도구(admin.html) ─(기본정보·할인·배치도)┼→ Supabase (venues / seasons)
수동 SQL ─────────────────────────────────────┘   └ pg_cron: 폐막 7일 뒤 seasons 행 삭제
                                             │
   상담 앱 로드 시 data/seed.live.js 가 Supabase REST 직접 조회 → window.GON_* 오버레이
   → GON_DB.reload() → 'gon:data' 이벤트 → index.html 폼 다시 그림.  ← 항상 최신, npm run pull 불필요
```

- `data/seed.js` — 폴백 + `test/run.js` 픽스처. **건드리지 않는다.**
- `data/seed.remote.js` — `npm run pull`(`data/pull.js`)이 생성. gitignore. 이제 **선택**(오프라인 스냅샷용).
- `data/seed.live.js` — 런타임 조회. `GON_SUPABASE` 없거나 실패 시 조용히 폴백. Supabase CORS 가 Origin echo → `file://` 도 됨.
- 로드 순서: `seed.js` → `seed.remote.js` → `data.js` → `auth.js` → `seed.live.js`.
- 관리자 저장 → 상담 앱 **새로고침**만으로 반영. 앱을 호스팅하면 폰만으로 데이터 관리 가능.

---

## 완료됨

### 관리자 도구 — `admin.html` + `supabase/functions/admin/` (JSON API)
- 진입: 랜딩 우하단 ⚙ → `admin.html`. 인증 = 공유 비밀번호 `ADMIN_PASSWORD`(계정 없음, `x-admin-password` 헤더).
- Supabase 가 Edge Function 의 HTML 응답을 막아서 화면은 정적 파일, 함수는 JSON API 만.
- 배포: CLI `supabase functions deploy admin --project-ref ewemqbatkrmvzevmlteo --use-api --no-verify-jwt`
  (웹 에디터는 큰 파일 한글 깨짐). CLI 가 막히면 Management API `POST /v1/projects/{ref}/functions/deploy?slug=admin`
  (multipart: `metadata` JSON + `file`) — `DEPLOY.md` §4 참고. PowerShell 은 `.ps1` 실행정책에 막히니 `supabase.cmd` 나
  `Set-ExecutionPolicy -Scope Process Bypass`.
- **할인정보 탭**: 이미지 여러 장 → Gemini `[{name,rate,type,applies_to,grades,note}]` → 검토표 → `seasons.discounts`.
  시즌 선택 시 **기존 할인 미리 로드**, 판독은 거기에 더해짐(1·2차 공지 누적). `discounts_updated_at` 기록.
- **기본정보 탭** [2026-08-31 신설] — 극명 · 시즌(`season_label`) · 극장 · 공연기간(개막/폐막) ·
  **등급별 정가** 를 손입력해 `seasons` 한 행에 저장 (`action=save-season-meta`, `prices_verified=true`).
  KOPIS 미승인·정가 파싱 불안정이라 여기서 채운다. 정가 표에 **`시야제한`** 행을 넣으면 그게 시야제한석 정가.
  등급 이름 끝의 "석"은 자동 제거(`시야제한석`→`시야제한`, `R석`→`R`) — `seat_grades` 등급 코드와 맞춤.
  **"극장" 칸도 자유입력** — 목록에 없으면 저장 시 `action=create-venue` 로 생성 (열 표기 안 주면 `null`,
  `data.js` 가 라벨 모양으로 추론). 극장 없는 기존 공연은 좌석배치도 탭에서도 붙일 수 있다.
- **좌석배치도 탭 = 공연(시즌) 선택.** `seasons.seat_grades/aisle_seats/side_seats/wheelchair_seats/cross_aisles`
  + `venues.base_geometry`(블록) 를 채우는 경로:
  - **공연 선택 시 저장된 배치도가 표·메모에 자동 로드** [2026-08-31] — 블록(venues 액션이 `base_geometry`
    반환) · 등급 · 통로 · 장애인석 · 극싸/사이드 · 고속도로. 메모는 `parseSeatMemo` 문법으로 자동 생성
    (사용자가 안 고쳤을 때만 덮음). "저장된 표에서 격자 만들기" 버튼 = 열범위·좌석수 자동 추론해 격자 재구성.
  - **문단 메모**: `parse-seatmap` → Gemini **초안 문단**(`{memo}`) → 관리자가 형식대로 고침 →
    "표 채우기"(`parseSeatMemo`) → 표 → 저장. Gemini 초안이 부실하면 Claude 챗(수동) 결과를
    같은 칸에 붙여넣어도 형식만 맞으면 파싱됨 — `admin.html` 에 프롬프트 템플릿·복사 버튼.
  - **격자 색칠판** — 세로 열 × 가로 좌석번호 판(칸 하나 = 좌석 하나). 층 탭(`+층`), 좌우대칭(기본 켜짐),
    자유칠, 고속도로 붓. 붓: 등급(`시야제한` 포함) · 통로 · 장애인석 · 극싸/사이드(수동) · 좌석없음 · 고속도로.
    마우스로 칠할 때 열 경계 데드밴드(6px)로 옆 열 이탈 방지 + 자유칠 선 보간. 극싸/사이드 + 지우개 =
    자동 점선까지 지움(`sideOff`). "격자 → 아래 표 채우기" 로 열범위·번호범위 압축해 표에 넣음(그 층만).
  - 표는 "+행" 버튼으로 직접 추가·수정도 가능.
  - 메모 형식(한 줄 = 한 층·한 열컨텍스트):
    ```
    1층
    블록 좌 1-8 / 중 9-40 / 우 41-48
    1-3열 8-11번 R / 12-37번 VIP / 38-41번 R
    5-7열 R                     (좌석범위 없이 등급만 = 그 열 전체)
    1-3열 1-2번 시야제한         (시야제한석 = 등급. "1-3열 시야제한 1,2" 옛 표기도 받음)
    짝수열 통로 15,16,32,34      (홀수열 통로 ... — 통로번호가 홀짝에 따라 밀리는 극장)
    1-5열 통로 31
    1열 장애인석 1,2
    ```
  - 저장 위치: 블록 → `venues.base_geometry` (+ `is_estimate=false`, `collected=true`),
    등급 → `seasons.seat_grades` (`시야제한` 등급 저장 시 레거시 `restricted_seats` 는 `[]` 로 비움),
    통로 → `seasons.aisle_seats`, 장애인석 → `seasons.wheelchair_seats`,
    극싸/사이드(수동) → `seasons.side_seats`, 고속도로 → `seasons.cross_aisles`.
    전부 구역 `{floor, row_from?, row_to?, row_parity?('even'|'odd'), seat_from?/seat_to?|numbers?[], ...}`.
    `data.js seatInZone()` 이 평가 — 같은 열 가운데 VIP·양끝 R, 홀짝 통로 다 대응. 좁은 구역 우선.

### 상담 앱 (`index.html`)
- **로그인 게이트** — Supabase Auth. 모달이 화면을 막지 않게(닫기 가능), 로드 시 자동 오픈 안 함.
  `?preview` / `#preview` = 로그인 없이 폼·상담시작 활성(저장은 세션 없어 스킵).
  `file://`·`localhost` 에서만 동작 — 배포 도메인에서는 로그인 우회 안 됨.
- **R-4 "어떤 할인" = 버튼** — 이 시즌 실제 할인 + `정가` + `목록에 없는 할인`.
  등급별로 나뉜 할인(조기예매 VIP·R 10% / S·A 20%)은 **버튼 1개** — 좌석 넣으면 등급으로 `resolveSelectedDiscount()` 자동 선택.
  할인 미수집 시즌도 `정가`/`할인 받음` 버튼은 두고 degraded 판정. 라벨 옆 `discounts_updated_at` 표시.
- **R-3b 좌석 등급 폴백** — 다등급인데 `resolveSeat().grade` null 이면 `#seatGradeExtra` 열려
  `season.prices` 키 버튼(`시야제한` 은 제외, 아래 전용 버튼) + **"시야제한석"** 버튼.
  시야제한석 고르면 `state.seatGrade='시야제한'` + `state.seatRestricted=true` → `prices['시야제한']` 있으면 그 정가,
  없으면 폴백(지불액=정가). `state` → 상담 기록에만(Supabase X). 좌석배치도로 등급이 채워지면 안 뜬다.
- **사후 피드백 모달** (PRD §3.6·§10.1) — 로그인 직후 `checkPendingFeedback()`:
  `session_date < 오늘` + `outcome IS NULL` + `gon:snooze:<id>` 없는 상담 중 가장 오래된 것 하나만.
  갔음→자리(+이벤트 있으면 증정) / 나눔→증정만 / 안 감→끝. `GON_AUTH.updateOutcome`. 이용내역에 결과/`관람 예정` 배지.
- 상담기록: 판정 후 `consult.html` 이 `consultations` 저장(RLS 본인 것만). 우상단 "이용내역".

### 엔진 (`engine.js` / `data.js`)
- **전부 결정론적 — LLM 호출 0회.** `runConsult(bundle)` 이 5개 축 점수 + 푯말/설명 문구를 코드로 만든다.
  PRD §14 Phase 1 은 "코드가 가드레일·밴드 확정 → LLM 이 종합·서술" 이지만 **아직 API 미연결** (다음 작업 참고).
- **`baselineRate`** 가 회차(`applies_to`)·좌석등급(`grades`)에 안 맞는 할인을 기준선에서 제외. 모르면 보수적 포함.
- **degraded 할인율** — 정가는 있고 할인 목록 미수집이면 "정가 X에서 Z% 할인받으셨습니다 (최선 여부 판단 안 함)".
- **통로(`is_aisle`)** — `season.aisle_seats` 명단 있으면 `true`/`false` 확정, 없으면 "모름". 선호좌석 '통로석' 사용.
- **장애인석(`is_wheelchair`)** — `season.wheelchair_seats` 명단 있으면 `true`/`false`, 없으면 `null`(unknown 에도 안 넣음).
- **시야제한석 = 등급** [2026-08-31] — `resolveSeat().grade === '시야제한'` 이면 `is_restricted=true`.
  `listPrice` 는 `prices['시야제한']`(끝 "석" 보정). 상담 앱 R-3b 는 그 정가 있으면 쓰고 없으면 옛 폴백(지불액=정가).
  레거시 `season/venue.restricted_seats` 명단도 계속 읽는다(호환).
- 시야축 사이드/중앙/엣지(`side_zone`) — `season.side_seats` 명단이 그 층에 있으면 그걸 신뢰(명단 밖은 일반),
  없으면 `venues.base_geometry` 블록 구조에서 `classifySide`/`sideZoneFor` 계산.

### 인프라
- **KOPIS 수집** — `data/kopis.js "공연명" 연도 season_id` → `data/kopis-import.sql`.
  ⚠ data.go.kr 키 여전히 미활성 (`SERVICE KEY IS NOT REGISTERED`). 활성돼도 정가는 자유텍스트라 불안정 → 기본정보 탭 손입력.
- **폐막 자동삭제** [2026-08-31] — pg_cron `purge-closed-seasons` (매일 03:17 UTC), `close_date` 7일 경과 `seasons` 행 삭제.
  `venues`(극장 기하)·`consultations`(상담기록·`outcome` 시야만족도)는 유지. 무료플랜 용량 절약. 설정 SQL 은 `data/schema.sql` 하단.
- **keep-alive** — `.github/workflows/keep-alive.yml`, 5일마다 `venues` 1행 조회로 Supabase 무료 프로젝트 유지.
  secrets: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`. main 브랜치에 있어야 동작.

### 마이그레이션 (기존 프로젝트에 실행 — `data/schema.sql` 하단에도)
```sql
alter table seasons
  add column if not exists discounts_updated_at timestamptz,
  add column if not exists aisle_seats jsonb default '[]'::jsonb,
  add column if not exists restricted_seats jsonb default '[]'::jsonb,
  add column if not exists side_seats jsonb default '[]'::jsonb,
  add column if not exists cross_aisles jsonb default '[]'::jsonb,
  add column if not exists wheelchair_seats jsonb default '[]'::jsonb;
-- open_date / close_date / running_time / has_intermission / prices 는 CREATE 에 이미 있음
```
> 현재 라이브(`ewemqbatkrmvzevmlteo`): Edge Function `admin` **v23** (2026-09-01 — 예매처 무시 프롬프트 + 역순 번호 `blockDefaults`), 위 컬럼 전부 적용됨, pg_cron 등록됨.

---

## 다음 작업

1. **에이전트 LLM API 연결** (PRD §14 Phase 1 "최우선", 아직 0%) —
   지금 `engine.js` 가 축 점수 + 문구를 전부 하드코딩. 설계는 *코드가 밴드·가드레일 확정 → LLM 이 종합·결론·서술*.
   - **에이전트별 모델 분리 [2026-09-01 결정]:** 기본은 Claude, **시야 에이전트는 더 싼 API(그록 등, `grok-3-mini` 말고 상위 모델)**.
     에이전트마다 `provider`/`model` 을 지정 가능하게 (Edge Function 라우팅).
   - API 키(유료 티어 필수 — 상담 데이터라 무료 티어 금지, PRD B-4·§12.1). Claude + 그록 둘 다 시크릿에.
   - Edge Function (`admin` 처럼, 키 서버 보관) — 번들 받아 5 에이전트 + 팀장 호출
   - **월 비용 한도**: `llm_usage` 테이블에 월별 누적, `LLM_MONTHLY_CAP_USD` 초과 시 그록/클로드 호출 스킵하고 `engine.js` 결과만 반환
   - **결과 캐시**: 같은 입력 번들(회차+좌석+답변 전부) 해시로 `consult_cache` 조회 → 히트면 저장된 결과 그대로, API 미호출
   - 프롬프트 6개 작성 (`test_cases.md` 6건이 회귀 기준, PRD §13.6 출력 스키마)
   - `consult.html` 연결 — `engine.js` 는 가드레일·밴드 계산 + **API 실패 시 폴백**으로 유지
2. **호스팅** — GitHub Pages / Netlify 등에 정적 배포. 배포 후 그 도메인을 `ADMIN_ALLOWED_ORIGINS` 시크릿에 추가
   (지금은 localhost/127.0.0.1/file:// 만 자동 허용).
3. **디자인/아트** — design.md §11 미결정 참고. 팀장·컨디션 건물은 제작 완료(§9.1).
   말풍선 최대 폭/줄수 확정, 모바일 말풍선 시트, 팀장 포즈별 표현.
4. **개인정보처리방침** — 유료 API + `consultations` 저장 시 고지 의무 (PRD B-4).
5. **시야제한석 독립 트리거** — 지금은 R-3b(등급 폴백)에 얹혀서만 물음. 등급은 아는데 좌석배치도가 없는
   공연에서는 시야제한석을 못 물어봄. 필요하면 독립 조건 추가.
6. **실서비스 공연 데이터 채우기** — 지금 3개(해몽가·엘리자벳·웨스턴스토리)는 테스트. 관리자 도구 한 바퀴 검증.

---

## 나중 (Phase 4+)

- `consultations` / `outcomes` → 익명화 → 임베딩 → RAG 유사 케이스 검색 (PRD §10).
- 축적 자리 만족도 통계 (극장×블럭) → 시야축 정확도.
- `GRADE_RANK` 하드코딩 사다리(`engine.js`) — 비표준 등급 라벨(프리미엄/로얄) 별칭표. 지금은 알려진 한계.
- KOPIS 정기 실행 (cron) — 데이터가 잘 안 바뀌어 우선순위 낮음.

---

## 잠긴 설계 결정 (재논의 불필요)

| 결정 | 이유 |
|---|---|
| 상담 저장 = 로그인 + Supabase (localStorage 아님) | 서비스 데이터 축적·RAG 루프 앵커 (PRD §10.1) |
| 상담 시작 = 로그인 필수 | 사용자 요청. 익명 사용 안 함 |
| baseline 모르면 null, 판정 보류 | 원칙 6 — "최선이었다" 단정 금지 |
| 좌석 등급은 좌석배치도에서, 안 되면 R-3b 로 사용자에게 | Gemini 색↔등급 판독 불가. 티켓이 정답 |
| 시야제한석 = `시야제한` 등급 (마커 아님) [2026-08-31] | 정가가 따로라서. 별도 컬럼/붓 필요 없음 |
| 할인 폴백 질문 없음 (degraded 만) | 사용자에게 할인 메뉴 묻기 = 서비스 무의미. 진짜 해결은 관리자 도구 수집 |
| 관리자 좌석배치도 = 문단 메모 + 격자 색칠판 둘 다 | 메모는 빠른 수정, 격자는 부채꼴·홀짝 통로 시각 확인. 저장 스키마는 동일 |
| 공연·극장·정가·기간 = 기본정보 탭 손입력 (KOPIS 아님) [2026-08-31] | KOPIS 미승인 + 정가 파싱 불안정 |
| 폐막 7일 뒤 seasons 행 자동삭제 [2026-08-31] | 무료플랜 용량. venues·consultations 는 유지 |
| 데이터 = seed.live.js 런타임 조회 (pull 선택) | 폰만으로 관리 가능. pull 은 오프라인 스냅샷용 |
