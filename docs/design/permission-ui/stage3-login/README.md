# 서버 3단계 로그인 화면

2026-10-30. 서버 로그인, 대표 이메일 설정, 로그인한 기기 목록을 추가했습니다. 대표의 팀 운영 권한은 늘리지 않았습니다. 기본 데스크톱 로그인은 기존 화면을 사용합니다. 오크색 배경과 세이지색 프레임을 이어 썼습니다.

먼저 [로그인과 설정](../../../../src/renderer/src/components/ServerLogin.tsx), [기기 목록](../../../../src/renderer/src/components/DeviceList.tsx), [행동 테스트](../../../../src/renderer/src/components/stage3-login.test.ts)를 보면 됩니다.

## 항목별 결과

구현 경로는 `src/renderer/src/` 기준입니다.

| 항목 | 동작 | 변경 파일 |
|---|---|---|
| 1. 서버 로그인 | `auth.mode === 'server'`에서 기기 코드를 발급합니다. 브라우저에서 기기 이름을 짐작해 전달합니다. 큰 코드, 복사, Google 주소, 남은 시간과 지정된 피싱 경고를 표시합니다. 이전 요청이 끝난 뒤 현재 `intervalSec`만큼 기다리고 폴링합니다. 서버가 보낸 유효한 간격은 다음 요청부터 유지합니다. 성공하면 인증 상태를 다시 읽습니다. 거절, 만료, 오류와 요청 실패에는 메시지와 다시 시작을 표시합니다. 화면을 벗어나면 타이머를 정리합니다. | `components/ServerLogin.tsx`, `App.tsx`, `api/store.ts`, `styles/app.css` |
| 2. 대표 이메일 설정 | `setupRequired`를 로그인 방식보다 먼저 확인합니다. 8자리 설정 코드와 대표 이메일만 받습니다. 코드 출처 문장은 요청한 원문을 사용합니다. 저장 결과에 따라 로그인 화면으로 넘어가며, 실패하면 입력값과 서버 메시지를 유지합니다. Google 클라이언트 설정은 표시하지 않습니다. | `components/ServerLogin.tsx`, `App.tsx` |
| 3. 기기 | 운영 설정의 계정 영역에 이름, Tailscale 사용자, 마지막 사용, 만료와 `이 기기` 표시를 둡니다. 확인한 뒤 기기를 끊으며, 이 기기라면 화면도 로그아웃합니다. 데스크톱도 `auth.listDevices`를 호출하고 지정된 안내 한 줄만 보입니다. 서버 fake에서는 설치 설정을 직접 바꾸는 길을 잠그고 운영자 안내를 표시합니다. | `components/DeviceList.tsx`, `screens/Settings.tsx`, `App.tsx` |
| 4. 새 기기 알림 | `device-login:`을 기존 알림 목록에서 표시합니다. `로그인한 기기 보기`는 계정 영역의 목록으로 이동하고 그곳에 초점을 둡니다. 메인 명령 바로가기를 만들지 않습니다. 서버 본문을 그대로 보입니다. | `lib/notice.ts`, `components/ServerNotice.tsx`, `App.tsx`, `screens/Settings.tsx` |
| 5. 가짜 브리지 | 다섯 메서드를 구현했습니다. 서버 모드, 설정 코드의 일회 사용, 시간에 따른 로그인 결과, 현재 기기가 있는 목록, 끊기와 로그아웃을 메모리에서 재현합니다. 기본 모드는 데스크톱입니다. | `api/fake/index.ts`, `api/fake/serverAuth.ts` |

로그인 성공의 `wook:authorized` 이벤트는 스냅샷도 다시 읽습니다. 따라서 앞서 이 기기를 끊어서 잠긴 화면에서도 재로그인 후 작업실로 돌아옵니다. 기기 목록은 스냅샷이 갱신되면 다시 읽습니다. Tailscale 사용자 정보가 없는 기기는 `사용자 정보 없음`으로 보입니다.

설정 분류에는 기존 계약의 `account`를 사용했습니다. 서버에서는 이름을 `계정과 기기`로 보이고, 데스크톱의 `설치 설정` 이름은 유지했습니다. 별도의 공유 내비게이션 계약은 추가하지 않았습니다.

## 가짜 화면 재현

`npx vite --config vite.web.config.ts --port 5196 --strictPort`로 실행한 화면에서 다음 주소를 사용합니다. Google 사이트의 실제 인증은 실행하지 않습니다.

