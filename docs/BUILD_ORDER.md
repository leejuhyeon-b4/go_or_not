# 빌드 순서 (Supabase 연동 이후)

> 다음 세션은 이 문서를 읽고 이어서 작업한다. "빌드 순서 문서대로 이어서 해줘" 라고 하면
> 아래 **다음 작업**부터 진행하면 된다.
> 설정(설치·키·SQL)은 `SETUP.md`. 데이터 파이프라인 개요도 거기.

---

## 완료됨

- **데이터 파이프라인** — `data/schema.sql`, `data/pull.js`(`npm run pull`) → `data/seed.remote.js`
  오버레이가 `data/seed.js` 위에 병합. `data.js`/`engine.js` 무수정.
- **KOPIS 수집** — `data/kopis.js` (키 2개 LIST/DETAIL, `data/kopis.js "공연명" 연도 season_id`)
  → `data/kopis-import.sql`. ⚠ data.go.kr 키 활성화 대기 중(발급 다음 영업일).
- **관리자 도구** — `admin.html`(화면) + `supabase/functions/admin/`(JSON API). 랜딩 우하단 ⚙ →
  `admin.html` → 비밀번호(`ADMIN_PASSWORD`, 계정 없음) → **할인정보 / 좌석배치도** 이미지 → Gemini 판독
  → 검토 → Supabase 저장 (`seasons.discounts` / `venues.base_geometry`+`restricted_seats`+`collected=true`).
  배포는 CLI 필수(`--use-api --no-verify-jwt`). 좌석배치도 판독은 거칠어 손보정 전제. → `DEPLOY.md`
- **로그인 + 상담기록** — `index.html` 로그인 게이트(Supabase Auth). `data/auth.js`(`GON_AUTH`),
  `data/supabase-config.js`, `data/consultations.sql`. 판정 후 `consult.html` 이 `consultations`
  테이블에 저장. 우상단 "이용내역" 목록.
- **사후 피드백 모달** (PRD §3.6 · §10.1) — `index.html` 로그인 직후 `checkPendingFeedback()`:
  `session_date < 오늘` + `outcome IS NULL` + `gon:snooze:<id>` 없는 상담 중 **가장 오래된 것 하나**만
  `#feedbackBackdrop` 모달로 묻는다. 갔음→자리(+이벤트 있으면 증정) / 나눔→증정만 / 안 감→끝.
  이벤트 유무는 `axis_scores.EVENT != null` 로 판정. "나중에"=localStorage 스킵.
  저장은 `GON_AUTH.updateOutcome`. 이용내역에 결과/`관람 예정` 배지 추가.
- **degraded 할인율 출력** — `engine.js agentCost` 정가는 있고 할인 목록 미수집일 때
  "정가 X에서 Z% 할인받으셨습니다 (최선 여부는 판단 안 함)" 로 raw 할인율을 사실로 출력.
- **할인 회차·등급 제한** — 할인 항목에 `applies_to`(ALL/MATINEE/EVENING) + `grades`(["R","S"]…) + `note`.
  `data.js baselineRate` 가 안 맞는 회차·좌석등급 할인을 기준선에서 제외 (모르면 보수적 포함).
  대상별 율·등급 다르면(대학생/초중고) 별도 항목. 관리자 도구가 Gemini 판독·검토·저장, `note` 는 저장만.
  R-4 "어떤 할인" 드롭다운 → **버튼**(이 시즌 실제 할인 + 정가 + 목록에 없는 할인). changelog §1.2 개정.

---

## 다음 작업

### 3. 폴백 모달 — 등급 + 시야제한석

`seasons` 데이터가 덜 찼을 때 상담 시작 전에 사용자에게 직접 물어 메운다.

- 트리거 조건:
  - **등급**: `GON_DB.listPrice(season, seatInfo.grade)` 가 null (다등급인데 `seat_grades` 매핑 없음)
  - **시야제한석**: `venue.collected` 가 false (좌석배치도 미수집)
- 질문 (둘 다 필요하면 한 모달에):
  - "예매하신 좌석 등급은?" → `season.prices` 키로 버튼 생성 **+ "시야제한석" 옵션**
    (시야제한석은 가격이 달라서 등급 선택지에 같이 둔다)
  - (등급 옵션에 시야제한석이 이미 있으므로 별도 예/아니오 불필요)
- 엔진 연결:
  - 등급 선택 → 번들 `seat.grade` 를 덮어씀 → `listPrice` 동작 → 비용축이 실제 숫자로 판정
  - "시야제한석" 선택 → `seat.is_restricted = true` → 시야축 반영. 정가는 지불액 그대로 사용.
- 입력값은 **상담 기록에만** 저장. Supabase `seasons` 엔 쓰지 않는다 (사용자 기억 ≠ 검증값, 원칙 6).

### 할인 폴백은 안 만든다 (결정됨)

`discounts` 미수집 시 비용축은 **degraded 모드**: "정가 X, 지불 Y, Z% 할인받으셨어요.
이 공연 할인 목록이 아직 없어 최선이었는지는 판단하지 않았습니다." — 사실만.
"더 큰 할인 받을 수 있었어요?" 같은 질문은 **안 물어본다** (사용자에게 할인 메뉴를
묻는 건 서비스가 무의미). 진짜 해결은 관리자 도구로 `discounts` 수집.
→ ✅ `engine.js agentCost` 가 degraded 모드에서 raw 할인율("정가 X에서 Z% 할인받으셨습니다")을
   사실로 출력하도록 수정 완료 (2026-08-28).

---

## 나중 (Phase 4+)

- `consultations` / `outcomes` → 익명화 → 임베딩 → RAG 유사 케이스 검색 (PRD §10)
- 축적 자리 만족도 통계 (극장×블럭) → 시야축 정확도
- `GRADE_RANK` 하드코딩 사다리(`engine.js:78`) — 비표준 등급 라벨(프리미엄/로얄) 별칭표.
  지금은 알려진 한계로 둠 (R-top 공연은 정상 동작).
- 좌석배치도 이미지 판독 (관리자 도구 확장) — 비전 정확도 낮아 항상 수동 검토 전제.
- KOPIS 정기 실행 (cron / scheduled) — 데이터가 잘 안 바뀌어 우선순위 낮음.

---

## 잠긴 설계 결정 (재논의 불필요)

| 결정 | 이유 |
|---|---|
| 상담 저장 = 로그인 + Supabase (localStorage 아님) | 서비스 데이터 축적·RAG 루프 앵커 (PRD §10.1) |
| 상담 시작 = 로그인 필수 | 사용자 요청. 익명 사용은 안 함 |
| baseline 모르면 null, 판정 보류 | 원칙 6 — "최선이었다" 단정 금지 |
| 등급 폴백 모달에 시야제한석 포함 | 가격이 다르고, 사용자가 확실히 앎 |
| 할인 폴백 질문 없음 | 사용자에게 할인 메뉴 묻기 = 서비스 무의미 |
