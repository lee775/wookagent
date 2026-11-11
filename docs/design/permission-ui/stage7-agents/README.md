# 서버 7단계 외부 에이전트 화면

대표는 외부 에이전트의 메인 자리와 연결 상태, 등록 목록을 확인합니다. 등록·접근 철회·자리 배정은 서버 PC 운영자의 권한입니다. 기존 색, Pretendard와 자리 화면의 섹션 구성을 유지했습니다.

기준은 `LEAD-DECISIONS.md` S7-0~14와 `S7-contract.md`입니다. `src/shared` 계약을 그대로 사용했고, 서버 구현과 독립적으로 fake bridge에서 검증했습니다.

## 요청 항목별 구현과 결정

| 항목 | 반영 내용과 이유 |
|---|---|
| 1. 실행 주체 | 상단 칩, 현재 자리, 다음 보유자, 자리 이력과 인계에 외부 에이전트 유형을 붙였습니다. M-MAIN의 현재 AI 설명은 최신 `snapshot.seat.holder`를 사용합니다. 이전 CLI의 모델·노력치·변경 예정 설정은 표시하지 않습니다. 세션은 `aiKind`, 턴은 `runner`로 각 행의 실행 주체를 표시합니다. 과거 CLI 행도 자기 주체를 유지합니다. |
| 2. 연결 | `agents.list`의 `connected`와 `lastSeenAt`을 읽습니다. 접근 철회와 긴급 정지는 오래된 `connected=true`보다 우선합니다. 연결 해제에는 마지막 접속 시각을, 접속 이력이 없으면 `접속 기록 없음`을 표시합니다. 응답 없음의 시작 시각과 사유는 기존 자리 정보에서 가져옵니다. 외부의 active 자리는 `자리 보유 중`으로 표시해 연결·활동과 혼동하지 않게 했습니다. |
| 3. 목록 | `자리와 인계` 탭에서 현재 자리 아래에 `등록된 외부 에이전트` 섹션을 배치했습니다. 이름, ID, 등록 시각, 접근 권한과 철회 시각, 마지막 접속, 보유·교체 대기 여부와 연결을 보여 줍니다. 버튼·입력·링크·복사 기능이 없는 목록입니다. |
| 4. fake | `devParam('fakeAgents')`를 통한 예제와 로그인 보호가 있는 `agents.list`를 구현했습니다. 외부 세션·턴과 과거 CLI 행을 함께 제공합니다. 외부 턴에는 CLI 바이패스 표시와 가짜 사용량을 붙이지 않습니다. 긴급 정지 예제도 프로그램 종료를 확인했다고 응답하지 않습니다. |
| 5. 검증 | 기존 S4-no-swap 검사에 에이전트 조회 영역과 허용 조회를 추가했습니다. 새 테스트 17개와 실제 화면 결함을 넣는 mutation 24건을 만들었습니다. 결과와 검출 근거는 아래에 기록합니다. |
| 6. 화면 | 1440×1100과 390×1100에서 34장을 촬영했습니다. 캡처 도구는 앱 페이지 전용 헤드리스 브라우저 하나와 5196 Vite만 사용합니다. |

철회 안내는 `서버 접근이 철회됐습니다. 외부 프로그램의 종료 여부는 확인할 수 없습니다.`입니다. 철회된 보유자가 돌아오면 계속 처리한다는 약속도 제거했습니다. 대표에게 프로그램 종료를 확인한 것처럼 보이지 않게 하기 위한 선택입니다.

목록은 처음 열 때와 보이는 페이지에서 5초마다 조회합니다. 숨겨진 페이지에서는 읽지 않고 다시 보이면 갱신합니다. 자리가 바뀌거나 조회에 실패하면 이전의 성공 상태를 숨기며, 화면 종료 시 타이머와 이벤트 구독을 정리합니다. 조회 중·조회 실패·등록 없음·보유자의 등록 정보 없음은 서로 다른 안내입니다.

