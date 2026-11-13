# 부서와 직원이 보이는 사무실

2026-11-13 대표 요구사항과 이름표 재검토 결과. 스냅샷과 IPC 계약은 바꾸지 않았다.

## 이번 수정: 사무실에는 이름만

이전 화면은 상자를 없앤 자리에 역할·AI·업무 문단을 항상 띄웠다. 12명이 있는 방에서 이름이 묻히고 설명끼리 겹쳤다. 이번에는 머리 위에 **이름 한 줄과 작은 상태 점만** 남겼다. AI 종류를 두 번째 줄에 넣는 선택도 하지 않았다. 사무실에서 사람과 이름이 먼저 보여야 하기 때문이다.

- 이름은 14px 굵은 글씨와 흰색 윤곽으로 표시한다. 배경·테두리·패널·연결선은 없다. 2D는 실제 머리 요소, 3D는 머리 뼈의 화면 좌표를 따라 걷기·착석·기립 중에도 이동한다. 기존 직원 행동 규칙은 유지했다.
- 이름의 실제 크기로 경계와 겹침을 계산한다. 답변 대기·막힘, 업무 중, 대기 순으로 배치하며, 뒤에 놓는 이름만 필요한 만큼 옮긴다. 다른 사람의 머리와 화이트보드 글 영역도 피한다. 위치 보간으로 이름끼리 잠깐 겹치지 않도록 매 프레임 위치를 바로 반영한다.
- 390px에서도 방 전체와 12명의 이름이 보인다. 이전의 넓은 장면과 가로 스크롤을 없앴다. 휴대폰 장면 높이는 440px로 두어 이름과 요청한 카드를 놓을 여유를 확보했다. 인물이 작아지는 화면에서는 바로 아래 디렉터리가 상세 정보를 맡는다.
- 이름이나 인물을 가리키거나 키보드 초점을 주면 업무 카드가 열린다. 터치는 첫 탭으로 카드만 연다. 카드에는 이름·역할, AI 종류·모델·노력·모의 여부, 현재 작업 제목·단계 또는 현재 업무와 상태 사유가 있다. 제품의 기존 AI 표기를 사용한다.
- 카드는 한 번에 한 명만 표시한다. 장면 안에 머물며 해당 사람의 이름·머리와 화이트보드 글을 가리지 않는다. 포인터가 떠나거나 초점이 나가면 닫히며, Escape·닫기·다른 곳 탭으로도 닫는다. 이름에서 Tab으로 카드에 들어갈 수 있다. 카드의 `자세히 보기 →`는 팀원 패널을 연다. 2D 이름에 남아 있던 패널 직행 클릭도 제거했다.
- `팀원 디렉터리`는 사무실 바로 다음에 놓았다. 모든 직원의 이름·역할·AI·현재 업무를 항상 읽을 수 있고, 현재 단계나 첫 상태 사유를 말줄임으로 없애지 않는다. 390px에서는 한 열로 줄바꿈한다. AI 선택 과정 같은 부가 설명은 팀원 패널에서 확인한다.
- 실행 중인 작업의 최근 로그도 디렉터리에 유지했다. 현재 업무와 같은 문장이면 반복하지 않고, 대기·정지 중에는 이전 로그를 새 업무처럼 표시하지 않는다. 기존 인수 검사가 확인하는 실시간 로그와 진행도 표시를 유지한다.
- 2D의 기존 12개 좌석을 넘으면 다음 작업실을 이어서 보여 준다. 작업실이 여러 개여도 업무 카드는 전체에서 하나만 열린다.
- 긴급 정지 직후 직원의 원래 상태가 아직 `working`이어도 2D 사무실의 업무 중 인원은 0명으로 표시한다.

## 유지한 회사 보기와 답변 알림

홈의 회사 사무실은 승인된 구성을 유지했다. 메인 자리의 보유 방식과 현재 업무를 맨 위에 놓고, 모든 프로젝트를 부서로, 각 직원을 한 번씩 표시한다. 부서에는 `N명 업무 중 / M명`, 전체 진행도와 진행 중 지시별 진행도가 있다. 가벼운 기존 초상화만 사용하며 Home에서 Studio3D·characterKit·GLB를 요청하지 않는다. 부서 바로가기, 프로젝트 사무실 진입, 팀원 패널 진입도 유지했다.

