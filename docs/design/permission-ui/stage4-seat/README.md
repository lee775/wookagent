# 서버 4단계: 메인 자리와 인계

2026-11-02. 대표는 메인에게 명령하고 자리와 기록을 봅니다. 자리를 바꾸는 화면은 없습니다. 오크색 배경과 세이지색 프레임을 유지했습니다.

먼저 [자리 화면](../../../../src/renderer/src/screens/Seat.tsx), [상단 상태](../../../../src/renderer/src/components/SeatStatus.tsx), [화면 테스트](../../../../src/renderer/src/components/stage4-seat.test.ts)를 보면 됩니다. 이전 결정은 [기본 화면](../README.md), [후속 검증](../followups/README.md), [2차 후속](../followups2/README.md), [3차 후속](../followups3/README.md), [서버 로그인](../stage3-login/README.md)을 따릅니다.

## 항목별 결과와 변경 파일

구현 경로는 `src/renderer/` 기준입니다.

| 항목 | 결과 | 변경 파일 |
|---|---|---|
| 1. 상단 보유자 칩 | `snapshot.seat`의 보유자, 모델과 교체 중 대상을 표시합니다. 빈 자리와 정지 상태도 구분합니다. 누르면 자리 화면으로 이동합니다. 390px에서는 이름만 표시하며, 전체 상태는 접근성 이름과 툴팁에 남깁니다. 로그인 전에는 칩을 그리지 않습니다. | `src/components/SeatStatus.tsx`, `src/App.tsx`, `src/styles/seat.css` |
| 2. 응답 없음 | 1초마다 경과 시간을 갱신하고 60분부터 시간과 분으로 표시합니다. 이유와 지정된 안내를 그대로 보여 줍니다. 명령창에 초점을 두는 버튼과 기존 긴급 정지 버튼만 제공합니다. 정지 중에는 안내를 유지하고 시간을 세지 않는다는 문구를 표시합니다. | `src/components/SeatStatus.tsx`, `src/App.tsx`, `src/styles/seat.css` |
| 3. 자리 화면 | 현재 보유자, 세대, 시작, 상태, 화면 보기 확인 결과와 최신순 이력을 표시합니다. 바꾼 주체는 메인, 운영자, 서버로 구분합니다. 꾸러미가 있는 이력에만 링크를 둡니다. 하단의 메인 명령 안내는 지정 문구를 사용합니다. | `src/screens/Seat.tsx`, `src/lib/seat.ts`, `src/App.tsx` |
| 4. 인계 꾸러미 | 세대별 꾸러미를 화면 안에서 엽니다. 생성 시각, 받은 보유자, 이전 보유자, 글자 수와 생략 건수를 표시합니다. 서버가 준 순서를 유지합니다. 확인되지 않은 메모에는 점선 테두리, 메모 아이콘과 지정된 설명을 붙입니다. null과 조회 실패도 구분합니다. | `src/screens/Seat.tsx`, `src/styles/seat.css` |
| 5. 메인 일지 | 자리 화면의 별도 탭입니다. 아홉 종류의 한국어 이름, 작성 주체, 보유자와 세대, 프로젝트, 참조 링크와 약속 상태를 표시합니다. 닫힌 약속의 마무리 내용도 보여 줍니다. 프로젝트, 종류, 작성자와 열린 약속 필터를 적용하며 기본 50건 뒤에는 커서로 더 불러옵니다. 이전 필터의 늦은 응답은 무시합니다. | `src/screens/Seat.tsx`, `src/lib/seat.ts`, `src/styles/seat.css`, `src/screens/Home.tsx` |
| 6. 알림과 활동 | `seat-unresponsive:` 알림의 바로가기는 자리 화면을 엽니다. 메인 명령 바로가기를 붙이지 않습니다. 홈과 스튜디오의 자리·일지 활동에 아이콘을 붙이고 기존 내용 표시를 유지합니다. | `src/lib/notice.ts`, `src/components/ServerNotice.tsx`, `src/components/ActivityMarker.tsx`, `src/screens/Home.tsx`, `src/screens/Studio.tsx` |
| 7. 데스크톱 설정 | 메인 AI 폼 아래에 운영자 배정, 세대 변경, 다음 턴 적용에 관한 지정 문구를 추가했습니다. 서버 모드에서는 이 폼이 비활성화됩니다. | `src/screens/Settings.tsx` |
| 8. 가짜 브리지 | 네 메서드, 세 세대 이력, 네 인계 구역과 생략 건수, 모든 일지 종류와 약속 사례를 제공합니다. 로그인 전 스냅샷의 자리는 `LOCKED_SEAT`이며 네 조회는 로그인 필요로 거절합니다. 긴급 정지를 여러 번 요청해도 정지 시작 시각을 유지하고, 해제 때 정지한 시간을 응답 없음 시각에 반영합니다. | `src/api/fake/data.ts`, `src/api/fake/index.ts`, `src/api/fake/seat.ts` |

공유 `NavTarget`에는 `seat`가 없으므로 `src/lib/seat.ts`의 renderer 전용 `RendererTarget`으로 확장했습니다. 공유 계약 변경은 필요하지 않았습니다. 칩, 빠른 이동 메뉴와 `Alt 5`가 같은 자리 화면을 엽니다. 질문 참조는 홈의 해당 질문으로 이동해 답변란에 초점을 둡니다. 지워진 참조는 링크로 만들지 않습니다.

응답 없음, 긴급 정지, 기존 메인 정지 안내는 높이를 계산해 겹쳐 놓는 대신 같은 흐름에 배치했습니다. 휴대폰에서 안내가 길면 안내 영역을 스크롤할 수 있습니다. 명령창과 상단 긴급 정지는 계속 사용할 수 있습니다.

