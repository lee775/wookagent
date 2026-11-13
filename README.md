# 욱채 프로그램 (wookagent)

대표의 명령을 메인 에이전트가 받아 프로젝트별 AI 팀(Claude Code·Codex CLI 세션)을 꾸리고 지휘해, 작업·검수·병합·보고까지 처리하는 PC 프로그램입니다.

- 기획서: [docs/기획서_v0.5.md](docs/기획서_v0.5.md)
- 설계: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (19장: 기획서 이후 추가 결정)
- 현재 범위: 기획서 3장의 **1차** (2차 기능은 화면에 "2차 예정"으로 표시)

## 실행

필요한 것: Windows 10/11 (1차 검증 환경) 또는 macOS, Node.js 24, git, Claude Code CLI, Codex CLI (각각 로그인된 상태).

```powershell
npm install
npm run dev        # Electron 앱 개발 실행 (개발 모드 로그인 사용 가능)
npm run dev:web    # 화면만 브라우저로 (가짜 데이터) — http://127.0.0.1:5199
npm test           # 단위·통합 테스트 (실제 git·프로세스·앱 도구 서버 + 모의 에이전트)
npm run typecheck
npm run build      # out/ 에 빌드
npm run pack:linux # Linux 서버 묶음 dist/wook-server-<판>-linux-<커밋>.tar.gz (docs/SERVER_SETUP.md L2 '묶음으로')
```

실제 Claude Code·Codex를 쓰는 테스트(사용량이 듭니다)는 기본 실행에서 빠져 있고, 환경 변수를 켜야 돌아갑니다.

| 테스트 | 켜는 방법 | 확인하는 것 |
| --- | --- | --- |
| `tests/real/realFeedback.test.ts` | `WOOK_REAL_FEEDBACK=1` | 1차 완료 기준. 실제 메인 에이전트·프로듀서(Claude)와 개발자(Codex)로 지시 → 작업 → 검수 → 병합 → 보고 → 수정 요청 → 2회차 → 결과 승인까지 (약 5분) |
| `tests/real/realTeam.test.ts` | `WOOK_REAL_TEAM=1` | 실제 Claude 프로듀서 + Codex 개발자가 작은 지시를 권한 확인 없이 병합까지 |
| `src/main/agents/realCliCapture.test.ts` | `WOOK_CAPTURE_FIXTURES=1` | 실제 CLI 이벤트를 받아 파서 시험용 자료(`__fixtures__/`)로 저장 |
| 위 FEEDBACK·TEAM을 서버 모드로 | 위의 변수와 `WOOK_REAL_MODE=server` | 같은 확인을 프로세스 안 서버(HTTP·운영자 시험 세션)로 |
| `tests/real/realHostExec.test.ts` | `WOOK_REAL_HOSTEXEC=1` | Claude·Codex 메인이 2분·6분짜리 `host_exec`의 결과를 받는지 (기본 서버 모드) |
| `tests/real/realTask.test.ts` | `WOOK_REAL_TASK=1`과 `WOOK_REAL_TASK_HOST=<PC 이름>` | 꺼 둔 작업 스케줄러 작업을 실제로 등록·다시 읽기·지우기 |

예: `WOOK_REAL_FEEDBACK=1 npx vitest run tests/real/realFeedback.test.ts`. 실제 화면 시험(`WOOK_REAL_DESKTOP`·`WOOK_REAL_GUI`)과 함께, 어느 것을 언제 누가 돌리는지는 [docs/SERVER_DESIGN.md](docs/SERVER_DESIGN.md) 10.9에 있습니다.

남은 낮은 결함과 설계상 한계는 [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md)에 정리했습니다.

## 서버로 띄우기 (서버 모드 — 이 PC의 루프백, 다른 기기는 Tailscale로)

