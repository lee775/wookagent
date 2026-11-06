# 서버 8단계 웹 화면

S8-6의 13개 항목을 렌더러에 반영했습니다. 기존 오크색 바탕, 세이지색 프레임과 Pretendard를 유지했습니다. 실제 서버 브리지는 W8a 소유이며, 이 작업의 화면 검증은 가짜 브리지로 진행했습니다.

## 항목별 결과와 결정

| 항목 | 반영 내용과 이유 |
|---|---|
| 1. 웹과 데스크톱 | `api/runtime.ts` 한 곳에서 웹, 서버, 데스크톱 운영자를 판정합니다. 웹에서는 설치 입력, 메인 AI 입력, 데이터 폴더 열기와 브라우저와 충돌할 단축키를 숨깁니다. 서버의 권한표와 종료 실패 안내도 서버 PC의 운영자를 가리킵니다. |
| 2. 첨부 | 파일 선택과 붙여넣은 이미지를 `web.upload`로 올립니다. 최대 3개씩 처리하고 나머지는 대기시킵니다. 50 MiB 초과, 진행률, 실패, 재시도와 취소를 파일별로 표시합니다. 준비되지 않은 첨부가 있으면 보내기를 막습니다. 웹 전송 값은 새로 만든 `{name, uploadId}`뿐입니다. 데스크톱은 기존 파일 선택과 경로를 유지합니다. |
| 3. 내려받기 | 보고서, 내보낸 기록, 대화 첨부와 지시 상세 첨부에 `web.downloadUrl` 링크를 표시합니다. 주소가 없으면 파일 없음 안내를 표시합니다. 데스크톱은 `system.openPath`를 사용하고, 다운로드 경로가 없는 작업 산출물은 기존 텍스트를 유지합니다. |
| 4. 연결 | 상태 영역 첫 줄에 연결 중, 끊긴 시간과 다음 시도, 연결됨을 표시합니다. 복구 직후에는 5초간 다시 연결됐다는 안내를 표시합니다. 휴대폰에서도 보이며 데스크톱에는 새 표시가 없습니다. |
| 5. 기록 복구 | 열린 팀원 패널이 해당 ID를 감시하고 닫으면 감시 목록을 비웁니다. 앱은 복구 때 알림 목록을 다시 읽습니다. 패널은 마지막 순번 다음부터 커서가 끝날 때까지 채우며, `(turnId, seq)`로 중복을 제거합니다. 첫 조회는 앞으로 끝까지 읽고 최근 40개를 표시합니다. 이전 기록 버튼은 메모리에 읽어 둔 과거 기록을 40개씩 펼칩니다. 앞으로 읽는 서버 커서를 과거 방향으로 쓰지 않습니다. |
| 6. 브라우저 알림 | 닫을 수 있는 안내에서 사용자가 버튼을 눌렀을 때만 권한을 요청합니다. 권한이 있고 페이지가 숨겨져 있을 때 새 토픽 알림을 한 번 표시합니다. OS 알림에는 고정된 짧은 문구만 사용합니다. 클릭하면 창에 초점을 주고 원래 링크로 이동합니다. 닫힌 페이지의 푸시는 범위 밖입니다. |
| 7. 로그인 | 기기 코드 시작이 실패하면 인증 상태를 다시 읽습니다. 설정이 필요해졌으면 오류 카드 대신 설정 코드와 대표 이메일 폼으로 전환합니다. |
| 8. 자리 | 자리 섹션 안에 응답 없음의 시작 시각과 사유를 표시합니다. 명령 초안을 채우는 버튼과 휴대폰에서도 보이는 탐색 항목을 추가했습니다. 서버 조회 effect는 세대, 상태, 응답 없음 시작 시각에만 의존합니다. 화면의 모델 표시는 최신 스냅샷을 따라갑니다. 자리 교체 버튼은 없습니다. |
| 9. 메인에게 말하기 | 기존 문맥별 대상과 초안을 유지합니다. 빈 초안을 만들던 실패 알림도 알림 종류를 담은 초안을 채웁니다. 알림 본문을 명령으로 복사하지는 않습니다. 팀 운영이나 자리 교체 조작은 추가하지 않았습니다. |
| 10. 휴대폰 | 390×844 레이아웃에서 상태 안내와 첨부가 차지하는 높이를 실제 흐름에 반영합니다. `visualViewport` 높이에 맞춰 명령창을 유지합니다. 명령 입력에 초점이 있으면 안내 영역을 연결 상태 한 줄로 줄입니다. 웹 초상은 2D이며 홈과 팀원 패널에서 Three.js나 GLB를 요청하지 않습니다. 760px 이하에서는 스튜디오도 2D를 기본으로 합니다. 큰 화면의 스튜디오만 선택 후 WebGL2 지원을 확인하고 기존 lazy 3D를 엽니다. `studio3d=0` 선택은 유지합니다. |
| 11. 개발 표시 | 개발 주소 표시는 `devParam`과 `hasDevParam`을 통합니다. 순수 fake 예제 생성기에 전달하는 값도 먼저 이 함수로 읽습니다. 예외는 대표의 화면 선택인 `studio3d=0`뿐입니다. 공통 데모 단계 스크립트를 `studio/officeDemoStep.ts`로 옮겨 3D 코드의 `api/fake` 의존을 없앴습니다. |
| 12. 가짜 브리지 | `fakeBridge.web`에 현재 연결 상태 즉시 전달, 감시 목록 교체, 복구 구독, 진행률과 취소가 있는 업로드, 내려받기 주소를 구현했습니다. 가짜 이벤트 조회도 실제 서버와 같은 앞으로 읽는 커서입니다. `fakeConn=connecting/reconnecting`, `fakeUpload=slow/fail`을 지원합니다. `fail`은 파일 이름별 첫 시도만 실패하므로 재시도 화면도 확인할 수 있습니다. |
| 13. 준비 중 화면 | 웹에서는 시뮬레이션 탐색과 빠른 이동 항목, 작업 보드 준비 중 버튼을 숨깁니다. 데스크톱의 기존 준비 중 표시는 유지합니다. |