## 테스트와 검사

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json --tsBuildInfoFile src/renderer/.stage4.tsbuildinfo` | 오류 0, 종료 0. 공유 작업 공간의 빌드 캐시를 덮지 않도록 캐시 위치만 지정했습니다. |
| `node src/renderer/tools/check-contract.mjs` | 종료 0. 메서드 46개, 토픽 6개. 브리지, 화면 호출과 토픽 누락 없음. 금지된 화면 호출 없음. |
| `npx vitest run --config src/renderer/tools/vitest.config.ts` | 29개 파일, 254개 테스트 통과. 새 화면 테스트는 19개입니다. |
| `npx vitest run tests/acceptance/flow.test.ts` | 21개 통과. Studio와 MemberPanel을 사용하는 기존 흐름을 유지했습니다. |
| `node src/renderer/tools/mutate-stage4-seat.mjs` | 결함 재주입 16건을 모두 검출했습니다. 매번 원본 바이트를 복원했습니다. |
| `node src/renderer/tools/capture-stage4-seat.mjs` | 실제 Chrome, 배율 1에서 1440px와 390px를 검사했습니다. 가로 넘침과 상단 바 줄바꿈이 없고 검사한 버튼은 높이 44px 이상입니다. 명령 초점과 정지 해제 뒤 시간 유지도 확인했습니다. |

실제 단언 실패는 [mutation-results.json](mutation-results.json), 화면 수치와 브라우저 오류 검사는 [layout-audit.json](layout-audit.json)에 있습니다. 테스트와 브라우저의 임시 파일은 `src/renderer/` 아래에만 만듭니다.

검증 도구도 변경 파일에 포함합니다. [화면 캡처 도구](../../../../src/renderer/tools/capture-stage4-seat.mjs)와 [결함 재주입 도구](../../../../src/renderer/tools/mutate-stage4-seat.mjs)를 같은 명령으로 다시 실행할 수 있습니다.

| 항목 / 테스트 | 다시 넣은 결함 | 결과 |
|---|---|---|
| 1 / `S4-1.` | 로그인 전 칩을 표시함 | 단언 실패로 검출 |
| 1 / `S4-1.` | 교체 중 다음 보유자를 빠뜨림 | 단언 실패로 검출 |
| 2 / `S4-2.` | 시간 갱신을 멈춤 | 단언 실패로 검출 |
| 2 / `S4-2.` | 긴급 정지 중에도 시간을 셈 | 단언 실패로 검출 |
| 3 / `S4-3.` | 운영자 배정을 대표 배정으로 표시함 | 단언 실패로 검출 |
| 4 / `S4-4.` | 메모를 사실과 같은 테두리로 표시함 | 단언 실패로 검출 |
| 4 / `S4-4.` | 생략 건수를 숨김 | 단언 실패로 검출 |
| 5 / `S4-5.` | 다음 커서를 빠뜨려 첫 페이지를 다시 추가함 | 단언 실패로 검출 |
| 5 / `S4-5.` | 오래된 약속 표시를 숨김 | 단언 실패로 검출 |
| 5 / `S4-5-filters.` | 열린 약속 필터를 무시함 | 단언 실패로 검출 |
| 6 / `S4-6.` | 응답 없음 알림을 홈으로 연결함 | 단언 실패로 검출 |
| 6 / `S4-6.` | 자리와 일지 활동 아이콘을 없앰 | 단언 실패로 검출 |
| 7 / `S4-7.` | 운영자 배정과 세대 변경 안내를 없앰 | 단언 실패로 검출 |
| 7 / `S4-7.` | 서버의 메인 AI 폼을 활성화함 | 단언 실패로 검출 |
| 권한 / `S4-no-swap.` | 칩 클릭에 `settings.update`를 몰래 추가함 | 단언 실패로 검출 |
| 8 / `S4-8.` | switching fake에서 다음 보유자를 빠뜨림 | 단언 실패로 검출 |

`S4-no-swap.`은 새 화면의 버튼과 링크를 실제로 누르고 호출을 기록합니다. 같은 테스트에서 새 화면 소스의 호출도 검사합니다. 허용하는 메서드는 `seat.get`, `seat.history`, `seat.handover`, `journal.list`, 기존 `stop.emergency`뿐입니다. 명령창 초점과 기존 대상 화면으로의 이동은 renderer 안에서 처리합니다. 추가로 네 fake 상태의 실제 브리지에서 로그인 전 차단, 로그인 후 스냅샷, 조회, 정지와 해제를 검증합니다.

## 화면 확인

아래 이미지를 배율 1로 열어 문구, 줄바꿈과 메모 구분을 확인했습니다. 데스크톱은 1440×1100, 휴대폰의 긴 화면은 390×1550입니다. 평소 휴대폰 높이인 390×844의 정지 전후 캡처도 따로 남겼습니다.

| 화면 | 1440 | 390 |
|---|---|---|
| 활동 중 상단 바 | [보기](topbar-active-1440.png) | [보기](topbar-active-390.png) |
| 교체 중 상단 바 | [보기](topbar-switching-1440.png) | [보기](topbar-switching-390.png) |
| 빈 자리 | [보기](topbar-vacant-1440.png) | [보기](topbar-vacant-390.png) |
| 응답 없음 시간 표시 | [보기](unresponsive-counting-1440.png) | [보기](unresponsive-counting-390.png) |
| 긴급 정지 중 | [보기](unresponsive-stopped-1440.png) | [보기](unresponsive-stopped-390.png) |
| 자리와 세 세대 이력 | [보기](seat-history-1440.png) | [보기](seat-history-390.png) |
| 인계 꾸러미 머리말과 사실 | [보기](handover-1440.png) | [보기](handover-390.png) |
| 인계의 확인되지 않은 메모 | [보기](handover-memos-1440.png) | [보기](handover-memos-390.png) |
| 모든 일지 | [보기](journal-all-1440.png) | [보기](journal-all-390.png) |
| 약속 종류 필터, 닫힌 약속 포함 | [보기](journal-promises-1440.png) | [보기](journal-promises-390.png) |
| 열린 약속 필터, 오래됨과 확인 필요 | [보기](journal-open-1440.png) | [보기](journal-open-390.png) |

390×844: [응답 없음](unresponsive-phone-390.png), [긴급 정지 중](unresponsive-stopped-phone-390.png).

## 개발에서 재현하기

`npx vite --config vite.web.config.ts --port 5196 --strictPort`로 실행합니다. 기본 로그인 화면의 개발 모드로 들어간 뒤 칩을 누르면 됩니다.

- 기본값은 활동 중이며 응답 가능한 Claude CLI입니다.
- `?fakeSeat=unresponsive`는 4분째 응답 없는 상태입니다.
- `?fakeSeat=switching`은 Claude CLI에서 Codex CLI로 교체 중입니다.
- `?fakeSeat=vacant`는 빈 자리입니다.

## 범위와 미완료

요청한 renderer 항목은 모두 구현했습니다. 실제 서버와 CLI의 자리 교체, 에이전트 도구와 서버 PC 운영자 명령의 통합 검증은 병행 중인 backend 작업 범위입니다. `tsconfig.node.json` 검사는 수행하지 않았습니다.

자동 승인 검토가 작업용 임시 폴더와 타입 검사 캐시 삭제를 정책상 차단했습니다. 삭제는 실행되지 않았으며 `src/renderer/.stage4-test-temp`와 `src/renderer/.stage4.tsbuildinfo`가 남아 있습니다. 다른 삭제 방법으로 재시도하지 않았습니다.

수정은 `src/renderer/`와 `docs/design/permission-ui/` 안에만 했습니다. 공유 계약, main, server, preload, 인수·회귀 테스트, 패키지와 설정 파일은 수정하지 않았습니다. 패키지 설치와 git 명령, 외부 업무일지 기록은 하지 않았습니다. 인수 테스트 자체가 사용하는 임시 Git 저장소는 테스트가 실행했습니다.

검증에 사용한 5196 서버와 전용 Chrome만 종료했습니다. 5199 서버는 조작하지 않았습니다.

## 후속: 자리 이동 대상·AC-27·모델 이름

2026-11-03. 공유 `NavTarget`의 `seat`를 사용합니다. renderer의 별도 자리 대상은 없애고, 일지 질문의 답변란으로 이동하는 `question`만 확장으로 남겼습니다. 알림 제목이나 키에 관계없이 `link: { tab: 'seat' }`를 우선합니다. `navigate` 토픽도 같은 대상의 자리 화면을 엽니다. `seat-unresponsive:` 알림에는 명령 초안을 붙이지 않으며, 이전 팀원 링크가 온 경우에도 이 규칙을 유지합니다.

가짜 브리지의 기본 상태에는 '메인 에이전트가 바뀌었습니다'를 넣었습니다. `?fakeSeat=switching`에는 '메인 자리 교체가 멈췄습니다', `?fakeSeat=unresponsive`에는 '메인 에이전트 응답 없음'이 나옵니다. 세 알림 모두 공유 자리 링크를 보냅니다.

`claudeParser.ts`의 `FILE_TOOLS`, `toolCallSummary`와 하위 호출 접두어, `codexParser.ts`의 파일 변경 출력, `util.ts`의 오류 접두어를 읽어 경로 보호 범위를 정했습니다. `파일 변경:`, `파일 작성:`, `파일 수정:`, `파일 노트북 수정:`, `읽기:`, `파일 찾기:`, `내용 검색:`으로 시작하는 줄을 그대로 둡니다. `[하위] `가 붙은 줄과 Windows 절대 경로, POSIX 경로, 상대 경로, UNC 경로도 보존합니다. Codex의 파일 변경 거부 오류와 같은 오류 반복 줄도 보존합니다. 여러 줄이 섞이면 경로 줄은 그대로 두고 일반 설명의 작업 ID만 제목으로 바꿉니다.

가짜 모델 목록은 앱의 기본 카탈로그와 같은 Claude `fable`, `opus`, `sonnet`, `haiku`와 Codex `gpt-6-sol`입니다. 자리 보유자는 `opus`, Codex 교체 대상과 팀원은 `gpt-6-sol`을 사용합니다. 기존 `claude-sonnet-4-5` 지정도 `sonnet`으로 바꿨습니다.

### 변경 파일

아래 구현 경로는 `src/renderer/` 기준입니다.

| 파일 | 변경 내용 |
|---|---|
| `src/lib/seat.ts`, `src/App.tsx` | 공유 이동 타입을 사용하고 renderer의 중복 자리 대상을 제거했습니다. |
| `src/lib/notice.ts`, `src/components/ServerNotice.tsx` | 공유 자리 링크를 우선하며, 다른 알림 키나 기기 보기 동작이 이를 덮어쓰지 않게 했습니다. |
| `src/lib/displayText.ts` | CLI 파일 경로 줄을 접두어별로 보존합니다. |
| `src/api/fake/index.ts` | 세 자리 알림에 공유 링크를 붙이고 자리 변경과 교체 멈춤 알림을 추가했습니다. |
| `src/api/fake/data.ts`, `src/api/fake/seat.ts` | 기본 모델 카탈로그와 실제 가짜 선택값을 맞췄습니다. |
| `src/components/stage4-seat.test.ts`, `src/lib/displayText.test.ts` | 공유 링크 클릭, 실제 App의 이동 토픽 구독, 가짜 알림, 모델 목록과 경로 보존을 검증합니다. |
| `tools/mutate-stage4-followup.mjs` | 결함 재주입 20건을 실행하고 매번 원본 바이트를 복원합니다. |
| `tools/capture-stage4-seat.mjs` | `--models-only`로 모델 이름이 보이는 화면만 다시 저장합니다. |

문서 산출물은 이 README, [결함 재주입 결과](followup-mutation-results.json), [화면 검사 결과](followup-model-layout-audit.json), [최종 검증 기록](followup-verification.json)과 아래 PNG 11장입니다. 모델 이름이 없는 기존 PNG 13장은 변경 전후 SHA-256이 같습니다.

- 1440px: `topbar-active`, `topbar-switching`, `seat-history`, `handover`, `handover-memos`, `journal-all`, `journal-promises`, `journal-open`, `unresponsive-counting`, `unresponsive-stopped`.
- 390px: `seat-history`.

파일 이름은 위 이름에 `-1440.png` 또는 `-390.png`를 붙입니다. 실제 Chrome에서 배율 1로 촬영했습니다. 검사한 화면의 가로 넘침과 브라우저 실행 오류는 없으며, 검사한 버튼과 링크 높이는 44px 이상입니다. 상단 모델과 휴대폰의 현재 자리 모델, 인계 메모의 구분을 이미지에서도 확인했습니다.

### 테스트와 다시 넣은 결함

아래 결함 20건은 모두 실제 단언 실패로 검출했습니다. 새 테스트는 21개이며, 기존 `S4-6.`과 네 `S4-8-bridge.` 테스트도 확장했습니다. 자세한 실패 이름과 증거는 `followup-mutation-results.json`에 있습니다.

| 테스트 | 다시 넣은 결함 |
|---|---|
| `S4-followup-notice.` 9개 | 공유 자리 링크를 프로젝트 화면으로 바꿨습니다. 세 자리 알림, 키 없는 알림과 usage, execution-reset, pause-stuck, device-login, crash 키의 모든 사례가 실패했습니다. |
| `S4-followup-notice.` 기기 키 사례 | 기기 보기 동작이 자리 링크를 덮어쓰게 했습니다. |
| `S4-6.` | 응답 없음 알림에 이전 팀원 링크에서 만든 명령 초안을 붙였습니다. |
| `S4-followup-topic.` | 실제 App의 `navigate` 구독을 빈 함수로 바꿔 자리 화면이 열리지 않게 했습니다. |
| `S4-followup-path.` 파일 변경 | `파일 변경:` 보호를 제거해 경로의 작업 ID와 `main`이 바뀌게 했습니다. |
| `S4-followup-path.` 파일 작성 | `파일 작성:` 보호를 제거했습니다. AC-27의 원인이던 경로의 작업 ID 치환이 다시 발생합니다. |
| `S4-followup-path.` 파일 수정 | `파일 수정:` 보호를 제거했습니다. Edit와 MultiEdit가 쓰는 접두어입니다. |
| `S4-followup-path.` 파일 노트북 수정 | `파일 노트북 수정:` 보호를 제거했습니다. NotebookEdit가 쓰는 접두어입니다. |
| `S4-followup-path.` 읽기 | `읽기:` 보호를 제거했습니다. |
| `S4-followup-path.` 파일 찾기 | `파일 찾기:` 보호를 제거해 검색 위치가 바뀌게 했습니다. |
| `S4-followup-path.` 내용 검색 | `내용 검색:` 보호를 제거해 검색 위치가 바뀌게 했습니다. |
| `S4-followup-multiline.` | 줄별 처리를 없애 여러 줄 중간의 경로가 바뀌게 했습니다. |
| `S4-followup-permission.` 2개 | Codex 파일 변경 거부 경로 보호를 제거했습니다. 일반 오류 접두어와 같은 오류 반복 접두어 사례가 모두 실패했습니다. |
| `S4-8-bridge.` | 자리 변경, 교체 멈춤, 응답 없음 알림의 링크를 각각 null로 바꿨습니다. 별도 재주입 3건입니다. |
| `S4-followup-models.` | 보유자 `claude-opus-4-6`, 교체 대상 `gpt-5.4`, 팀원 `gpt-5`를 각각 복원하거나 카탈로그의 `fable` ID를 바꿨습니다. 별도 재주입 4건입니다. |

### 최종 검증과 남은 범위

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json --tsBuildInfoFile src/renderer/.stage4-followup-temp/web.tsbuildinfo` | 종료 0. 검사 캐시도 renderer 안에만 생성했습니다. |
| `node src/renderer/tools/check-contract.mjs` | 종료 0. 메서드 46개와 토픽 6개에서 누락이나 금지된 호출이 없습니다. |
| `npx vitest run --config src/renderer/tools/vitest.config.ts --no-cache` | 29개 파일, 275개 테스트 통과. |
| `npx vitest run tests/acceptance/flow.test.ts --no-cache` | 최종 코드로 3회 연속 각각 21개 통과, 모두 종료 0. |
| `node src/renderer/tools/mutate-stage4-followup.mjs` | 20건 모두 검출, 원본 복원 확인. |
| `node src/renderer/tools/capture-stage4-seat.mjs --models-only` | 모델 이름이 보이는 11장만 다시 촬영했습니다. |