Electron 창 없이 도는 서버입니다(콘솔 창 `욱채 서버 (pid …)` 하나만 보입니다). 같은 PC 안(루프백 — 같은 포트의 127.0.0.1과 ::1)에서만 열리고, 들어올 때는 기기 세션(쿠키 `__Host-wos_session` 또는 `Authorization: Bearer`)을 씁니다. 세션은 구글 기기 코드 로그인(대표 이메일의 구글 계정만 — 휴대폰에서 google.com/device에 코드를 넣습니다)이나 관리 채널이 발급하는 운영자 시험 세션으로 엽니다. 다른 기기는 `tailscale serve`가 만든 주소(`--public-origin`)로 들어옵니다. 대표가 휴대폰 브라우저로 쓰는 웹 화면은 `npm run build:web`(→ `out/web`)으로 만들어 `--web-dir out/web`으로 붙입니다.

- **설치 순서** (명령 차례대로 — 에이전트가 그대로 따라 할 수 있게): [docs/SERVER_SETUP.md](docs/SERVER_SETUP.md). Windows 편(작업 스케줄러 등록)과 Linux 편(Ubuntu 24.04 — systemd 사용자 유닛, Xvfb 화면 조작)이 있고, 둘 다 `install-task`, 서버 PC 점검(`check`), 깨끗한 VM 점검표가 있습니다. Linux에서는 `scripts\wook-server.cmd` 대신 `scripts/wook-server`를 씁니다.
- **설명** (왜 그렇게 하는지, 운영자 명령 표): [docs/SERVER_INSTALL.md](docs/SERVER_INSTALL.md)
- **이 PC에서 먼저 써 보기** (`scripts\try-server.cmd` — `mock`·`phone`·`stop`도 있습니다 — 와 `scripts\try-desktop.cmd`): [docs/TRY_IT.md](docs/TRY_IT.md)
- **외부 에이전트**(그록봇 등)가 붙는 법: [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md)와 SERVER_INSTALL 10절
- 설계는 [docs/SERVER_DESIGN.md](docs/SERVER_DESIGN.md) 3장·10장, 코드 안내는 ARCHITECTURE 20장에 있습니다.

```powershell
npm run build:server                     # out/server/index.mjs
node out/server/index.mjs --data-dir D:\wook-data --allow-test-session
# 준비되면 한 줄: 욱채 서버 준비 완료: 주소 http://127.0.0.1:7317 (127.0.0.1과 ::1에서 받음) · 실행 ID … · 데이터 폴더 D:\wook-data
```