기록 API에는 뒤로 읽거나 마지막 페이지로 바로 가는 기능이 없습니다. 따라서 현재 턴을 끝까지 읽는 방식이 정확한 대안입니다. 매우 긴 턴은 최초 요청량과 메모리 사용이 늘어납니다. 더 빠른 최근 기록 조회가 필요하면 리드가 별도 커서 계약을 결정해야 합니다.

## 변경 파일

경로는 `src/renderer/` 기준입니다. 다른 레인의 `api/bridge.ts`, `api/remote*`, `api/install*`, `main.tsx`, `env.ts`와 계약 파일은 수정하지 않았습니다.

| 파일 | 변경 |
|---|---|
| `src/App.tsx` | 연결과 알림 안내, 복구 때 알림 갱신, 웹 탐색과 단축키, 휴대폰 화면 높이 |
| `src/api/runtime.ts` | 실행 환경 공통 판정 |
| `src/api/fake/index.ts`, `src/api/fake/web.ts` | 웹 도구, 감시 이벤트 필터와 실제 서버 방향의 커서, 개발 표시 |
| `src/api/fake/officeDemo.ts`, `src/studio/officeDemoStep.ts` | 화면과 fake가 공유하는 단계 스크립트 분리 |
| `src/components/CommandBar.tsx`, `src/lib/uploads.ts` | 웹 첨부 큐와 전송 값, 대화 첨부 링크 |
| `src/components/FileDownload.tsx` | 웹 링크와 데스크톱 경로 열기 |
| `src/components/ConnectionStatus.tsx` | 연결과 복구 상태 |
| `src/components/NotificationOffer.tsx`, `src/lib/browserNotifications.ts` | 명시적인 권한 요청과 숨겨진 페이지 알림 |
| `src/components/MemberPanel.tsx`, `src/lib/memberEvents.ts` | 감시, 복구, 기록 순서와 중복 제거 |
| `src/components/ServerLogin.tsx` | 설정 미완료로 바뀐 로그인 복구 |
| `src/components/MainPauseNotice.tsx`, `src/components/SeatStatus.tsx`, `src/components/PolicyTable.tsx`, `src/lib/taskSignals.ts` | 공통 환경 판정과 서버에 맞는 안내 |
| `src/components/TaskDetail.tsx`, `src/screens/Documents.tsx` | 첨부와 보고서 내려받기 |
| `src/screens/Settings.tsx` | 설치 입력 숨김과 기록 다운로드 |
| `src/screens/Seat.tsx` | 섹션 내 응답 없음, 명령 초안과 조회 의존성 |
| `src/screens/Studio.tsx`, `src/studio3d/Member3DPortrait.tsx` | 휴대폰 2D와 웹 초상 경량화 |
| `src/studio3d/Studio3D.tsx`, `src/studio3d/behaviour.ts` | 개발 표시 통합과 fake import 제거 |
| `src/lib/notice.ts` | 실패 알림에도 문맥이 있는 명령 초안 |
| `src/styles/web.css` | 연결 안내, 업로드 칩과 휴대폰 명령창 |
| `src/components/web-stage8.test.ts` | 새 동작 테스트 15개 |
| `src/components/permission-ui.test.ts`, `stage3-login.test.ts`, `stage4-seat.test.ts`, `followups2.test.ts` | S8의 숨김, 버튼 이름과 문맥 초안 결정에 기존 기대값 갱신 |
| `tools/capture-stage8-web.mjs`, `tools/mutate-stage8-web.mjs` | 다시 실행할 수 있는 화면 검사와 결함 재주입 |

이 디렉터리에는 README, 검사 JSON 2개와 PNG 32장을 남겼습니다. PNG는 저장소의 기존 이미지 제외 규칙 때문에 `git status`에 나타나지 않을 수 있지만 파일은 존재합니다.

## 브라우저 테스트에서 사용할 이름

| 역할 | 접근성 이름 | 용도 |
|---|---|---|
| `button` | `파일 첨부` | 브라우저 파일 선택 열기 |
| `input[type=file]` | `첨부할 파일 선택` | 숨겨진 multiple 파일 입력. Playwright `getByLabel(...).setInputFiles(...)` 사용 가능 |
| `textbox` | `명령 입력` | 명령 초안과 입력 |
| `combobox` | `명령 대상` | `main` 또는 프로젝트 ID |
| `button` | `보내기` | 명령 전송 |
| `progressbar` | `<파일 이름> 업로드 진행률` | 업로드 진행률 |
| `button` | `<파일 이름> 다시 올리기` | 실패한 파일 재시도 |
| `button` | `<파일 이름> 첨부 제거` | 대기, 진행, 실패, 완료 첨부 제거 |
| `alert` | 표시된 업로드 오류 문구 | 각 칩의 실패 사유 |
| `button` | `대화 기록 펼치기` / `대화 기록 접기` | 대화 영역 |
| `link` | 첨부 파일 이름 | 대화와 지시 상세의 다운로드 |
| `link` | `보고서 내려받기` | 보고서 원본 다운로드 |
| `button` / `link` | `내보내기` / `내보낸 기록 내려받기` | 기록 내보내기와 다운로드 |
| `status` | `서버 연결 상태` | 연결 중, 재연결 중과 복구 안내 |
| `button` | `브라우저 알림 켜기` / `브라우저 알림 안내 닫기` | 권한 요청 / 안내 닫기 |
| `button` | `메인 에이전트에게 말하기` | 현재 화면 또는 패널로 범위를 좁혀 선택. 대상과 초안을 채우고 패널을 닫음 |
| `.sidebar button` | `자리와 인계` | 휴대폰에서도 자리 화면 진입 |
| `tab` | `자리와 인계` / `메인 일지` | 자리 화면 내부 탭 |
| `button` | `이전 기록 더 보기` | 현재 읽은 기록에서 과거 40개 펼침 |
| `button` | `수정 요청` / `수정 요청 보내기` | 보고서 의견 작성 / 전송 |
| `textbox` | `전체 코멘트` | 보고서 수정 요청 내용 |
| `textbox` | `설정 코드` / `대표 이메일` | 설정 미완료 서버의 초기 등록 |