Vitest에는 결과 캐시를 남기지 않는 `--no-cache`만 추가했습니다. 인수 테스트 자체가 쓰는 임시 Git 저장소도 `TMP`와 `TEMP`를 renderer 아래로 지정해 격리했습니다. 직접 git 명령이나 패키지 설치는 하지 않았습니다. 기존 Vite 설정 형식 안내, Node SQLite 실험 기능 안내와 테스트 저장소의 CRLF 안내는 테스트 실패가 아닙니다.

요청한 세 항목의 구현은 끝났습니다. 실제 서버와 CLI 자리 교체의 통합 검증, node 타입 검사와 다른 backend 테스트는 이번 범위에서 실행하지 않았습니다. main, server, preload, shared, 인수·회귀 테스트 원본, 패키지와 설정 파일은 수정하지 않았습니다. 업무일지는 리드가 기록합니다. 전용 5196 서버와 Chrome만 종료했고, 5196의 접속 종료도 확인했습니다. 5199는 조작하지 않았습니다.

자동 승인 검토가 renderer 안의 절대 경로를 확인한 뒤 실행하려던 임시 폴더 삭제를 `blocked by policy`로 거부했습니다. 삭제는 실행되지 않았으며 다른 방법으로 재시도하지 않았습니다. 남은 경로는 `src/renderer/.stage4-followup-temp`와 `src/renderer/.stage4-test-temp`입니다. 전자는 테스트 로그, 타입 검사 캐시와 개발 서버 캐시를 담고, 후자는 촬영용 임시 폴더입니다. 전용 Chrome 프로필은 촬영 도구가 종료하면서 제거했습니다. 요청한 구현과 검증은 모두 끝났으며, 미완료 항목은 이 임시 폴더 두 곳의 삭제뿐입니다.