- 데이터 폴더는 `--data-dir` → 환경 변수 `WOOK_DATA_DIR` → 기본 위치(`%APPDATA%\wookagent`, 데스크톱 앱과 같은 곳 — Linux는 `~/.config/wookagent`) 순서로 정합니다. 없는 폴더는 서버가 이 사용자만 쓸 수 있게 만들고, 이미 있는 폴더의 권한은 건드리지 않습니다. 한 데이터 폴더는 데스크톱 앱이든 서버든 하나만 쓸 수 있습니다. 실행 중인 욱채의 데이터 폴더를 복사한 폴더(되살린 백업 wook.db 포함)나 잠금 파일(`server.lock`)을 지운 폴더로도 시작하지 않습니다 — '이 데이터는 실행 중인 욱채(…)가 쓰고 있는 데이터입니다'가 나오면 그 욱채를 먼저 끝내세요.
- 다른 옵션: `--port <번호>`(기본 7317, 0이면 빈 포트), `--bind 127.0.0.1|::1|localhost`(다른 주소는 거부합니다. 어느 것을 골라도 같은 포트의 127.0.0.1과 ::1을 함께 열고, 둘 중 하나라도 다른 프로그램이 쓰고 있으면 시작하지 않습니다 — `localhost`로 보낸 토큰이 다른 프로그램으로 가지 않게), `--web-dir <폴더>`(빌드한 웹 화면 — `npm run build:web`이 만든 `out/web`. 서버용 빌드 표시가 없는 폴더(가짜 데이터로 도는 개발용 화면)면 서버가 까닭을 말하고 시작하지 않습니다). `npm run start:server -- --data-dir …`도 같습니다.
- 요청은 주소가 `127.0.0.1`·`localhost`·`[::1]`과 그 포트, 또는 공개 주소(`--public-origin https://<서버 PC 이름>.<tailnet>.ts.net` 또는 server.json `network.publicOrigin`)일 때만 받습니다. 다른 이름(hosts 파일에 적은 별명 등)으로 오면 403입니다. 토큰은 `Authorization: Bearer <토큰>`이나 쿠키로만 보냅니다(주소에 `?token=`으로 붙이면 401입니다).
- server.json `owner.tailscaleLogins`에 Tailscale 사용자(예: `owner@example.com`)를 적으면 그 사용자의 요청만 받습니다 — 이 PC 안에서 바로 붙는 도구도 `Tailscale-User-Login` 머리를 실어야 합니다. 비워 두면 보지 않습니다.
- 요청은 1분마다 기기 세션별(1,200번), 로그인 전 요청은 Tailscale 사용자별(120번)과 모두 합쳐(600번) 셉니다. 넘으면 429와 `Retry-After`입니다. 상태를 바꾸는 요청(명령·답변·승인·수정 요청·정지 해제·기기 끊기)은 같은 요청 `id`를 한 번만 처리하고 24시간 동안 같은 답을 줍니다 — 다시 보낼 때는 같은 `id`, 새 요청에는 새 `id`를 쓰세요.
- 명령에 붙일 파일은 `POST /api/uploads?name=<이름>`으로 올리고(50MB까지, 24시간 뒤 지움) 답의 `uploadId`를 첨부(`{ name, uploadId }`)로 씁니다. 서버 PC의 파일 경로는 첨부로 받지 않습니다. 첨부·보고서 파일·내보낸 기록은 `/api/attachments/<ID>`·`/api/reports/<ID>/file`·`/api/exports/<이름>`으로 내려받습니다.
- 서버 기록은 `<데이터 폴더>\logs\server.log`(백엔드는 `backend.log`)에 남습니다. 요청 인자·토큰은 남기지 않고, 한 번의 기록은 늘 한 줄(4KB까지)입니다. 토큰 없이 온 요청(Host·Tailscale 사용자 거부, 횟수 제한, 토큰 없음, 안내 쪽)의 접근 기록은 종류마다 1분에 한 줄과 '…지난 1분 동안 N번 더 있었습니다' 한 줄로 모읍니다 — 요청을 퍼부어 앞 기록을 밀어내지 못하게.
- 운영자 설정 파일은 `<데이터 폴더>\server.json`(`--config <파일>`로 바꿉니다)입니다. 대표 이메일(`owner.email`), 서버의 구글 로그인 클라이언트 ID(`google.clientId` — 구글 클라우드 콘솔의 'TV 및 입력 제한 기기' 종류, 데스크톱 앱의 구글 설정과 따로입니다), CLI 실행 파일 위치(`cli.claudePath`·`cli.codexPath`)를 적으면 서버가 시작할 때와 `config reload` 때 그 값으로 덮어쓰고 활동 기록에 남깁니다. 공개 주소(`network.publicOrigin`)와 받는 Tailscale 사용자(`owner.tailscaleLogins`)는 `config reload`가 다시 시작하지 않고 바로 바꿉니다 — 바뀐 것은 답·활동 기록·서버 기록에 남습니다(Tailscale 사용자는 켬·끔과 사람 수만). 모양이 틀린 파일이면 시작하지 않습니다. 비밀 값은 이 파일에 넣지 않습니다(아래 `secret set`). `--owner-email <이메일>`·`--public-origin <주소>`는 파일의 값보다 먼저입니다.
- 메인 에이전트 자리는 server.json `seat`로 정합니다: `initialHolder`(처음 보유자 `launched:claude`·`launched:codex`·등록한 외부 에이전트 `external:<ID>` — 새 데이터로 처음 띄울 때만 씁니다. 이미 앉은 자리는 바꾸지 않습니다), `holders`(앉을 수 있는 보유자, 기본 모두), `drainMs`(교체 때 나가는 메인 턴의 마무리를 기다리는 시간, 기본 120000). 그 뒤 자리는 메인 에이전트가 넘깁니다(`hand_off_seat` — 대표가 "Codex에게 메인을 넘겨"라고 명령하면). 대표 화면에는 교체 버튼이 없습니다. 메인 에이전트가 응답하지 않아도(사용량 한도·재로그인 필요·시작 실패가 이어짐) 서버는 자리를 바꾸지 않고 대표에게 5분·30분·2시간에 알립니다 — 자리를 바꾸는 것은 운영자의 `seat assign`뿐입니다(아래). 외부 에이전트(`external:<ID>`)는 운영자가 `wook-server agent add --label <이름>`으로 등록한 뒤(키는 그때 한 번만 보입니다) `seat assign external:<ID>`로 앉힙니다 — 서버 모드에서만 됩니다.
- 대표 이메일이 정해지지 않았으면 준비 줄 뒤에 설정 코드(8자, 1시간, 한 번만)가 나오고 `<데이터 폴더>\setup-code.txt`(이 사용자만 읽음)에도 적힙니다. 화면의 서버 설정에 그 코드와 대표 이메일을 넣거나 `config owner-email`로 정하세요. 정하기 전에는 기기 코드 로그인이 시작되지 않습니다. 대표 이메일을 바꾸면 등록된 대표 계정과 모든 기기 세션이 끊깁니다.
- 하루 1회 자동 백업은 데스크톱 앱과 같은 설정(운영 설정의 자동 백업)으로 돕니다.
- 운영자 명령이 쓰는 관리 채널은 Windows에서는 이름 있는 파이프로, 서버가 시작할 때마다 새 이름을 골라 데이터 폴더의 `admin.endpoint`에 적습니다. Linux에서는 늘 같은 자리인 데이터 폴더의 소켓 파일 `admin.sock`입니다(이 사용자만 열고 다른 기기에서는 닿지 않습니다 — 그 자리도 `admin.endpoint`에 적습니다). 운영자 명령은 `server.lock`이 살아 있는 서버를 가리키는지 먼저 보고, 이 파일과 `admin.token`(둘 다 이 사용자만 읽음)으로 서버와 서로 증명한 뒤에만 명령을 보냅니다 — 토큰 자체는 보내지 않습니다. Windows에서는 서버 도우미(`<데이터 폴더>\bin\WookServerHelper.exe`)가 이 파이프를 만들어 다른 기기(SMB)의 연결을 증명 전에 거부하고 지금 사용자만 열게 합니다. 도우미를 쓸 수 없으면 서버는 Node 파이프로 열고 그렇다고 알립니다(`status`의 '관리 채널' 줄). 그래도 데이터 폴더 권한은 넓히지 말고, tailnet에 올린 PC는 Tailscale 쪽의 들어오는 TCP 445를 막아 두세요([docs/SERVER_INSTALL.md](docs/SERVER_INSTALL.md) 4절 6번).
- 작업 중에는 서버가 PC의 절전을 막습니다(같은 도우미, 설정 `execution.preventSleep`). 쉬는 동안의 절전은 Windows 전원 설정으로 끕니다(SERVER_SETUP 7단계). Linux는 작업 중에 `systemd-inhibit`로 막고(사용자 유닛의 서버에는 거부될 수 있습니다), 쉬는 동안의 절전은 절전 대상을 막아(mask) 끕니다(SERVER_SETUP L7단계).