같은 이름의 버튼이 여러 개 있는 화면은 `.seat-screen`, `.member-panel`, `.report-footer`, `.sidebar` 또는 해당 dialog로 범위를 좁히면 됩니다. 연결과 파일 링크는 실서버 브리지에서도 같은 이름을 씁니다.

## 테스트와 다시 넣은 결함

새 테스트는 모두 `src/components/web-stage8.test.ts`에 있습니다. 실제 제품 파일을 하나씩 바꿔 단언 실패를 확인한 뒤 원래 바이트로 복원합니다. 결과는 [mutation-results.json](mutation-results.json)에 있습니다.

| 테스트 접두사 | 다시 넣으면 잡는 결함 |
|---|---|
| `S8-upload-wire` | 웹 명령에 경로를 싣거나 붙여넣은 이미지를 업로드하지 않음 |
| `S8-upload-error` | 실패 칩에서 오류 문구를 없앰 |
| `S8-upload-limits` | 동시에 4개를 올리거나 50 MiB 초과 파일을 대기열에 넣음. 제거한 파일의 취소와 다음 파일 시작도 검사 |
| `S8-download` | 웹 링크의 href 누락, 웹에서 데스크톱 열기 분기로 진입 |
| `S8-hidden` | 웹에도 설치 입력과 메인 AI 폼 노출 |
| `S8-connection` | 재연결 중 연결 표시를 숨김 |
| `S8-resync` | 복구 이벤트를 중복으로 합침. 턴이 다른 같은 순번은 보존 |
| `S8-notification` | 보이는 페이지에서 알리거나 권한 없이 알림 생성 |
| `S8-notification-offer` | 안내를 그리는 것만으로 권한 요청 |
| `S8-login409` | 인증 상태를 다시 읽어도 설정 폼으로 바꾸지 않음 |
| `S8-flags-and-imports` | 개발 표시를 URL에서 직접 읽음, 3D 코드에서 api/fake를 다시 import |
| `S8-member-panel` | 첫 화면에 오래된 페이지를 표시함, 감시 목록 누락, 복구 때 마지막 순번 이후를 채우지 않음. 실시간·복구 중복과 과거 펼치기 순서를 실제 패널로 확인 |
| `S8-fake-web` | 실패 시나리오 무시, 업로드 진행률 콜백 누락 |
| `S8-app-resync` | 앱의 복구 구독에서 알림 목록 갱신을 없앰. 연결 영역과 시뮬레이션 숨김도 실제 앱 마크업으로 확인 |
| `S8-seat` | 스냅샷 객체마다 자리 이력을 다시 읽음. 현재 모델, 응답 없음과 명령 초안도 확인 |

기존 테스트의 `S4-2-actions`, `S4-37-*`는 새 버튼 이름을 검사합니다. `S3-server-settings`, `S4-7`, 원격 설정 검사는 비활성 fieldset 대신 fieldset 자체가 없는지 검사합니다. W8a가 정적 fake import를 없앤 뒤에도 검사 대상이 같도록 자리 예제를 테스트에서 명시적으로 준비합니다. `S2-1-drop`은 S8-6.9에 따라 알림 종류가 담긴 초안을 기대하며 본문에 따른 명령 추론 금지는 유지합니다.

## 화면 캡처

[브라우저 검사 결과](browser-audit.json)는 문서 가로 넘침, 명령창 하단, 금지 조작, 연결 문구와 3D 요청을 기록합니다. 파일 선택, 실패 후 재시도, 실제 command.send의 uploadId와 대화 첨부 링크까지 브라우저에서 확인합니다.

| 화면 | 1440px | 390×844 |
|---|---|---|
| 재연결과 알림 제안 | [보기](home-reconnecting-notification-offer-1440.png) | [보기](home-reconnecting-notification-offer-390.png) |
| 계정과 기기 | [보기](account-1440.png) | [보기](account-390.png) |
| 기록 다운로드 | [보기](log-download-1440.png) | [보기](log-download-390.png) |
| 보고서 다운로드 | [보기](report-download-1440.png) | [보기](report-download-390.png) |
| 자리 응답 없음 | [보기](seat-unresponsive-1440.png) | [보기](seat-unresponsive-390.png) |
| 업로드 진행 | [보기](upload-progress-1440.png) | [보기](upload-progress-390.png) |
| 업로드 오류와 재시도 | [보기](upload-error-1440.png) | [보기](upload-error-390.png) |
| 대화 첨부 | [보기](conversation-attachment-1440.png) | [보기](conversation-attachment-390.png) |
| 팀원 상세 | [보기](member-1440.png) | [보기](member-390.png) |
| 스튜디오 | [보기](studio-1440.png) | [보기](studio-390.png) |

키보드가 차지하는 공간을 가정해 390×500으로 줄인 화면: [스튜디오](studio-keyboard-viewport-390.png), [프로젝트](keyboard-프로젝트-390.png), [문서함](keyboard-문서함-390.png), [자리](<keyboard-자리와 인계-390.png>), [운영 설정](<keyboard-운영 설정-390.png>), [계정](<keyboard-계정과 기기-390.png>), [팀](<keyboard-팀과 역할-390.png>), [실행](keyboard-실행-390.png), [실행 정책](<keyboard-실행 정책·정지-390.png>), [스킬](keyboard-스킬-390.png), [기록](keyboard-기록-390.png), [개발자 옵션](<keyboard-개발자 옵션-390.png>). 재연결과 응답 없음 안내를 둔 상태에서 명령 입력과 보내기가 화면 안에 남는지 검사했습니다.

