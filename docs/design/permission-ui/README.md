# 대표 권한 화면 검증

서버 4단계의 메인 자리, 인계 꾸러미와 일지는 [stage4-seat](stage4-seat/README.md)에 정리했습니다.

서버 3단계의 로그인, 대표 이메일 설정, 기기 목록과 새 기기 알림은 [stage3-login](stage3-login/README.md)에 정리했습니다. 폴링 간격 증가의 공유 계약 공백도 그 문서에 기록했습니다.

2026-10-29. 대표는 프로젝트를 지정해 메인 에이전트에게 명령하고, 질문에 답하거나 보고서 결과를 확인합니다. 팀 운영은 메인 에이전트가 맡습니다. 기존 오크색과 세이지색 프레임을 유지했습니다.

2026-10-30의 [2차 후속 검증](followups2/README.md)에서 새 알림 키와 보류 전달 여부 계약을 반영했습니다. 최신 화면, 테스트, 캡처는 그 문서에서 확인할 수 있습니다.

## 먼저 볼 파일

- [화면 행동 테스트](../../../src/renderer/src/components/permission-ui.test.ts)
- [설치 설정 저장값](../../../src/renderer/src/lib/installationSettings.ts)
- [메인 정지 안내와 해제](../../../src/renderer/src/components/MainPauseNotice.tsx)
- [금지 호출 검사](../../../src/renderer/tools/renderer-methods.mjs)
- [실제 변이 결과](mutation-results.json), [화면 너비와 라벨 검사](layout-audit.json)

## 항목별 결과