운영자 명령은 같은 파일로 실행하고, 서버를 띄운 데이터 폴더를 알려 줍니다. 저장소 폴더에서는 `node out/server/index.mjs` 대신 `scripts\wook-server.cmd`를 써도 같습니다. 결과는 한국어로, `--json`을 붙이면 JSON 한 줄로 나옵니다.

```powershell
node out/server/index.mjs status       --data-dir D:\wook-data   # 상태 (pid, 주소, 실행 ID, 진행 중 작업, 긴급 정지, 비밀 값 저장소, 화면 조작, 관리 채널, 절전 방지, 배포 점검, 버전)
node out/server/index.mjs session test --data-dir D:\wook-data   # 운영자 시험 세션 = 대표의 기기 세션 토큰 (--allow-test-session으로 띄운 서버만, 쉬다가 14일·최대 90일, 다시 시작해도 남음)
node out/server/index.mjs stop         --data-dir D:\wook-data   # 긴급 정지 (대표의 긴급 정지와 같습니다)
node out/server/index.mjs shutdown     --data-dir D:\wook-data   # 정상 종료 (Windows에서 창 없이 띄운 서버를 끝낼 때. 터미널이면 Ctrl+C·Ctrl+Break도 됩니다)
node out/server/index.mjs config show  --data-dir D:\wook-data   # 운영자 설정 보기 (대표 이메일·구글 클라이언트·보안 비밀 등록 여부·CLI 위치·공개 주소·Tailscale 사용자 — 비밀 값은 보여 주지 않습니다)
node out/server/index.mjs config reload --data-dir D:\wook-data  # server.json을 다시 읽어 적용
node out/server/index.mjs config owner-email owner@example.com --data-dir D:\wook-data        # 대표 이메일 (server.json에 쓰고 적용)
node out/server/index.mjs config google-client-id 1234-abc.apps.googleusercontent.com --data-dir D:\wook-data
Get-Content .\secret.txt | node out/server/index.mjs secret set google-client-secret --data-dir D:\wook-data   # 보안 비밀은 표준 입력으로만 (그냥 실행하면 화면에 보이지 않게 붙여 넣습니다)
node out/server/index.mjs secret clear google-client-secret --data-dir D:\wook-data
node out/server/index.mjs seat status  --data-dir D:\wook-data   # 메인 에이전트 자리 (보유자·세대·응답 없음·교체 중인지·자리 정책·최근 이력 — 보기만)
node out/server/index.mjs seat assign launched:codex --data-dir D:\wook-data   # 메인 자리를 Codex CLI에게 (운영자 배정 — 나가는 메인 턴의 마무리를 기다림, --force면 바로 멈춤)
node out/server/index.mjs check        --data-dir D:\wook-data   # 서버 PC 점검 (Windows는 세션·자동 로그온·잠금·절전·작업·데이터 폴더·CLI·SMB·Tailscale — 바꾸지 않음, 서버가 없어도 됨)
node out/server/index.mjs install-task --dry-run --data-dir D:\wook-data   # 로그온할 때 이 사용자로 서버를 띄우는 작업 (Linux는 systemd 사용자 유닛 — --dry-run 없이 치면 등록)
node out/server/index.mjs uninstall-task --data-dir D:\wook-data          # 그 작업(유닛) 지우기 (실행 중인 서버는 끄지 않음)
```

