# 1단계 화면 후속 검증

기존 [권한 화면 작업](../README.md)을 유지하고, 서버 수정 보고서 S1F3·S1F4·S1F6·S1F7과 리드 결정 22~35를 반영했습니다. 대표는 메인에게 명령하고, 긴급 정지와 해제, 질문 답변, 보고서 승인과 수정 요청, 조회를 합니다. 데스크톱의 설치 설정은 운영자가 직접 바꿉니다.

**이 문서는 1차 후속 작업 당시의 기록입니다.** 당시 남았던 알림 키 전달과 검수 멈춤 링크의 작업 ID 문제는 새 계약을 반영한 [2차 후속 검증](../followups2/README.md)에서 해결했습니다. 아래의 미완료 설명은 계약이 추가되기 전의 상태입니다.

## 항목별 변경

아래 구현 경로는 `src/renderer/src/` 기준입니다.

| 항목 | 화면과 동작 | 바꾼 파일 |
|---|---|---|
| 1. 모의 실행 끄기 | 설치 설정에서 켜져 있는 메인과 프로젝트만 끄기 버튼을 보입니다. 메인은 `settings.update({developer:{mainAgentMock:false}})`, 프로젝트는 `projects.setMock(projectId,{enabled:false})`를 보냅니다. 성공하면 버튼을 없애고 S1F6 문구를 보입니다. 원격 화면에는 버튼이 없습니다. | `screens/Settings.tsx`, `api/fake/index.ts` |
| 2. 사용량 한도 | 홈 AI 경고와 운영 상태에 `modelLimits`의 `label`과 해제 시각을 표시합니다. 모델별 한도만으로 AI 전체가 막혔다고 표시하지 않습니다. 계열 목록을 고정하지 않아 Fable과 이후 계열도 데이터대로 보입니다. 인증 방식 선택 바로 아래에 결제 변경 안내를 넣었습니다. | `components/AiStatusSummary.tsx`, `screens/Home.tsx`, `screens/Settings.tsx` |
| 3. 새 알림 | 서버 제목, 본문, 링크를 그대로 표시합니다. 프로젝트 알림은 링크의 작업, 팀원 또는 지시를 이름과 함께 명령 초안에 넣습니다. 재개나 재시도 버튼은 없습니다. 키 접두사 처리는 계약 문제로 남았습니다. | `components/ServerNotice.tsx`, `App.tsx` |
| 4. 보고서 상세 | `canRequestChanges`가 있으면 그 값을 따릅니다. 없으면 이전 상태 규칙을 씁니다. 버튼, 본문 선택 코멘트, 이미 열린 수정 창, 전송까지 같은 조건으로 제한합니다. 종료된 지시에는 S1F7 문구와 메인 명령 바로가기를 보입니다. `conflict` 메시지는 그대로 표시합니다. | `screens/Documents.tsx`, `api/store.ts`, `api/fake/index.ts` |
| 5. 운영 설정 범위 | 실행 항목마다 허용 범위와 단위를 보입니다. 백업 보관 개수에는 1~365개를 표시합니다. Claude 최대 턴 수가 null이면 값에 '제한 없음'을 표시합니다. 작은 렌더러 상수 사본을 원본과 비교합니다. main 코드를 화면에 import하지 않습니다. | `lib/operationLimits.ts`, `screens/Settings.tsx` |
| 6. 재로그인 안내 | 홈 인증 할 일에 API 키 방식이면 설치 설정에서 키를 다시 등록해 재로그인 필요 상태를 해제할 수 있다고 안내합니다. | `screens/Home.tsx` |
| 7. 대표 이메일 | 입력칸을 없애고 이메일과 변경 불가 안내를 일반 텍스트로 보입니다. | `screens/Settings.tsx` |
| 8. 설정 오류 경계 | 설정 화면만 오류 경계로 감쌉니다. 이상한 저장값이 렌더링 오류를 내면 짧은 한국어 안내를 보입니다. 홈과 명령창은 계속 쓸 수 있습니다. 다른 설정 분류로 이동하면 해당 화면을 다시 그립니다. | `components/SettingsBoundary.tsx`, `App.tsx` |