진행 중 지시 없음, 모두 대기, 프로듀서 한 명, 일시정지, 긴급 정지는 이유를 문장으로 표시한다. 종료·취소 지시는 진행 중 목록에서 제외한다. 업무 정보가 오지 않았을 때 활동을 만들어 쓰지 않는다. 검수·대표 답변 대기·보류·오류는 첫 사유를 표시한다.

`main-reply:` 알림은 토스트·알림함·브라우저 알림에 답변 본문을 보여 준다. 클릭하면 대상 프로젝트 대화 또는 직접 대화의 최신 메시지를 연다. 실제로 본 대화의 답변만 읽음 처리한다. 명령창이 준비되기 전 누른 브라우저 알림도 대상을 보관한다. 기존 `프로젝트 현황` 제목과 프로젝트·메인 진입 경로를 유지했다.

## 접근성 이름

| 요소 | 이름 |
|---|---|
| 사무실 영역 | `프로젝트 사무실` |
| 이름 버튼 | `{이름} 업무 보기` (`aria-expanded`, `aria-controls` 포함) |
| 요청한 업무 카드 | `{이름} 업무 정보` (`group`) |
| 카드 닫기 | `업무 정보 닫기` |
| 카드의 상세 진입 | `{이름} 팀원 상세 열기` |
| 바로 아래 목록 | `팀원 디렉터리` 제목, 각 직원의 팀원 상세 버튼 |
| 회사 영역 | `회사 사무실` |
| 부서 영역 / 이동 | `{프로젝트명} 부서` / `부서 바로가기`와 프로젝트 이름 링크 |
| 부서 진행도 / 지시 | `{프로젝트명} 부서 진행도` / `{프로젝트명} 진행 중 지시` |
| 부서 사무실 버튼 | `{프로젝트명} 사무실 열기` |
| 회사 직원 버튼 | `{이름} 팀원 상세 열기` |
| 알림함 / 토스트 답변 | `답변 대화 열기` / `{알림 제목} 대화 열기` |
| 대화 토글 / 새 답변 | `대화 기록 펼치기`, `대화 기록 접기` / `읽지 않은 메인 답변 N개` |

## 개발용 재현

개발 매개변수는 모두 `devParam`을 거친다. 서버용 웹 빌드에서는 동작하지 않는다.

| 매개변수 | 상태 |
|---|---|
| `officeState=producer` | 프로듀서 한 명, 진행 중 지시 없음 |
| `officeState=busy` | 12명: 업무 중 8명, 검수·대표 답변 대기·일시정지·막힘 각 1명 |
| `officeState=idle` | 12명 모두 대기, 진행 중 지시 없음 |
| `officeState=paused` | 일시정지된 부서 |
| `officeState=emergency` | 메인과 직원이 정지된 긴급 정지 |
| `officeState=six` | 6개 부서 × 12명 + 메인 1명 |
| `fakeReply=direct`, `project`, `both` | 직접/프로젝트 메인 답변과 긴 대화 이력 |
| `studio3d=0`, `1` | 2D / WebGL2를 쓸 수 있는 경우 3D. 휴대폰에서도 명시적으로 3D 선택 가능 |

예: `http://127.0.0.1:5196/?officeState=busy&fakeMode=server&fakeSetup=ready&fakeReply=both`. 홈에서 `서비스 개발 사무실 열기`로 들어간다. 실제 서버는 실행하지 않는다.

## 회귀 검사와 잡는 버그