운영자 시험 세션 토큰으로 대표 메서드를 부를 수 있습니다(대표 권한 밖의 메서드는 403입니다). 토큰 없이는 로그인 전 메서드(`auth.getState` 등)만 됩니다. `auth.logout`은 그 기기 세션만 끊습니다.

```powershell
curl.exe -H "Authorization: Bearer <토큰>" -H "Content-Type: application/json" -d "{\"id\":\"1\",\"method\":\"system.prereqs\",\"args\":[]}" http://127.0.0.1:7317/api/invoke
curl.exe -N -H "Authorization: Bearer <토큰>" "http://127.0.0.1:7317/api/events?members=M-0001"   # 밀어주기(SSE)
```

## 처음 쓸 때

1. **로그인**: 개발 실행에서는 "개발 모드로 시작하기"로 들어갈 수 있습니다. 정식 사용은 구글 로그인이 필요합니다.
   - Google Cloud Console → API 및 서비스 → 사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → 애플리케이션 유형 **데스크톱 앱**
   - 받은 클라이언트 ID와 보안 비밀을 운영 설정 > 계정에 넣습니다. 보안 비밀은 Windows 자격 증명 관리자(macOS 키체인)에 저장됩니다.
   - 처음 로그인한 구글 계정이 대표로 등록되고, 이후 다른 계정은 거부됩니다.