## 후속 2: 설정 화면의 메인 AI·출구 문장

2026-11-03. 리드 결정 S4-25에 따라 설치 설정 저장에서 `general.mainAgent`를 제외했습니다. 기존 permission-ui 테스트의 패치 기대값에서도 이 항목을 제거했습니다. 이는 저장 계약을 바꾼 결정이며, 테스트를 약하게 만든 것이 아닙니다. 다른 설치 항목의 정확한 패치 형태는 계속 고정합니다.

메인 AI 폼은 `{ general: { mainAgent: value } }`만 저장하며, 폼이 불러온 AI를 두 번째 인자 `expected.mainAgent`로 보냅니다. 설치 설정과 별도로 저장 중 상태와 완료 안내를 관리합니다. 충돌은 기존 오류 알림으로 표시하고 자동으로 다시 저장하지 않습니다. 가짜 브리지도 AI 종류, 모델, 노력치 단계와 직접 지정값을 비교하며, 하나라도 달라졌으면 `conflict`와 지정된 안내 문구로 전체 저장을 거절합니다.

설정 화면은 자리 세대, 상태 또는 실행형 보유자의 AI가 바뀔 때 `settings.get`을 다시 읽습니다. `settings`는 새 응답으로 바꾸고 `draft`에서는 `general.mainAgent`만 갱신합니다. 작성 중인 로그인 설정, CLI 경로, 기록 보관 기간과 백업 설정을 보존합니다. 일반 스냅샷 버전 변경만으로는 다시 읽지 않습니다. 이전 조회의 응답이 늦게 도착하면 반영하지 않습니다. 메인 AI 저장에 성공했을 때도 다른 설치 입력값은 보존합니다.