모바일 칩은 별도 줄에서 이름과 외부 유형을 줄바꿈합니다. 상단 높이는 실제 내용으로 정해 탐색 메뉴를 가리지 않습니다. 긴 현재·다음 보유자 이름도 두 유형이 보이고 탐색 버튼을 누를 수 있는지 브라우저에서 검사합니다.

세션과 턴 계약에는 외부 에이전트 ID나 모델이 없습니다. 화면에서 이를 추정하지 않고 `외부 에이전트`만 표시합니다. `runner`가 없는 과거 턴은 계약에 따라 CLI입니다. 모델을 알아야 하는 기능이나 계약 변경은 추가하지 않았습니다.

## 변경 파일

아래 경로는 `src/renderer/`를 기준으로 합니다.

| 파일 | 변경 |
|---|---|
| `src/lib/agents.ts` | 보유자 유형 표시, 연결 판정과 접근 철회 문구 |
| `src/components/ExternalAgents.tsx` | 목록 조회, 현재 외부 보유자의 연결, 읽기 전용 목록 |
| `src/components/SeatStatus.tsx` | 상단과 응답 없음 안내의 외부 유형, 철회 후 복귀 약속 제거 |
| `src/screens/Seat.tsx` | 현재·다음·과거 보유자, 인계와 목록 섹션 |
| `src/components/MemberPanel.tsx` | 현재 자리 기반 메인 설명, 세션·턴 주체와 외부 바이패스 숨김 |
| `src/styles/seat.css` | 목록과 연결 표시, 긴 칩과 모바일 상단 배치 |
| `src/api/fake/agents.ts` | 등록·연결·철회·교체 예제 |
| `src/api/fake/seat.ts` | 외부 자리, 이력과 일지 예제 |
| `src/api/fake/index.ts` | 개발 매개변수, agents.list와 인증, 외부 실행 기록·긴급 정지 예제 |
| `src/components/stage7-agents.test.ts` | 새 동작 테스트 17개 |
| `src/components/stage4-seat.test.ts` | 에이전트 관리 금지까지 확장한 S4-no-swap |
| `src/components/web-stage8.test.ts` | 새 조회와 visibility 이벤트를 기존 테스트 환경에 제공 |
| `tools/mutate-stage4-seat.mjs` | `--stage7` 진입점 |
| `tools/mutate-stage7-agents.mjs` | 스크래치 전용 순차 결함 재주입과 복원 확인 |
| `tools/capture-stage7-agents.mjs` | 재현 가능한 헤드리스 캡처와 React·레이아웃 검사 |

이 문서 폴더에는 README, PNG 34장, `browser-audit.json`, `mutation-results.json`을 둡니다. 다른 레인의 파일은 수정하지 않았습니다.

## 접근 가능한 이름

| 역할·위치 | 이름 |
|---|---|
| 상단 `button` | `메인 에이전트: {이름} · 외부 에이전트` |
| 교체 중 상단 `button` | `메인 에이전트: {현재 이름과 유형} → {다음 이름과 유형} 교체 중` |
| 정지 중 상단 `button` | `메인 에이전트 정지됨 · {이름} · 외부 에이전트` |
| 연결 `status` | `메인 외부 에이전트 연결 상태` |
| 목록 `region` | `등록된 외부 에이전트` |
| 개별 `listitem` | `외부 에이전트 {이름} ({ID})` |
| 메인 패널 설명 | `현재 메인 자리 보유자` |
| 실행 기록 선택 | 기존 `턴 선택`. 각 option에 실행 주체를 추가 |
| 세션 표 열 | `실행 주체` |

새 관리 컨트롤은 없습니다. 상단 칩은 기존 자리 화면을 열고, 기존 `메인 에이전트에게 말하기`는 명령창에 초점과 초안을 전달합니다.

## 테스트와 재주입한 결함