2. **프로젝트 추가**: 기존 폴더 연결 또는 새 폴더 만들기. git이 없으면 초기화하고, `AGENTS.md`(공통 지침)와 `CLAUDE.md` 첫 줄 `@AGENTS.md`를 자동으로 넣어 커밋합니다. 프로듀서는 자동 배치됩니다.
3. **팀 구성**: 스튜디오에서 역할을 골라 팀원을 추가합니다. 팀원의 AI 종류·모델·노력치는 메인 에이전트가 일에 맞게 정하고, 대표가 직접 바꾼 팀원은 "대표 고정"이 되어 메인 에이전트가 바꾸지 않습니다.
4. **명령**: 하단 명령창에서 프로젝트를 고르고 지시합니다. 결과 보고서는 문서함에 쌓이고, [결과 승인] 또는 [수정 요청]으로 답합니다.

## 모의 에이전트 (사용량 없이 시험)

운영 설정 > 개발자 옵션에서 프로젝트별로 "모의 에이전트 모드"를 켜면 팀원이 실제 AI 대신 정해진 시나리오대로 움직입니다(정상 완료, 비정상 종료, 응답 없음, 헛돌기, 사용량 한도, 3회 반려, 병합 충돌, 되돌리기 등). 팀원 상세에서 팀원별 시나리오를 고를 수 있습니다. 메인 에이전트도 모의로 돌릴 수 있습니다.

## 실행 정책 (중요)

대표 결정(기획서 v0.5)에 따라 **CLI의 실행 권한 승인은 바이패스**합니다 (`claude --dangerously-skip-permissions`, `codex --dangerously-bypass-approvals-and-sandbox`). 팀원 AI는 실행 계정의 권한으로 파일·명령을 실행할 수 있습니다. 앱은 자체 도구의 권한·작업 배정·검수·병합 순서·정지를 검사하고 모든 활동을 기록하지만, CLI가 직접 하는 파일·셸 접근을 작업 폴더 안으로 강제 격리하지는 않습니다 (기획서 10장).

- 긴급 정지: 상단 빨간 버튼, 트레이 메뉴, 전역 단축키(기본 `Ctrl+Alt+Shift+S`). 모든 CLI와 하위 프로세스를 3초 안에 종료하고 확인합니다.
- 팀원 CLI 세션에는 대표 PC의 개인 훅·개인 전역 지침(업무일지 강제 등)이 적용되지 않게 분리합니다.

## 데이터 위치

`%APPDATA%\wookagent` (macOS `~/Library/Application Support/wookagent`): DB, 보고서, CLI 이벤트(비밀 값 가림), 작업 폴더(worktree), 검수 사본, 산출물, 기억 문서, 백업(하루 1회, 7개 보관).

## 폴더 구조

```text
src/shared        화면·백엔드 공통 계약 (도메인 타입, IPC, CLI 이벤트, 한국어 라벨)
src/core          순수 로직: 상태 전이, 실행 자리, 실행 허용 검사, 검수 규칙, 진행도, 비밀 값 가리기
src/main          Electron 메인 프로세스 (백엔드는 서버와 함께 쓴다)
src/server        서버 프로세스: 진입점·운영자 명령·HTTP·SSE·관리 채널 (서버 개편 2단계)
  orchestrator    업무 로직 (작업·검수·병합·정지·턴 실행·스케줄러·복구·앱 도구 처리)
  db, git, process, agents, mcp, auth, reports, skills, shell, backend
src/preload       화면에 window.wook만 노출
src/renderer      화면 (React)
resources         Windows Job Object 러너(C#), 모의 에이전트
tests             단위·통합 테스트
```