S4-30의 응답 없음 배너와 메인 정지 안내는 설정 화면과 같은 판별식, `snapshot.auth.mode !== 'server' && (!window.wook || getBridge().platform !== 'web')`을 사용합니다. 데스크톱 배너는 이 PC의 운영자가 운영 설정의 메인 AI에서 바꿀 수 있다고 안내합니다. 서버 배너는 서버 PC의 운영자를 안내하며, 서버 정지 안내는 남은 프로세스 확인을 운영자에게 부탁하도록 바꿨습니다. 데스크톱의 작업 관리자 안내는 유지합니다.

### 변경 파일

아래 경로는 `src/renderer/` 기준입니다.

| 파일 | 변경 내용 |
|---|---|
| `src/lib/installationSettings.ts` | 설치 패치에서 메인 AI를 제외했습니다. |
| `src/screens/Settings.tsx` | 메인 AI 저장과 기대값을 분리하고, 자리 변경 시 다른 설치 입력값을 보존하며 다시 읽습니다. |
| `src/api/fake/index.ts` | 두 번째 저장 인자를 받고 오래된 기대값이면 전체 저장을 거절합니다. |
| `src/components/SeatStatus.tsx` | 데스크톱과 서버의 자리 변경 안내를 구분합니다. |
| `src/components/MainPauseNotice.tsx` | 서버에서는 운영자에게 프로세스 확인을 부탁하도록 안내합니다. |
| `src/components/permission-ui.test.ts` | 설치 패치 기대값을 갱신하고, 폼 저장, 자리 갱신, 입력값 보존과 모드별 문구 테스트 12개를 추가했습니다. |
| `src/components/stage4-seat.test.ts` | 시간 표시 테스트에서 공통 안내를 확인하고, 모드별 문구는 새 전용 테스트가 정확히 검증합니다. |
| `src/api/fake/settings-seat.test.ts` | 가짜 브리지의 오래된 기대값 거절과 정상 저장 테스트 5개를 추가했습니다. |
| `tools/mutate-stage4-settings.mjs` | 결함 11건을 각각 재주입하고 테스트 실패와 원본 복원을 기록합니다. |
| `tools/capture-stage4-settings.mjs` | 전용 5196 서버를 실행해 필요한 화면만 촬영하고 실제 입력, 자리 갱신과 충돌을 확인한 뒤 종료합니다. |

