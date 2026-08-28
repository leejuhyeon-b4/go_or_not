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
  R-4 "어떤 할인" 드롭다운 → **버튼**. 등급별로 나뉜 할인(조기예매 VIP·R 10% / S·A 20%)은
  **버튼 1개** — 좌석 넣으면 등급 나와 `resolveSelectedDiscount()` 가 알아서 고름.
  할인 미수집 시즌도 `정가`/`할인 받음` 버튼은 두고 degraded 판정. 라벨 옆 `discounts_updated_at` 표시.
  새 컬럼: `alter table seasons add column if not exists discounts_updated_at timestamptz;`
  관리자 도구: 시즌 선택 시 **기존 할인 미리 로드**, 판독은 거기에 더해짐(1·2차 공지 누적). changelog §1.2 개정.

- **좌석 등급 폴백 (R-3b)** — 다등급 공연인데 `seat_grades` 매핑이 없어 `resolveSeat().grade` 가
  null이면, 좌석 입력칸 아래 `#seatGradeExtra` 가 열려 `season.prices` 키 버튼 + "시야제한석" 을 묻는다.
  `state.seatGrade`/`state.seatRestricted` → `currentList()`·`buildBundle` 에 반영 (상담 기록에만, Supabase X).
  시야제한석은 정가=지불액. `index.html` 인라인(모달 아님).

---

- **좌석배치도 탭 = 공연 선택** — 블록·시야제한만 Gemini 자동. **등급은 이미지로 못 읽어서
  텍스트로 직접 입력** ("1층 1-22열 12-37번 VIP" 식 줄 → 표 파싱). `seasons.seat_grades` 에
  구역 그대로 저장 `{floor,row_from?,row_to?,seat_from?,seat_to?,grade}`. 등급만 저장 가능(블록 없이).
  안 채우면 상담 때 R-3b 로 사용자에게 물음.
- **통로 개념 삭제** — 어느 좌석이 통로 옆인지 확정 불가. 선호좌석 '통로석' 옵션·engine AISLE·
  is_aisle 전부 제거. 시야축은 사이드/중앙/엣지(블록 기반)만.

---

## 다음 작업

### 3. 폴백 — 남은 것

- **시야제한석 독립 트리거**: 지금은 등급 폴백(R-3b)에 얹혀서만 물음. 등급은 아는데
  `venue.collected` 가 false 인 공연에서는 시야제한석을 못 묻는다 → 필요 시 독립 트리거.
- 관리자 좌석배치도 판독 정확도(등급 색↔코드) 실사용 검증.

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