새 테스트는 `src/components/stage7-agents.test.ts`에 있습니다. 매개변수별로 펼치면 17개입니다. [mutation 결과](mutation-results.json)는 실제 단언 실패만 검출로 셉니다. JSX 구문 오류나 도구 오류는 성공으로 세지 않으며 매번 원본 바이트를 복원합니다.

| 테스트 | 잡는 결함 |
|---|---|
| `S7-chip` | 활동·교체·정지 중 외부 보유자를 Claude CLI로 표시. 다음 보유자와 외부 유형 누락도 검사 |
| `S7-seat` | 자리 화면의 Codex CLI 오표시, 외부 접근 철회 뒤 복귀 처리 약속, 상단 응답 없음 안내의 같은 약속 |
| `S7-main-panel` | 현재 자리 대신 마지막 CLI 모델·노력치·변경 예정 설정 표시. 빈 자리도 확인 |
| `S7-records` | 외부 세션·턴의 CLI 오표시와 외부 턴의 CLI 바이패스 표시. 혼합 기록과 runner 없는 과거 CLI도 확인 |
| `S7-connection` ×3 | 연결 해제·철회·긴급 정지 중 연결됨 표시, 마지막 접속 시각 누락, 프로그램 종료 확인을 단정하는 문구 |
| `S7-list` | 등록·철회·자리 배정·키 복사 컨트롤 추가. 모든 표시 필드와 인증 값 부재도 확인 |
| `S7-empty` | 등록 없음과 빈 자리 혼동, 조회 중을 미등록으로 표시. 실패와 등록 정보 누락도 연결됨으로 표시하지 않는지 확인 |
| `S7-refresh` | 조회 실패 후 이전 연결 상태 유지, 화면 종료 후 타이머 유지. 숨긴 페이지의 조회 중단과 다시 보일 때 갱신도 확인 |
| `S7-fake` ×7 | fakeAgents 무시와 로그인 전 목록 노출. 예제별 내용, 외부·CLI 혼합 기록, 복제된 반환값과 외부 긴급 정지도 확인 |
| 기존 `S4-no-swap` | 에이전트 조회 영역에 운영 설정 쓰기 호출 추가. 자리·화면·에이전트 영역 전체에서 허용 조회와 기존 긴급 정지 이외 호출 금지 |

## 검증 결과

| 검사 | 결과 |
|---|---|
| 웹 TypeScript | 종료 0 |
| check-contract | 종료 0. 메서드 49개, fake·화면 호출 누락 없음, 금지 호출 없음 |
| Renderer vitest | 34개 파일, 454개 통과. 시작 기준 437개에서 17개 추가, 기존 테스트 감소 없음 |
| 서버용 `npm run build:web` | 종료 0. remote 빌드와 fake 코드 유입 방지 검사 통과 |
| `tests/acceptance/flow.test.ts` | 21개 통과, 종료 0 |
| Mutation | 24/24 결함을 실제 단언 실패로 검출. 원본 바이트 복원 확인 |
| 브라우저 | 34장, 실행 오류 0. 가로 넘침·메뉴 가림·새 관리 컨트롤 없음. 칩 44px 이상, 긴 보유자 이름 표시 확인 |

전체 renderer 첫 실행에는 복사본에 빠진 3D 에셋과 기존 웹 테스트의 visibility 이벤트 스텁 누락이 있었습니다. 에셋을 복사하고 테스트 환경을 보완한 뒤 전체가 통과했습니다. 백엔드 테스트 실패는 없었습니다. 관리 버튼 mutation 4건은 처음에 JSX 구문 오류였으며 정상 JSX로 다시 넣어 네 건 모두 단언 실패를 확인했습니다.

재현할 때는 저장소를 레인 전용 시스템 임시 폴더에 복사하고 기존 node_modules를 연결합니다. 리드의 S7-13~14에 따라 mutation과 편집한 제품의 실행은 이 복사본에서만 합니다. `VT`는 아래 경로입니다.