문서 산출물은 이 README, [결함 재주입 결과](followup2-mutation-results.json), [브라우저 검사 결과](followup2-browser-audit.json)와 아래 PNG입니다.

### 테스트와 다시 넣은 결함

수정 전에는 기존 설치 패치 기대값과 새 자리 갱신, 폼 저장, 데스크톱 배너, 서버 정지 안내, 가짜 브리지 충돌 테스트가 의도한 단언으로 실패했습니다. 수정 후 새 테스트 17개가 모두 통과했습니다. 아래 결함 11건도 각각 실제로 다시 넣어 단언 실패로 검출했고, 매번 수정 전 원본 바이트를 복원했습니다.

| 테스트 | 다시 넣은 결함 | 결과 |
|---|---|---|
| 기존 `8. operations are views…` | `installationPatch`가 `general.mainAgent`를 다시 보냄 | 검출 |
| `S4-25-form.` | 메인 AI 폼이 `expected`를 보내지 않음 | 검출 |
| `S4-25-form.` | 불러온 AI 대신 편집 중인 새 AI를 `expected`로 보냄 | 검출 |
| `S4-25-refresh.` 4개 | 자리 세대, 상태, 보유자의 모델 또는 종류가 바뀌어도 다시 읽지 않음 | 검출 |
| `S4-25-refresh.` 4개 | 자리 변경 후 `draft` 전체를 덮어써 저장하지 않은 설치 입력값을 지움 | 검출 |
| `S4-30-banner.` | 데스크톱 배너에 서버 운영자 문장을 표시함 | 검출 |
| `S4-30-banner.` | 서버 배너에 이 PC의 운영 설정 문장을 표시함 | 검출 |
| `S4-30-pause.` | 서버 정지 안내에 작업 관리자를 표시함 | 검출 |
| `S4-30-banner.` | 웹 플랫폼 조건을 빠뜨려 데스크톱 배너를 표시함 | 검출 |
| `S4-30-pause.` | 웹 플랫폼 조건을 빠뜨려 작업 관리자를 안내함 | 검출 |
| `S4-25-fake-conflict.` 4개 | 오래된 기대값을 무시하고 다른 설치 항목까지 저장함 | 검출 |

`S4-25-form.`은 저장 요청이 메인 AI 하나와 불러온 기대값만 담는지 확인합니다. 저장이 진행되는 동안 메인 폼의 버튼만 비활성화되고, 완료 안내도 메인 폼에만 나오는지 확인합니다. `S4-25-conflict.`는 공통 오류 알림의 원문, 한 번만 호출하는 동작과 성공 안내가 없는 것을 검증합니다. `S4-25-fake-save.`는 일치하는 기대값의 정상 저장과 메인 AI가 없는 설치 패치를 확인합니다.