headless Edge는 실제 휴대폰 OS 키보드를 열 수 없습니다. 위 500px 검사는 화면 높이 축소 검증이며 실제 Android/iOS 키보드 확인을 대신했다고 주장하지 않습니다. 휴대폰 스튜디오는 결정한 기본값인 2D이고, 1440px 스튜디오 캡처도 대표 선택 `studio3d=0`을 사용했습니다.

캡처 도구는 5196에 전용 Vite 서버와 Edge 하나를 엽니다. 다른 레인의 부트스트랩 작업과 독립적으로 fake 화면을 확인하도록 브라우저 요청에서만 fake를 먼저 설치합니다. 실제 파일 `main.tsx`는 바꾸지 않습니다. 종료 때 브라우저, 서버와 OS 임시 폴더를 정리합니다. 업무일지는 리드가 기록합니다.

## 첫 구현 검증 결과

2026-11-05 최종 확인 결과입니다. 모든 Vitest와 긴 명령은 지정된 `scratchpad/vt.sh`를 거쳤고, 테스트는 하나씩 실행했습니다.

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json` | **exit 0**. W8a가 `remote.test.ts` 오류를 수정했습니다. 수정 1회차에서도 다시 확인했습니다. |
| `node src/renderer/tools/check-contract.mjs` | **exit 0**. 메서드 46개, 누락과 금지 호출 없음 |
| `vt.sh --config src/renderer/tools/vitest.config.ts` | **exit 0**, 32개 파일 / **365개 통과**. W8a의 remote 테스트 38개도 포함한 최종 전체 결과 |
| `vt.sh tests/acceptance/flow.test.ts` | **exit 0**, **21개 통과**. AC-27 실시간 턴 전환 포함 |
| `vt.sh -- node src/renderer/tools/mutate-stage8-web.mjs` | 정상 코드의 15개 테스트 통과 후 **23/23 결함을 단언으로 검출**, 원본 바이트 복원. 기록 버퍼 정리 후 영향받은 4건도 다시 검출 |
| `vt.sh -- node src/renderer/tools/capture-stage8-web.mjs` | **exit 0**, **32장**, 브라우저 실행 오류 0건. 홈과 팀원 상세의 3D 요청 0건. 모든 캡처에서 문서 가로 넘침과 화면 밖 명령창 없음 |

AC-27 하네스가 새 `useRef`를 처리하지 못하는 문제가 한 차례 있었습니다. 구독 effect 안의 기록 버퍼 하나로 초기 조회, 실시간과 복구를 합치도록 정리해 참조 객체 자체를 없앴고, acceptance 전체가 통과했습니다. `tests/` 파일은 바꾸지 않았습니다.

`vt.sh` 경로는 `C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/vt.sh`입니다. 타입 검사 같은 일반 명령은 `bash <경로> -- <명령>`, Vitest 인자는 `bash <경로> <인자>`로 실행합니다. 결함 검사 도구 뒤에 결함 이름을 넘기면 해당 건만 다시 확인하고 기존 결과에 합칩니다.

캡처용 5196 리스너가 없음을 확인했습니다. 브라우저와 OS 임시 프로필·캐시 폴더도 종료 때 정리했으며 저장소에 테스트 임시 파일을 남기지 않았습니다.

## 남은 일과 리드 확인

- 웹 타입 검사는 W8a의 수정 후 통과했습니다. 아래 수정 1회차에 재검증 결과를 기록합니다.
- 수정 요청의 서버 대화 저장은 S8-13에서 보완됐습니다. 수정 1회차는 프로젝트 대화 선택과 fake의 같은 메시지 저장을 반영했습니다. 추가 `command.send`는 호출하지 않습니다.
- 실제 서버의 로그인, 네트워크 단절, 다운로드 응답과 번들 내 fake 코드 부재는 W8a/W8b 검증 영역입니다. 이 작업은 기존 계약에 새 필드를 요구하지 않습니다.
- 실제 휴대폰 OS 키보드와 OS 브라우저 알림 정책은 기기에서 추가 확인할 수 있습니다. 닫힌 페이지 푸시는 S8-2에 따라 구현하지 않았습니다.

## 수정 1회차

S8-17~19의 화면 부분과 S8-20 a~j를 반영했습니다. 아래 소스 경로는 `src/renderer/` 기준입니다. 보호된 브리지, 계약, 서버, `tests/`와 빌드 설정은 수정하지 않았습니다. 실서버 브라우저 probe는 실행하지 않았으며, 가짜 브리지와 렌더러 검사로 확인했습니다.

### 항목별 변경

| 항목 | 변경과 근거 위치 |
|---|---|
| S8-17 | `src/components/MemberPanel.tsx:120`에서 초기 조회와 실시간 구독을 유지하고 `watchMembers`가 풀린 뒤 한 번 더 끝까지 조회합니다. 보충 커서는 **초기 조회에서 읽은 최대 seq**입니다. 새 스트림의 높은 seq가 먼저 도착해도 그 앞의 빈 구간을 건너뛰지 않습니다. 합치기는 `(turnId, seq)`를 기준으로 합니다. 팀원과 턴이 바뀌면 이전 조회를 무시하고 다시 감시합니다. `src/api/fake/web.ts:20`도 마이크로태스크 뒤 풀리는 `Promise<void>`를 반환합니다. |
| S8-18 | `src/lib/uploads.ts:55`에서 `rate_limited`를 다시 대기로 돌립니다. 0.3초, 1초, 오류의 `retryAfterSec` 순서로 최대 3회 재시도합니다. 값이 없으면 마지막 대기는 5초입니다. 모두 실패한 뒤에만 오류와 재시도 버튼을 표시합니다. 제거와 해제는 대기 타이머도 취소하며, 동시 업로드 상한은 3개입니다. `src/components/CommandBar.tsx:60`에 대기 상태를 표시합니다. |
| S8-19 | `public/notify-sw.js:2`에는 `notificationclick`만 있습니다. 요청 가로채기, 캐시, `importScripts`가 없습니다. `src/lib/browserNotifications.ts:26`에서 웹 알림을 켜거나 이미 허용된 페이지를 열 때 `/` 범위로 등록합니다. `:86`에서 `showNotification`을 먼저 사용하고 생성자로 대체합니다. 제목과 본문은 고정 문구이며 tag와 `data.link`만 항목을 가리킵니다. 둘 다 실패하면 `src/components/NotificationOffer.tsx:16`의 안내 한 곳에 표시하고 제안을 숨깁니다. `src/lib/browserNotifications.ts:70`, `src/App.tsx:263`이 클릭 메시지와 새 창의 링크를 처리합니다. Electron에는 등록이나 새 안내가 없습니다. |
| S8-20 a | `src/components/TaskDetail.tsx:51`에서 중복 첨부 섹션과 깨진 제목을 삭제했습니다. `tools/check-stage8-text.mjs:7`로 전체 renderer 소스, 8단계 도구와 진입 파일의 UTF-8, U+FFFD, 문자열·JSX의 연속 물음표를 검사합니다. 코드의 `??` 연산자는 구분합니다. 추가로 깨진 한글은 없었습니다. PowerShell 쓰기는 유니코드 이스케이프를 사용하고 저장 뒤 UTF-8 재읽기를 확인했습니다. |
| S8-20 b | `src/App.tsx:261`에서 연결을 잃은 시각을 기억합니다. 복구 후 목록을 읽어 `src/lib/browserNotifications.ts:113`에서 그 뒤 생긴 미확인·미표시 알림만 한 건으로 묶습니다. 여러 건이면 고정 문구에 개수만 넣습니다. 페이지 숨김, 권한과 중복 방지는 실시간 경로와 같습니다. |
| S8-20 c | `src/screens/Documents.tsx:57`의 성공 경로가 프로젝트 대화를 선택하고 위치를 안내합니다. `src/lib/commands.ts:5`, `src/components/CommandBar.tsx:27`에서 대화를 펼치고 즉시 갱신하며 작성 중인 명령은 보존합니다. 두 번째 `command.send`는 보내지 않습니다. |
| S8-20 d | `src/components/ServerLogin.tsx:63`에서 로그인 시작만 브리지로 직접 호출합니다. 설정 미완료면 인증 상태를 다시 읽고 설정 폼으로 전환합니다. 이 경로는 일반 오류 토스트를 만들지 않으며, 다른 시작 실패는 기존 로그인 오류 카드에 표시합니다. |
| S8-20 e | `src/screens/Home.tsx:71`의 경로에 전용 클래스를 붙였습니다. `src/styles/web.css:9`에서 카드·격자의 최소 폭을 0으로 두고 경로에 `overflow-wrap:anywhere`, `white-space:normal`을 적용합니다. 기존 한 줄 말줄임도 해제됩니다. |
| S8-20 f | 허용된 자리 탐색 항목은 유지했습니다. `src/screens/Settings.tsx:238`에서 데스크톱 내보내기 결과를 **내보낸 기록 열기**, 웹 링크를 **내보낸 기록 내려받기**로 구분합니다. |
| S8-20 g | `src/App.tsx:300`에서 웹에서도 Escape가 빠른 이동을 닫습니다. 브라우저 단축키 차단은 유지합니다. `src/api/fake/index.ts:749`에 S8-13의 대표 대화 한 건을 추가했습니다. 이미 요청한 보고서의 재호출이나 거부에는 추가하지 않습니다. |
| S8-20 h | `src/lib/uploads.ts:55`에서 업로드의 `unauthorized`도 `wook:unauthorized`를 발생시켜 기존 로그인 전환을 사용합니다. 자동 재시도하지 않습니다. |
| S8-20 i | `src/components/web-stage8.test.ts:252`는 실시간 중복을 복구 전에 바로 검사합니다. `:145`는 다시 올리기를 눌러 두 번째 성공·준비됨·보내기 활성화를 확인합니다. `:206`, `:422`는 생성자와 서비스 워커 모두 제목·본문의 고정 문자열과 서버 텍스트 부재를 검사합니다. |
| S8-20 j | 위 타입 검사 표와 남은 일에서 W8a 수정 전의 오래된 오류 안내를 정정했습니다. `S8-doc-status`로 문서가 통과 상태를 유지하는지도 검사합니다. |

알림 링크는 같은 출처의 `/#wook-notify=<인코딩한 화면 대상>`입니다. 서버 텍스트, 인증 값은 넣지 않습니다. 기존 창을 찾으면 초점을 주고 메시지를 보내며, 없으면 같은 출처의 링크만 엽니다. 새 창은 로그인 후에도 목적지를 유지합니다. `fakeUpload=rate_limited`는 이름별 처음 세 번을 거절하고 네 번째에 성공해 재대기 화면을 재현합니다.

