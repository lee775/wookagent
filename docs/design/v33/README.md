# 욱채 렌더러 v3.3 증거

## 화면과 시퀀스

- [s01–s09](main/): 1440×900 화면 아홉 장. [s04 1100px](s04-1100.png), [s04 1920px](s04-1920.png)도 있다.
- [58초·25fps 영상](main/office-demo.webm), [40프레임 주기](cycle-sheet.png), [2.5초 버스트](burst-2500-sheet.png), [11초 버스트](burst-11000-sheet.png).
- [검수 전달 27프레임](review-sheet.png)은 [실제 촬영 시각](review/timestamps.json)에 따라 1초 간격이며 최대 시각 오차는 15ms다.
- [정면·뒷면 자세 시트](poses/pose-sheet.png)에는 모든 자세와 걷기 4단계씩이 있다. 영상에서 추출한 [4초](video-f04.png), [14초](video-f14.png), [26초](video-f26.png), [32초](video-f32.png), [50초](video-f50.png), [54초](video-f54.png) 화면도 원본 크기로 확인했다.

## 측정

| 항목 | 최종 값 | 근거 |
| --- | ---: | --- |
| 58초 실시간 겹침 | 최대 7.5%; 15% 초과 0건 | [동작 요약](geometry-summary.json), [표본](probe-cycle-final.json) |
| 첫 걸음 다리 움직임 | 12회 모두 첫 이동 0ms·0u 이내 | [동작 요약](geometry-summary.json) |
| 자리 밖 작업 자세 / 먼 줄 책상 위 다리 | 각각 0건 | [동작 요약](geometry-summary.json) |
| 검수 전달 대면 | 14.67초; 두 이동 경로 각각 650u 이하, 검수자 대기 1초 이하 | [동작 요약](geometry-summary.json), `src/renderer/src/studio/motion.v33.test.ts` |
| 이름표 | 1440px에서 6,438/6,438 보임·소유자 연결; 최대 거리 58.77u, 다른 사람 가림 6.34%, 잘림·정지 안내 겹침 0건. 1100px에서 6,462/6,462, 최대 거리 58.59u, 가림 8.60%. 1920px에서 6,456/6,456, 최대 거리 59.86u, 가림 6.45% | [1440px 주기](plate-probe-cycle-final.json), [1100px 주기](plate-probe-1100.json), [1920px 주기](plate-probe-1920.json) |
| 300초 휴식 | 같은 장소의 자리 변경 0건; 낮잠 소파 두 자리 예약 | `src/renderer/src/studio/motion.v33.test.ts` |
| 가까운 줄 작업 움직임 | 6곳 평균 182.4–805.8px/프레임 | [버스트 픽셀 비교](desk-motion.json) |
| 작업실 유채색 | 카펫 색을 가린 뒤 전체 픽셀의 11.23%, 6개 색상 계열 | [색도 측정](room-chroma.json) |
| 참고 색상 근접 덩어리 | s03–s05 최대 19px | [색상 덩어리 감사](banned-color-summary.json) |
| 색상 게이트 | s01–s08 전부 통과; s04 작업실 게이트 통과 | [전체](palette-gate.txt), [작업실](palette-room.txt) |
| CPU, 12명 작업 | mainThreadBusy 0.054; 레이아웃 21.6회/초 | [CPU](cpu.json) |
| 웹 빌드 | 3,594,602바이트 | `npx vite build --config vite.web.config.ts` |
| 한글 글꼴 | KS X 1001 완성형 2,350/2,350자 Pretendard, 대체 글꼴 0자 | [글꼴 프로브](font-coverage.json) |
| 텍스트 크기·대비 | s01–s09, 1100·1440에서 지적 0건 | [텍스트 감사](text-audit.json) |

## 기능 검사

`npx tsc --noEmit -p tsconfig.web.json`, `npx vitest run --config src/renderer/tools/vitest.config.ts`(46/46), AC-05(2/2), `check-contract.mjs`, `verify-browser.mjs`가 통과했다. [검수 양식](forms-probe.json), [Google 복구](auth-probe.json), [중단 확인](interrupt-probe.json), [노력치 max 카드·패널·호버](effort-probe.json), [원시 ID·복사 검사](copy-audit.json)도 브라우저에서 확인했다. [검수 전달](plate-probe-review.json)과 [두 버스트](plate-probe-burst-2500.json)의 [이름표 검사](plate-probe-burst-11000.json)에서도 숨김·잘림·소유 오류가 없었다. [회귀 주입 20건](mutation-check.json)은 모두 해당 테스트를 실패시켰다. 검수 구간은 23초이며 출력 장면은 [29·30번 프레임](main/)에서 확인했다.

| 새 동작 검사 | 다시 넣어 실패시킨 버그 |
| --- | --- |
| 가구 깊이·가까운 줄 팔 | 가구 역순, 양 소매 정지 |
| 휴식·방문 자리의 통로 거리 | 휴식 자리를 통로 위로 이동 |
| 경로 길이·연결 통로 | 목적지 미도착, 먼 자리 우회로 평탄화, 낮잠 자리 탈출 차단 |
| 열두 명 외형 충돌 | 모두 같은 셔츠 |
| 300초 휴식 자리 | 5초마다 자리 이동, 낮잠 한 자리만 예약 |
| 300초 공실 충돌 | 걷는 경로에서 점유된 휴식 자리 무시 |
| 첫 걸음·책상 가림·자리 밖 자세 | 다리 움직임 지연, 먼 줄 다리 항상 표시, 통로에서 책상 자세 |
| 120초 주기와 검수 전달 | 이름표 숨김, 검수 3초로 단축, 검수자 조기 이탈, 긴급 정지 뒤 동시 출발 |
| 좁은 화면의 이름표 | 앉은 동료에게 걷는 사람 이름표 배정 |
| 소파에서 일어나기 | 일어나는 구간 생략 |
| 긴급 정지 해제 순서 | 앉은 사람이 통로의 정지된 사람을 향해 먼저 기상 |

## 확인이 더 필요한 경계

먼 줄 자리에서 옆으로 일어나도록 경로를 만들고 책상 근처 다리를 감췄다. 다만 사람의 시작점이 자기 의자 중심인 좌표계라, **자기 의자의 전체 경계 상자와 경로 선분이 겹치지 않는다**는 문자 그대로의 검사는 넣지 못했다. 실제 프레임과 책상 위 다리 프로브는 통과했다. 사람 머리와 가구의 실제 겹침, 픽셀 움직임 수치는 브라우저·이미지 감사로 확인하며 Vitest의 순수 틱 시험과는 별도다.

현재 `src/shared/views.ts`의 `stop.pausedMembers`에는 `by`와 `reason`이 없어 자동 일시정지 이유를 표시할 수 없다. 선택 사항인 이전 세션 연결 UI도 이번 화면에 넣지 않았다. [구현 설계](../DESIGN.md)는 실제 코드 위치를 문단마다 적었다.