### 검증과 화면

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json --tsBuildInfoFile "$TEMP/wook-stage4-followup2-web.tsbuildinfo"` | 종료 0. 타입 검사 캐시는 시스템 임시 폴더에 둡니다. |
| `node src/renderer/tools/check-contract.mjs` | 종료 0. 메서드 46개와 토픽 6개, 누락과 금지된 호출 없음. |
| `npx vitest run --config src/renderer/tools/vitest.config.ts --no-cache` | 30개 파일, 292개 테스트 통과. |
| `npx vitest run tests/acceptance/flow.test.ts --no-cache` | 21개 통과, 종료 0. 인수 테스트 원본은 수정하지 않았습니다. |
| `node src/renderer/tools/mutate-stage4-settings.mjs` | 결함 11건 모두 검출, 원본 복원 확인. |
| `node src/renderer/tools/capture-stage4-settings.mjs` | 실제 Chrome에서 좌석 변경, 입력값 보존, 설치 패치, 오래된 기대값 거절과 재시도 없는 동작을 확인했습니다. |

문구가 바뀐 기존 응답 없음 화면 6장만 다시 촬영했습니다. 기존 PNG 중 나머지 18장은 바이트가 같습니다. 변경된 서버 정지 안내는 새 화면 2장으로 남겼습니다. 1440px와 390px, 배율 1에서 안내가 잘리지 않고 버튼 높이가 44px 이상이며 가로 넘침이나 브라우저 실행 오류가 없는 것을 확인했습니다. 휴대폰 기본 높이인 844px의 응답 없음과 정지 중 화면도 확인했습니다.

| 화면 | 1440px | 390px |
|---|---|---|
| 응답 없음 | [보기](unresponsive-counting-1440.png) | [보기](unresponsive-counting-390.png) |
| 긴급 정지 중 | [보기](unresponsive-stopped-1440.png) | [보기](unresponsive-stopped-390.png) |
| 서버의 메인 정지 안내 | [보기](server-main-paused-1440.png) | [보기](server-main-paused-390.png) |

390×844: [응답 없음](unresponsive-phone-390.png), [긴급 정지 중](unresponsive-stopped-phone-390.png).

### 미완료와 범위

요청한 renderer 구현, 테스트와 화면 확인은 모두 끝났습니다. 실제 backend와 CLI를 연결한 자리 변경 검증과 `tsconfig.node.json` 검사는 수행하지 않았습니다. main, server, preload, shared, 인수·회귀 테스트 원본, 패키지와 설정 파일은 수정하지 않았습니다. 패키지 설치와 git 명령은 실행하지 않았으며, 업무일지는 리드가 기록합니다.

이번 테스트와 촬영의 임시 파일은 시스템 임시 폴더만 사용했습니다. 촬영용 임시 폴더는 제거했고 renderer 안에 새 임시 파일을 남기지 않았습니다. 이 후속 작업에서 실행한 5196 서버와 전용 Chrome은 종료했습니다. 5199 서버와 기존 작업의 임시 폴더는 조작하지 않았습니다.

## 후속 3: 가짜 브리지 문구·교체 중 응답 없음 띠

2026-11-03. 리드 결정 S4-37을 반영했습니다.

가짜 `settings.update`의 충돌 문구를 `AI 이름(모델 ID 또는 CLI 기본 모델, 노력치 값)` 형식으로 맞췄습니다. 노력치는 직접 지정한 값이 우선이고, 없으면 설정의 단계 연결값을 씁니다. Codex의 모델 미지정은 backend와 같이 모델 목록의 첫 항목으로 풀며, 사용할 기본 모델도 없으면 `CLI 기본 모델`로 표시합니다. Claude의 기본값 거절 문구는 아래 문자열 전체를 테스트에서 고정합니다.

> 메인 AI가 그사이 Claude CLI(CLI 기본 모델, 노력치 high)로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요

기대값 검사는 패치에 `general.mainAgent`가 있을 때만 합니다. 메인 AI가 없는 설치 패치는 오래된 기대값을 보내도 저장하며 현재 메인 AI를 보존합니다. `general` 자체가 없는 경우와 다른 일반 설정만 있는 경우를 모두 확인했습니다.

응답 없음 띠는 `seat.state === 'switching'`이면 `pendingHolder.label`을 써서 `메인 자리를 Codex CLI에게 넘기고 있습니다.`처럼 안내합니다. 이때 운영 설정이나 서버 PC의 운영자를 통한 자리 변경은 안내하지 않습니다. `stop.pausedMembers`에 `M-MAIN` 정지가 함께 있으면 `교체가 보류되어 있습니다. 메인 에이전트 정지 안내에서 정지 해제를 눌러 주세요.`를 덧붙입니다. 기존 정지 안내의 버튼을 그대로 사용하며, 응답 없음 띠의 버튼은 명령하기와 긴급 정지 두 개입니다. 교체 중이 아닐 때는 S4-30의 모드별 문장을 유지합니다. 별도의 교체 단계나 공유 필드는 추가하지 않았습니다.

### 변경 파일

구현 경로는 `src/renderer/` 기준입니다.

| 파일 | 변경 내용 |
|---|---|
| `src/api/fake/index.ts` | 충돌 문구의 모델과 노력치를 backend 형식으로 표시하고, 메인 AI 패치에만 기대값 검사를 적용합니다. |
| `src/api/fake/settings-seat.test.ts` | 정확한 거절 문자열, 모델 기본값, 노력치 연결과 직접 지정, 메인 AI가 없는 설치 패치를 검증합니다. |
| `src/components/SeatStatus.tsx` | 교체 중 다음 보유자와 보류 시 정지 해제 경로를 안내합니다. |
| `src/components/permission-ui.test.ts` | 데스크톱, 서버, 웹에서 교체 중 안내를 검증하고 기존 정지 해제 버튼을 실행합니다. |
| `tools/mutate-stage4-followup3.mjs` | 결함 10건을 하나씩 재도입하고 단언 실패를 확인한 뒤 원본 바이트를 복원합니다. |
| `tools/capture-stage4-settings.mjs` | `--switching-only`로 이번에 문구를 바꾼 상태만 촬영하고 가짜 브리지와 정지 해제 경로를 실행합니다. |

문서 변경은 이 README, [재도입 결과](followup3-mutation-results.json), [브라우저 검사 결과](followup3-browser-audit.json), [검증 기록](followup3-verification.json), 아래 PNG 8장입니다.

### 테스트와 다시 넣은 결함

새 테스트는 11개이며 기존 `S4-25-fake-conflict.` 4개의 단언도 강화했습니다. 아래 재도입 10건은 모두 실제 단언 실패로 검출했고 매번 원본 복원을 확인했습니다.

| 테스트 | 다시 넣은 결함과 검출 내용 |
|---|---|
| `S4-25-fake-conflict.` 4개 | 문구를 이전의 `AI · 모델` 형식으로 되돌려 검출했습니다. 직접 지정한 노력치를 무시하거나 Codex의 기본 모델 해석을 빠뜨리는 결함도 각각 검출했습니다. 오래된 종류, 모델, 노력치 단계, 직접 지정값은 다른 설치 항목을 포함한 패치 전체를 거절합니다. |
| `S4-37-fake-label.` | 이전 문구 형식을 검출했습니다. 연결된 노력치 대신 단계 이름을 표시하는 별도 결함도 검출했습니다. Claude 기본값의 거절 문장은 전체 문자열로 고정했습니다. |
| `S4-37-fake-codex-default.` | 이전 문구 형식으로 되돌리면 실패합니다. Codex의 모델과 기본 목록이 모두 비어 있을 때의 `CLI 기본 모델` 문구를 고정합니다. |
| `S4-37-fake-installation.` 2개 | `general.mainAgent`가 없어도 기대값을 검사하게 되돌려 두 경우 모두 실패했습니다. 기록 보관일과 일반 설정이 실제로 저장되고 메인 AI는 보존되는지 확인합니다. |
| `S4-37-switching.` 3개 | 교체 중 데스크톱에 운영 설정을 안내하는 결함과 서버에 서버 PC의 운영자를 안내하는 결함을 따로 넣어 검출했습니다. 웹도 서버용 안내를 다시 넣으면 실패합니다. 다음 보유자 대신 현재 보유자를 표시하는 결함도 검출했습니다. |
| `S4-37-held-switching.` 3개 | 보류된 교체에서 정지 해제 안내를 빼면 세 모드 모두 실패했습니다. 전역 긴급 정지가 꺼져 있어도 `M-MAIN` 정지를 읽으며, 새 버튼 없이 기존 버튼으로 `stop.release`를 한 번 호출하고 안내가 사라지는지 확인합니다. |
| `S4-37-switching-pause.` | 다른 팀원의 정지를 교체 보류로 잘못 판단하게 바꿔 검출했습니다. |

### 검증과 화면

| 검사 | 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json --tsBuildInfoFile "$env:TEMP/wook-s437-review-cLG2jX/web.tsbuildinfo"` | 종료 0. 타입 검사 캐시는 시스템 임시 폴더를 사용했습니다. |
| `node src/renderer/tools/check-contract.mjs` | 종료 0. 메서드 46개, 토픽 6개에서 누락과 금지된 호출이 없습니다. |
| `npx vitest run --config src/renderer/tools/vitest.config.ts --no-cache --configLoader runner` | 30개 파일 중 28개 통과, 테스트 301개 통과와 기존 문구 검사 2개 실패. 아래에 원인을 기록했습니다. |
| 같은 설정으로 `settings-seat.test.ts`, `permission-ui.test.ts`만 실행 | 관련 53개 모두 통과, 종료 0. |
| `npx vitest run tests/acceptance/flow.test.ts --no-cache --configLoader runner` | 21개 통과, 종료 0. 인수 테스트 원본은 수정하지 않았습니다. |
| `node src/renderer/tools/mutate-stage4-followup3.mjs` | 10건 모두 검출, 원본 복원 확인. |
| `node src/renderer/tools/capture-stage4-settings.mjs --switching-only` | 실제 Chrome에서 두 모드의 교체 중 안내, 보류 시 기존 정지 해제, 정확한 가짜 거절 문구와 설치 패치 저장을 확인했습니다. |