| 검사 | 다시 생기면 실패하는 버그 |
|---|---|
| `keeps only the name…` | 2D DOM의 항상 보이는 문단 재등장, 3D·2D 공용 상세 데이터의 역할·AI·모델·노력·모의·작업·단계 누락 |
| `keeps name-only tags…` | 12명 이름이 작은 장면의 경계를 벗어나거나 서로 겹치거나 보드 글을 가림 |
| `nudges colliding edge names…` | 가장자리 보정·충돌 회피·보드 보호를 무시함 |
| `places an on-demand card…` | 카드가 장면 밖으로 나가거나 자기 이름·머리·보드 글을 가림 |
| `keeps the directory directly below…` | 디렉터리가 사무실과 떨어지거나 직원·역할·AI·작업·단계가 빠짐 |
| `says nobody is working…` | 진행 중 지시 없는 대기 부서의 설명 누락 |
| `does not invent activity…` | 업무 정보가 없을 때 가짜 활동을 표시 |
| `lists every company project…` | 부서·직원 누락 또는 중복. 프로듀서 한 명과 6개 부서 73명 포함 |
| `renders truthful quiet…` | 대기·정지·검수·답변 대기·막힘의 사유 누락 또는 가짜 업무 표시. 정지 직후 원래 상태가 남아 있는 직원의 업무 중 인원도 확인 |
| `opens the exact direct or project…` | 알림함·브라우저 알림이 다른 대화를 열거나 답변 본문을 잃음 |
| `retains a cold notification…` | 명령창 구독 전 누른 알림의 대상 유실 |
| `Office-reply-unread` | 새 답변 표시 누락 또는 다른 대화의 답변까지 읽음 처리 |
| `Office-reply-browser` | 서비스 워커 답변 클릭이 대화 대신 일반 페이지를 열거나 본문을 대체 |
| `S8-home-wrap` | 홈의 실제 부서 카드 구조와 긴 프로젝트 경로의 줄바꿈 회귀 |
| `check-office-departments.mjs` | 실제 두 렌더러의 문단·연결선·상자 재등장, 이름 잘림·겹침·보드 침범, 요청 없는 카드, 카드의 정보 누락·중복·잘못된 위치, hover/focus/tap/Tab/Escape/blur/바깥 탭 실패, 첫 탭의 패널 직행, 디렉터리 누락 |
| 같은 브라우저 검사의 Home·답변 경로 | 홈의 무거운 자산 요청, 회사 인원 중복·누락, 개발 팀원/작업 조회 실패, 잘못된 대화 대상·최신 위치·읽음 표시 |
| `routes around colleagues resting…` | 창가의 쉬는 동료를 통과하는 경로. 기존 동선 검사 도구의 해당 변이와 연결 |
| 기존 `motion.v33.test.ts` | 가구 깊이, 팔·다리 동작, 휴식 자리, 이동 경로, 검수 전달, 정지 해제 간격의 회귀 |
| 기존 `api/fake/fake.test.ts`의 1·4·7·12명 배치 검사 | 인원별 이름 버튼 누락. 새 동작인 `업무 보기`를 접근성 이름으로 확인하며 실행 슬롯 상한 검사도 유지 |
| 기존 인수 검사의 AC-27 실시간 로그 | 실행 중 스냅샷의 최근 로그와 작업 진행도가 디렉터리에서 사라지는 회귀 |

브라우저 검사는 1440·390의 3D·2D에서 12명 이름의 위치를 여러 번 측정한다. 모든 직원의 hover 카드를 확인하고, 키보드와 실제 휴대폰 터치 입력도 확인한다. 캡처에는 깨끗한 장면과 요청한 카드 상태를 따로 남긴다. 화면 밖에 가려진 카드가 DOM에만 있어도 통과하던 검사를 보강해, 팀원 패널이 함께 열리지 않는지도 검사한다.

`mutation-check.mjs --departments`는 위 버그를 소스에 하나씩 넣고 해당 행동 검사가 실제로 실패하는지 확인한다. 실패 이유까지 일치해야 잡힌 것으로 센다. 원본은 `finally`에서 복구하며 자체 시작한 5196 서버만 닫는다. Vitest와 긴 명령은 지정된 `vt.sh`로 직렬 실행한다.

기존 동작 변이 20개도 확인한다. 오래된 치환 지점 8개를 현행 코드에 맞추고, 시작 전에 모든 치환 지점을 검사하도록 바꿨다. 쉬는 동료를 지나는 경로와 정지 해제 간격은 해당 행동을 직접 확인하는 검사에 연결했다. 직원 행동 구현은 바꾸지 않았다. 기존 도구의 Vitest 호출도 `vt.sh`를 거친다.

```text
bash <vt.sh> -- node src/renderer/tools/check-office-departments.mjs --serve
bash <vt.sh> -- node src/renderer/tools/mutation-check.mjs --departments
bash <vt.sh> -- node src/renderer/tools/mutation-check.mjs docs/design/permission-ui/office-departments/motion-mutation-results.json
```

`vt.sh`는 `C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/vt.sh`다. 화면 도구는 `--state=busy`로 한 상태만 갱신할 수 있다. 두 도구 모두 Vite 서버를 직접 소유하고 종료한다.

## 검증 결과