### 테스트와 다시 넣은 결함

모든 화면 테스트는 `src/components/web-stage8.test.ts`에 있습니다. 변이 도구는 한 번에 제품 결함 하나만 넣고 단언 실패를 확인한 뒤 원본 바이트를 복원·대조합니다. [전체 결과](mutation-results.json)는 기존 23건과 이번 보강을 함께 기록합니다.

| 테스트 접두사 | 다시 넣으면 잡는 결함 |
|---|---|
| `S8-panel-watch-gap` | 감시 준비를 기다리지 않음, 준비 뒤 보충 조회 누락, 먼저 도착한 실시간 최대 seq 때문에 중간 기록을 건너뜀. 턴 전환 후에도 다시 조회하는지 확인합니다. |
| `S8-member-panel` | 실시간 겹침을 그대로 추가함, 감시 누락, 복구 조회 누락, 최신 기록 대신 첫 페이지 표시 |
| `S8-fake-web` | 준비 약속을 반환하지 않음, 업로드 실패 예제·진행률 누락 |
| `S8-upload-rate-limit` | 첫 429를 즉시 오류로 표시함, 대기 없이 바로 재시도함. 준비된 뒤 보내기 활성화도 확인합니다. |
| `S8-upload-rate-exhausted` | 제한 없이 반복함, 마지막 Retry-After를 무시함. 제거한 칩의 대기 취소도 검사합니다. |
| `S8-upload-error` | 오류를 숨김, 다시 올리기가 업로드를 시작하지 않음 |
| `S8-upload-limits`, `S8-upload-wire` | 동시 4개, 크기 초과, 웹 경로 유출, 붙여넣기 누락 |
| `S8-upload-unauthorized` | 업로드 인증 만료를 로그인 경로에 알리지 않음 |
| `S8-notification-worker` | 서비스 워커 사용 누락, 서버 제목·본문 노출, tag 누락, 클릭 메시지 무시. 같은 항목의 동시 호출도 한 번만 표시하는지 확인합니다. |
| `S8-notification` | 보이는 페이지·미허용 상태에서 알림. 생성자 경로도 고정 제목·본문인지 검사합니다. |
| `S8-notification-offer`, `S8-notification-granted-load` | 화면을 그리기만 해도 권한 요청, 이미 허용된 페이지의 등록 누락. 데스크톱 등록이 없는지도 확인합니다. |
| `S8-notification-unavailable` | 알림 실패를 삼킴. 제안 숨김과 페이지 안내 한 건을 검사합니다. |
| `S8-worker-click` | 창 초점·새 창 열기 누락, 외부 링크 허용, fetch 핸들러 추가. 등록된 핸들러가 클릭 하나인지 실제 worker 소스를 실행해 확인합니다. |
| `S8-app-resync`, `S8-missed-notifications` | 복구 목록 갱신·브라우저 알림 누락, 오래된 항목·읽은 항목 포함, 중복 표시. 여러 새 알림은 한 건과 개수로 표시하는지 확인합니다. |
| `S8-project-changes` | 성공 후 프로젝트 대화 선택·위치 안내 누락. 초안 보존과 명령 중복 전송 부재도 확인합니다. |
| `S8-login409` | 설정 전환 누락, 일반 실패 토스트 동반 |
| `S8-directive-and-text` | 첨부 이중 렌더링, U+FFFD 또는 한글 자리를 대신한 물음표 재유입 |
| `S8-home-wrap` | 경로 줄바꿈 또는 카드 최소 폭 수정 누락. 실제 폭과 줄바꿈은 캡처 검사도 함께 사용합니다. |
| `S8-desktop-export` | 데스크톱 버튼에 내려받기라고 표시 |
| `S8-web-escape`, `S8-fake-changes` | Escape 무시, fake의 수정 요청 대화 누락 |
| `S8-doc-status` | 타입 검사 표를 다시 실패로 잘못 기록하거나 수정 1회차 섹션 누락 |

