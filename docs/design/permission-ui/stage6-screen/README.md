# 서버 6단계 화면 검증

S6-12의 1~6항을 구현했습니다. 대표는 상단 표시와 `자리와 인계 > 화면 조작`에서 서버 PC의 상태, 멈춘 이유, 최근 캡처와 동작 기록을 봅니다. 요청은 기존 명령창에 적고, 긴급 정지는 기존 상단 버튼을 사용합니다.

기준은 리드의 `LEAD-DECISIONS.md` S6-0~18, `S6-contract.md`, `screens-contract.md`의 §12와 파일 위치 설명입니다. 화면 구현은 `src/shared`의 계약을 그대로 사용합니다.

## 변경 파일

아래 경로는 `src/renderer/`를 기준으로 합니다.

| 파일 | 변경 내용 |
|---|---|
| `src/App.tsx` | 상단 칩, 화면 패널 이동, 같은 패널을 다시 여는 방문 번호, 스타일 연결 |
| `src/components/ScreenStatus.tsx` | 로그인과 조작 상태에 따른 칩 표시, 멈춘 이유와 종료 예정 시각 |
| `src/screens/Seat.tsx` | 세 번째 탭과 화면 패널, 화면 보기 확인의 결과 설명 |
| `src/screens/SeatScreenControl.tsx` | 서버 PC 상태, 캡처 열기와 닫기, 동작 기록, 보관 여부 확인, 폴링 정리 |
| `src/lib/screens.ts` | 멈춤 사유, 화면 보기 확인 결과, 입력한 글의 가림 처리 |
| `src/lib/notice.ts` | 자리 알림에 들어 있는 `panel` 유지 |
| `src/styles/screen.css` | 기존 색과 글꼴을 따르는 패널, 390px에서 줄바꿈하는 상단 표시 |
| `src/components/ActivityMarker.tsx` | `screen` 종류의 모니터 아이콘과 접근 가능한 이름 |
| `src/screens/Studio.tsx` | 활동 종류의 한국어 이름 표시. M-MAIN의 기존 메인 에이전트 표시는 유지 |
| `src/screens/Settings.tsx` | 화면 도구와 작업 개체 도우미 준비 상태 |
| `src/screens/Home.tsx`, `src/components/MemberPanel.tsx` | `screen_check`의 현재 작업을 `화면 확인`으로 표시 |
| `src/api/fake/index.ts` | `devParam('fakeScreen')` 연결, 두 조회 메서드, 로그인 보호, 준비 상태와 활동 예제 |
| `src/api/fake/seat.ts` | `SeatView.screen`과 화면 시나리오 연결 |
| `src/api/fake/screens.ts` | 모든 GuiResult, 두 세대, 보관 중과 보관 종료 캡처, 입력 가림 예제 |
| `src/api/fake/screenPng.ts` | 생성한 PNG 데이터 URL과 SHA-256 |
| `src/components/stage6-screen.test.ts` | 상태와 기록, 이미지 요청, 알림 이동, 폴링 수명, fake 조회 검사 |
| `src/components/stage4-seat.test.ts` | S4-no-swap을 화면 패널과 칩까지 확장 |
| `tools/generate-stage6-png.mjs` | 실제 화면을 읽지 않고 픽셀과 PNG 청크를 만드는 생성기 |
| `tools/mutate-stage4-seat.mjs` | 기존 mutation 도구에 `--stage6` 진입점 추가 |
| `tools/mutate-stage6-screen.mjs` | 결함을 하나씩 넣고 단언 실패를 확인한 뒤 원본 바이트 복원 |
| `tools/capture-stage6-screen.mjs` | 5196 개발 서버와 전용 headless Chrome으로 앱 페이지 촬영 및 실제 React 동작 확인 |

이 폴더에는 README, PNG 예제, 화면 캡처, `mutation-results.json`, `browser-audit.json`을 둡니다.

## 구현 결정과 이유