| 주소 | 상태 |
|---|---|
| `http://127.0.0.1:5196/` | 기존 데스크톱 로그인 |
| `http://127.0.0.1:5196/?fakeMode=server` | 서버 로그인. 시작 후 12초가 지나면 성공 |
| `http://127.0.0.1:5196/?fakeMode=server&fakeLogin=pending` | 코드가 만료될 때까지 대기 |
| `http://127.0.0.1:5196/?fakeMode=server&fakeLogin=slow` | 두 번째 폴링에서 한 번만 7초 간격을 전달. 이후에도 7초 간격을 유지하다 성공 |
| `http://127.0.0.1:5196/?fakeMode=server&fakeLogin=denied` | 시작 후 6초가 지나면 대표 계정 불일치로 거절 |
| `http://127.0.0.1:5196/?fakeMode=server&fakeLogin=expired` | 6초 뒤 만료 |
| `http://127.0.0.1:5196/?fakeMode=server&fakeLogin=error` | 6초 뒤 연결 오류 |
| `http://127.0.0.1:5196/?fakeMode=server&fakeSetup=1` | 초기 설정. 시험 코드는 `BCDX2345`, 이메일은 올바른 형식의 주소 |

서버 fake는 개발용 메모리 상태이며 새로고침하면 초기화됩니다. 서버용 설정 코드나 기기 세션을 localStorage에 쓰지 않습니다. 목록에 다른 기기 한 대와 로그인한 현재 기기를 준비합니다. 알림에도 다른 기기의 이름, Tailscale 사용자와 시각을 넣었습니다.

## 검사 결과

| 실행 | 결과 |
|---|---|
| `npx tsc --noEmit -p tsconfig.web.json` | 오류 0, 종료 0 |
| `node src/renderer/tools/check-contract.mjs` | 메서드 42개와 토픽 6개. 가짜 구현, 화면 호출, 토픽 누락과 금지 호출 없음. 종료 0 |
| `npx vitest run --config src/renderer/tools/vitest.config.ts` | 28개 파일, 235개 테스트 통과 |
| `npx vitest run tests/acceptance/flow.test.ts` | 21개 테스트 통과. Studio와 MemberPanel의 기존 흐름 포함 |
| `node src/renderer/tools/mutate-stage3-login.mjs` | 변이 9개를 모두 단언 실패로 검출. 매번 원본 바이트 복원 확인 |
| `node src/renderer/tools/capture-stage3-login.mjs` | 1440×1000과 390×844에서 8장 촬영. 가로 넘침 없음. 새 화면 컨트롤 높이 44px 이상 |

초기 작업에서 추가한 테스트는 `components/stage3-login.test.ts`의 17개입니다. 코드 발급, 정확한 경고, 복사, 폴링 간격과 요청 중복 방지, 인증 새로 읽기, 세 종료 상태, 로컬 만료, 설정 오류와 성공, 기기 목록과 확인, 현재 기기 로그아웃, 두 데스크톱 모드, 서버 fake의 설치 설정 차단, 알림 이동, 실제 fake의 시간 경과와 설정을 검사합니다. 기존 `components/permission-ui.test.ts`의 원격 설정 안내 단언도 현재 운영자 문구로 갱신했습니다. 브라우저를 띄우는 도구와 변이 도구는 `src/renderer/tools/`에 있습니다.

| 항목 | 다시 넣은 버그 | 실패한 테스트 |
|---|---|---|
| 1 | 다른 사람이 보낸 코드도 사용할 수 있다고 경고를 바꿈 | `S3-login-code.` |
| 1 | 시작한 로그인과 다른 ID를 폴링함 | `S3-login-poll.` |
| 1 | 거절, 만료, 오류의 서버 메시지를 버림 | `S3-login-terminal.` |
| 2 | 설정 코드와 이메일의 인자 순서를 뒤집음 | `S3-setup.` |
| 3 | 현재 기기의 표시를 없앰 | `S3-devices.` |
| 3 | 끊기 확인을 생략함 | `S3-devices.` |
| 3 | 현재 기기를 끊어도 화면을 로그아웃하지 않음 | `S3-current-device.` |
| 3 | 데스크톱의 기기 목록 호출을 생략함 | `S3-desktop.` |
| 4 | 새 기기 알림을 프로젝트와 명령 초안으로 돌림 | `S3-device-notice.` |

실패 단언은 [mutation-results.json](mutation-results.json)에 있습니다. [layout-audit.json](layout-audit.json)은 화면 너비, 컨트롤 높이, 코드 크기와 실제 브라우저 행동을 기록합니다. 캡처 도구는 코드 복사, 설정 저장 후 전환, 거절 후 다른 코드로 재시작, 알림의 목록 이동과 초점, 끊기 취소, 현재 기기 끊기와 재로그인, 기본 데스크톱 화면을 확인합니다. 코드와 설정 화면의 버튼은 44~48px이며 휴대폰 코드는 약 32px입니다.