활동 본문도 서버 글을 그대로 표시하도록 `screens/Home.tsx`, `screens/Studio.tsx`, `screens/Settings.tsx`를 수정했습니다. 보류 할 일에 화면이 덧붙이던 자동 처리 약속은 메인에게 알려 달라는 안내로 바꿨습니다. 스타일 변경은 `styles/app.css`에 있습니다.

가짜 브리지는 모의 끄기에서 추가 속성, 켜기, 잘못된 값, 빠지거나 넘치는 인자를 `forbidden`과 preload의 원문 메시지로 거부합니다. 메인 모의 끄기 패치에 다른 설정을 섞어도 거부합니다. 보고서의 수정 가능 여부도 반환하고, 끝난 지시와 새 회차가 열린 보고서의 수정 요청을 거부합니다. 알림 읽음 처리는 화면 이동을 일으키지 않습니다. 화면 보기와 명령 바로가기가 각각 이동을 결정합니다.

## 테스트와 변이

화면 테스트는 [permission-ui.test.ts](../../../../src/renderer/src/components/permission-ui.test.ts)와 [followups.test.ts](../../../../src/renderer/src/components/followups.test.ts)에 있습니다. 기존 Studio·MemberPanel 인수 흐름을 유지했습니다.

| 명령 | 최종 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json` | 오류 0개, 종료 0 |
| `node src/renderer/tools/check-contract.mjs` | 종료 0. 메서드 37개, 토픽 6개. 누락과 금지 호출 없음 |
| `npx vitest run --config src/renderer/tools/vitest.config.ts` | 26개 파일, 191개 테스트 통과 |
| `npx vitest run tests/acceptance/flow.test.ts` | 21개 테스트 통과 |
| `node src/renderer/tools/mutate-followups.mjs` | 11개 변이 모두 해당 테스트 실패로 검출 |
| `node src/renderer/tools/capture-followups.mjs` | 1440×1000, 390×844에서 16장 촬영. 문서 가로 넘침, 라벨 넘침, 주요 컨트롤의 화면 밖 배치 없음 |

다음 버그를 실제 소스에 하나씩 넣어 테스트를 실행했습니다. 매번 원래 소스를 복원하고 복원값도 확인합니다. 상세 결과는 [mutation-results.json](mutation-results.json)에 있습니다.

| 항목 | 다시 넣은 버그 | 실패한 테스트 |
|---|---|---|
| 1 | 프로젝트 끄기 버튼에서 `enabled:true` 전송 | `F1.` |
| 1 | 가짜 브리지에서 켜기와 추가 속성 허용 | `F1-fake.` |
| 2 | AI 전체가 막히지 않으면 홈에서 모델 한도를 숨김 | `F2.` |
| 2 | 데이터의 모델 이름을 Opus로 고정 | `F2-family.` |
| 3 | 서버 본문의 팀원 ID를 화면에서 바꿈 | `F3.` |
| 3 | 명령 초안에서 작업과 팀원 식별자를 지움 | `F3.` |
| 4 | `canRequestChanges:false` 무시 | `F4.` |
| 4 | 서버의 `conflict` 메시지를 일반 문구로 바꿈 | `F4-conflict.` |
| 5 | 실행 상한 하한 사본을 2에서 1로 바꿈 | `F5-source.` |
| 5 | Claude 반복 수 null을 0으로 표시 | `F5.` |
| 8 | App에서 설정 오류 경계를 제거 | `F8.` |

`F5-source.`는 TypeScript AST에서 서버 상수의 초기값만 읽어 렌더러 사본과 비교합니다. `F8.`은 오류 안내와 경계 배치를 검사합니다. 브라우저 검사에서는 모델 목록의 label에 객체를 넣어 실제 렌더링 오류를 일으켰고, 오류 안내를 본 뒤 홈으로 이동해 명령창이 남아 있는지도 확인했습니다. 두 폭 모두 통과했습니다. 6번과 7번은 `F6-7.`에서 안내와 텍스트 표시를 확인합니다.

## 스크린샷

모든 PNG는 배율 1로 촬영하고 원본 해상도로 열어 검수했습니다. 첫 검수에서 발견한 모바일 알림함 왼쪽 잘림과 AI 경고 버튼의 과도한 줄바꿈을 고친 뒤 다시 촬영했습니다. [layout-audit.json](layout-audit.json)에 화면별 버튼, 넘침 검사, 오류 격리 결과가 있습니다.

| 화면 | 1440 | 390 |
|---|---|---|
| 설치 설정과 대표 이메일 | [원본](settings-1440.png) | [원본](settings-390.png) |
| 모의 실행 켜짐과 끄기 버튼 | [원본](settings-mock-1440.png) | [원본](settings-mock-390.png) |
| AI 인증 방식과 결제 변경 안내 | [원본](settings-ai-1440.png) | [원본](settings-ai-390.png) |
| 홈의 Fable 모델별 한도 | [원본](home-model-limit-1440.png) | [원본](home-model-limit-390.png) |
| 메인 에이전트 처리 지연 알림 | [원본](notice-handoff-1440.png) | [원본](notice-handoff-390.png) |
| 알림에서 연 작업 명령 초안 | [원본](notice-command-1440.png) | [원본](notice-command-390.png) |
| 수정 요청이 거부된 보고서 | [원본](report-refused-1440.png) | [원본](report-refused-390.png) |
| 잘못된 저장값의 오류 안내 | [원본](settings-error-1440.png) | [원본](settings-error-390.png) |

촬영 도구는 5196의 가짜 브리지에 모의 실행, Fable 한도, 처리 지연 알림, 취소된 지시를 준비합니다. 이 준비값은 촬영할 브라우저에만 넣으며 앱 코드에 촬영 전용 분기를 추가하지 않았습니다. 실제 CLI 실행이나 인증을 시험한 결과는 아닙니다. 촬영 도구가 시작한 Chrome만 닫고 임시 프로필을 지웁니다.

## 남은 계약 문제와 구현 판단

3번의 키 접두사 처리에는 계약 변경이 필요합니다. `src/shared/views.ts`의 `NotificationView`에는 `key`가 없고, `src/main/orchestrator/views.ts`의 `notifications()`도 저장된 키를 응답에 넣지 않습니다. 알림 ID는 `N-...`이므로 키로 대신 쓸 수 없습니다. 수정 금지 범위에 따라 두 파일은 건드리지 않았습니다.

현재 서버가 보내는 제목과 링크만으로 실행 설정 초기화, 모의 실행 켜짐, 사용량 한도, 검수 멈춤, 메인 처리 지연을 표시하고 이동할 수 있습니다. 작업이나 팀원 링크가 있는 처리 지연 알림은 해당 대상을 명령 초안에 넣습니다. 다만 `review-stuck:<작업>:<검수자>` 알림처럼 링크에 지시 ID만 오는 경우에는 지시를 대상으로 초안을 만듭니다. **키 접두사별 판정과, 이 알림에서 정확한 작업·검수자를 넣는 초안은 미완료입니다.** 이를 마치려면 공유 계약과 실제 알림 응답에 키가 전달되어야 합니다. 제목이나 본문을 분석하는 대체 판정은 넣지 않았습니다.

종료된 지시가 스냅샷의 최근 7일 범위에서 빠져도, 수정 불가이고 더 새 보고 회차나 기존 수정 요청이 없으면 종료 안내를 보입니다. 새 회차가 확인되는 보고서에는 종료됐다는 안내를 붙이지 않습니다.

작성한 파일은 `src/renderer/`와 이 폴더 안에 있습니다. 서버, preload, shared, 인수·회귀 테스트, 패키지와 설정 파일은 수정하지 않았습니다. 설치, 커밋, 외부 업무일지 기록은 하지 않았습니다. 개발 서버는 5196만 사용하고 종료했습니다. 5199 서버는 조작하지 않았습니다.