- 멈춤 상태를 조작 중보다 먼저 표시합니다. `operatingSince`가 남아 있어도 `paused`가 있으면 멈춘 주체와 `until`을 보여 줍니다. 화면이 임의로 멈춤을 해제하거나 재개를 약속하지 않습니다.
- 로그인 전과 조작하지 않는 동안에는 상단 칩을 숨깁니다. 멈춤만 남은 상태는 이유를 알 수 있도록 칩을 유지합니다. 칩은 화면 패널로만 이동합니다.
- 화면 도구를 쓸 수 없으면 서버의 `unavailable.text`를 그대로 보여 줍니다. 화면 보기 `unknown`은 미확인과 그 이유를, `failed`는 이미지 대신 창과 좌표의 글 정보만 받는다는 결과를 설명합니다. 자리 탭과 화면 탭에 같은 문구를 씁니다.
- 캡처 목록은 이미지 없는 기록으로 먼저 표시합니다. 대표가 보기를 누르면 열린 캡처 위치로 스크롤하고 `screens.image`를 호출합니다. `kept=false`인 항목과 동작의 전후 링크에는 보기 버튼을 만들지 않습니다. 현재 캡처 목록에 없는 ID도 요청하지 않습니다.
- `kept=false`에는 만료뿐 아니라 파일 누락과 해시 불일치도 포함됩니다. 계약에 원인 구분이 없으므로 삭제로 단정하지 않고 `보관 기간이 지났거나 파일을 확인할 수 없습니다.`로 안내합니다. S6-12의 보관 종료 안내와 screens-contract §12의 파일 확인 실패 안내를 함께 담았습니다.
- 폴링에서 열린 캡처의 보관 종료를 확인하면 이미지 컴포넌트를 즉시 제거합니다. 닫거나 제거한 컴포넌트는 늦게 온 이미지 응답을 적용하지 않습니다. 서버가 이미지를 `null`로 돌려주면 파일을 확인할 수 없다는 안내를 보여 줍니다.
- 입력한 글은 `text`가 있고 `secret_blocked`가 아니며 포커스가 암호 칸이 아니라고 확인된 경우에만 표시합니다. 그 밖에는 `가림 · n자`를 표시합니다. 이는 서버의 가림 처리에 더해 암호 칸과 알 수 없는 포커스의 글도 숨기는 선택입니다.
- 기록은 최근 동작 최대 100건을 보여 줍니다. 시간, 실제 픽셀 좌표, 버튼과 횟수, 스크롤 값, 키, 글, 포커스, 결과, 상세 설명, 전후 캡처를 포함합니다. 최근 캡처 목록은 계약이 반환하는 목록을 사용합니다.
- 패널을 마운트할 때 한 번 읽고, 패널과 브라우저 페이지가 보이며 `operatingSince`가 있을 때만 5초마다 읽습니다. 스냅샷 객체 자체는 effect 의존성에 넣지 않습니다. 세대가 바뀌면 이전 요청을 무시하고 새 기록을 읽습니다.
- `panel`을 알림, navigate 토픽, App, 자리 화면까지 전달합니다. 같은 화면으로 다시 오는 알림도 해당 패널을 열도록 방문 번호를 사용합니다.
- 390px에서는 칩을 상단의 두 번째 줄에 둡니다. 멈춘 이유와 종료 예정 시각을 줄여 숨기지 않도록 헤더 높이를 실제 내용으로 정합니다.
- S4-no-swap에 `screens.recent`와 `screens.image`만 추가했습니다. S6-12가 정한 보기 권한의 확장입니다. 기존 자리 읽기, 명령창 초점 이동과 긴급 정지 제한을 유지하며, 별도의 화면 시작과 멈춤 버튼도 검사에서 거부합니다.
- fake 시나리오는 `?fakeScreen=operating|human|local|locked|desktop`입니다. 주소 표시는 `devParam`으로만 읽습니다. PNG는 도형을 픽셀로 그린 640×360 예제이며 실제 PC의 캡처가 아닙니다. [생성한 PNG](generated-preview.png)의 바이트와 메타데이터를 테스트합니다.

## 새 컨트롤의 접근 가능한 이름

| 위치 | 이름 | 동작 |
|---|---|---|
| 상단 칩 | `화면 조작 중` | 화면 패널 열기 |
| 멈춤 칩 | `화면 조작 멈춤 — 서버 PC 앞 사람 입력 · {종료 예정 시각}까지` 또는 `화면 조작 멈춤 — 서버 PC의 멈춤 단축키 · {종료 예정 시각}까지` | 화면 패널 열기 |
| 세 번째 탭 | `화면 조작` | `screen-panel` 보기 |
| 캡처 목록 | `캡처 {SC-ID} 보기` | 보관 중인 캡처 열기 |
| 열린 캡처 | `캡처 닫기` | 이미지 보기 닫기 |
| 동작 기록 | `{GA-ID} 전 캡처 {SC-ID} 보기`, `{GA-ID} 후 캡처 {SC-ID} 보기` | 해당 캡처 열기 |