Vite와 Vitest는 기존 설정의 ESM 로딩 안내를 출력했습니다. 인수 테스트의 SQLite 실험 기능 안내도 있었으며 검사 결과에는 영향이 없었습니다. 설정 파일은 수정하지 않았습니다.

## 화면 확인

8장 모두 배율 1로 촬영하고 원본 해상도로 열었습니다. 코드와 안내가 휴대폰에서 읽히는지, 버튼과 기기명이 잘리지 않는지 확인했습니다. 로그인 안내는 `로그인을 마치면 작업실로 이동합니다`로 다듬었습니다.

| 화면 | 1440 | 390 |
|---|---|---|
| 기기 코드 | [device-code-1440.png](device-code-1440.png) | [device-code-390.png](device-code-390.png) |
| 초기 설정 | [setup-1440.png](setup-1440.png) | [setup-390.png](setup-390.png) |
| 로그인한 기기 | [devices-1440.png](devices-1440.png) | [devices-390.png](devices-390.png) |
| 대표 계정 불일치로 거절 | [denied-1440.png](denied-1440.png) | [denied-390.png](denied-390.png) |

## 후속: 확인 간격

2026-11-02. 추가된 `DeviceLoginPoll.intervalSec`를 반영해 계약 공백을 해결했습니다. `pending` 응답의 값이 1~60초이면 응답이 끝난 뒤 그만큼 기다렸다가 다음 요청을 보냅니다. 다른 유효한 값이 올 때까지 그 간격을 유지합니다. 값이 없거나 범위를 벗어나면 현재 간격을 유지합니다. 소수도 범위 안이면 허용하고, `NaN`과 무한대는 무시합니다. 응답을 기다리는 동안 새 요청을 보내지 않습니다.

`?fakeMode=server&fakeLogin=slow`는 로그인 시도마다 두 번째 폴링에서만 `intervalSec: 7`을 보냅니다. 실제 fake와 화면을 연결한 테스트에서 시작 후 2초, 4초, 11초, 18초에 요청이 나가고 마지막에 성공하는 것을 확인했습니다.

`components/stage3-login.test.ts`에 14개 테스트를 추가했습니다. 간격 유지와 재변경, 값 누락과 범위 밖 값, 경계값 1초와 60초, 소수, 느린 응답과 요청 중복 방지, fake의 일회성 변경과 로그인 성공을 검사합니다. 수정 전에는 추가한 14개가 모두 실패했고, 수정 후에는 이 파일의 31개가 모두 통과했습니다.

| 다시 넣은 버그 | 실패한 테스트 | 결과 |
|---|---|---|
| `intervalSec`를 무시하고 시작 간격을 사용 | `S3-login-interval.` | 실패 1개로 검출 |
| 바뀐 간격을 한 번만 쓰고 시작 간격으로 복귀 | `S3-login-interval.` | 실패 1개로 검출 |
| 범위 검사를 없애 0.5초와 61초도 수용 | `S3-login-interval-range.` | 실패 2개로 양쪽 범위 위반 검출 |

`node src/renderer/tools/mutate-login-interval.mjs`로 세 변이를 재현합니다. 매번 원본 바이트를 복원하고 임시 폴더를 삭제합니다. 실행 결과와 실패 단언은 [interval-mutation-results.json](interval-mutation-results.json)에 있습니다.

후속 검증은 타입 오류 0개, 계약 검사 종료 0, renderer 28개 파일의 235개 테스트와 인수 테스트 21개 통과입니다. 타입 검사는 위 명령에 `--tsBuildInfoFile src/renderer/.interval-test-temp/tsconfig.web.tsbuildinfo`를 붙여 기존 빌드 캐시를 건드리지 않았습니다. 후속 테스트의 임시 파일은 `src/renderer/.interval-test-temp`에 모아 검증 후 삭제했습니다. 개발 서버는 실행하지 않았습니다.

## 미완료와 범위

실제 원격 브리지와 Tailscale, Google, 쿠키 전송의 통합 검증은 서버 8단계 범위입니다. 이번에는 화면과 실제 fake의 브라우저 동작을 검증했습니다. 화면이 기기 토큰을 직접 다루지 않습니다.

변경은 `src/renderer/`와 `docs/design/permission-ui/` 안에 있습니다. `src/main`, `src/server`, `src/preload`, `src/shared`, 인수 및 회귀 테스트, 패키지와 설정 파일은 직접 수정하지 않았습니다. git 명령, 패키지 설치, 외부 업무일지 기록은 하지 않았습니다. 지정된 인수 테스트 내부에서는 임시 저장소의 Git 동작을 검증합니다. 테스트와 브라우저의 임시 경로는 `src/renderer/.stage3-test-temp` 안입니다.

5196 개발 서버와 캡처용 Chrome은 이 작업에서 시작한 것만 종료했습니다. 5199 서버는 조작하지 않았습니다.