| 항목 | 바뀐 동작 | 구현 파일 (`src/renderer/src/` 기준) |
|---|---|---|
| 1. 팀원 상세 | 일시정지, 재개, 중단, 설정 변경, 삭제, 직접 메시지 입력을 제거했습니다. 메시지에는 메인 지시, 긴급 지시, 공유 받는 이름과 전달 상태를 표시합니다. AI 선택은 `aiDecision`에 기록된 결정자와 사유만 보여 줍니다. 바로가기는 팀원의 프로젝트와 `ID 이름(역할)에 대해: `를 명령창에 넣습니다. | `components/MemberPanel.tsx`, `components/CommandBar.tsx`, `lib/commands.ts` |
| 2. 메인 정지 | 팀원 상세, 홈의 대표 할 일, 상단 긴급 안내에 정지 사유와 남은 프로세스 확인 안내를 표시합니다. 긴급 정지가 없어도 `정지 해제`는 `stop.release`를 부릅니다. 상단 안내에서 메인 상세로 이동할 수 있습니다. | `components/MainPauseNotice.tsx`, `App.tsx`, `screens/Home.tsx` |
| 3. 스튜디오 | 프로젝트 일시정지, 재개, 팀원 추가, 대표 고정 표시를 제거했습니다. 프로젝트 설정은 조회만 하고, 변경 요청은 `<프로젝트 이름>에 대해: ` 바로가기를 씁니다. | `screens/Studio.tsx`, `components/ProjectSettings.tsx` |
| 4. 홈 | 프로젝트 추가를 `프로젝트 만들기 요청`으로 바꿨습니다. 명령 대상은 메인 직접, 초안은 `새 프로젝트를 만들어 줘: `입니다. 대표 검수 할 일을 없앴고, 오류와 복구는 조회와 메인 명령 바로가기로 연결합니다. 인증의 `다시 확인`은 `system.recheckAi`입니다. | `screens/Home.tsx`, `lib/displayText.ts` |
| 5. 작업 상세 | 대표 검수 입력, 재개, 취소, 중단, 검수자에게 직접 메시지 보내기를 제거했습니다. M-MAIN 검수는 `메인 에이전트 검수 중`으로 표시합니다. 보류 사유와 메인이 처리할 내용을 남겼고, `ID "제목"에 대해: ` 바로가기를 추가했습니다. 지시 상세의 취소도 명령 바로가기로 바꿨습니다. | `components/TaskDetail.tsx` |
| 6. 문서함 | 수정 요청 후 `수정 요청을 메인 에이전트에게 보냈습니다. 다음 회차는 메인 에이전트가 엽니다.`라고 안내합니다. 승인 버튼과 승인 확인창은 `canApprove`를 우선합니다. 값이 없으면 종전 상태 규칙을 씁니다. 스냅샷 갱신은 승인 가능 여부를 다시 읽으면서 작성 중인 의견을 유지합니다. | `screens/Documents.tsx` |
| 7. 긴급 정지 해제 | `새 실행을 시작할 수 있습니다. 보류된 작업 n건은 메인 에이전트가 확인해 항목별로 재개합니다`라고 안내합니다. 대표 화면에 항목별 재개 버튼은 없습니다. | `components/MainPauseNotice.tsx`, `App.tsx` |
| 8. 설정 | 실행, 팀 AI, 노력치 연결, 모델 목록, 백업 보관 개수, 스킬, 역할, 모의 실행은 조회만 합니다. 설치 설정에는 Google 설정과 비밀, API 키, 인증 방식, CLI 경로, 메인 AI, 보안 정책, 기록 보관 기간, 자동 백업, 로그인 때 실행을 모았습니다. 저장값을 허용된 항목으로 새로 구성하므로 운영 설정이 섞이지 않습니다. 대표 이메일의 계약 제한은 아래에 적었습니다. | `screens/Settings.tsx`, `lib/installationSettings.ts`, `components/PolicyTable.tsx` |
| 9. 검사 보류 탐지 | `kind === error`, `scope === task`, 보류 `refId`와 `checkRuns.requestId`의 일치로 가려냅니다. 파일 안내도 해당 실행의 `leftFiles`를 씁니다. 한국어 문구를 탐지 조건으로 쓰지 않습니다. 백엔드 `autocheck.ts`와 `turns.blockUnconfirmedRun`이 이 필드를 넣는 것을 확인했습니다. | `lib/taskSignals.ts`, `lib/taskSignals.test.ts`, `api/fake/data.ts` |
| 10. 가짜 브리지 | 허용 목록 밖 요청을 preload와 같은 `forbidden` 코드와 문구로 거부합니다. 직접 메시지와 대표 검수 조작을 제거했습니다. 수정 요청은 새 회차를 열지 않고, 그 회차가 최신이면 계속 승인할 수 있습니다. 정지 해제는 메인의 정지만 풀고 보류 작업을 재개하지 않습니다. 설치 설정의 혼합 패치를 거부하며, 허용된 부분 저장은 다른 값을 보존합니다. | `api/fake/index.ts`, `api/fake/data.ts`, `api/fake/fake.test.ts`, `api/fake/real-formats.test.ts` |
| 11. 호출 잔여 검사 | TypeScript AST로 `call`과 `invoke`의 문자열 인자를 수집합니다. 조건식의 두 갈래도 검사합니다. 허용값은 `DESKTOP_METHODS`와 최종 계약의 `system.recheckAi`뿐입니다. 제거된 다섯 식별자는 `src/renderer/src` 검색에서 0건입니다. | `components/permission-ui.test.ts`, `tools/renderer-methods.mjs`, `tools/check-contract.mjs` |

## 테스트와 변이 검증