활동 아이콘의 접근 가능한 이름은 `화면 조작`입니다. 이 아이콘은 컨트롤이 아닙니다. 새 버튼은 화면 입력이나 도우미 실행을 요청하지 않습니다.

## 테스트와 재주입한 결함

테스트는 `src/components/stage6-screen.test.ts`에 있습니다. S4-no-swap은 기존 파일을 확장했습니다. mutation 도구는 구문 오류나 실행 오류를 성공으로 세지 않고, 종료 코드 1과 실제 단언 실패를 함께 확인합니다.

| 테스트 이름 | 다시 넣어 검출하는 결함 |
|---|---|
| `S6-chip-hidden` | 로그인 전 또는 조작하지 않는 동안 칩을 표시함 |
| `S6-chip-paused` | 사람 입력과 멈춤 단축키 상태를 조작 중으로 표시함 |
| `S6-chip-route` | 실제 App의 칩 콜백에서 `panel: 'screen'`을 빠뜨림 |
| `S6-unavailable` | 상태 영역에서 화면 도구를 쓸 수 없는 이유를 빼버림. 다른 영역에 반복된 문구로 통과하지 않도록 상태 영역만 검사 |
| `S6-vision` | `unknown` 또는 `failed`를 확인됨으로 표시함 |
| `S6-typed` | 차단된 글이나 암호 칸의 글을 노출함, 가린 글자 수를 빼버림 |
| `S6-kept` | 보관 종료 이미지 요청, 보관 종료 항목의 보기 버튼, 보관 종료 후 열린 이미지 유지, 열린 캡처로 스크롤하지 않음 |
| `S6-image-late` | 닫은 캡처의 늦은 응답으로 컴포넌트 상태를 바꿈. 비동기 응답이 끝날 때까지 확인 |
| `S6-poll` | 닫은 뒤 타이머 유지, 조작하지 않거나 페이지가 숨겨졌는데 조회, 스냅샷 객체 교체마다 재조회 |
| `S6-panel-close` | 다른 내부 탭에서도 화면 패널을 마운트해 둠 |
| `S6-notice` | 알림 표시 또는 navigate 처리에서 패널을 빠뜨림. 같은 패널 재방문도 확인 |
| `S6-records` | 실제 좌표 대신 고정 좌표를 표시함. 모든 결과 이름, 두 세대, 키와 전후 캡처 연결도 검사 |
| `S6-view-controls` | 보기 패널에 별도의 화면 멈춤 버튼 추가. 모든 새 버튼과 기록 링크의 이름과 호출 범위 검사 |
| `S4-no-swap` | 화면 칩에 설정 쓰기 추가 또는 화면 패널에 다른 조작 메서드 추가 |
| `S6-prereqs` | 화면 도구 또는 작업 개체 도우미의 준비 상태를 빼버림 |
| `S6-activity` | `screen` 활동의 모니터 아이콘과 접근 가능한 이름 누락 |
| `S6-activity-labels` | 홈, 스튜디오 또는 설정 기록에서 화면 조작 라벨 누락. 스튜디오의 M-MAIN 이름도 검사 |
| `S6-work-label` | 홈 또는 팀원 상세에서 화면 확인 대신 내부 작업 이름 표시 |
| `S6-fixtures` | 비밀 입력 차단 예제 누락. 모든 결과, 두 세대, 보관 상태, 페이지 커서, PNG 헤더와 압축 데이터, 해시도 검사 |
| `S6-fake-bridge` | `fakeScreen` 주소 표시를 읽지 않음. 다섯 상태의 실제 fake 조회와 로그인 전 두 메서드 거부도 검사 |

처음 mutation 실행에서 이유 문구 누락, 늦은 이미지 응답, 정리하지 않은 타이머를 놓쳤습니다. 상태 영역을 직접 검사하고, 비동기 응답이 끝날 때까지 기다리며, 정리 후 타이머 개수도 확인하도록 테스트를 보강했습니다.

## 검증 결과

최종 실행 결과는 아래 표에 기록합니다. 모든 vitest 실행과 긴 명령은 리드의 `vt.sh`를 통과합니다. 명령은 한 번에 하나씩 실행하며 mutation도 순서대로 실행합니다.