### 캡처

`bash <vt.sh> -- node src/renderer/tools/capture-stage8-web.mjs --fix1`로 재현합니다. [검사 JSON](browser-audit-fix1.json)에 문서 폭, 카드의 실제 오른쪽 경계와 내부 폭, 명령창 위치, 금지 조작과 실행 오류를 기록합니다. 긴 경로는 한 줄보다 높은지와 `white-space`도 검사하고 카드가 보이는 위치에서 찍습니다. 문서함은 성공 안내와 새 대화가 보이도록 스크롤하고 토스트가 사라진 뒤 찍습니다.

| 화면 | 1440px | 390×844 |
|---|---|---|
| 업로드 제한 후 재대기 | [보기](fix1-upload-queued-again-1440.png) | [보기](fix1-upload-queued-again-390.png) |
| 알림 제안 | [보기](fix1-notification-offer-1440.png) | [보기](fix1-notification-offer-390.png) |
| 알림을 표시할 수 없음 | [보기](fix1-notification-unavailable-1440.png) | [보기](fix1-notification-unavailable-390.png) |
| 첨부가 있는 지시 상세 | [보기](fix1-directive-attachments-1440.png) | [보기](fix1-directive-attachments-390.png) |
| 긴 경로가 있는 Home | [보기](fix1-home-long-path-1440.png) | [보기](fix1-home-long-path-390.png) |
| 수정 요청 뒤 문서함 | [보기](fix1-documents-change-request-1440.png) | [보기](fix1-documents-change-request-390.png) |

### 브라우저 테스트에 추가할 이름

| 역할 | 접근성 이름 또는 표시 문구 |
|---|---|
| `status` | `브라우저 알림을 표시할 수 없음` |
| 위 상태의 본문 | `이 브라우저에서는 알림을 표시할 수 없습니다. 작업실의 알림함을 확인해 주세요.` |
| `status` | `<파일 이름> 업로드 대기` |
| 재대기 본문 | `업로드 대기 · 잠시 뒤 다시 올립니다` (`.upload-queued`, 오류 아님) |
| `small` | `첨부 준비됨` (`.upload-ready`) |
| `button` | 데스크톱 `내보낸 기록 열기` |
| 문서함의 `status` | 기존 성공 안내 뒤 `<프로젝트 이름> 대화에 수정 요청을 표시했습니다.` |

`명령 대상` combobox의 값은 수정 요청 뒤 해당 프로젝트 ID입니다. 대화 기록은 자동으로 펼쳐집니다. 기존 파일 재시도·제거 이름과 브라우저 알림 켜기 이름은 같습니다.

### 재검증과 남은 범위