최종 코드에서 아래 검사를 모두 통과했다.

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json` | 종료 0 |
| `node src/renderer/tools/check-contract.mjs` | 종료 0. 49개 메서드 일치, 누락·금지 호출 없음 |
| `vt.sh run --config src/renderer/tools/vitest.config.ts` | 35개 파일, 468개 통과 |
| `vt.sh -- npm run build:web` | 서버용 웹 빌드와 기존 빌드 검사 통과 |
| `vt.sh run tests/acceptance/flow.test.ts` | 21개 통과. 최근 로그와 진행도 표시 포함 |
| `node src/renderer/tools/check-stage8-text.mjs` | 130개 파일, 깨진 문구 없음 |
| 사무실·부서·답변 변이 | 40개 모두 해당 검사에서 검출 |
| 기존 직원 동작 변이 | 20개 모두 해당 검사에서 검출 |
| headless 브라우저 | 24개 시나리오 통과. 1440·390 각각 48장, 총 96장 |

모든 변이의 원본 소스는 복구했다. 최종 캡처에서 두 크기와 두 렌더러의 이름 12개를 직접 확인했다. 이름 잘림·겹침·보드 글 침범과 항상 보이는 문단·연결선이 없고, 요청한 카드와 바로 아래 디렉터리도 확인했다. 자체 사용한 5196 서버는 종료했다.

명령과 출력은 [verification-results.json](verification-results.json), 브라우저 측정은 [browser-check.json](browser-check.json), 사무실 변이의 실패 증거는 [mutation-results.json](mutation-results.json), 기존 동작 변이는 [motion-mutation-results.json](motion-mutation-results.json)에 기록한다.

## 캡처

이전의 여러 줄 이름표와 가로 스크롤 아래쪽 캡처는 교체했다. 아래 사무실 네 장에서 12개 이름을 직접 읽고, 문단·연결선·보드 글 침범이 없는지 확인했다.

| 여러 업무 상태 | 1440px | 390px |
|---|---|---|
| 깨끗한 3D 사무실 | [보기](busy-office-3d-1440.png) | [보기](busy-office-3d-390.png) |
| 깨끗한 2D 사무실 | [보기](busy-office-2d-1440.png) | [보기](busy-office-2d-390.png) |
| 3D hover / focus / tap | [hover](busy-card-hover-3d-1440.png), [focus](busy-card-focus-3d-1440.png), [tap](busy-card-touch-3d-1440.png) | [hover](busy-card-hover-3d-390.png), [focus](busy-card-focus-3d-390.png), [tap](busy-card-touch-3d-390.png) |
| 2D hover / focus / tap | [hover](busy-card-hover-2d-1440.png), [focus](busy-card-focus-2d-1440.png), [tap](busy-card-touch-2d-1440.png) | [hover](busy-card-hover-2d-390.png), [focus](busy-card-focus-2d-390.png), [tap](busy-card-touch-2d-390.png) |
| 사무실 바로 아래 디렉터리 | [3D 아래](busy-directory-3d-1440.png), [2D 아래](busy-directory-2d-1440.png) | [3D 아래](busy-directory-3d-390.png), [2D 아래](busy-directory-2d-390.png) |

| 조용한 상태 | 1440px | 390px |
|---|---|---|
| 프로듀서 한 명 | [회사](producer-company-1440.png), [3D](producer-office-3d-1440.png), [2D](producer-office-2d-1440.png), [목록](producer-directory-2d-1440.png) | [회사](producer-company-390.png), [3D](producer-office-3d-390.png), [2D](producer-office-2d-390.png), [목록](producer-directory-2d-390.png) |
| 모두 대기 | [회사](idle-company-1440.png), [3D](idle-office-3d-1440.png), [2D](idle-office-2d-1440.png), [목록](idle-directory-2d-1440.png) | [회사](idle-company-390.png), [3D](idle-office-3d-390.png), [2D](idle-office-2d-390.png), [목록](idle-directory-2d-390.png) |
| 일시정지 | [회사](paused-company-1440.png), [3D](paused-office-3d-1440.png), [2D](paused-office-2d-1440.png), [목록](paused-directory-2d-1440.png) | [회사](paused-company-390.png), [3D](paused-office-3d-390.png), [2D](paused-office-2d-390.png), [목록](paused-directory-2d-390.png) |
| 긴급 정지 | [회사](emergency-company-1440.png), [3D](emergency-office-3d-1440.png), [2D](emergency-office-2d-1440.png), [목록](emergency-directory-2d-1440.png) | [회사](emergency-company-390.png), [3D](emergency-office-3d-390.png), [2D](emergency-office-2d-390.png), [목록](emergency-directory-2d-390.png) |

각 상태의 `*-department-*.png`, 3D·2D 디렉터리도 같은 폴더에 있다.

| 회사와 대화 | 1440px | 390px |
|---|---|---|
| 업무 중인 부서 | [회사](busy-company-1440.png), [부서](busy-department-1440.png) | [회사](busy-company-390.png), [부서](busy-department-390.png) |
| 6개 부서 | [전체](six-company-1440.png), [개발](six-company-P-8001-1440.png), [운영](six-company-P-8002-1440.png), [콘텐츠](six-company-P-8003-1440.png), [디자인](six-company-P-8004-1440.png), [품질](six-company-P-8005-1440.png), [자료](six-company-P-8006-1440.png) | [전체](six-company-390.png), [개발](six-company-P-8001-390.png), [운영](six-company-P-8002-390.png), [콘텐츠](six-company-P-8003-390.png), [디자인](six-company-P-8004-390.png), [품질](six-company-P-8005-390.png), [자료](six-company-P-8006-390.png) |
| 답변 토스트 / 알림함 | [토스트](main-replies-toast-1440.png), [알림함](main-replies-bell-1440.png) | [토스트](main-replies-toast-390.png), [알림함](main-replies-bell-390.png) |
| 열린 답변 대화 | [프로젝트](main-reply-project-1440.png), [직접](main-reply-direct-1440.png) | [프로젝트](main-reply-project-390.png), [직접](main-reply-direct-390.png) |
| 홈에서 연 직원 상세 | [보기](busy-member-panel-1440.png) | [보기](busy-member-panel-390.png) |

## 변경 파일

이번 수정:

- 이름과 요청한 카드: `src/renderer/src/components/OfficeLabel.tsx`, `studio/OfficeLabelController.ts`, `studio/Office.tsx`, `studio3d/Studio3D.tsx`, `studio3d/tags.ts`, `styles/identity.css`, `styles/app.css` (이전 가로 이동 안내 제거)
- 디렉터리: `src/renderer/src/screens/Studio.tsx`
- 검사: `src/renderer/src/components/office-departments.test.ts`, `studio/motion.v33.test.ts`, `api/fake/fake.test.ts`, `src/renderer/tools/check-office-departments.mjs`, `src/renderer/tools/mutation-office-departments.mjs`, `src/renderer/tools/mutation-check.mjs`
- 기록: 이 README, 같은 폴더의 PNG·JSON 증빙

이전 요구사항 구현을 유지한 파일:

- 회사 화면: `src/renderer/src/screens/Home.tsx`, `components/CompanyOffice.tsx`, `lib/officePeople.ts`
- 답변 알림: `src/renderer/src/App.tsx`, `components/CommandBar.tsx`, `components/ServerNotice.tsx`, `lib/notice.ts`, `lib/commands.ts`, `lib/browserNotifications.ts`, `api/store.ts`
- 개발 데이터: `src/renderer/src/api/fake/departments.ts`, `api/fake/index.ts`
- 기존 검사 확장: `src/renderer/src/components/web-stage8.test.ts`

## 범위와 남은 사항

- 공유 계약·백엔드·기존 `tests/`·설정·패키지는 수정하지 않았다. 실제 서버와 데스크톱 도우미는 실행하지 않았다. 모든 캡처는 한 번에 하나의 headless 브라우저에서 앱 페이지 자체를 찍었다.
- 브라우저 알림은 실제 OS 화면을 캡처하지 않았다. 알림 API의 제목·본문·워커 전달·클릭·대화 대상을 검사하고, 토스트·알림함·열린 대화는 앱 캡처로 남겼다.
- 실제 서버 실행 금지에 따라 `tests/web/web.test.ts` 전체는 실행하지 않았다. Home의 무거운 자산 요청 금지는 headless 검사와 해당 자산을 불러오는 변이로 확인한다. 서버용 웹 빌드의 기존 검사도 실행한다.
- 업무일지는 이 작업에서 쓰지 않았다(리드가 쓴다). 저장소에는 업무일지의 글이나 패치를 두지 않는다.
- 리드의 확인(2026-11-13): `tests/web/web.test.ts` 전체(실제 서버 + 서버용 웹 빌드 + headless Edge) 15개 통과 — `webDemoFlagsInert`는 데모 스튜디오를 제목 이름이 아니라 스튜디오 화면의 머리(`.studio-heading`)로 가리게 고쳤다(홈에도 프로젝트 이름이 든 제목이 생겼다). 실제 서버 웹 화면에서 홈, 3D 사무실의 이름과 가리켰을 때의 카드, 390 크기, 답 알림을 눌렀을 때의 대화를 열어 봤고 CSP·화면 오류는 없었다. 홈에서 3D 자료 요청 0건.