```sh
VT=C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/vt.sh
bash "$VT" -- npx tsc --noEmit -p tsconfig.web.json --tsBuildInfoFile "$TEMP/wook-codex-s7-web.tsbuildinfo"
node src/renderer/tools/check-contract.mjs
bash "$VT" run --config src/renderer/tools/vitest.config.ts --configLoader runner --no-cache
bash "$VT" -- npm run build:web
bash "$VT" run tests/acceptance/flow.test.ts --configLoader runner --no-cache
bash "$VT" -- node src/renderer/tools/mutate-stage4-seat.mjs --stage7
bash "$VT" -- node src/renderer/tools/capture-stage7-agents.mjs
```

모든 Vitest와 긴 명령은 vt.sh를 통과했고 한 번에 하나씩 실행했습니다. 캡처 도구는 프로필과 Vite 캐시를 시스템 임시 폴더에 두고 끝날 때 브라우저와 5196 서버를 종료합니다. 5199와 다른 프로세스는 조작하지 않았습니다.

## 화면

아래는 실제 PC 화면을 읽지 않고 앱 페이지를 촬영한 이미지입니다. [브라우저 검사 기록](browser-audit.json)에는 표시 문구, 요청 메서드, 컨트롤 수와 레이아웃 측정값을 남겼습니다.

| 상태 | 자리 1440px | 자리 390px | 목록 1440px | 목록 390px |
|---|---|---|---|---|
| 등록 없음 | [보기](seat-none-1440.png) | [보기](seat-none-390.png) | [보기](agents-none-1440.png) | [보기](agents-none-390.png) |
| 연결됨 | [보기](seat-connected-1440.png) | [보기](seat-connected-390.png) | [보기](agents-connected-1440.png) | [보기](agents-connected-390.png) |
| 연결 안 됨 | [보기](seat-disconnected-1440.png) | [보기](seat-disconnected-390.png) | [보기](agents-disconnected-1440.png) | [보기](agents-disconnected-390.png) |
| 다음 보유자 | [보기](seat-incoming-1440.png) | [보기](seat-incoming-390.png) | [보기](agents-incoming-1440.png) | [보기](agents-incoming-390.png) |
| 보유 중 접근 철회 | [보기](seat-revoked-1440.png) | [보기](seat-revoked-390.png) | [보기](agents-revoked-1440.png) | [보기](agents-revoked-390.png) |
| 여러 에이전트 | [보기](seat-several-1440.png) | [보기](seat-several-390.png) | [보기](agents-several-1440.png) | [보기](agents-several-390.png) |
| 응답 없음 | [보기](seat-unresponsive-1440.png) | [보기](seat-unresponsive-390.png) | [보기](agents-unresponsive-1440.png) | [보기](agents-unresponsive-390.png) |

| 실행 기록 | 1440px | 390px |
|---|---|---|
| 메인 팀원 패널 | [보기](member-external-1440.png) | [보기](member-external-390.png) |
| 외부 턴 | [보기](turn-external-1440.png) | [보기](turn-external-390.png) |
| 외부·CLI 세션 | [보기](sessions-mixed-1440.png) | [보기](sessions-mixed-390.png) |

fake 주소는 `?fakeAgents=none|connected|disconnected|incoming|revoked|several|unresponsive`입니다. 등록 없음은 기존 CLI 보유자와 공존합니다. 외부 에이전트가 없다는 사실을 빈 자리로 표현하지 않습니다.

## 남은 일과 범위

요청한 1~6항의 구현에 남은 일은 없습니다. 계약 수정 요청도 없습니다. 실제 서버·실제 외부 프로그램·화면 도우미·실화면 캡처·입력 주입은 실행하지 않았습니다. 실제 서버 연결 검증은 백엔드 레인의 범위입니다.

외부 Obsidian 업무일지는 이번 요청의 파일 소유권과 외부 쓰기 금지에 따라 수정하지 않았습니다. 리드가 합칠 수 있도록 이 문서에 작업 결과를 남겼습니다. 한국어 파일은 UTF-8로 작성하고 깨진 문자와 줄바꿈을 검사했습니다.