`--no-cache --configLoader runner`는 저장소 안에 검사 캐시나 설정 번들 임시 파일을 만들지 않기 위한 실행 옵션입니다. 촬영은 자체 5196 서버에서 했습니다. 1440×1100과 390×844, 배율 1에서 가로 넘침과 문구 잘림이 없고 검사한 버튼 높이는 44px 이상입니다. 브라우저 실행 오류도 없습니다. 아래 이미지를 열어 줄바꿈과 기존 정지 해제 버튼을 확인했습니다.

| 새로 확인한 상태 | 1440px | 390px |
|---|---|---|
| 데스크톱 교체 중 | [보기](unresponsive-switching-desktop-1440.png) | [보기](unresponsive-switching-desktop-390.png) |
| 서버 교체 중 | [보기](unresponsive-switching-server-1440.png) | [보기](unresponsive-switching-server-390.png) |
| 데스크톱 교체 보류 | [보기](unresponsive-held-switching-desktop-1440.png) | [보기](unresponsive-held-switching-desktop-390.png) |
| 서버 교체 보류 | [보기](unresponsive-held-switching-server-1440.png) | [보기](unresponsive-held-switching-server-390.png) |

기존 PNG 26장에 담긴 상태는 이번 수정으로 문구가 바뀌지 않아 다시 촬영하지 않았습니다. 모두 작업 시작 때와 바이트가 같습니다. 기존 교체 중 상단 바 이미지는 응답 없음 시각이 없는 상태이므로 그대로 두었습니다.

### 미완료와 범위

전체 renderer 검사의 통과 조건은 달성하지 못했습니다. `src/api/fake/copy.v35.test.ts`는 기존 `src/api/fake/seat.ts`의 `메뉴`를 금지어로 잡고, `src/studio/copy.v34.test.ts`는 같은 파일의 `보고가 도착`을 잡습니다. 두 검사와 해당 가짜 일지 파일은 작업 시작 때와 SHA-256이 같습니다. 두 검사만 따로 실행해도 같은 실패가 재현됩니다. 이번 두 수정과 관계없는 일지 문구나 기존 검사는 변경하지 않았습니다. 해시와 실제 실패 출력은 검증 기록에 남겼습니다.

요청한 두 항목의 구현, 관련 테스트, 결함 재도입과 브라우저 확인은 끝났습니다. 실제 backend와 CLI를 연결한 자리 교체 검증 및 `tsconfig.node.json` 검사는 수행하지 않았습니다. backend 테스트 실패는 관찰하지 않았습니다.

수정은 `src/renderer/`와 `docs/design/permission-ui/` 안에서만 했습니다. main, server, preload, shared, 인수·회귀 테스트 원본, 패키지와 설정 파일은 수정하지 않았습니다. 패키지 설치와 git 명령은 실행하지 않았습니다. 인수 테스트 자체는 시스템 임시 폴더에 만든 Git 저장소를 사용합니다. 외부 업무일지는 리드가 기록합니다.

이번 작업의 테스트 임시 파일과 브라우저 프로필은 시스템 임시 폴더에 두고 제거했습니다. 저장소 안에 새 임시 파일은 남기지 않았습니다. 자체 5196 서버와 전용 Chrome은 종료했고 5196의 수신 프로세스가 없는 것을 확인했습니다. 5199 서버와 다른 작업의 프로세스 및 임시 폴더는 조작하지 않았습니다.