| 명령 | 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json` | 오류 0, 종료 코드 0 |
| `node src/renderer/tools/check-contract.mjs` | 데스크톱 계약 36개와 토픽 6개. 가짜 구현 누락, 화면 호출 누락, 토픽 누락, 금지 호출 모두 없음 |
| `npx vitest run --config src/renderer/tools/vitest.config.ts` | 25개 파일, 180개 테스트 통과 |
| `npx vitest run tests/acceptance/flow.test.ts` | 21개 테스트 통과. AC-05 팀원 카드와 AC-27 실시간 로그 포함. 인수 테스트 파일을 수정하지 않았습니다. |
| `node src/renderer/tools/mutate-permission-ui.mjs` | 아래 8개 버그를 실제 소스에 하나씩 다시 넣었을 때 전부 해당 테스트 실패. 각 실행 뒤 원문 복원을 검사합니다. |

변이 결과의 실패한 테스트 이름, 종료 코드와 단언 오류는 [mutation-results.json](mutation-results.json)에 있습니다. 모든 변이는 종료 코드 1로 검출됐습니다.

| 항목 | 실제로 다시 넣은 버그 | 실패한 테스트 |
|---|---|---|
| 1 | 팀원 명령을 해당 프로젝트 대신 `main`으로 보냄 | `1. member has instructions and a project command shortcut, with no operations` |
| 2 | 긴급 정지가 없으면 메인 정지 해제를 숨김 | `2. main pause can be released without an emergency, with the reason and process check` |
| 4 | 새 프로젝트 요청을 기존 프로젝트로 보냄 | `4. home project creation opens a main draft and authentication recheck remains callable` |
| 5 | 메인 검수를 대표 검수 대기로 다시 표시 | `5. task shows main review and hold guidance without verdict or operation buttons` |
| 6 | `canApprove`를 무시하고 상태만으로 승인 버튼을 결정 | `6. report approval follows canApprove, including changes requested, with legacy fallback` |
| 8 | 설치 저장값에 백업 보관 개수를 섞음 | `8. operations are views and installation save sends only permitted leaves` |
| 9 | 자동 검사 보류 조건을 종전 한국어 문구에 다시 묶음 | `2. detects an unconfirmed check by kind, scope, and its execution request ID, regardless of copy` |
| 11 | 실행되지 않는 갈래에 금지된 팀원 일시정지 호출을 추가 | `11. every literal renderer invocation belongs to the desktop contract` |

추가 검증은 메인 상세와 홈의 정지 안내, 명령창의 실제 대상과 초안, 승인 가능 여부가 바뀐 확인창, 스냅샷 중 의견 유지, 원격 설치 설정 제한, 모든 금지 메서드의 가짜 브리지 거부, 혼합 패치의 원자적 거부를 다룹니다. 기존 `backend-view.test.ts`에서 사라진 대표 검수 폼 검사를 제거하고 되돌리기 연결 검사는 유지했습니다.

## 화면 캡처

로컬 서버 `5196`과 격리된 headless Chrome에서 1440×1000, 390×844 CSS 픽셀로 촬영했습니다. 모든 PNG는 배율 1로 열어 확인했습니다. 기본 14개 화면의 페이지 가로 넘침과 잘린 버튼·라벨은 각각 0건입니다. 홈 바로가기 폭과 작은 화면 이름표 문제를 발견해 수정한 뒤 다시 촬영했습니다. 좁은 작업실은 좌우로 밀어서 봅니다. 기존 오피스와 인물 자산을 사용했습니다.

| 화면 | 1440 | 390 | 추가 확인 |
|---|---|---|---|
| 팀원 상세 | [기본](member-1440.png) | [기본](member-390.png) | `member-lower-*`: 메인 지시, 공유, 전달 상태 |
| 메인 정지 | [상세](main-paused-1440.png) | [상세](main-paused-390.png) | `main-paused-home-*`: 상단 링크와 홈 할 일 |
| 스튜디오 | [기본](studio-1440.png) | [기본](studio-390.png) | `studio-members-*`: 팀원 AI 결정 사유 |
| 홈 | [기본](home-1440.png) | [기본](home-390.png) | `home-todos-*`, `command-new-project-*` |
| 작업 상세 | [기본](task-1440.png) | [기본](task-390.png) | `task-hold-*`: 검사 보류와 메인 처리 안내, `task-lower-*`: 이력과 diff |
| 문서함 | [기본](documents-1440.png) | [기본](documents-390.png) | `documents-actions-*`, `documents-changes-requested-*`: 수정 요청 후에도 가능한 승인 |
| 설치 설정 | [기본](settings-1440.png) | [기본](settings-390.png) | `settings-ai-*`, `settings-policy-*`, `settings-lower-*` |
| 운영 설정 조회 | [실행](settings-execution-1440.png) | [실행](settings-execution-390.png) | `settings-team-*`, `settings-operations-*`, `settings-skills-*`, `settings-developer-*` |

총 48장입니다. 재촬영 명령은 `node src/renderer/tools/capture-permission-ui.mjs`입니다. 먼저 지정된 Vite 서버를 `5196`에 띄워야 합니다. 이 도구는 자신이 시작한 브라우저만 닫고 격리 프로필을 정리합니다.

## 판단과 남은 제한

- 최신 리드 결정 6–10과 14를 후속 문서보다 우선했습니다. 공유 계약이 아직 덜 반영돼도 `system.recheckAi`, `general.mainAgent`, 메인 단독 정지 해제, `canApprove`의 최종 동작을 기준으로 구현했습니다.
- 대표 이메일 변경은 구현하지 못했습니다. 현재 `Settings.account`와 `settings.update` 계약에는 이메일 필드가 없고, 대표 이메일은 `AuthState.owner.email`로만 내려옵니다. 이 값은 설치 설정에 읽기 전용으로 표시했습니다. 공유 계약과 백엔드를 수정할 권한이 없어 임의의 이메일 키나 저장 성공을 만들지 않았습니다. 이메일 변경 계약이 추가되면 이 입력을 연결해야 합니다.
- 나머지 설치 항목은 편집할 수 있습니다. 원격 브리지의 `platform === web`에서는 설치 입력을 비활성화합니다. 브라우저 가짜 미리보기는 데스크톱 설치 설정을 보여 줍니다.
- 과거의 `aiDecision`에 대표가 결정자로 남은 경우에는 그 이력을 보여 줍니다. 대표 고정 표시나 고정 조작은 없습니다. 가짜 작업의 `awaitingOwner: false`는 현재 공유 타입을 만족시키는 호환 값이며 어떤 화면이나 동작도 읽지 않습니다. 객체 펼치기를 사용해 공유 타입에서 이 필드를 지워도 추가 속성 검사에 걸리지 않게 했습니다.
- 자동 PID 재확인은 추가하지 않았습니다. 정지 해제 전에 남은 프로세스를 확인하라는 안내와 확인창을 사용합니다.
- `src/main`, `src/preload`, `src/shared`, 인수·회귀 테스트, 패키지와 설정 파일은 직접 편집하지 않았습니다. 별도 설치와 직접 Git 명령을 실행하지 않았습니다. 이전 `src/renderer/docs/design/v34/build/`는 과거 캡처용 번들이므로 그대로 두었습니다. 활성 렌더러 소스 검사에는 포함되지 않습니다.
- 확인용 서버는 `5196`에서만 실행했고 종료했습니다. `5199`에는 접속하거나 조작하지 않았습니다. 업무일지는 리드 담당이라는 지시대로 별도로 쓰지 않았습니다.

## 변경 파일 전체

`src/renderer/` 기준입니다.

```text
src/App.tsx
src/api/fake/data.ts
src/api/fake/index.ts
src/api/fake/fake.test.ts
src/api/fake/real-formats.test.ts
src/components/CommandBar.tsx
src/components/MainPauseNotice.tsx
src/components/MemberPanel.tsx
src/components/PolicyTable.tsx
src/components/ProjectSettings.tsx
src/components/TaskDetail.tsx
src/components/backend-view.test.ts
src/components/permission-ui.test.ts
src/lib/commands.ts
src/lib/displayText.ts
src/lib/installationSettings.ts
src/lib/taskSignals.ts
src/lib/taskSignals.test.ts
src/screens/Documents.tsx
src/screens/Home.tsx
src/screens/Settings.tsx
src/screens/Studio.tsx
src/styles/app.css
tools/capture-permission-ui.mjs
tools/check-contract.mjs
tools/mutate-permission-ui.mjs
tools/renderer-methods.mjs
tools/renderer-methods.d.mts
tools/verify-forms.mjs
tools/verify-member-message.mjs
```

기존 검증 스크립트 두 개도 사라진 조작 대신 새 화면 행동 테스트를 실행하도록 바꿨습니다. 이 폴더에는 README, PNG 48장, 레이아웃 검사와 변이 결과 JSON을 추가했습니다.