| 검사 | 결과 |
|---|---|
| 웹 TypeScript | 종료 0 |
| check-contract | 종료 0. 메서드 48개, 누락과 금지된 화면 호출 없음 |
| Renderer vitest | 33개 파일, 437개 테스트 통과 |
| `tests/acceptance/flow.test.ts` | 21개 테스트 통과, 종료 0 |
| mutation | 결함 36건 모두 실제 단언 실패로 검출. 원본 바이트 복원 확인. [결과](mutation-results.json) |
| headless Chrome | 1440×1100과 390×1100에서 16장 촬영. 가로 넘침, 44px 미만 버튼, 브라우저 오류 없음. 실제 React에서 보관 종료 이미지 제거와 패널 종료 후 폴링 중단, 알림의 화면 패널 이동 확인 |

재현 명령의 `VT`는 `C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/vt.sh`입니다.

```sh
bash "$VT" -- npx tsc --noEmit -p tsconfig.web.json --tsBuildInfoFile "$TEMP/wook-stage6-web.tsbuildinfo"
node src/renderer/tools/check-contract.mjs
bash "$VT" run --config src/renderer/tools/vitest.config.ts --configLoader runner --no-cache
bash "$VT" run tests/acceptance/flow.test.ts --configLoader runner --no-cache
bash "$VT" -- node src/renderer/tools/mutate-stage4-seat.mjs --stage6
bash "$VT" -- node src/renderer/tools/capture-stage6-screen.mjs
node src/renderer/tools/generate-stage6-png.mjs
```

TypeScript 캐시와 Chrome 프로필, Vite 캐시는 시스템 임시 폴더에 둡니다. `--configLoader runner --no-cache`는 설정 번들과 테스트 캐시를 저장소에 남기지 않기 위한 옵션입니다. mutation 도구의 `--retry-failed`는 아직 검출하지 못한 결함과 새로 추가한 결함만 다시 실행하며, 앞서 검출한 결함의 증거를 유지합니다.

## 화면

아래 이미지는 앱 페이지를 headless Chrome으로 촬영한 것입니다. 1440×1100과 390×1100, 배율 1에서 확인합니다. [브라우저 검사 기록](browser-audit.json)에 캡처별 표시 문구, 버튼 높이와 가로 폭을 남깁니다.

| 화면 | 1440px | 390px |
|---|---|---|
| 조작 중 | [보기](screen-operating-1440.png) | [보기](screen-operating-390.png) |
| 서버 PC 앞 사람 입력으로 멈춤 | [보기](screen-human-1440.png) | [보기](screen-human-390.png) |
| 서버 PC의 멈춤 단축키 | [보기](screen-local-1440.png) | [보기](screen-local-390.png) |
| 서버 PC 잠김 | [보기](screen-locked-1440.png) | [보기](screen-locked-390.png) |
| 데스크톱 모드 | [보기](screen-desktop-1440.png) | [보기](screen-desktop-390.png) |
| 생성한 캡처 열기 | [보기](capture-open-1440.png) | [보기](capture-open-390.png) |
| 입력 글 가림 기록 | [보기](action-secret-1440.png) | [보기](action-secret-390.png) |
| 두 준비 상태 | [보기](settings-prereqs-1440.png) | [보기](settings-prereqs-390.png) |

## 범위와 남은 일

S6-12의 구현과 fake 검증이 범위입니다. 실제 화면 도우미, 실제 화면 캡처, 입력 주입과 실제 CLI의 화면 보기 능력은 실행하지 않았습니다. backend 연결과 실제 서버 PC 검증은 해당 담당의 범위입니다.

요청한 S6-12 항목에 남은 구현은 없습니다. 계약 수정이 필요한 항목도 없습니다. 이 작업에서는 허용된 renderer 파일과 이 문서 폴더만 수정했습니다. 외부 Obsidian 업무일지는 이번 작업의 파일 소유권과 쓰기 제한에 따라 기록하지 않았으며, 리드의 기록에 합칠 수 있도록 이 문서에 결과를 남깁니다.

직접 시작한 5196 서버와 전용 headless Chrome을 종료했습니다. 촬영용 임시 폴더와 브라우저 프로필을 제거했습니다. 5199와 다른 작업의 프로세스는 조작하지 않았습니다.