| 검사 | 수정 1회차 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json` | exit 0. W8c 소유 파일을 포함해 남은 오류 없음 |
| `node src/renderer/tools/check-contract.mjs` | exit 0. 메서드 46개, 누락·금지 호출 없음 |
| `node src/renderer/tools/check-stage8-text.mjs` | exit 0. 113개 파일, 깨진 문자열과 U+FFFD 없음 |
| `vt.sh run --config src/renderer/tools/vitest.config.ts` | exit 0. **32개 파일 / 393개 통과**, 이 중 화면 테스트 31개 |
| `vt.sh run tests/acceptance/flow.test.ts` | exit 0. **21개 통과**, 마지막 보충 조회 수정 뒤 재확인 |
| `tools/mutate-stage8-web.mjs` | **60/60 검출**, 모두 단언 실패. 원본 바이트 복원 확인 |
| `tools/capture-stage8-web.mjs --fix1` | exit 0. **12장**, 실행 오류·문서 넘침·카드 넘침·화면 밖 명령창 없음 |

- 화면 수정에서 남겨 둔 항목이나 새 계약 요청은 없습니다.
- W8c의 실서버 브리지·정적 파일·브라우저 검사와 실제 Android 기기의 OS 알림 확인은 해당 레인과 소유자의 후속 확인입니다. 이 작업에서 실행했다고 보고하지 않습니다.
- 닫힌 페이지 푸시와 실제 휴대폰 OS 키보드는 기존 범위 밖입니다. 캡처는 가짜 브리지의 화면 확인이며 서버 보안 검증을 대신하지 않습니다.
- 캡처 도구는 5196과 headless Edge 하나만 사용하고 종료 때 서버·브라우저·임시 캐시를 닫습니다. 5199와 다른 프로세스는 건드리지 않았습니다. 업무일지는 리드가 기록합니다.

## 마무리

S8-25 a~d를 반영했습니다. 아래 소스와 도구 경로는 `src/renderer/` 기준입니다. W8d의 파일과 공유 계약은 수정하지 않았습니다.

### 항목별 변경

| 항목 | 코드 위치와 동작 |
|---|---|
| a. 시계와 무관한 미수신 알림 복구 | `src/lib/browserNotifications.ts:9`, `:112`, `:116`에서 페이지가 이미 본 알림 ID를 기억합니다. 첫 목록은 기존 알림의 기준으로만 사용합니다. 이후 목록에서 처음 발견한 읽지 않은 항목만 묶어서 알립니다. 보이는 페이지에서 받은 실시간 항목과 목록도 본 것으로 기록하므로 숨긴 뒤 다시 알리지 않습니다. |
| a. 감지 전 공백과 일반 목록 갱신 | `src/App.tsx:259`, `:275`, `:311`에서 복구 조회, 실시간 수신 뒤의 조회와 스냅샷에 따른 조회에 같은 처리를 적용합니다. 끊김 감지 여부와 생성 시각을 조건으로 쓰지 않습니다. 브라우저와 서버 시계의 차이, 감시 타이머가 끊김을 알아채기 전의 공백을 함께 처리합니다. |
| b. iPhone 안내 위치와 닫기 | `src/components/NotificationOffer.tsx:5`, `:9`, `:21`에 닫기 버튼과 사용자별 저장을 추가했습니다. `src/App.tsx:431`의 홈 알림 제안 자리에만 표시합니다. 계정이 바뀌면 해당 사용자의 닫기 선택을 읽으며, `localStorage` 읽기와 쓰기는 모두 `try/catch`로 감쌌습니다. 저장소가 차단돼도 현재 방문에서는 닫힙니다. 다른 화면에서도 이미 허용한 알림의 워커 등록은 유지합니다. |
| c. 빠진 분기 검사 | `src/components/web-stage8.test.ts:462`, `:558`, `:583`, `:595`에서 빈 첫 조회 뒤의 보충 조회, 제어하지 않는 창까지 찾는 워커 옵션, 워커 알림 실패 뒤 생성자 사용, 등록 대기 뒤 가시성과 권한 재확인을 검사합니다. 해당 제품 분기는 이미 올바르므로 그대로 유지했습니다. |
| c. 결함 재주입 | `tools/mutate-stage8-web.mjs:71`부터 마무리 항목의 변이를 추가했습니다. 기존 시계 비교용 변이도 ID 기준 판정에 맞춰 갱신했습니다. 변이마다 제품 파일을 바꾸고 단언 실패를 확인한 뒤 원래 바이트로 복원합니다. |
| d. 결과 기록 | `docs/design/permission-ui/stage8-web/README.md:253`의 `마무리` 절에 변경 위치, 테스트와 변이, 캡처와 남은 범위를 기록합니다. |

첫 조회가 실패하면 다음에 성공한 조회가 기준 목록이 됩니다. 이미 본 ID는 페이지가 열려 있는 동안 메모리에만 보관합니다. 알림 목록의 기존 50개 조회 범위와 닫힌 페이지 푸시의 범위는 바꾸지 않았습니다.

### 테스트와 잡는 변이

테스트 파일은 `src/components/web-stage8.test.ts`입니다. 표의 줄 번호는 각 테스트의 시작입니다. 새 테스트와 보강한 테스트가 각각 해당 변이에서 단언 실패하는지 검사합니다.

| 테스트와 줄 | 잡는 변이와 의미 |
|---|---|
| `S8-clock-skew` `:509` | `missed-clock-skew`. 페이지 시계가 서버보다 3분 빠르거나 느려도 미수신 ID만 알립니다. |
| `S8-silent-dead` `:527` | `missed-silent-dead-clock`. 생성된 뒤 47초가 지나서야 끊김을 감지한 항목도 복구합니다. |
| `S8-later-list` `:542` | `missed-later-list-ignored`. 재연결 없이 스냅샷에 따른 목록 조회로 발견한 항목도 알립니다. 보이는 상태에서 읽은 목록은 다시 알리지 않습니다. |
| `S8-live-before-list` `:500` | `missed-live-not-seen`. 직전 목록에 없던 실시간 항목도 이미 본 것으로 기억합니다. |
| `S8-missed-notifications` `:479` | `missed-first-list-announced`, `missed-notifications-include-old`, `missed-notifications-include-read`. 첫 목록, 이미 본 항목, 읽은 항목을 제외하고 여러 새 항목을 한 번만 묶어 알립니다. |
| `S8-panel-empty-catchup` `:558` | `watch-empty-no-catchup`. 첫 조회가 비어도 감시 준비 뒤 커서 `0`부터 끝까지 보충합니다. 도중에 들어온 실시간 항목과 겹쳐도 순서대로 한 번씩 표시합니다. |
| `S8-worker-click` `:462` | `worker-controlled-only`. `includeUncontrolled`가 없으면 등록한 페이지를 찾지 못하는 워커 상황을 재현합니다. 기존 창을 찾았을 때 새 창을 열지 않는지도 확인합니다. |
| `S8-worker-reject-fallback` `:583` | `worker-reject-no-fallback`. `showNotification`이 거부돼도 정상 생성자로 한 번 표시하고 브라우저를 사용 불가로 바꾸지 않습니다. |
| `S8-registration-recheck` `:595` | `registration-no-recheck`. 등록 대기 중 페이지가 보이거나 권한이 거부되면 표시하지 않습니다. 이후 조건이 맞으면 같은 항목을 다시 시도할 수 있습니다. |
| `S8-notice-viewer` `:611` | `notice-dismiss-ignored`, `notice-dismiss-not-stored`, `notice-dismiss-not-read`, `notice-shared-viewer`. 즉시 닫기, 다시 열었을 때의 저장 복원과 사용자별 분리를 검사합니다. |
| `S8-notice-storage-blocked` `:621` | `notice-storage-exception-hides`. 저장소 접근이 예외를 던져도 안내를 표시하고 현재 방문에서는 닫을 수 있습니다. |
| `S8-notice-home` `:628` | `notice-every-screen`. 홈을 떠나면 알림 제안 자리를 숨깁니다. 안내가 숨겨져 있어도 허용된 알림의 등록은 실행합니다. |

### 캡처

`bash <vt.sh> -- node src/renderer/tools/capture-stage8-web.mjs --wrapup`으로 다시 실행합니다. 이 모드는 실제 제품 화면에 가짜 브리지를 연결하고 Notification API 부재와 OS 알림 생성자를 재현합니다. 실제 기기의 OS 알림을 캡처한 것은 아닙니다.

| 화면 | 1440px | 390×844 |
|---|---|---|
| 닫을 수 있는 알림 불가 안내 | [보기](wrapup-notification-notice-1440.png) | [보기](wrapup-notification-notice-390.png) |
| 닫고 새로고침한 뒤 홈 | [보기](wrapup-notification-dismissed-1440.png) | [보기](wrapup-notification-dismissed-390.png) |
| 조용히 끊긴 동안의 알림 2개 복구 | [보기](wrapup-missed-notifications-1440.png) | [보기](wrapup-missed-notifications-390.png) |

[브라우저 검사 기록](browser-audit-wrapup.json)에 실제 문서 폭, 명령창 위치, 안내 개수와 알림 생성 결과를 남깁니다. 캡처 도구는 문서함에서 안내가 반복되지 않는지, 닫기 선택이 새로고침 뒤에도 유지되는지 검사합니다. 과거 생성 시각의 새 ID 두 개를 실시간 토픽 없이 넣고 복구 조회로 하나의 고정 문구 알림이 만들어지는지, 두 번째 복구에는 중복이 없는지도 확인합니다.

### 검증 결과와 남은 범위

| 검사 | 마무리 결과 |
|---|---|
| `bash <vt.sh> -- npx tsc --noEmit -p tsconfig.web.json` | exit 0. 원격 브리지 파일을 포함해 타입 오류 없음 |
| `node src/renderer/tools/check-contract.mjs` | exit 0. 메서드 46개, 누락과 금지 호출 없음 |
| `bash <vt.sh> run --config src/renderer/tools/vitest.config.ts` | exit 0. 32개 파일, **405개 통과**. 화면 테스트는 31개에서 **43개**로 증가 |
| `bash <vt.sh> run tests/acceptance/flow.test.ts` | exit 0. **21개 통과** |
| `bash <vt.sh> -- node src/renderer/tools/mutate-stage8-web.mjs` | 기존 60개와 새 14개가 모두 단언 실패. 추가한 저장소 예외 변이 1개도 이름을 지정해 재실행하여 검출. 합계 **75/75**, 새 변이 **15/15**. 결과는 [mutation-results.json](mutation-results.json)에 저장하며 각 실행 뒤 원본 바이트 복원을 검사 |
| `bash <vt.sh> -- node src/renderer/tools/capture-stage8-web.mjs --wrapup` | exit 0. **6장**, 실행 오류와 문서·카드 가로 넘침 없음. 두 폭 모두 명령창이 화면 안에 있으며 복구 알림은 한 번만 생성 |
| `node src/renderer/tools/check-stage8-text.mjs` | exit 0. 113개 파일에서 깨진 한국어와 U+FFFD 없음. 수정한 README도 UTF-8로 별도 확인 |

- S8-25 a~d에서 남은 구현이나 검증은 없습니다. 전체 루트 테스트와 실서버 브라우저 테스트는 이번 화면 마무리에서 실행하지 않았으며 리드 최종 검증과 W8d 범위입니다.
- 실제 Android와 iPhone에서 OS 알림을 누르는 검사는 소유자의 수동 확인으로 남습니다. 닫힌 휴대폰의 푸시는 S8-2에 따라 범위 밖입니다.
- 캡처용 5196 서버와 headless Edge를 종료했습니다. 5199와 다른 프로세스는 건드리지 않았고, 임시 프로필과 캐시는 시스템 임시 폴더에서 정리했습니다.
- 업무일지는 이번 요청의 저장소 밖 수정 금지에 따라 직접 기록하지 않았습니다. 이 절의 결과를 리드 기록에 전달합니다.
