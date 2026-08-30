# 빌드 현황 (Supabase 연동 이후)

> 다음 세션은 이 문서를 읽고 이어서 작업한다. "빌드 순서 문서대로 이어서" 하면 **다음 작업**부터.
> 설정(설치·키·SQL)은 루트 `SETUP.md`. 관리자 도구 배포는 `supabase/functions/admin/DEPLOY.md`.

---

## 데이터 파이프라인 (터미널 없이 동작)

```
KOPIS ─(node data/kopis.js)→ SQL ─┐
관리자도구(admin.html) ────────────┼→ Supabase (venues / seasons / seatmaps)
수동 SQL ─────────────────────────┘
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
- 배포: **CLI 필수** `supabase functions deploy admin --project-ref ewemqbatkrmvzevmlteo --use-api --no-verify-jwt`
  (웹 에디터는 큰 파일 한글 깨짐).
- **할인정보 탭**: 이미지 여러 장 → Gemini `[{name,rate,type,applies_to,grades,note}]` → 검토표 → `seasons.discounts`.
  시즌 선택 시 **기존 할인 미리 로드**, 판독은 거기에 더해짐(1·2차 공지 누적). `discounts_updated_at` 기록.
- **좌석배치도 탭 = 공연(시즌) 선택.** `seasons.seat_grades/aisle_seats/restricted_seats/side_seats` 를 채우는 경로:
  - **문단 메모**: `parse-seatmap` → Gemini **초안 문단**(`{memo}`) → 관리자가 형식대로 고침 → "표 채우기"(`parseSeatMemo`) → 4개 표 → 저장.
    Gemini 초안이 부실하면 같은 칸에 Claude 챗(수동, 관리자가 직접 물어봄) 결과를 붙여넣어도 형식만 맞으면 그대로 파싱됨 —
    `admin.html` 에 프롬프트 템플릿과 복사 버튼 있음.
  - 표는 "+행" 버튼으로 직접 추가·수정도 가능 — 메모 없이 손으로만 채워도 됨.
  - **(폐지) 그리드 색칠** — `parse-seatmap-grid` + 드래그 선택 색칠 UI는 삭제했다. Claude API 를
    관리자 도구에 안 쓰기로 하면서 자동 그리드 재구성(Vision/CLOVA OCR + 코드 재구성)까지
    함께 걷어냈다 — 문단 메모 하나로 통일.
  - 메모 형식(한 줄 = 한 층·한 열컨텍스트):
    ```
    1층
    블록 좌 1-8 / 중 9-40 / 우 41-48
    1-3열 8-11번 R / 12-37번 VIP / 38-41번 R
    5-7열 R                     (좌석범위 없이 등급만 = 그 열 전체)
    짝수열 통로 15,16,32,34      (홀수열 통로 ... — 통로번호가 홀짝에 따라 밀리는 극장)
    1-5열 통로 31
    1-3열 시야제한 1,2
    ```
  - 저장 위치: 블록 → `venues.base_geometry`, 등급 → `seasons.seat_grades`,
    통로 → `seasons.aisle_seats`, 시야제한 → `seasons.restricted_seats`(venue 것보다 우선).
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
  `season.prices` 키 버튼 + "시야제한석" 질문. `state.seatGrade`/`state.seatRestricted` → 상담 기록에만(Supabase X).
  좌석배치도로 등급이 채워지면 안 뜬다.
- **사후 피드백 모달** (PRD §3.6·§10.1) — 로그인 직후 `checkPendingFeedback()`:
  `session_date < 오늘` + `outcome IS NULL` + `gon:snooze:<id>` 없는 상담 중 가장 오래된 것 하나만.
  갔음→자리(+이벤트 있으면 증정) / 나눔→증정만 / 안 감→끝. `GON_AUTH.updateOutcome`. 이용내역에 결과/`관람 예정` 배지.
- 상담기록: 판정 후 `consult.html` 이 `consultations` 저장(RLS 본인 것만). 우상단 "이용내역".

### 엔진 (`engine.js` / `data.js`)
- **`baselineRate`** 가 회차(`applies_to`)·좌석등급(`grades`)에 안 맞는 할인을 기준선에서 제외. 모르면 보수적 포함.
  대상별 율·등급 다르면(대학생/초중고) 별도 항목.
- **degraded 할인율** — 정가는 있고 할인 목록 미수집이면 "정가 X에서 Z% 할인받으셨습니다 (최선 여부 판단 안 함)".
- **통로(`is_aisle`)** — `season.aisle_seats` 명단 있으면 `true`/`false` 확정, 없으면 "모름". 선호좌석 '통로석' 사용.
- 시야축 사이드/중앙/엣지(`side_zone`)는 블록 구조에서 계산 — 좌석배치도만 있으면 됨.

### 인프라
- **KOPIS 수집** — `data/kopis.js "공연명" 연도 season_id` → `data/kopis-import.sql`.
  ⚠ data.go.kr 키 활성화 대기 중(발급 다음 영업일).
- **keep-alive** — `.github/workflows/keep-alive.yml`, 5일마다 `venues` 1행 조회로 Supabase 무료 프로젝트 유지.
  secrets: `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`. main 브랜치에 있어야 동작.

### 마이그레이션 (기존 프로젝트에 실행)
```sql
alter table seasons
  add column if not exists discounts_updated_at timestamptz,
  add column if not exists aisle_seats jsonb default '[]'::jsonb,
  add column if not exists restricted_seats jsonb default '[]'::jsonb;
```

---

## 다음 작업

1. **호스팅** — GitHub Pages / Netlify 등에 정적 배포. 그래야 폰에서 admin.html·index.html 사용 가능.
2. **시야제한석 독립 트리거** — 지금은 R-3b(등급 폴백)에 얹혀서만 물음. 등급은 아는데 좌석배치도가 없는
   공연에서는 시야제한석을 못 물어봄. 필요하면 독립 조건 추가.
3. **관리자 도구 실사용 검증** — 여러 공연으로 메모 파서·저장·상담 반영까지 한 바퀴.
4. **엘리자벳 데이터 마무리** — 등급·통로 숫자 배치도 대조해서 정확히. 프리뷰/조기예매 할인 확인.

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
| 등급 폴백에 시야제한석 포함 | 가격이 다르고, 사용자가 확실히 앎 |
| 할인 폴백 질문 없음 (degraded 만) | 사용자에게 할인 메뉴 묻기 = 서비스 무의미. 진짜 해결은 관리자 도구 수집 |
| 관리자 도구 = 문단 메모(표 아님) | 표는 편집 부담 큼. Gemini 초안 → 사람이 문단으로 수정 |
| 데이터 = seed.live.js 런타임 조회 (pull 선택) | 폰만으로 관리 가능. pull 은 오프라인 스냅샷용 |
