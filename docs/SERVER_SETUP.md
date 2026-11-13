# 욱채 서버 설치 순서

서버 PC에 욱채 서버를 처음부터 설치하는 순서입니다. 서버 PC에서 셸을 쓰는 에이전트(그록봇 등)가 위에서부터 그대로 따라 하도록 명령 순서로 썼습니다. **[사람]** 표시가 있는 단계는 사람이 해야 합니다(브라우저 로그인, 암호, 휴대폰, 다시 시작). 에이전트는 그 단계에서 멈추고 사람에게 부탁합니다.

- **Windows 10·11**: 아래 0~13단계와 [부록 A](#부록-a-깨끗한-vm-점검표)·[부록 B](#부록-b-문제-해결--check-항목별)
- **Linux (Ubuntu 24.04)**: 맨 뒤의 [Linux 편](#linux-편-ubuntu-2404) — L0~L13단계와 [부록 C](#부록-c-깨끗한-linux-vm-점검표)·[부록 D](#부록-d-문제-해결--linux-check-항목과-시작-거부)

왜 그렇게 하는지는 [SERVER_INSTALL.md](SERVER_INSTALL.md)에 있습니다. 서버를 두기 전에 이 PC에서 먼저 써 보려면 [TRY_IT.md](TRY_IT.md)를 봅니다(체험 도구는 Windows 전용입니다).

# Windows 편

## 읽기 전에

- **셸**: Windows PowerShell 5.1(시작 메뉴의 'Windows PowerShell')을 씁니다. 관리자 권한으로 열지 않습니다. 관리자 PowerShell이 필요한 줄은 따로 적었습니다.
- **어디서**: 서버를 돌릴 사용자 계정으로 Windows에 로그인한 화면(그 PC 앞이나 원격 데스크톱)에서 엽니다. 0단계에서 확인합니다.
- **경로**: 저장소 폴더는 `C:\wookagent`, 데이터 폴더는 `$env:USERPROFILE\wook-data`로 적었습니다. 다르게 쓰려면 모든 줄에서 같이 바꿉니다. 두 경로에 큰따옴표(`"`)나 퍼센트(`%`)가 있으면 안 됩니다. 작업 스케줄러가 `%…%`를 환경 변수로 펼치기 때문에 `install-task`가 거부합니다.
- **명령**: `scripts\wook-server.cmd`는 SERVER_INSTALL의 `wook-server`(= `node out\server\index.mjs`)와 같습니다. 모든 명령은 저장소 폴더에서 칩니다.
- **블록**: 여러 줄 블록은 통째로 붙여 넣습니다. `& { … }`로 감싼 블록은 한 줄이라도 실패하면 거기서 멈춥니다.
- **출력**: '나와야 하는 것'은 2026-11-11에 Windows 10 Pro(코드 페이지 949) PC의 Windows PowerShell 5.1에서 실제로 돌린 출력입니다. PC 이름·계정·tailnet 이름·경로는 `<…>`로 바꿨습니다. 그 PC에서는 서버를 임시 데이터 폴더와 빈 포트(`--port 0`)로 띄웠고, 출력의 포트는 기본값 7317로 바꿔 적었습니다.
- **돌려 보지 못한 줄**: 그 PC에서 돌릴 수 없던 줄(설치, 시스템 설정 바꾸기, Tailscale 바꾸기, 작업 등록, 실제 구글 로그인, 다시 시작, 다른 기기)에는 '이 PC에서는 돌려 보지 않음'이라고 적었습니다. 모두 [부록 A. 깨끗한 VM 점검표](#부록-a-깨끗한-vm-점검표)에 모았습니다.

## 0. 확인 — Windows, winget, 계정, 세션

```powershell
(Get-CimInstance Win32_OperatingSystem).Caption
winget --version
whoami /user /fo csv /nh
(Get-Process -Id $PID).SessionId
Get-ExecutionPolicy
```

나와야 하는 것:

```text
Microsoft Windows 10 Pro
v1.29.380
"<PC 이름>\<사용자>","S-1-5-21-<…>-1001"
1
RemoteSigned
```

- 첫 줄은 Windows 10이나 11이면 됩니다. winget 판은 달라도 됩니다.
- 셋째 줄의 SID는 `S-1-5-21-`로 시작해야 합니다. 넷째 줄(세션 번호)은 0이 아니어야 합니다.

안 되면:

- `winget`을 찾을 수 없음 → **[사람]** Microsoft Store에서 '앱 설치 관리자(App Installer)'를 설치하거나 업데이트합니다.
- SID가 `S-1-5-18`·`S-1-5-19`·`S-1-5-20`이면 서비스 계정의 셸입니다. 세션 번호가 0이면 화면이 없는 세션(서비스, 일부 원격 셸)입니다. 둘 다 서버를 돌릴 수 없고, 8단계의 `install-task`도 '로그인한 사용자 계정으로 실행해야 합니다 — LocalSystem·서비스 계정 금지'로 거부합니다. **[사람]** 서버를 돌릴 사용자로 Windows에 로그인한 화면에서 PowerShell을 열고 다시 합니다.
- `Restricted`(새 Windows의 기본값)나 `AllSigned`가 나오면 npm·claude·codex의 `.ps1` 실행 파일이 막힙니다('이 시스템에서 스크립트를 실행할 수 없으므로 … npm.ps1 파일을 로드할 수 없습니다'). 이 사용자에게만 풀어 둡니다(관리자 권한이 필요 없습니다):

  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser RemoteSigned -Force
  Get-ExecutionPolicy
  ```

  `RemoteSigned`가 나오면 됩니다. (이 PC는 이미 `RemoteSigned`라 이 두 줄은 돌려 보지 않았습니다. 위의 막힘 글은 이 창에만 `Restricted`를 걸고 `npm --version`을 쳐서 본 것입니다.)

## 1. 프로그램 설치 — Node.js, Git, Tailscale, CLI 둘

**[사람: 설치 확인 창]** 아래 설치는 Windows의 사용자 계정 컨트롤(UAC) 창을 띄울 수 있습니다. 그 창에서 '예'를 누르는 것은 사람이 합니다.

```powershell
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
winget install -e --id Git.Git --accept-source-agreements --accept-package-agreements
winget install -e --id Tailscale.Tailscale --accept-source-agreements --accept-package-agreements
```

설치가 끝나면 **PowerShell 창을 닫고 새로 엽니다**(새 PATH를 읽게). 그다음 CLI 둘을 설치합니다:

```powershell
npm i -g @anthropic-ai/claude-code @openai/codex
```

(이 PC에서는 돌려 보지 않음 — 이미 설치된 PC입니다.)

판 확인:

```powershell
node --version
npm --version
git --version
tailscale version
claude --version
codex --version
```

나와야 하는 것 (판 번호는 달라도 됩니다. `tailscale version`은 아래에 커밋 줄이 더 나옵니다):

```text
v24.13.0
11.6.2
git version 2.50.1.windows.1
1.104.6
2.1.322 (Claude Code)
codex-cli 0.167.0
```

안 되면:

- 명령을 찾을 수 없음 → 새 PowerShell 창을 열었는지 봅니다. 그래도 없으면 그 `winget install`을 다시 합니다.
- `node`가 `v24`보다 낮으면 서버가 쓰는 `node:sqlite`가 없습니다. `winget install -e --id OpenJS.NodeJS --accept-source-agreements --accept-package-agreements`로 최신판을 넣습니다. 7단계의 `check`도 Node 항목을 실패로 봅니다.
- `npm.ps1 … 로드할 수 없습니다` → 0단계의 실행 정책.

## 2. 저장소와 빌드

```powershell
git clone <저장소 주소> C:\wookagent
cd C:\wookagent
npm ci
```

- **[사람]** 비공개 저장소면 `git clone`이 GitHub 로그인 창을 띄웁니다.
- `npm ci`는 끝에 `added … packages`를 내고 오류 없이 끝나면 됩니다.
- (이 PC에서는 `git clone`과 `npm ci`를 돌려 보지 않음 — 이미 받아 둔 저장소입니다.)

```powershell
npm run build:server
npm run build:web
scripts\wook-server.cmd --help
```

나와야 하는 것 (빌드마다 `✓ built in …`으로 끝나고, 도움말의 '이 PC에서만 하는 명령'에 `install-task`·`uninstall-task`·`check`가 있습니다):

```text
> wookagent@0.1.0 build:server
> vite build --config vite.server.config.ts
…
out/server/index.mjs          1,444.93 kB │ gzip: 431.70 kB
✓ built in 125ms

> wookagent@0.1.0 build:web
> vite build --config vite.web.config.ts --mode remote
…
✓ built in 390ms

욱채 서버 (이 PC의 루프백 — 다른 기기는 tailscale serve로)
…
이 PC에서만 하는 명령 (실행 중인 서버가 없어도 됩니다)
  wook-server install-task [서버 옵션]
  …
  wook-server uninstall-task          그 작업(Linux는 유닛)을 지웁니다 (실행 중인 서버는 끄지 않습니다)
  wook-server check                   서버 PC를 점검합니다 (바꾸는 것은 없습니다. 실패가 있으면 끝 코드 1)
                                      Windows: 세션·자동 로그온·잠금·절전·작업·데이터 폴더·CLI·SMB·Tailscale
```

- 도움말의 글은 2026-11-12에 Windows와 Linux 둘 다에 맞게 고쳤습니다(10단계). 위의 두 줄은 지금의 도움말 그대로이고, 나머지 출력은 2026-11-11에 돌린 그대로입니다.
- 빌드 앞에 나오는 `(!) Your Vite config uses features that are unsupported by configLoader: 'native'` 안내는 그대로 두면 됩니다.

안 되면:

- `npm run build:web`이 실패하면 `out\web`이 빈 채로 남습니다. 까닭(위의 글)을 고치고 다시 합니다. 빈 `out\web`으로는 서버가 '서버용 웹 화면이 아닙니다'로 시작하지 않습니다(SERVER_INSTALL 3절).

## 3. CLI 로그인 — [사람]

서버가 띄우는 Claude Code·Codex CLI는 **서버를 돌리는 이 사용자**의 로그인을 씁니다. 이 PC의 브라우저로 로그인합니다:

```powershell
claude auth login
codex login
```

**[사람]** 열린 브라우저에서 구독 계정으로 로그인합니다. (이 PC에서는 돌려 보지 않음 — 이미 로그인된 PC입니다.)

확인:

```powershell
claude auth status --json
codex login status
```

나와야 하는 것:

```text
{
  "loggedIn": true,
  "authMethod": "claude.ai",
  "apiProvider": "firstParty",
  …
  "email": "<구독 계정 메일>",
  …
}
Logged in using ChatGPT
```

- `"loggedIn": true`와 `Logged in using ChatGPT`면 됩니다. 로그인 정보는 그 사용자의 프로필 폴더(`~\.claude`, `~\.codex`)에 남아 다시 시작해도 그대로입니다.

브라우저를 쓸 수 없는 PC(원격 셸만 있는 VM)면 (이 PC에서는 돌려 보지 않음):

- Codex: `codex login --device-auth` — 나온 주소와 코드를 다른 기기의 브라우저에 넣습니다 **[사람]**.
- Claude: 브라우저가 있는 다른 PC에서 `claude setup-token`으로 긴 토큰을 받고 **[사람]**, 서버 PC에서 `setx CLAUDE_CODE_OAUTH_TOKEN <토큰>`으로 넣은 뒤 새 PowerShell 창을 엽니다. 이 변수 이름과, `claude auth status`가 이 토큰을 로그인으로 보는지는 이 PC에서 확인하지 못했습니다(부록 A).

API 요금으로 쓰려면 구독 로그인 대신 앱의 API 키 방식을 씁니다. 서버가 뜬 뒤(4단계 끝) `scripts\wook-server.cmd secret set claude-api-key --data-dir "$env:USERPROFILE\wook-data"`(`codex-api-key`도 같습니다)를 치고 키를 붙여 넣습니다 **[사람]**. 그 AI가 API 키 방식일 때만 씁니다 — 방식은 메인 에이전트가 정합니다(SERVER_INSTALL 7절의 표). 구독으로 쓸 때는 `ANTHROPIC_API_KEY`·`OPENAI_API_KEY` 같은 환경 변수를 두지 않습니다. 7단계의 `check`가 경고합니다.

안 되면:

- `"loggedIn": false`나 `Not logged in` → 로그인을 다시 합니다. 서버를 돌릴 계정과 같은 계정으로 했는지 봅니다.

## 4. 데이터 폴더와 server.json, 설정용으로 서버 띄우기

대표의 구글 메일을 `owner@example.com` 자리에 넣고 통째로 붙여 넣습니다:

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $data = "$env:USERPROFILE\wook-data"
  $me = "$($env:USERDOMAIN)\$($env:USERNAME)"
  New-Item -ItemType Directory -Force $data | Out-Null
  icacls $data /inheritance:r /grant:r "${me}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '데이터 폴더의 권한을 좁히지 못했습니다 — server.json을 쓰지 않았습니다' }
  $cfg = [ordered]@{
    owner = [ordered]@{ email = 'owner@example.com' }
    seat = [ordered]@{ initialHolder = 'launched:claude' }
    workspaceRoot = "$env:USERPROFILE\wook-workspace"
    screen = [ordered]@{ enabled = $true }
  }
  $cfg | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 "$data\server.json"
  Get-Content -Encoding utf8 "$data\server.json"
}
```

나와야 하는 것:

```text
{
    "owner":  {
                  "email":  "owner@example.com"
              },
    "seat":  {
                 "initialHolder":  "launched:claude"
             },
    "workspaceRoot":  "C:\\Users\\<사용자>\\wook-workspace",
    "screen":  {
                   "enabled":  true
               }
}
```

- 데이터 폴더: `icacls` 줄이 물려받은 권한을 끊고 이 사용자만 쓰게 합니다. 서버가 데이터 폴더를 스스로 만들 때와 같은 권한이고, 그 안에 생기는 `server.json`·DB·기록·관리 토큰이 이 권한을 물려받습니다. 이 줄이 실패하면 블록이 멈추고 `server.json`을 쓰지 않습니다.
- `owner.email`: 이 메일의 구글 계정만 대표로 받습니다. 정해 두면 서버가 설정 코드를 내지 않습니다.
- `seat.initialHolder`: 처음 메인 자리는 서버가 띄우는 Claude CLI입니다. 9단계에서 외부 에이전트로 바꿉니다.
- `workspaceRoot`: 메인 에이전트가 그 아래 `main` 폴더에서 일합니다. 서버가 처음 쓸 때 이 사용자만 쓰게 만듭니다.
- `screen.enabled`: 메인 에이전트가 이 PC의 화면을 찍고 마우스·키보드를 쓰게 합니다. 쓰지 않으려면 `$false`로 둡니다(SERVER_INSTALL 9절). 서버를 다시 시작해야 바뀝니다.
- 구글 클라이언트 ID(5단계)와 공개 주소·받는 Tailscale 사용자(6단계)는 그 단계에서 이 파일에 더합니다.

(이 PC에서는 화면 조작을 쓰지 않는 규칙이라 `enabled = $false`로 바꿔 돌렸습니다. 출력의 그 줄만 다릅니다.)

**설정용으로 서버를 띄웁니다.** 5·6·9단계의 운영자 명령이 이 서버에 붙습니다. 8단계에서 끄고 작업 스케줄러로 다시 띄웁니다. **새 PowerShell 창**을 열어(사람이 열거나 에이전트의 두 번째 셸) 저장소 폴더에서:

```powershell
cd C:\wookagent
scripts\wook-server.cmd --data-dir "$env:USERPROFILE\wook-data" --web-dir out\web
```

나와야 하는 것 (이 창은 서버가 끝날 때까지 이대로 둡니다):

```text
(node:<pid>) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
욱채 서버 준비 완료: 주소 http://127.0.0.1:7317 (127.0.0.1과 ::1에서 받음) · 실행 ID <…> · 데이터 폴더 C:\Users\<사용자>\wook-data
```

- 창 제목이 `욱채 서버 (pid …)`로 바뀝니다. 이 창은 화면 조작에서 막히는 창입니다(SERVER_INSTALL 9절 6번).
- 처음 시작하면 서버가 `<데이터 폴더>\bin\WookServerHelper.exe`를 컴파일합니다. 몇 초 걸릴 수 있습니다.

원래 창에서 확인합니다:

```powershell
scripts\wook-server.cmd status --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것:

```text
욱채 서버 상태
  프로세스      pid <pid>, 14초째 실행 중
  주소          http://127.0.0.1:7317 (이 PC 안에서만 — 127.0.0.1과 ::1에서 받습니다)
  데이터 폴더   C:\Users\<사용자>\wook-data
  실행 ID       <…>
  진행 중 작업  없음
  긴급 정지     꺼짐
  비밀 값 저장  OS 보안 저장소
  화면 조작     <화면 조작 상태>
  관리 채널     서버 도우미 — 다른 기기(SMB) 거부
  절전 방지     idle — 진행 중 작업이 없어 막지 않습니다
  배포 점검     <시각>에 — 통과 9 · 경고 4 (autologon, lock, task, tailscale) · 실패 0 · 건너뜀 0 (wook-server check로 자세히)
  시험용 세션   꺼짐 (--allow-test-session 없이 시작)
  버전          0.1.0
```

- `관리 채널`이 `서버 도우미 — 다른 기기(SMB) 거부`여야 합니다.
- `절전 방지`는 진행 중 작업이 없으면 `idle`, 작업 중이면 `awake — 작업 중이라 시스템 절전을 막고 있습니다`입니다. 작업이 막 시작돼 절전 방지 도우미의 답을 기다리는 동안은 `pending — 작업 중 — 절전 방지 도우미의 답을 기다리는 중이라 아직 막지 못했습니다`이고, 도우미를 끝내 쓰지 못하면 `unavailable — …`(작업 중에도 PC가 절전에 들 수 있습니다)가 됩니다.
- `배포 점검`은 서버가 시작 뒤 한 번 돌린 점검(7단계의 `check`와 같은 13개 항목)의 요약입니다. 시작 직후에는 `아직 없음 — …`일 수 있습니다. 경고는 7단계에서 차례로 없앱니다. (이 줄의 수는 7단계 표와 같은 점검의 요약입니다 — 이 PC에서는 이 단계의 서버를 점검 없이 띄워 `아직 없음`이 나왔고, 줄의 꼴은 `status`가 내는 그대로입니다.)
- `화면 조작` 줄은 서버가 마지막으로 본 화면 세션의 상태입니다. (이 PC에서는 화면 조작을 꺼 두어 `서버 PC의 운영자가 화면 조작을 꺼 두었습니다 (server.json의 screen.enabled: false) — …`가 나왔습니다.)

안 되면:

- 서버 창에 `server.json의 … 모양이 아닙니다`가 나오고 끝남 → 4단계 블록의 메일을 고쳐 다시 붙여 넣고, 서버를 다시 띄웁니다.
- `--web-dir 폴더가 서버용 웹 화면이 아닙니다` → 2단계의 `npm run build:web`.
- 포트 7317을 다른 프로그램이 씀 → 서버 창의 글대로 그 프로그램을 끄거나, 서버를 띄우는 줄에만 `--port <번호>`를 붙입니다 — 위의 설정용 서버와 8단계의 `install-task`입니다. 6단계의 `tailscale serve`도 그 번호로 합니다. `status`·`config`·`check` 같은 운영자 명령에는 붙이지 않습니다(데이터 폴더로 서버를 찾고, `--port`를 주면 쓰임새 오류로 거부합니다).
- `관리 채널`이 `Node 파이프 — 다른 기기를 거부하지 못함 (<까닭>)` → 까닭(csc.exe가 없음, 백신이 실행 파일을 바꿈 등)을 고치고 서버를 다시 띄웁니다. 그동안은 6단계의 445 막기 규칙이 꼭 필요합니다(SERVER_INSTALL 4절 6번).
- `실행 중인 욱채 서버가 없습니다` → 서버 창이 준비 줄을 냈는지, `--data-dir`이 같은지 봅니다.

## 5. 구글 로그인 클라이언트 — [사람]

**[사람]** 구글 클라우드 콘솔에서 **'TV 및 입력 제한 기기'** 종류의 OAuth 클라이언트를 만듭니다. 순서는 [SERVER_INSTALL.md](SERVER_INSTALL.md) 2절입니다. 게시 상태가 '테스트'면 테스트 사용자에 대표의 구글 계정을 꼭 넣습니다.

받은 클라이언트 ID를 넣습니다:

```powershell
scripts\wook-server.cmd config google-client-id <클라이언트 ID> --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것:

```text
구글 클라이언트 ID를 server.json에 쓰고 적용했습니다: 바꾼 것 1개
  - 구글 클라이언트 ID → 1234567890-abc.apps.googleusercontent.com
```

보안 비밀은 **[사람]**이 넣습니다. 명령 줄에 쓰지 않습니다. 아래를 치면 화면에 보이지 않게 붙여 넣을 수 있습니다:

```powershell
scripts\wook-server.cmd secret set google-client-secret --data-dir "$env:USERPROFILE\wook-data"
```

또는 보안 비밀을 파일로 받았으면:

```powershell
Get-Content .\google-secret.txt | scripts\wook-server.cmd secret set google-client-secret --data-dir "$env:USERPROFILE\wook-data"
Remove-Item .\google-secret.txt
```

나와야 하는 것:

```text
구글 로그인 보안 비밀을 OS 보안 저장소에 넣었습니다 (값은 다시 보여 주지 않습니다).
```

확인:

```powershell
scripts\wook-server.cmd config show --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것 (그 가운데):

```text
  구글 클라이언트 1234567890-abc.apps.googleusercontent.com
  구글 보안 비밀  등록됨 (OS 보안 저장소)
```

- 보안 비밀은 Windows 자격 증명 관리자에 들어갑니다. 다시 시작해도 남습니다(12단계에서 확인).
- (이 PC에서는 파일로 넣는 꼴만 돌렸습니다. 서버는 가짜 비밀 값 저장소로 띄워 실제 자격 증명 관리자를 건드리지 않았습니다. 붙여 넣는 꼴은 돌려 보지 않음.)

안 되면:

- `구글이 이 클라이언트 ID로 기기 코드를 내주지 않았습니다 (invalid_client)` (11단계의 로그인 화면 — 괄호 안은 `unauthorized_client`일 수도 있습니다) → 클라이언트 종류가 'TV 및 입력 제한 기기'인지, 넣은 ID가 그 클라이언트의 ID인지 봅니다.
- 실수로 비밀 값을 명령 줄에 붙였으면 그 값은 쓰이지 않습니다. 셸 기록에서 그 줄을 지우고 구글 클라우드 콘솔에서 보안 비밀을 새로 만듭니다(SERVER_INSTALL 2절).

## 6. Tailscale — [사람]

```powershell
tailscale up
```

**[사람]** 열린 브라우저에서 Tailscale 계정으로 로그인합니다. 대표의 휴대폰에도 Tailscale 앱을 깔고 같은 tailnet에 로그인합니다.

**[사람]** Tailscale 관리 콘솔(https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다.

서버 앞에 `tailscale serve`를 둡니다 (`funnel`은 쓰지 않습니다 — 인터넷 전체에 엽니다):

```powershell
tailscale serve --bg 7317
tailscale serve status
```

- `tailscale serve status`에 `https://<서버 PC 이름>.<tailnet>.ts.net`과 `http://127.0.0.1:7317`로 넘기는 줄이 보이면 됩니다.
- (이 PC에서는 `tailscale up`과 `tailscale serve`를 돌려 보지 않음 — Tailscale 설정을 바꾸는 명령입니다.)

그 주소를 서버의 **공개 주소**로, 이 PC의 Tailscale 로그인을 **받는 Tailscale 사용자**로 server.json에 더합니다:

```powershell
& {
  $ErrorActionPreference = 'Stop'
  $f = "$env:USERPROFILE\wook-data\server.json"
  $enc = [Console]::OutputEncoding
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  try { $ts = tailscale status --json --peers=false | Out-String | ConvertFrom-Json } finally { [Console]::OutputEncoding = $enc }
  $name = "$($ts.Self.DNSName)".TrimEnd('.')
  $login = "$($ts.User.("$($ts.Self.UserID)").LoginName)"
  if (-not $name -or -not $login) { throw 'tailscale status에서 이 PC의 이름이나 로그인을 읽지 못했습니다 - tailscale up을 먼저 하세요' }
  $j = Get-Content -Raw -Encoding UTF8 $f | ConvertFrom-Json
  $j.owner | Add-Member -Force -NotePropertyName tailscaleLogins -NotePropertyValue @($login)
  $j | Add-Member -Force -NotePropertyName network -NotePropertyValue ([pscustomobject]@{ publicOrigin = "https://$name" })
  $j | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $f
  "server.json: 공개 주소 https://$name, 받는 Tailscale 사용자 $login"
}
scripts\wook-server.cmd config reload --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것:

```text
server.json: 공개 주소 https://<서버 PC 이름>.<tailnet>.ts.net, 받는 Tailscale 사용자 <Tailscale 로그인>
운영자 설정을 다시 읽었습니다: 바꾼 것 2개
  - 공개 주소 → https://<서버 PC 이름>.<tailnet>.ts.net
  - 받는 Tailscale 사용자 → 켬 (1명)
```

- 블록은 Tailscale의 JSON(UTF-8)을 바르게 읽으려고 그 동안만 콘솔의 출력 인코딩을 UTF-8로 바꾸고 되돌립니다.
- 이제 server.json에 4~6단계의 값이 모두 있습니다. `Get-Content -Encoding utf8 "$env:USERPROFILE\wook-data\server.json"`으로 보면 이렇습니다 (이 PC에서는 `screen.enabled`가 `false`, 경로가 임시 폴더였습니다):

  ```text
  {
      "owner":  {
                    "email":  "owner@example.com",
                    "tailscaleLogins":  [
                                            "<Tailscale 로그인>"
                                        ]
                },
      "seat":  {
                   "initialHolder":  "launched:claude"
               },
      "workspaceRoot":  "C:\\Users\\<사용자>\\wook-workspace",
      "screen":  {
                     "enabled":  true
                 },
      "google":  {
                     "clientId":  "1234567890-abc.apps.googleusercontent.com"
                 },
      "network":  {
                      "publicOrigin":  "https://<서버 PC 이름>.<tailnet>.ts.net"
                  }
  }
  ```

- 받는 Tailscale 사용자를 정하면 그 사용자의 요청만 받습니다. 대표의 휴대폰은 같은 Tailscale 계정으로 로그인해야 합니다. 다른 계정이면 그 계정의 로그인 이름을 server.json의 `owner.tailscaleLogins`에 더하고 `config reload`를 다시 합니다(SERVER_INSTALL 4절 5번).

겹 방어로 tailnet 쪽 SMB(TCP 445)를 막습니다. **관리자 PowerShell**에서 (이 PC에서는 돌려 보지 않음 — 방화벽을 바꾸는 명령입니다):

```powershell
New-NetFirewallRule -DisplayName "욱채 - Tailscale SMB 막기" -Direction Inbound -Protocol TCP -LocalPort 445 -InterfaceAlias "Tailscale" -Action Block
```

- `Tailscale`은 Tailscale 네트워크 어댑터의 이름입니다. 다르면 `Get-NetAdapter`로 확인해 바꿉니다(SERVER_INSTALL 4절 6번).
- 원하면 **[사람]** Tailscale 관리 콘솔의 접근 규칙(ACL)으로 이 PC에는 대표의 기기만 닿게 합니다.

안 되면:

- 블록이 `tailscale status에서 … 읽지 못했습니다`로 멈춤 → `tailscale up`이 끝났는지, `tailscale status`가 이 PC를 보이는지 봅니다.
- `config reload`가 `공개 주소 … 모양이 아닙니다`로 아무것도 바꾸지 않음 → server.json의 `network.publicOrigin`이 `https://<이름>` 꼴인지 봅니다.
- 같은 Tailscale 이름에 다른 `tailscale serve` 항목이 있으면 7단계의 `check`가 경고합니다. 그 이름에는 욱채만 둡니다(그 이름의 로그인 쿠키가 그쪽에도 갑니다). `tailscale serve reset`은 다른 항목까지 지우니 쓰지 않습니다.

## 7. 화면 세션 — [사람: 암호] 그리고 점검

서버는 사용자가 로그인한 화면에서 돌아야 하고, 그 화면이 잠기면 화면 조작이 막힙니다. 다시 시작한 뒤에도 사람 없이 로그인되게 합니다.

1. **자동 로그온 [사람: 암호]**: [Sysinternals Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon)을 받아 `Autologon64.exe`를 열고 이 사용자·도메인·암호를 넣고 Enable을 누릅니다. 암호는 LSA 비밀로 저장됩니다. 레지스트리의 `DefaultPassword`에 암호를 적는 방법은 쓰지 않습니다. Microsoft 계정이면 먼저 설정 → 계정 → 로그인 옵션에서 'Windows Hello 로그인만 허용'을 끕니다.
2. **화면 보호기와 동적 잠금 끄기 [사람]**: 설정 → 개인 설정 → 잠금 화면 → 화면 보호기 설정에서 '없음'(또는 '다시 시작할 때 로그온 화면 표시' 끔). 설정 → 계정 → 로그인 옵션에서 동적 잠금을 끕니다.
3. **절전에서 깨어날 때 암호 묻지 않기**:

   ```powershell
   powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
   powercfg /setactive SCHEME_CURRENT
   powercfg /qh SCHEME_CURRENT SUB_NONE CONSOLELOCK
   ```

   마지막 줄의 출력에서 `현재 AC 전원 설정 색인`이 `0x00000000`이면 됩니다. 이 설정은 숨은 설정이라 `/query`로는 보이지 않고 `/qh`로 봅니다. 아래는 바꾸기 전 이 PC의 출력입니다(`0x00000001` = 암호를 묻습니다):

   ```text
   전원 구성표 GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (균형 조정)
     GUID 별칭: SCHEME_BALANCED
     하위 그룹 GUID: fea3413e-7e05-4911-9a71-700331f1c294  (하위 그룹에 속하지 않은 설정)
       GUID 별칭: SUB_NONE
       전원 설정 GUID: 0e796bdb-100d-47d6-a2d5-f7d2daa51f51  (절전 모드 해제 시 암호 사용)
         GUID 별칭: CONSOLELOCK
         가능한 설정 색인: 000
         가능한 설정 이름: 아니요
         가능한 설정 색인: 001
         가능한 설정 이름: 예
       현재 AC 전원 설정 색인: 0x00000001
       현재 DC 전원 설정 색인: 0x00000001
   ```

4. **전원에 꽂혀 있으면 잠들지 않기**:

   ```powershell
   powercfg /change standby-timeout-ac 0
   powercfg /change hibernate-timeout-ac 0
   powercfg /qh SCHEME_CURRENT SUB_SLEEP STANDBYIDLE
   ```

   `현재 AC 전원 설정 색인: 0x00000000`이면 됩니다. 서버는 작업 중에만 절전을 막습니다. 잠든 PC는 휴대폰에서 닿지 않습니다. 화면(디스플레이)은 꺼져도 됩니다.

5. **원격 데스크톱(RDP)으로 들어왔으면 [사람]**: 연결을 그냥 끊으면 이 세션의 화면이 잠깁니다. 끊기 전에 그 세션에서 **관리자 PowerShell**을 열고:

   ```powershell
   tscon ((Get-Process -Id $PID).SessionId) /dest:console
   ```

   RDP 창은 닫히고 화면은 콘솔에서 살아 있습니다. 해상도가 바뀔 수 있습니다(KNOWN_ISSUES).

(3·4·5번의 설정 바꾸기와 1·2번은 이 PC에서는 돌려 보지 않음. `powercfg /qh`로 읽기만 했습니다.)

그다음 점검합니다:

```powershell
scripts\wook-server.cmd check --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것: 모든 줄이 `통과`(또는 `건너뜀`)이고 마지막 줄이 `결과: … 실패 0 …`입니다. 아래는 위 1~4번과 6단계의 `tailscale serve`를 하기 **전**의 이 PC의 출력입니다. 경고마다 `할 일:`이 그 고칠 길이고, `wook-server` 명령에는 점검한 데이터 폴더가 `--data-dir`로 붙어 나옵니다(그대로 치면 됩니다 — `wook-server`는 `scripts\wook-server.cmd`):

```text
욱채 서버 배포 점검 (2026-11-11T15:17:29.924Z — 바꾼 것은 없습니다)
  통과   세션              Console (세션 1)
  경고   자동 로그온       자동 로그온이 꺼져 있습니다 — 다시 시작하면 로그인 화면에서 멈춰 작업(로그온할 때)이 돌지 않습니다
                           할 일: Sysinternals Autologon으로 이 계정의 자동 로그온을 켜세요 (암호는 LSA 비밀로 둡니다 — Microsoft 계정이면 먼저 'Windows Hello 로그인만 허용'을 끕니다)
  경고   화면 잠금         절전에서 깨어날 때 암호를 묻습니다 (CONSOLELOCK) — 잠긴 화면은 검게 찍히고 입력이 먹지 않습니다
                           할 일: powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0 그다음 powercfg /setactive SCHEME_CURRENT
  통과   절전              전원에 꽂혀 있으면 절전에 들지 않습니다
  경고   작업 스케줄러     등록된 작업이 없습니다 (WookServer-<8자>) — 다시 시작하면 서버가 스스로 뜨지 않습니다
                           할 일: wook-server install-task --data-dir "C:\Users\<사용자>\wook-data"
  통과   데이터 폴더       C:\Users\<사용자>\wook-data — 이 사용자·SYSTEM·Administrators만 열 수 있습니다
  통과   Node              Node 24.13.0
  통과   Claude CLI        C:\Users\<사용자>\.local\bin\claude.exe · 로그인됨 (claude.ai)
  통과   Codex CLI         C:\Users\<사용자>\AppData\Roaming\npm\node_modules\@openai\codex\…\codex.exe · 로그인됨 (ChatGPT)
  통과   API 키 환경 변수  구독 방식 AI에 걸리는 API 키 환경 변수가 없습니다
  통과   화면 조작         화면 조작을 꺼 두었습니다 (server.json screen.enabled false)
  통과   SMB(관리 채널)    관리 채널이 다른 기기(SMB)의 연결을 거부합니다 (서버 도우미) · Tailscale 쪽 TCP 445를 막는 규칙이 없습니다 (정보 — 겹 방어로 막아 두기를 권합니다)
  경고   Tailscale         tailnet의 HTTPS 인증서가 꺼져 있습니다 (CertDomains가 비었습니다) · 이 서버(포트 7317)로 넘기는 tailscale serve 항목이 없습니다 · 같은 이름에 다른 항목이 있습니다: TCP 80 → 127.0.0.1:7878, TCP 7878 → 127.0.0.1:7878 — 그 이름의 로그인 쿠키가 그쪽에도 갑니다 (S3-31)
                           할 일: Tailscale 관리 콘솔 → DNS에서 MagicDNS와 HTTPS 인증서를 켜세요 · tailscale serve --bg 7317 뒤 그 https 주소를 server.json network.publicOrigin에 넣고 wook-server config reload --data-dir "C:\Users\<사용자>\wook-data" · 다른 서비스는 다른 Tailscale 기기 이름에 두세요
결과: 통과 9 · 경고 4 (autologon, lock, task, tailscale) · 실패 0 · 건너뜀 0 — 실패가 없습니다
```

- `작업 스케줄러` 경고는 8단계에서 없어집니다.
- `데이터 폴더`는 4단계의 `icacls` 줄로 좁힌 폴더라 통과입니다. 다른 계정도 열 수 있으면 `경고` 줄에 `다른 계정도 데이터 폴더를 열 수 있습니다 (<계정들>) — …`가 나오고, 그 폴더를 좁히는 `icacls` 줄이 `할 일:`로 나옵니다([부록 B](#부록-b-문제-해결--check-항목별)).
- 이 표는 `screen.enabled`를 `false`로 둔 서버에서 본 것입니다. 켜 두면 `화면 조작` 줄에 화면 세션 확인 결과(잠김, 연결 끊김, 관리자 권한 등)가 나옵니다.
- 이 표를 만든 곳: 세션부터 작업 스케줄러까지, Node, CLI 둘, API 키 환경 변수, Tailscale 줄은 2026-11-11에 이 PC에서 돌린 실제 `check`의 출력(서버를 띄우지 않고 빈 데이터 폴더로)에서 옮겼습니다. 화면 조작·SMB 줄은 서버를 띄우고 돌린 그 전의 실제 `check`에서, 데이터 폴더 줄은 4단계대로 좁힌 폴더일 때 `check`가 내는 글입니다. 줄 모양(칸 맞춤)은 점검 코드가 내는 그대로이고, PC 이름·계정·경로만 바꿨습니다.
- 점검은 아무것도 바꾸지 않습니다. 무엇을 읽는지 보려면 `scripts\wook-server.cmd check --dry-run --data-dir "$env:USERPROFILE\wook-data"`(점검 스크립트를 보여 주기만 합니다 — 레지스트리의 정한 값들, `powercfg /qh`, 작업 스케줄러, 데이터 폴더의 권한(`Get-Acl`), 서비스·방화벽 규칙, `tailscale status`). 레지스트리의 `DefaultPassword`는 값이 있는지만 보고 읽지 않습니다.
- 실패가 하나라도 있으면 끝 코드가 1입니다. 항목별 고칠 길은 [부록 B](#부록-b-문제-해결--check-항목별)에 있습니다.

## 8. 작업 스케줄러에 등록하고 띄우기

설정용 서버를 끕니다(그 창에 '서버를 종료했습니다'가 나오고 창의 서버가 끝납니다):

```powershell
scripts\wook-server.cmd shutdown --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것:

```text
서버를 종료했습니다.
```

로그온할 때 이 사용자로 서버를 띄우는 작업을 등록합니다. 먼저 무엇을 등록하는지 봅니다:

```powershell
scripts\wook-server.cmd install-task --dry-run --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것 (그 뒤에 작업 XML과, 등록한 뒤 작업을 다시 읽는 스크립트가 이어집니다):

```text
[시험 실행 — 아무것도 바꾸지 않았습니다] 등록할 작업: WookServer-<8자>
  Node          <Node 경로>\node.exe
  서버 진입점   C:\wookagent\out\server\index.mjs
  데이터 폴더   C:\Users\<사용자>\wook-data
  웹 화면       C:\wookagent\out\web
  인자          "C:\wookagent\out\server\index.mjs" serve --data-dir "C:\Users\<사용자>\wook-data" --web-dir "C:\wookagent\out\web"
  실행 계정     S-1-5-21-<…>-1001 (로그온할 때 30초 뒤, 관리자 권한 없이, 이 사용자의 화면에서)
실행할 명령
  schtasks /create /tn WookServer-<8자> /xml <임시 파일> /f
  powershell.exe -NoProfile -NonInteractive -EncodedCommand <아래 다시 읽기 스크립트의 UTF-16LE base64>  (등록한 작업을 작업 스케줄러 COM으로 그대로 다시 읽어 견줍니다 — 읽기만)
작업 XML (UTF-16, BOM — 임시 파일에 이대로 씁니다)
…
다시 읽기 스크립트 (Windows PowerShell 5.1 — 읽기만)
…
```

- 웹 화면은 `out\web`(2단계에서 만든 것)을 저절로 넣습니다. 포트를 바꿨으면 `--port <번호>`를 붙입니다. `--allow-test-session`은 받지 않습니다.
- 등록한 뒤 작업 스케줄러에서 작업을 그대로 다시 읽어(COM — 콘솔의 코드 페이지를 거치지 않습니다) Node·인자·실행 계정·로그온 방식·권한 수준(`LeastPrivilege`)·동작이 쓴 것과 같은지 봅니다.

맞으면 등록합니다:

```powershell
scripts\wook-server.cmd install-task --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것 (이 PC에서는 등록하지 않았습니다 — 아래는 명령이 성공할 때 내는 글을 코드에서 옮긴 것입니다):

```text
작업 스케줄러에 등록했습니다: WookServer-<8자>
  …(위의 --dry-run과 같은 여섯 줄)
다음 할 일
  지금 띄우기   schtasks /run /tn WookServer-<8자>
  확인          wook-server status --data-dir "C:\Users\<사용자>\wook-data"
  끄기          wook-server shutdown --data-dir "C:\Users\<사용자>\wook-data" (작업을 지워도 실행 중인 서버는 그대로입니다)
서버가 뜨면 '욱채 서버 (pid …)' 콘솔 창이 보입니다 — 그 창을 닫지 말고 wook-server shutdown으로 끄세요 (창을 닫으면 정리가 5초쯤에서 잘릴 수 있습니다)
```

등록한 작업을 지금 띄우고 확인합니다. 첫 줄은 작업 이름(`WookServer-<8자>`)을 `install-task --dry-run --json`에서 읽어 `$task`에 둡니다:

```powershell
$task = (scripts\wook-server.cmd install-task --dry-run --json --data-dir "$env:USERPROFILE\wook-data" | ConvertFrom-Json).result.name
schtasks /run /tn $task
scripts\wook-server.cmd status --data-dir "$env:USERPROFILE\wook-data"
```

- `$task`는 `WookServer-`와 16진 8자입니다(첫 줄만 이 PC에서 돌렸습니다).
- `schtasks /run`은 `성공:`으로 시작하는 한 줄을 냅니다. 몇 초 뒤 `욱채 서버 (pid …)` 창이 뜹니다. (이 PC에서는 돌려 보지 않음.)
- `status`는 4단계와 같은 꼴이어야 합니다. 서버가 막 떴으면 몇 초 뒤 다시 칩니다.
- **서버 창을 닫지 않습니다.** 끌 때는 `scripts\wook-server.cmd shutdown --data-dir "$env:USERPROFILE\wook-data"`입니다.

안 되면:

- `로그인한 사용자 계정으로 실행해야 합니다 — LocalSystem·서비스 계정 금지` → 0단계의 계정·세션.
- `… 큰따옴표(")나 퍼센트(%)·제어 문자가 있어 작업에 넣지 않습니다` → 그런 글자가 없는 폴더로 옮깁니다(읽기 전에).
- `서버 진입점이 없습니다` → 2단계의 `npm run build:server`.
- `등록한 작업이 쓴 것과 다릅니다 (…)`로 끝 코드 1 → 괄호 안이 다른 칸입니다(`Command(Node)`·`Arguments`·`UserId`·`LogonType`·`RunLevel`·`Actions`). 누가 같은 이름의 작업을 손으로 바꾸고 있지 않은지 보고, 그 글을 그대로 보관한 뒤 `uninstall-task`와 `install-task`를 다시 합니다.
- `등록한 작업을 다시 읽지 못했습니다 (…)`나 `등록했다는 작업이 작업 스케줄러에 보이지 않습니다`로 끝 코드 1 → 작업 스케줄러(`taskschd.msc`)에서 `$task`의 이름을 찾아봅니다. 괄호 안이 `Windows PowerShell …`이면 `powershell.exe`가 있는지 봅니다.
- `status`가 `실행 중인 욱채 서버가 없습니다` → 서버 창의 글과 `<데이터 폴더>\logs\server.log`의 끝을 봅니다. 작업 스케줄러(`taskschd.msc`)의 그 작업 '기록' 탭도 봅니다.

## 9. 외부 에이전트 — 그록봇

서버가 띄우는 Claude CLI 대신 이 PC의 다른 에이전트(그록봇 등)를 메인 자리에 앉힙니다. **[SERVER_INSTALL.md](SERVER_INSTALL.md) 10절을 그대로 따릅니다.** 에이전트가 서버에 붙는 방법(키·주소·확인값, `wook` 명령)은 [AGENT_GUIDE.md](AGENT_GUIDE.md)에 있습니다. 이 문서에 따로 줄인 방법은 없습니다.

- 등록은 한 번만 합니다. 에이전트가 같은 Windows 계정에서 돌면 10절 2의 블록 하나가 등록(`agent add`)과 키 파일 `~/.wook/agent.json` 쓰기를 함께 합니다 — 키가 화면에 남지 않습니다. 그때 10절 1의 `agent add`는 따로 치지 않습니다(같은 이름은 두 번 등록되지 않습니다).
- 에이전트를 다른 방법으로 띄우면 10절 1로 등록하고(키가 그때 한 번만 화면에 나옵니다) 키를 환경 변수 `WOOK_AGENT_KEY`로 넘깁니다.
- 그다음 10절 3(배정). 데이터 폴더 자리에는 `"$env:USERPROFILE\wook-data"`를 넣습니다. 배정은 이렇게 됩니다(ID는 등록에서 받은 것):

```powershell
scripts\wook-server.cmd seat assign external:X-0001 --data-dir "$env:USERPROFILE\wook-data"
scripts\wook-server.cmd seat status --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것:

```text
메인 자리를 그록봇에게 넘겼습니다 (세대 1 → 2, 운영자 배정). 메인 토큰을 폐기하고 메인 세션을 닫았습니다. 새 보유자는 인계 꾸러미를 받고 쌓인 일을 이어서 처리합니다.
욱채 메인 자리
  보유자          그록봇 (세대 2, <시각>부터)
  상태            앉아 있음
  응답            응답함
  앉을 수 있는 쪽 launched:claude, launched:codex, external:*(등록한 외부 에이전트 모두)
  마무리 기다림   120초
  최근 이력       세대 2 그록봇 — 운영자, <시각>부터
                  세대 1 Claude CLI — 서버, <시각>부터 <시각>까지 (운영자가 바꿈: 운영자 복구 배정 (wook-server seat assign))
```

- 에이전트가 60초 안에 자리를 잡지 않으면 `응답`이 '응답 없음 … 60초 동안 claim하지 않음'으로 바뀝니다. 에이전트를 띄우고 AGENT_GUIDE대로 `wook seat claim`을 하게 합니다(SERVER_INSTALL 10절 6).
- (이 PC에서는 에이전트를 등록한 뒤 위 두 줄만 돌렸습니다. 10절 2의 키 파일 블록은 이 문서를 쓰며 돌려 보지 않음 — 실제 `~/.wook`를 쓰는 블록입니다.)

## 10. 처음 메인 자리

9단계 전까지 메인 자리는 server.json의 `seat.initialHolder`대로 서버가 띄우는 Claude CLI입니다. 9단계를 하지 않을 때의 `seat status`는 이렇습니다:

```powershell
scripts\wook-server.cmd seat status --data-dir "$env:USERPROFILE\wook-data"
```

```text
욱채 메인 자리
  보유자          Claude CLI (세대 1, <시각>부터)
  상태            앉아 있음
  응답            응답함
  앉을 수 있는 쪽 launched:claude, launched:codex, external:*(등록한 외부 에이전트 모두)
  마무리 기다림   120초
  최근 이력       세대 1 Claude CLI — 서버, <시각>부터
```

- 메인 자리를 바꾸는 것은 메인 에이전트(`hand_off_seat`)와 운영자의 `seat assign`뿐입니다. 서버는 응답하지 않는 메인을 스스로 바꾸지 않습니다(SERVER_INSTALL 6절).

## 11. 대표의 첫 로그인 — [사람: 휴대폰]

**[사람]** 대표가 휴대폰의 Tailscale 앱을 켜고, 휴대폰 브라우저로 `https://<서버 PC 이름>.<tailnet>.ts.net`을 엽니다. 로그인 화면의 코드를 google.com/device에 넣고 대표 메일의 구글 계정으로 승인합니다(SERVER_INSTALL 5절). 서버 PC의 브라우저에서는 대표로 로그인하지 않습니다(SERVER_INSTALL 9절 5번).

확인:

```powershell
scripts\wook-server.cmd config show --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것: `대표 계정` 줄이 `구글 계정 등록됨`으로 바뀝니다(로그인 전에는 `아직 등록 전 — 대표 이메일의 구글 계정으로 처음 로그인하면 등록됩니다`). `기기 세션` 줄의 수가 1 늘어납니다. (이 PC에서는 돌려 보지 않음 — 실제 구글 로그인과 휴대폰이 필요합니다.)

안 되면:

- 휴대폰에서 주소가 열리지 않음 → 휴대폰의 Tailscale이 켜져 있는지, 6단계의 `tailscale serve status`에 그 주소가 있는지 봅니다.
- 로그인 화면도 열리지 않고 403 → 휴대폰의 Tailscale 계정이 `owner.tailscaleLogins`에 있는지 봅니다(6단계).
- 구글이 로그인을 막음 → 5단계의 테스트 사용자에 대표의 구글 계정이 있는지 봅니다.

## 12. 마지막 점검과 다시 시작 — [사람]

```powershell
scripts\wook-server.cmd check --data-dir "$env:USERPROFILE\wook-data"
```

마지막 줄이 `결과: … 실패 0 …`이고 경고가 없어야 합니다(남은 경고마다 [부록 B](#부록-b-문제-해결--check-항목별)).

**[사람]** PC를 다시 시작합니다. 그다음 차례로 봅니다 (이 PC에서는 돌려 보지 않음):

1. 로그인 화면에서 멈추지 않고 자동으로 로그인됩니다(7단계 1번).
2. 로그온 30초쯤 뒤 `욱채 서버 (pid …)` 창이 뜹니다(8단계의 작업).
3. `scripts\wook-server.cmd status --data-dir "$env:USERPROFILE\wook-data"`가 4단계와 같은 꼴입니다.
4. 대표의 휴대폰은 다시 로그인하지 않아도 화면이 열립니다(기기 세션은 쓰지 않고 14일, 최대 90일).
5. `scripts\wook-server.cmd config show --data-dir "$env:USERPROFILE\wook-data"`의 `구글 보안 비밀` 줄이 여전히 `등록됨 (OS 보안 저장소)`입니다.

## 13. 되돌리기

구글 보안 비밀도 지우려면 **서버가 도는 동안 먼저** 지웁니다. 비밀은 Windows 자격 증명 관리자에 있어 데이터 폴더를 지워도 남고, `secret clear`는 실행 중인 서버에 보내는 명령이라 서버를 끈 뒤에는 '실행 중인 욱채 서버가 없습니다'로 끝납니다:

```powershell
scripts\wook-server.cmd secret clear google-client-secret --data-dir "$env:USERPROFILE\wook-data"
```

나와야 하는 것:

```text
구글 로그인 보안 비밀을 지웠습니다. 다시 넣기 전까지 기기 코드 로그인을 시작할 수 없습니다.
```

그다음 서버를 끄고 작업을 지웁니다:

```powershell
scripts\wook-server.cmd shutdown --data-dir "$env:USERPROFILE\wook-data"
scripts\wook-server.cmd uninstall-task --data-dir "$env:USERPROFILE\wook-data"
tailscale serve --https=443 off
```

- `uninstall-task`는 작업만 지우고 실행 중인 서버는 끄지 않습니다. 그래서 `shutdown`을 먼저 합니다. 작업이 없으면 `등록된 작업이 없습니다 (WookServer-<8자>) — 바꾼 것이 없습니다`로 0으로 끝납니다. 작업이 있는지 읽지 못하면 지우지 않고 `작업이 있는지 읽지 못해 지우지 않았습니다 (…)`로 1로 끝납니다 — 작업 스케줄러(`taskschd.msc`)에서 그 이름을 봅니다.
- 무엇을 지우는지 먼저 보려면 `uninstall-task --dry-run` (그 뒤에 작업이 있는지 읽는 스크립트가 이어집니다):

  ```text
  [시험 실행 — 아무것도 바꾸지 않았습니다] 지울 작업: WookServer-<8자>
  실행할 명령
    powershell.exe -NoProfile -NonInteractive -EncodedCommand <아래 다시 읽기 스크립트의 UTF-16LE base64>  (작업이 있는지 작업 스케줄러 COM으로 읽습니다 — 읽기만, 지운 뒤에도 한 번 더)
    schtasks /delete /tn WookServer-<8자> /f
  다시 읽기 스크립트 (Windows PowerShell 5.1 — 읽기만)
  …
  ```

- `tailscale serve reset`은 이 이름의 다른 항목까지 지우니 쓰지 않습니다.
- **[사람]** 자동 로그온은 `Autologon64.exe`의 Disable로 끕니다.
- 방화벽 규칙은 **관리자 PowerShell**에서 `Remove-NetFirewallRule -DisplayName "욱채 - Tailscale SMB 막기"`.
- 데이터 폴더(`$env:USERPROFILE\wook-data`)와 작업 폴더(`$env:USERPROFILE\wook-workspace`)는 지우지 않으면 남습니다.
- (이 PC에서는 `secret clear`와 `shutdown`을 임시 데이터 폴더의 서버와 가짜 비밀 값 저장소로, `uninstall-task`는 `--dry-run`만 돌렸습니다. 나머지는 돌려 보지 않음.)

## 부록 A. 깨끗한 VM 점검표

새 Windows VM(클라우드 VM 포함)에서 이 문서만 보고 설치하며 확인할 것입니다. '이 PC'는 위 출력을 찍은 PC(대표가 쓰는 Windows 10 Pro, 시험 기계가 아님)입니다. 이 PC에서는 작업 등록, 시스템·전원·방화벽·자동 로그온 설정, Tailscale 설정, 실제 구글 로그인, 다시 시작을 하지 않았습니다(리드 결정 S9-13).

| # | 확인할 것 | 어떻게 | 이 PC 결과 |
|---|---|---|---|
| 1 | 새 Windows(실행 정책 `Restricted`)에서 0단계의 `Set-ExecutionPolicy -Scope CurrentUser` 뒤 npm·claude·codex가 돈다 | 0·1단계 | 이 PC에서는 확인하지 못함 (이미 `RemoteSigned`). `Restricted`에서 `npm`이 `npm.ps1`로 막히는 것은 이 창에만 건 정책으로 확인함 |
| 2 | `winget install … OpenJS.NodeJS.LTS`가 Node 24 이상을 넣는다 | 1단계의 `node --version` | 이 PC에서는 확인하지 못함 (winget 설치를 하지 않음) |
| 3 | winget 설치가 UAC 확인 말고는 묻지 않고 끝난다 (`--accept-…`) | 1단계 | 이 PC에서는 확인하지 못함 |
| 4 | `git clone`(비공개면 GitHub 로그인)과 `npm ci`가 된다 | 2단계 | 이 PC에서는 확인하지 못함 |
| 5 | `npm run build:server`·`build:web`·`--help` | 2단계 | 확인함 (Windows PowerShell 5.1, 코드 페이지 949) |
| 6 | 브라우저로 `claude auth login`·`codex login` | 3단계 | 이 PC에서는 확인하지 못함 (이미 로그인됨). 상태 확인 두 명령은 확인함 |
| 7 | 브라우저 없는 로그인: `codex login --device-auth`, `claude setup-token` → `setx CLAUDE_CODE_OAUTH_TOKEN` — 변수 이름이 맞고 `claude auth status`와 서버의 CLI 확인이 로그인으로 본다 | 3단계 | 이 PC에서는 확인하지 못함 (리드 결정 S9-6 '(verify)') |
| 8 | server.json 블록, 설정용 서버, `status`·`config show` | 4단계 | 확인함 (임시 데이터 폴더, 모의 메인 에이전트, 화면 조작 끔). 블록이 만든 데이터 폴더는 Get-Acl로 상속이 끊기고 이 사용자만 남은 것을 확인함. `icacls`가 실패하면 블록이 멈추고 `server.json`을 쓰지 않는 것도 확인함 |
| 9 | `config google-client-id`, `secret set google-client-secret`(파일로) | 5단계 | 확인함 (서버는 가짜 비밀 값 저장소). 붙여 넣는 꼴은 확인하지 못함 |
| 10 | `tailscale up`, MagicDNS·HTTPS 켜기, `tailscale serve --bg 7317`, `tailscale serve status`의 모양 | 6단계 | 이 PC에서는 확인하지 못함 |
| 11 | 공개 주소·받는 Tailscale 사용자 블록과 `config reload` | 6단계 | 확인함 (이 PC의 실제 `tailscale status`를 읽음) |
| 12 | 445 막기 규칙을 만들고, tailnet의 다른 기기에서 `Test-NetConnection <서버의 Tailscale 주소> -Port 445`가 실패한다 | 6단계 | 이 PC에서는 확인하지 못함 (방화벽을 바꾸지 않음, 다른 기기 필요) |
| 13 | 다른 기기에서 `\\<서버 PC 이름>\pipe\…`로 연 관리 채널 연결이 증명 전에 거부된다 | 4단계 뒤 | 이 PC에서는 SMB 루프백(`\\127.0.0.1\pipe\…`, `\\<PC 이름>\pipe\…`)으로만 확인함 (`tests/server/adminPipeRemote.test.ts`) |
| 14 | Autologon으로 자동 로그온, 다시 시작 뒤 로그인 화면에서 멈추지 않는다 | 7·12단계 | 이 PC에서는 확인하지 못함 |
| 15 | `powercfg /setacvalueindex … CONSOLELOCK 0`·`/setactive`가 관리자 권한 없이 된다 | 7단계 | 이 PC에서는 확인하지 못함 (`/qh`로 읽기만 함) |
| 16 | `powercfg /change standby-timeout-ac 0`·`hibernate-timeout-ac 0` | 7단계 | 이 PC에서는 확인하지 못함 (이 PC는 이미 0) |
| 17 | 화면 보호기·동적 잠금 끄기 뒤 `check`의 화면 잠금 항목이 통과 | 7단계 | 이 PC에서는 확인하지 못함 |
| 18 | 화면이 꺼진 동안의 캡처 (절전 방지는 화면을 켜 두지 않는다) | 7단계 뒤, 화면이 꺼진 때 | 이 PC에서는 확인하지 못함 (리드 결정 S9-4 '(verify)') |
| 19 | RDP에서 `tscon`으로 콘솔에 돌린 뒤 화면 조작, 해상도 | 7단계 5번 | 이 PC에서는 확인하지 못함 |
| 20 | 모든 단계 뒤 `check`가 실패 0·경고 0 | 12단계 | 이 PC에서는 확인하지 못함 (이 PC는 경고 4) |
| 21 | 관리자 권한 없는 보통 사용자가 `install-task`로 자기 '로그온할 때' 작업을 등록한다 | 8단계 | 이 PC에서는 확인하지 못함 (작업을 등록하지 않음 — 리드 결정 S9-3 '(verify)') |
| 22 | 작업 스케줄러가 작업의 Command·Arguments의 `%VAR%`를 펼친다 (그래서 `%`가 든 경로를 거부한다) | `%`가 든 경로로 시험 작업 | 이 PC에서는 확인하지 못함 (리드 결정 S9-3 '(verify)') |
| 23 | 작업의 Priority 6이 '보통' 우선순위로 돈다 (기본 7은 '보통보다 낮음') | 작업 관리자 → 세부 정보 → node.exe의 우선 순위 | 이 PC에서는 확인하지 못함 (스케줄러가 6을 받아 그대로 읽는 것은 확인함 — `tests/server/taskXml.test.ts`) |
| 24 | `install-task` 등록·다시 읽기, `schtasks /run`으로 뜨고 `욱채 서버 (pid …)` 창이 보인다 | 8단계 | 이 PC에서는 확인하지 못함 (`--dry-run`만). 꺼 둔 작업으로 시험하는 `tests/real/realTask.test.ts`(`WOOK_REAL_TASK=1`, `WOOK_REAL_TASK_HOST=<PC 이름>`)는 써 두었고 돌리지 않음 |
| 25 | 서버 창을 닫으면 정리가 5초쯤에서 잘린다 (KNOWN_ISSUES) | 8단계 뒤 창 닫기 | 이 PC에서는 확인하지 못함 |
| 26 | `seat assign external:<ID>`와 `seat status` | 9단계 | 확인함 |
| 27 | 대표의 휴대폰이 Tailscale을 거쳐 구글로 로그인한다 | 11단계 | 이 PC에서는 확인하지 못함 (대표와 함께 — TRY_IT 4절) |
| 28 | 다시 시작 뒤: 자동 로그온 → 작업 → `status` → 휴대폰 로그인 그대로 → 구글 보안 비밀 그대로 | 12단계 | 이 PC에서는 확인하지 못함. 비밀 값이 프로세스를 다시 띄워도 남는 것만 확인함 (`tests/server/secretApiKeys.test.ts`) |
| 29 | `uninstall-task`, `tailscale serve --https=443 off`, Autologon 끄기, 방화벽 규칙 지우기 | 13단계 | 이 PC에서는 `uninstall-task --dry-run`만 확인함. 그 앞의 `secret clear`·`shutdown`은 확인함 (가짜 비밀 값 저장소 — 서버를 끈 뒤의 `secret clear`는 '실행 중인 욱채 서버가 없습니다'로 끝나는 것도 봄) |
| 30 | 실제 화면 시험 `WOOK_REAL_DESKTOP=1`·`WOOK_REAL_DESKTOP_HOST`와 `WOOK_REAL_GUI=1`을 그 VM의 서버 모드로 | SERVER_DESIGN 10.9 | 이 PC에서는 돌리지 않음 (대표 허락이 필요, DESKTOP은 대표가 자리에 있을 때) |
| 31 | 화면 보호기를 '다시 시작할 때 로그온 화면 표시'로 쓰다가 7단계 2번대로 '(없음)'으로 바꾼 뒤 `check`의 화면 잠금 항목이 통과한다 — Windows가 `ScreenSaveActive`·`ScreenSaverIsSecure`를 1로 남겨 두어도, 고른 화면 보호기(`SCRNSAVE.EXE`)가 없으면 `check`는 화면 보호기가 잠그지 않는다고 본다 | 7단계 2번 뒤 `check` | 이 PC에서는 확인하지 못함 (화면 보호기 설정을 바꾸지 않음 — 두 값이 1로 남는 일도 이 PC에서는 다시 보지 못함) |

## 부록 B. 문제 해결 — check 항목별

`check`의 각 줄은 `통과`·`경고`·`실패`·`건너뜀`이고, 경고·실패 밑의 `할 일:`이 고칠 길입니다. 아래는 그 글과 더 볼 곳입니다. 고친 뒤 `check`를 다시 합니다.

| 항목 (`--json`의 id) | 이런 글이면 | 할 일 |
|---|---|---|
| 점검 스크립트 (`probe`) | 실패: `점검 스크립트(Windows PowerShell)가 끝나지 못했습니다 (…)` — 세션부터 데이터 폴더까지 여섯 줄이 `건너뜀` | `powershell.exe`(Windows PowerShell 5.1)가 있는지 보고 `할 일:`의 `wook-server check --data-dir "<폴더>"`로 다시 합니다. 10초 안에 끝나지 않으면 바쁜 때를 피해 다시 합니다 |
| 세션 (`session`) | 실패: `세션 0(서비스)에서 돕니다` | 서비스나 '사용자의 로그온 여부에 관계없이 실행' 작업으로 띄우지 않습니다. 8단계의 `install-task`로 등록합니다 |
| | 경고: `원격 데스크톱(RDP) 세션입니다 (RDP-Tcp#…)` | 끊기 전에 그 세션의 관리자 PowerShell에서 `tscon ((Get-Process -Id $PID).SessionId) /dest:console` (7단계 5번) |
| 자동 로그온 (`autologon`) | 경고: `자동 로그온이 꺼져 있습니다` / `자동 로그온 계정이 이 사용자가 아닙니다` | 7단계 1번 (Sysinternals Autologon) |
| | 경고: `Winlogon에 DefaultPassword 값이 있습니다 — 암호가 레지스트리에 평문으로 남습니다 (값은 읽지 않았습니다)` | Autologon으로 다시 켠 뒤 그 값을 지웁니다 (**관리자**: `Remove-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon' -Name DefaultPassword`) |
| 화면 잠금 (`lock`) | 경고: `화면 보호기가 암호로 잠급니다` — 화면 보호기를 고른 때만 나옵니다 (`(정책)`이면 암호 보호를 그룹 정책이 겁니다) | 7단계 2번 (화면 보호기 '없음', 또는 '다시 시작할 때 로그온 화면 표시' 끔). 정책이면 그 정책을 관리하는 사람에게 부탁합니다 |
| | 경고: `절전에서 깨어날 때 암호를 묻습니다 (CONSOLELOCK)` | 7단계 3번 |
| | 경고: `비활성 N분 뒤 잠급니다 (InactivityTimeoutSecs 정책)` | 보안 정책 '대화형 로그온: 컴퓨터 비활성 한도'를 0으로 둡니다 (관리자) |
| | 경고: `동적 잠금이 켜져 있습니다` | 7단계 2번 |
| 절전 (`sleep`) | 경고: `전원에 꽂혀 있어도 N분 쉬면 절전에 듭니다` / `… 최대 절전에 듭니다` | 7단계 4번 |
| | 건너뜀: `전원 설정을 읽지 못했습니다 (powercfg /qh)` | `powercfg /qh SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`를 직접 쳐 봅니다 |
| 작업 스케줄러 (`task`) | 경고: `등록된 작업이 없습니다 (WookServer-<8자>)` | 8단계 (`할 일:`의 `wook-server install-task --data-dir "<폴더>"`와 같습니다) |
| | 경고: `Node가 지금 것과 다릅니다` / `서버 진입점이 지금 것과 다릅니다` / `serve로 띄우지 않습니다` / `데이터 폴더가 지금 것과 다릅니다` / `install-task가 쓰지 않는 인자가 있습니다 (…)` / `작업의 Command·Arguments·WorkingDirectory에 %가 있습니다` / `동작이 <n>개입니다` / `서버를 띄우는 프로그램 실행(Exec) 동작이 아닙니다` / `실행 시간 상한이 있습니다` / `배터리로 돌 때 …` / `작업이 꺼져 있습니다` | `할 일:`의 `다시 등록하세요 (같은 이름을 바꿔 넣습니다): wook-server install-task … --data-dir "<폴더>"`를 그대로 칩니다 — 지금 작업의 install-task 옵션(`--port`·`--public-origin` 등)을 옮겨 적어 주므로 포트·공개 주소가 바뀌지 않습니다. Node나 저장소를 옮긴 뒤, 또는 누가 작업에 동작·인자를 더한 뒤에 생깁니다 |
| | 실패: `서비스 계정으로 돕니다` / `다른 계정으로 돕니다` / `'사용자가 로그온한 경우에만 실행'이 아닙니다` / `관리자 권한(가장 높은 수준)으로 돕니다 (RunLevel …)` / `--allow-test-session으로 띄웁니다` (따옴표로 감싸거나 `=…`를 붙여도, 둘째 동작에 있어도 — 그때는 `(<n>번째 동작)`이 붙습니다) | 누가 작업을 손으로 바꿨습니다(작업 스케줄러의 '가장 높은 수준의 권한으로 실행'을 켠 것 등). `uninstall-task` 뒤 이 사용자의 보통(관리자 아닌) PowerShell에서 `install-task`를 다시 합니다 |
| | 건너뜀: `작업 스케줄러를 읽지 못했습니다 (…)` | 8단계의 `$task = …` 줄 뒤 `schtasks /query /tn $task`를 직접 쳐 봅니다 |
| | `할 일:`에 `그대로 붙여 넣을 줄을 내지 않습니다`가 나올 때 | 데이터 폴더 이름(또는 지금 작업에서 옮길 값)에 셸이 바꾸는 글자(`$`, 백틱, `&`, `^`, `%`, `!`, 큰따옴표, 굽은 따옴표)가 있습니다. 그 줄이 알려 주는 명령을 손으로 치면서 `--data-dir`에 그 폴더를 넣습니다(데이터 폴더 항목의 `icacls` 줄도 같습니다 — `<데이터 폴더>` 자리에 그 폴더를 넣습니다). 이런 글자가 없는 폴더를 쓰면 붙여 넣을 줄이 그대로 나옵니다 |
| 데이터 폴더 (`dataDir`) | 경고: `다른 계정도 데이터 폴더를 열 수 있습니다 (<계정들>) — 그 계정이 server.json·wook.db·기록을 읽거나 bin의 서버 도우미를 바꿀 수 있습니다` | `할 일:`의 `icacls "<폴더>" /inheritance:r /grant:r "<도메인\사용자>:(OI)(CI)F"`를 그대로 칩니다(4단계의 그 줄과 같습니다 — 물려받은 권한을 끊고 이 사용자만 남깁니다). 그다음 `check`를 다시 합니다 |
| | 건너뜀: `데이터 폴더가 아직 없습니다 (…)` | 4단계를 합니다. 서버가 없는 폴더로 처음 시작하면 그 폴더를 이 사용자만 열게 만듭니다 |
| | 건너뜀: `데이터 폴더의 권한을 읽지 못했습니다 (…)` / `지금 사용자를 읽지 못해 데이터 폴더의 권한을 견주지 못했습니다` | `Get-Acl "<폴더>"`를 직접 쳐 보고 `check`를 다시 합니다 |
| Node (`node`) | 실패: `Node <판> — 24 이상이어야 합니다 (node:sqlite)` | 1단계의 Node 설치 뒤 `할 일:`의 `wook-server install-task --data-dir "<폴더>"`로 다시 등록합니다(작업에 Node 경로가 들어 있습니다) |
| Claude CLI·Codex CLI (`cli.claude`·`cli.codex`) | 경고: `찾지 못했습니다 — 이 AI를 쓰지 않으면 괜찮습니다` | 1단계의 `npm i -g …` 뒤 3단계 |
| | 경고: `로그인돼 있지 않습니다 — 이 AI의 턴은 '재로그인 필요'로 막힙니다` | 3단계 (서버를 돌리는 이 사용자로). API 키 방식인데 키가 없으면 `할 일:`의 `wook-server secret set claude-api-key\|codex-api-key --data-dir "<폴더>"`(표준 입력) |
| | 경고: `로그인 상태를 확인하지 못했습니다` | 3단계의 상태 확인을 직접 쳐 보고 `할 일:`의 `wook-server check --data-dir "<폴더>"`로 다시 합니다 |
| API 키 환경 변수 (`apikey-env`) | 경고: `구독 방식인데 API 키 환경 변수가 있습니다: ANTHROPIC_API_KEY(사용자 환경) …` — 값은 읽지 않습니다 | 구독으로 쓰려면 그 변수를 지우고 서버를 다시 시작합니다 — 사용자 환경이면 `[Environment]::SetEnvironmentVariable('<이름>', $null, 'User')`. API 키로 쓰려면 3단계 끝의 `secret set`(`할 일:`에 `--data-dir`까지 붙어 나옵니다) |
| 화면 조작 (`screen`) | 건너뜀: `서버가 돌지 않아 보지 못했습니다` | 서버를 띄운 뒤 다시 합니다 |
| | 경고: 서버의 화면 확인 글 (화면 잠김, 세션 연결 끊김, 관리자 권한 등) | 7단계와 SERVER_INSTALL 9절. 화면 조작을 쓰지 않으면 server.json의 `screen.enabled`를 `false`로 두고 서버를 다시 시작합니다 |
| SMB(관리 채널) (`smb`) | 통과에 `Tailscale 쪽 TCP 445를 막는 규칙이 없습니다 (정보 — …)` | 6단계의 445 막기 규칙 (겹 방어) |
| | 경고: `관리 채널이 다른 기기(SMB)의 연결을 거부하지 못합니다 (<까닭>) — Tailscale 쪽 TCP 445를 막아 두세요` | 까닭(csc.exe 없음, 백신 등)을 고치고 서버를 다시 시작합니다. 그동안 6단계의 445 규칙을 꼭 둡니다 (SERVER_INSTALL 4절 6번, KNOWN_ISSUES) |
| | 건너뜀: `서버가 돌지 않아 관리 채널을 보지 못했습니다` | 서버를 띄운 뒤 다시 합니다 |
| Tailscale (`tailscale`) | 경고: `Tailscale이 없습니다` / `tailscale status를 읽지 못했습니다` / `Tailscale이 돌고 있지 않습니다` | 1단계의 설치, 6단계의 `tailscale up`. `tailscale status를 읽지 못했습니다`는 Tailscale CLI가 4초 안에 답하지 않을 때도 나옵니다 — `tailscale status`를 직접 쳐 봅니다 |
| | 실패: `tailscale funnel이 켜져 있습니다 — 인터넷 전체에 열립니다` | `tailscale funnel --https=443 off` |
| | 경고: `tailnet의 HTTPS 인증서가 꺼져 있습니다` | 6단계 (관리 콘솔의 MagicDNS·HTTPS Certificates) |
| | 경고: `이 서버(포트 7317)로 넘기는 tailscale serve 항목이 없습니다` | 6단계의 `tailscale serve --bg 7317`과 공개 주소 블록, 그다음 `할 일:`의 `wook-server config reload --data-dir "<폴더>"` |
| | 경고: `같은 이름에 다른 항목이 있습니다: …` | 다른 서비스는 다른 Tailscale 기기 이름에 둡니다 (SERVER_INSTALL 4절 4번). `tailscale serve reset`은 쓰지 않습니다 |

더 볼 곳: 서버 기록 `<데이터 폴더>\logs\server.log`(시작·운영자 명령·배포 점검 요약)와 `backend.log`(업무), [KNOWN_ISSUES.md](KNOWN_ISSUES.md)의 9단계 항목.

# Linux 편 (Ubuntu 24.04)

Linux 서버 PC에 욱채 서버를 처음부터 설치하는 순서입니다. Windows 편과 같은 꼴로, 서버 PC의 셸을 쓰는 에이전트(그록봇 등)가 위에서부터 그대로 따라 하게 썼습니다. **[사람]** 표시는 사람이 할 일(관리자 암호를 넣는 `sudo`, 브라우저 로그인, 휴대폰, 다시 시작)입니다. 에이전트는 그 단계에서 멈추고 사람에게 부탁합니다.

## L. 읽기 전에 (Linux)

- **기준 시스템**: Ubuntu 24.04 LTS (x86_64, systemd 255). 다른 배포판은 꾸러미 이름과 Node 설치가 다를 수 있습니다.
- **지원하지 않는 곳**: 컨테이너(Docker 등). 컨테이너마다 프로세스 번호가 따로라 실행 잠금이 컨테이너를 넘어 맞지 않고, init 없이 띄우면 좀비 프로세스 때문에 정지가 늘 '남은 프로세스 있음'으로 끝납니다. WSL2는 시험에 쓴 곳이지만 서버 자리로는 권하지 않습니다 — 시계가 30초쯤마다 0.5초쯤 뒤로 당겨집니다. 둘 다 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)에 있습니다.
- **셸**: bash. **서버를 돌릴 사용자로 직접 로그인한 셸**(그 PC의 터미널이나 SSH)에서 칩니다. root로 치지 않고, `sudo -u`·`su`로 바꾼 셸에서도 치지 않습니다 — 그 셸에는 그 사용자의 systemd(사용자 관리자)에 닿는 길(`XDG_RUNTIME_DIR`)이 없어 L8단계의 `install-task`가 거부합니다. `sudo`로 시작하는 줄만 관리자 권한이 듭니다 **[사람: sudo 암호]**.
- **경로**: 저장소 폴더는 `~/wookagent`, 데이터 폴더는 `~/wook-data`(명령에는 `"$HOME/wook-data"`)로 적었습니다. 다르게 쓰려면 모든 줄에서 같이 바꿉니다. 데이터 폴더의 경로는 UTF-8로 96바이트 이하여야 합니다(L4단계).
- **명령**: `scripts/wook-server`는 SERVER_INSTALL의 `wook-server`(= `node out/server/index.mjs`)와 같습니다 — Windows 편의 `scripts\wook-server.cmd`의 짝이고, PATH의 `node`로 띄웁니다. 모든 명령은 저장소 폴더에서 칩니다.
- **블록**: `( … )`로 감싼 블록은 안에서 `set -eu`를 켜 한 줄이라도 실패하면 거기서 멈춥니다(바깥 셸은 그대로입니다). 통째로 붙여 넣습니다.
- **출력**: '나와야 하는 것'은 2026-11-12에 두 곳에서 실제로 돌린 출력입니다. (1) 이 PC의 WSL2 Ubuntu 24.04.3(systemd 255, 사용자 관리자 있음, sudo 없음): 빌드, 서버, 운영자 명령, 유닛 시험 실행, `check`, 비밀 값. (2) 깨끗한 Ubuntu 24.04 루트(공식 `ubuntu-base`를 root 없이 uid 1000으로 들어간 것, systemd 없음): Node 설치와 화면 조작(Xvfb·openbox). 두 곳 모두 집 폴더(`HOME`)를 빈 임시 폴더로 바꿔 돌렸고, 서버는 빈 포트(`--port 0`)로 띄웠습니다. 사용자 이름·PC 이름·경로·실행 ID·시각은 `<…>`로, 포트는 기본값 7317로 바꿔 적었습니다. Claude·Codex CLI는 두 곳에 없었습니다(그래서 CLI 항목은 '찾지 못했습니다'입니다).
- **(verify)**: 그 두 곳에서 돌릴 수 없던 줄 — `sudo`가 드는 줄, 유닛 등록·시작, 다시 시작, 실제 Tailscale·구글·CLI 로그인, 실제 X 데스크톱 — 에는 **(verify — 까닭)**을 적었습니다. 모두 [부록 C](#부록-c-깨끗한-linux-vm-점검표)에 모았습니다.

## L0. 확인 — Ubuntu, 사용자, 사용자 systemd, /proc

```sh
. /etc/os-release; echo "$PRETTY_NAME"
id -un; id -u
systemctl --user show-environment >/dev/null && echo "사용자 systemd: 있음 ($XDG_RUNTIME_DIR)"
test -r /proc/self/stat && test -r /proc/sys/kernel/random/boot_id && grep -q '^btime ' /proc/stat && echo "/proc: 읽힘"
```

나와야 하는 것:

```text
Ubuntu 24.04.3 LTS
<사용자>
1000
사용자 systemd: 있음 (/run/user/1000)
/proc: 읽힘
```

- 첫 줄은 Ubuntu 24.04면 됩니다(점 뒤의 판은 달라도 됩니다). 셋째 줄(uid)은 0이 아니어야 합니다. 보통의 로그인 사용자는 1000 이상입니다.

안 되면:

- uid가 0 → root의 셸입니다. 서버는 root로 시작하지 않습니다([부록 D](#부록-d-문제-해결--linux-check-항목과-시작-거부)의 시작 거부). 서버를 돌릴 보통 사용자를 만들고(**[사람]** `sudo adduser <이름>`) 그 사용자로 다시 로그인합니다.
- `사용자 systemd` 줄 대신 `Failed to connect to bus`가 나옴 → `sudo -u`·`su`로 바꾼 셸입니다. 그 사용자로 직접 로그인(SSH 포함)해 다시 합니다.
- `/proc` 줄이 나오지 않음 → `/proc`이 없거나 막힌 곳(컨테이너 등)입니다. 서버는 `/proc`으로 실행 잠금과 정지를 확인하므로 거기서는 시작하지 않습니다. 보통의 Linux PC나 VM에서 합니다.

## L1. 프로그램 설치 — 꾸러미, Node.js 24, CLI 둘

**[사람: sudo 암호]** (verify — 이 PC에서는 sudo를 쓰지 않습니다. 꾸러미 이름은 WSL의 `apt-cache policy`로 모두 있는 것을 확인했습니다):

```sh
sudo apt update
sudo apt install -y git curl xz-utils ca-certificates procps dbus-user-session
```

- `procps`(`ps`·`pgrep`)는 운영자가 프로세스를 볼 때 씁니다. 서버는 쓰지 않습니다(`/proc`을 바로 읽습니다).
- `dbus-user-session`은 사용자 세션 버스(`/run/user/<uid>/bus`)를 줍니다. L8단계의 유닛이 이 버스를 물려받고, L9단계의 암호 칸 판정(AT-SPI)이 이 버스를 씁니다.

**Node.js 24** — Ubuntu 24.04의 `nodejs` 꾸러미는 18판(`apt-cache policy nodejs`의 Candidate `18.19.1+dfsg-6ubuntu5`)이라 서버가 쓰는 `node:sqlite`가 없습니다. nodejs.org의 공식 압축 파일을 이 사용자의 집 폴더에 풉니다(sudo가 들지 않습니다). 통째로 붙여 넣습니다:

```sh
(
  set -eu
  v=24.13.0
  case "$(uname -m)" in x86_64) a=x64 ;; aarch64) a=arm64 ;; *) echo "이 CPU($(uname -m))의 Node는 nodejs.org에서 직접 고르세요" >&2; exit 1 ;; esac
  n="node-v$v-linux-$a"
  mkdir -p ~/.local/opt
  cd ~/.local/opt
  curl -fsSLO "https://nodejs.org/dist/v$v/$n.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$v/SHASUMS256.txt" | grep " $n.tar.xz\$" | sha256sum -c -
  tar -xJf "$n.tar.xz"
  rm "$n.tar.xz"
  echo "export PATH=\"\$HOME/.local/opt/$n/bin:\$PATH\"" >> ~/.profile
)
. ~/.profile
node --version
npm --version
command -v node
```

나와야 하는 것 (깨끗한 Ubuntu 24.04 루트에서 돌린 것):

```text
node-v24.13.0-linux-x64.tar.xz: OK
v24.13.0
11.6.2
/home/<사용자>/.local/opt/node-v24.13.0-linux-x64/bin/node
```

- `: OK`는 받은 파일이 nodejs.org가 적은 SHA-256과 같다는 뜻입니다.
- `~/.profile`에 PATH 한 줄을 더했습니다. 새로 로그인한 셸(SSH 포함)은 이 줄을 읽습니다.
- **Node의 자리는 L8단계의 유닛에 그대로 적힙니다.** 유닛은 `install-task`를 친 그 `node`의 절대 경로와 그 셸의 PATH를 적어 둡니다 — 사용자 유닛은 로그인 셸의 `~/.profile`을 읽지 않기 때문입니다. 그래서 Node를 새 판(다른 폴더)으로 바꾸면 `install-task`를 다시 합니다. 잊으면 `check`의 `systemd 유닛` 항목이 'Node가 지금 것과 다릅니다'로 알립니다. Node의 경로에 `"` `'` `\` `$`가 있으면 `install-task`가 거부합니다(systemd가 실행 파일 이름으로 받지 않습니다).
- NodeSource의 apt 저장소나 nvm으로 깔아도 됩니다(verify — 이 PC에서는 그 둘을 돌려 보지 않았습니다). 같은 까닭으로, 판을 바꾼 뒤에는 `install-task`를 다시 합니다.

CLI 둘 (verify — 이 PC에서는 `npm i -g`로 아무것도 설치하지 않습니다):

```sh
npm i -g @anthropic-ai/claude-code @openai/codex
git --version
claude --version
codex --version
```

- 위의 Node(집 폴더)라면 `npm i -g`가 sudo 없이 Node와 같은 `bin` 폴더에 `claude`·`codex`를 넣습니다. Node를 새 폴더로 옮기면 CLI도 다시 넣습니다.
- `git --version`은 `git version 2.43.0`쯤이면 됩니다. CLI의 판은 Windows 편 1단계의 표와 같은 꼴입니다.

안 되면:

- `curl: command not found`나 `xz: Cannot exec` → 위의 `apt install` 줄을 먼저 합니다.
- `sha256sum`이 `FAILED`를 냄 → 받은 파일이 깨졌습니다. `~/.local/opt`의 그 `.tar.xz`를 지우고 블록을 다시 붙여 넣습니다.
- `node --version`이 `v18…`이거나 `node: command not found` → 새 셸을 열거나 `. ~/.profile`을 다시 칩니다. `command -v node`가 `/usr/bin/node`면 apt의 옛 Node가 앞에 있습니다 — `~/.profile`의 그 줄이 PATH의 맨 앞에 오는지 봅니다.

## L2. 저장소와 빌드

**묶음으로 (저장소와 빌드 없이)** — 개발 PC에서 `npm run pack:linux`로 만든 묶음 `wook-server-<판>-linux-<커밋 7자>.tar.gz`와 곁의 `.sha256` 파일을 이 PC로 옮겨 왔으면, 아래 블록만 하고 이 단계의 나머지(`git clone`·`npm ci`·빌드)를 건너뜁니다. 두 파일이 있는 폴더에서 칩니다(그 폴더에 묶음이 여럿이면 `*` 자리에 파일 이름을 그대로 적습니다):

```sh
sha256sum -c wook-server-*-linux-*.tar.gz.sha256
tar -xzf wook-server-*-linux-*.tar.gz -C ~
cd ~/wookagent
scripts/wook-server --help
```

- 첫 줄이 `…tar.gz: OK`를 내야 합니다(옮기다 깨지지 않았다는 뜻). 풀면 `~/wookagent`가 생기고, 도움말은 아래 '나와야 하는 것'의 끝부분과 같습니다.
- 묶음에는 빌드한 서버(`out/server`)와 웹 화면(`out/web`), `resources`, 실행에 드는 꾸러미(`node_modules`), 문서가 들어 있어 L1단계의 Node 24만 있으면 돕니다. 네이티브 모듈이 없어 x86_64와 arm64에서 같은 파일을 씁니다. `git`은 서버가 프로젝트를 다룰 때 쓰므로 L1단계대로 깔려 있어야 합니다.
- 그 PC의 AI 도우미(Claude Code·Codex 등)에게 맡길 때는 `~/wookagent/AGENTS.md`부터 읽게 합니다 — 설치·운영·문제 해결의 차례와 사람만 할 수 있는 일이 `docs/ai/`에 있습니다.
- 새 묶음으로 바꿀 때는 서버를 끄고(`scripts/wook-server shutdown --data-dir "$HOME/wook-data"`) `~/wookagent`를 새 묶음의 것으로 바꾼 뒤 다시 띄웁니다. 데이터 폴더(`~/wook-data`)는 그대로 둡니다. 같은 자리에 풀었으면 L8단계의 유닛은 그대로 맞습니다(유닛은 Node와 `~/wookagent/out/server/index.mjs`의 경로를 적어 둡니다) — 바꾼 뒤 `check`로 봅니다.
- 묶음은 이 PC의 깨끗한 폴더에 풀어 운영자 명령·`wook`이 뜨는 것을 시험으로 보고(`tests/server/linuxBundle.test.ts`), Linux에서는 그 서버를 띄워 `status`·`shutdown`까지 봅니다.

**저장소에서 (개발하는 PC이거나 묶음이 없을 때)**:

```sh
git clone <저장소 주소> ~/wookagent
cd ~/wookagent
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

- **[사람]** 비공개 저장소면 `git clone`이 GitHub 로그인(또는 토큰)을 묻습니다. (verify — 이 PC에서는 `git clone`을 돌리지 않았습니다. 저장소를 Linux 쪽으로 복사해 썼습니다.)
- `npm ci`는 `added 207 packages in 6s`처럼 끝나면 됩니다(WSL에서 돌린 것). `ELECTRON_SKIP_BINARY_DOWNLOAD=1`은 데스크톱 앱의 Electron 실행 파일(100MB쯤)을 받지 않게 합니다 — 서버는 쓰지 않습니다. 컴파일러(`build-essential`)는 필요 없습니다(설치 때 무엇을 컴파일하는 꾸러미가 없습니다).

```sh
npm run build:server
npm run build:web
scripts/wook-server --help
```

나와야 하는 것 (빌드마다 `✓ built in …`으로 끝나고, 도움말의 '이 PC에서만 하는 명령'에 `install-task`·`uninstall-task`·`check`가 있습니다):

```text
> wookagent@0.1.0 build:server
> vite build --config vite.server.config.ts
…
out/server/index.mjs             1,510.68 kB │ gzip: 452.17 kB
✓ built in 184ms
> wookagent@0.1.0 build:web
> vite build --config vite.web.config.ts --mode remote
…
✓ built in 339ms
욱채 서버 (이 PC의 루프백 — 다른 기기는 tailscale serve로)
…
이 PC에서만 하는 명령 (실행 중인 서버가 없어도 됩니다)
  wook-server install-task [서버 옵션]
                                      로그온할 때 이 사용자로 서버를 띄우게 등록합니다 — Windows는 작업 스케줄러 작업,
                                      Linux는 systemd 사용자 유닛 (관리자 권한 없이 — 다시 하면 바꿔 넣고, --allow-test-session은 받지 않음)
  wook-server uninstall-task          그 작업(Linux는 유닛)을 지웁니다 (실행 중인 서버는 끄지 않습니다)
  wook-server check                   서버 PC를 점검합니다 (바꾸는 것은 없습니다. 실패가 있으면 끝 코드 1)
                                      Windows: 세션·자동 로그온·잠금·절전·작업·데이터 폴더·CLI·SMB·Tailscale
                                      Linux: 사용자·/proc·유닛·linger·데이터 폴더·비밀 값·절전·CLI·화면 조작·Tailscale
```

- 빌드 앞에 나오는 `(!) Your Vite config uses features that are unsupported by configLoader: 'native'` 안내는 그대로 두면 됩니다.

안 되면:

- `scripts/wook-server: Permission denied` → 그 파일에 실행 권한이 없는 받은 사본입니다. `sh scripts/wook-server --help`처럼 앞에 `sh `를 붙여도 같습니다. (이 PC의 사본은 Windows에서 옮겨 와 실행 권한이 없어, 시험할 때 그 사본에만 `chmod +x`를 했습니다 — 저장소에는 실행 권한으로 올립니다.)
- `npm run build:web`이 실패하면 `out/web`이 빈 채로 남습니다. 까닭을 고치고 다시 합니다(Windows 편 2단계와 같습니다).

## L3. CLI 로그인 — [사람]

서버가 띄우는 Claude Code·Codex CLI는 **서버를 돌리는 이 사용자**의 로그인을 씁니다. 화면 없는 서버면 브라우저 없이 로그인합니다 (verify — 이 PC에서는 실제 로그인을 하지 않습니다):

- **Codex**: `codex login --device-auth` — 나온 주소와 코드를 다른 기기의 브라우저에 넣습니다 **[사람]**.
- **Claude**: `claude auth login` — 브라우저를 열 수 없으면 주소를 보여 줍니다. 그 주소를 다른 기기의 브라우저에서 열고 받은 코드를 셸에 붙여 넣습니다 **[사람]**. 로그인 정보는 이 사용자의 `~/.claude`에 남아 다시 시작해도 그대로입니다.
- 또는 브라우저가 있는 다른 PC에서 `claude setup-token`으로 긴 토큰을 받아 **[사람]** 이 사용자의 `~/.config/environment.d/` 아래 파일(예: `50-claude.conf`, 권한 600)에 `CLAUDE_CODE_OAUTH_TOKEN=<토큰>` 한 줄로 둡니다. 사용자 관리자가 시작할 때 이 폴더를 읽어 유닛의 서버에 넘깁니다. `install-task`는 이 토큰을 유닛 파일에 넣지 않습니다. 사용자 관리자가 언제 다시 읽는지(다시 로그인, linger면 다시 시작)와 `claude auth status`가 이 토큰을 로그인으로 보는지는 확인하지 못했습니다 (verify).

확인 (verify):

```sh
claude auth status --json
codex login status
```

- `"loggedIn": true`와 `Logged in using ChatGPT`면 됩니다(Windows 편 3단계와 같은 꼴).
- API 요금으로 쓰려면 L4단계 뒤에 `scripts/wook-server secret set claude-api-key --data-dir "$HOME/wook-data"`(`codex-api-key`도 같습니다)를 치고 키를 붙여 넣습니다 **[사람]**. Linux에서는 키가 그 데이터 폴더의 비밀 값 파일(L5단계)에 들어갑니다 — Windows와 달리 데이터 폴더마다 따로입니다. 구독으로 쓸 때는 `ANTHROPIC_API_KEY`·`OPENAI_API_KEY` 같은 환경 변수를 `~/.profile`·`~/.bashrc`·`~/.config/environment.d`에 두지 않습니다. `check`가 경고합니다.

## L4. 데이터 폴더와 server.json, 설정용으로 서버 띄우기

대표의 구글 메일을 `owner@example.com` 자리에 넣고 통째로 붙여 넣습니다:

```sh
(
  set -eu
  data="$HOME/wook-data"
  printf '데이터 폴더 %s (%s바이트 — 96 이하여야 합니다)\n' "$data" "$(printf '%s' "$data" | wc -c)"
  umask 077
  mkdir -p "$data"
  chmod 700 "$data"
  cat > "$data/server.json" <<JSON
{
  "owner": { "email": "owner@example.com" },
  "seat": { "initialHolder": "launched:claude" },
  "workspaceRoot": "$HOME/wook-workspace",
  "screen": { "enabled": false }
}
JSON
  stat -c '%A %n' "$data" "$data/server.json"
  cat "$data/server.json"
)
```

나와야 하는 것:

```text
데이터 폴더 /home/<사용자>/wook-data (<바이트 수>바이트 — 96 이하여야 합니다)
drwx------ /home/<사용자>/wook-data
-rw------- /home/<사용자>/wook-data/server.json
{
  "owner": { "email": "owner@example.com" },
  "seat": { "initialHolder": "launched:claude" },
  "workspaceRoot": "/home/<사용자>/wook-workspace",
  "screen": { "enabled": false }
}
```

- **데이터 폴더**: 이 사용자만 여는 0700(`drwx------`)입니다. 서버가 없는 폴더로 처음 시작할 때도 이렇게 만듭니다. 그 안의 DB·기록·관리 토큰·관리 소켓·비밀 값은 이 폴더로 막힙니다. `--data-dir`을 주지 않으면 기본 자리는 `~/.config/wookagent`(`XDG_CONFIG_HOME`이 있으면 그 아래)입니다. 데이터를 다른 디스크에 두려면 `~/wook-data`를 그 폴더로 가는 심볼릭 링크로 둬도 됩니다 — 서버와 `check`는 링크를 따라가 실제 폴더를 봅니다(그 폴더도 0700). 링크가 가리키는 곳이 없으면(디스크가 붙지 않음, 링크 고리 — 데이터 폴더 자신이든 그 위 폴더든) 서버가 시작하지 않고 `check`가 실패합니다([부록 D](#부록-d-문제-해결--linux-check-항목과-시작-거부)).
- **96바이트**: 운영자 명령은 데이터 폴더의 관리 소켓 `admin.sock`으로 서버에 붙습니다. Linux의 소켓 주소는 108바이트(끝의 NUL을 빼면 107)까지라, `<데이터 폴더>/admin.sock`이 107바이트를 넘으면 서버가 시작하지 않습니다 — 데이터 폴더는 96바이트 이하입니다. 한글은 한 글자가 3바이트입니다.
- `owner.email`: 이 메일의 구글 계정만 대표로 받습니다. 정해 두면 서버가 설정 코드를 내지 않습니다. 정하지 않으면 서버가 시작할 때 설정 코드를 콘솔과 `<데이터 폴더>/setup-code.txt`에 냅니다 — 다만 systemd 아래(L8단계의 유닛)에서는 코드를 저널에 내지 않고 그 파일만 가리킵니다. 그때는 `cat ~/wook-data/setup-code.txt`로 보거나 `scripts/wook-server config owner-email <이메일> --data-dir "$HOME/wook-data"`로 정합니다.
- `seat.initialHolder`·`workspaceRoot`: Windows 편 4단계와 같습니다. `$HOME`은 셸이 펼쳐 적습니다 — 집 폴더의 경로에 `"`나 `\`가 있으면 이 블록 대신 손으로 씁니다.
- `screen.enabled`: L9단계(화면 조작)에서 켭니다. 화면 조작을 쓰지 않으면 `false`로 둡니다 — 이 칸을 빼 두고 X 도구가 없으면 `check`의 `화면 조작` 항목이 경고이고, `true`로 켜 두고 X 도구가 없으면 실패입니다.
- 구글 클라이언트 ID(L5단계)와 공개 주소·받는 Tailscale 사용자(L6단계)는 그 단계에서 더합니다.

**설정용으로 서버를 띄웁니다.** L5·L6·L10단계의 운영자 명령이 이 서버에 붙습니다. L8단계에서 끄고 유닛으로 다시 띄웁니다. **두 번째 셸**(새 터미널이나 두 번째 SSH 연결)에서:

```sh
cd ~/wookagent
scripts/wook-server --data-dir "$HOME/wook-data" --web-dir out/web
```

나와야 하는 것 (이 셸은 서버가 끝날 때까지 이대로 둡니다):

```text
(node:<pid>) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
욱채 서버 준비 완료: 주소 http://127.0.0.1:7317 (127.0.0.1과 ::1에서 받음) · 실행 ID <…> · 데이터 폴더 /home/<사용자>/wook-data
```

- 이 셸에서 Ctrl+C를 누르면 서버가 정상 종료합니다(`shutdown`과 같습니다). 끝날 때 이 셸에는 아무 글도 더 나오지 않고(끝 코드 0) 프롬프트로 돌아옵니다 — 끝난 기록은 `<데이터 폴더>/logs/server.log`의 `종료 신호 받음 (SIGINT)` … `욱채 서버 종료 (코드 0)` 줄입니다(이 PC의 WSL에서 본 것).

원래 셸에서 확인합니다:

```sh
cd ~/wookagent
scripts/wook-server status --data-dir "$HOME/wook-data"
```

나와야 하는 것:

```text
욱채 서버 상태
  프로세스      pid <pid>, 2초째 실행 중
  주소          http://127.0.0.1:7317 (이 PC 안에서만 — 127.0.0.1과 ::1에서 받습니다)
  데이터 폴더   /home/<사용자>/wook-data
  실행 ID       <…>
  진행 중 작업  없음
  긴급 정지     꺼짐
  비밀 값 저장  파일 (/home/<사용자>/wook-data/secrets — 이 사용자만, 암호화하지 않음)
  화면 조작     서버 PC의 운영자가 화면 조작을 꺼 두었습니다 (server.json의 screen.enabled: false) — 켜려면 운영자가 그 값을 바꾸고 서버를 다시 시작해야 합니다
  관리 채널     소켓 파일 — 이 사용자만
  절전 방지     idle — 진행 중 작업이 없어 막지 않습니다
  배포 점검     <시각>에 — 통과 10 · 경고 6 (unit, linger, sleep, cli.claude, cli.codex, tailscale) · 실패 0 · 건너뜀 1 (wook-server check로 자세히)
  시험용 세션   꺼짐 (--allow-test-session 없이 시작)
  버전          0.1.0
```

- `비밀 값 저장`이 `파일 (… — 이 사용자만, 암호화하지 않음)`이어야 합니다(L5단계). 뒤에 `— 쓸 수 없음: …`이 붙으면 [부록 D](#부록-d-문제-해결--linux-check-항목과-시작-거부)의 `secrets`입니다.
- `관리 채널`이 `소켓 파일 — 이 사용자만`이어야 합니다. Linux의 관리 채널은 데이터 폴더 안의 소켓 파일이라 다른 기기에서는 닿지 않습니다 — Windows 편 6단계의 445 막기 규칙은 Linux에는 없습니다.
- `절전 방지`는 진행 중 작업이 없으면 `idle`, 작업 중이면 `awake`, 막 시작해 `systemd-inhibit`의 답을 기다리는 동안 `pending`입니다. `unavailable — …`이면 L7단계를 봅니다.
- `배포 점검`은 서버가 시작 뒤 한 번 돌린 점검(L7단계의 `check`와 같은 17개 항목)의 요약입니다. 경고는 L5~L9단계에서 차례로 없앱니다.

안 되면:

- 서버 셸에 `욱채 서버를 시작하지 못했습니다: …`가 나오고 끝남 → 그 글이 까닭입니다. root, `/proc`, 데이터 폴더 경로의 길이, 비밀 값 폴더의 권한은 [부록 D](#부록-d-문제-해결--linux-check-항목과-시작-거부)의 '서버가 시작하지 않을 때'에 있습니다. `server.json의 … 모양이 아닙니다`면 위 블록의 메일을 고쳐 다시 붙여 넣습니다.
- `--web-dir 폴더가 서버용 웹 화면이 아닙니다` → L2단계의 `npm run build:web`.
- 포트 7317을 다른 프로그램이 씀 → Windows 편 4단계와 같습니다(서버를 띄우는 줄과 L8단계의 `install-task`에만 `--port <번호>`).
- `이 데이터 폴더(…)로 실행 중인 욱채 서버가 없습니다 (server.lock 없음)` → 서버 셸이 준비 줄을 냈는지, `--data-dir`이 같은지 봅니다.

## L5. 구글 로그인 클라이언트와 비밀 값 — [사람]

**[사람]** 구글 클라우드 콘솔에서 **'TV 및 입력 제한 기기'** 종류의 OAuth 클라이언트를 만듭니다(Windows 편 5단계, [SERVER_INSTALL.md](SERVER_INSTALL.md) 2절). 받은 클라이언트 ID를 넣습니다:

```sh
scripts/wook-server config google-client-id <클라이언트 ID> --data-dir "$HOME/wook-data"
```

나와야 하는 것:

```text
구글 클라이언트 ID를 server.json에 쓰고 적용했습니다: 바꾼 것 1개
  - 구글 클라이언트 ID → 1234567890-abc.apps.googleusercontent.com
```

보안 비밀은 **[사람]**이 넣습니다. 명령 줄에 쓰지 않습니다. `scripts/wook-server secret set google-client-secret --data-dir "$HOME/wook-data"`를 치면 화면에 보이지 않게 붙여 넣을 수 있습니다. 파일로 받았으면:

```sh
cat ~/google-secret.txt | scripts/wook-server secret set google-client-secret --data-dir "$HOME/wook-data"
rm ~/google-secret.txt
```

나와야 하는 것:

```text
구글 로그인 보안 비밀을 데이터 폴더의 비밀 값 파일에 넣었습니다 (값은 다시 보여 주지 않습니다).
```

확인:

```sh
scripts/wook-server config show --data-dir "$HOME/wook-data"
stat -c '%A %n' "$HOME/wook-data/secrets" "$HOME/wook-data/secrets"/*
```

나와야 하는 것 (`config show`의 그 가운데와 `stat`):

```text
  구글 클라이언트 1234567890-abc.apps.googleusercontent.com
  구글 보안 비밀  등록됨 (데이터 폴더의 비밀 값 파일)
…
drwx------ /home/<사용자>/wook-data/secrets
-rw------- /home/<사용자>/wook-data/secrets/<64자>.json
```

**Linux의 비밀 값 저장소는 파일입니다.** 구글 보안 비밀과 AI의 API 키는 `<데이터 폴더>/secrets/` 아래에 이름마다 파일 하나(`<이름의 SHA-256>.json`)로 들어갑니다.

- 폴더는 0700, 파일은 0600 — 이 사용자만 읽습니다. 쓰기는 옆 임시 파일(`.<파일 이름>.tmp-…`)에 쓴 뒤 바꿔 넣어 반쯤 쓴 값 파일이 남지 않습니다. 쓰는 도중 서버가 죽어 임시 파일이 남으면, 그 비밀 값을 지울 때(`secret clear`)와 다음 시작에서(1분 넘게 지난 것) 지웁니다. 값은 다시 시작해도 남습니다.
- 막는 것: 이 PC의 **다른 사용자**. 폴더나 파일의 권한이 넓어지거나(그룹·다른 사용자가 열 수 있음) 주인이 다르거나 심볼릭 링크면 서버는 그 값을 쓰지 않고 시작하지 않으며, `check`의 `비밀 값 저장소`가 실패로 고칠 `chmod` 줄을 냅니다([부록 D](#부록-d-문제-해결--linux-check-항목과-시작-거부)).
- 막지 못하는 것: 값은 **암호화하지 않습니다.** 같은 사용자로 도는 프로세스(서버가 띄우는 CLI, 같은 계정의 외부 에이전트)는 이 파일을 읽을 수 있습니다 — 서버는 그 값을 기록·도구 결과·대화에서 가립니다. 집 폴더를 통째로 백업하면 백업에도 그대로 들어갑니다. 그 계정에는 믿는 프로그램만 둡니다(SERVER_DESIGN 9.2).
- Windows와 달리 OS 키링을 쓰지 않습니다. 화면 없는 Linux의 키링은 다시 시작하면 사라질 수 있기 때문입니다. 그래서 데이터 폴더를 지우면 그 안의 비밀 값도 함께 지워지고, 데이터 폴더마다 따로입니다.

안 되면:

- `구글이 이 클라이언트 ID로 기기 코드를 내주지 않았습니다 (invalid_client)` (L11단계의 로그인 화면) → Windows 편 5단계와 같습니다.
- 실수로 비밀 값을 명령 줄에 붙였으면 그 값은 쓰이지 않습니다. `history -d <번호>`로 셸 기록의 그 줄을 지우고(`~/.bash_history`에 이미 쓰였으면 거기서도) 구글 클라우드 콘솔에서 보안 비밀을 새로 만듭니다.

## L6. Tailscale — [사람]

**[사람: sudo 암호]** (verify — 이 PC에서는 Tailscale을 설치하거나 바꾸지 않습니다):

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --operator="$(id -un)"
```

- `tailscale up`이 로그인 주소를 냅니다. **[사람]** 그 주소를 브라우저에서 열고 Tailscale 계정으로 로그인합니다. 대표의 휴대폰에도 Tailscale 앱을 깔고 같은 tailnet에 로그인합니다.
- `--operator=<사용자>`는 이 사용자가 `sudo` 없이 `tailscale serve`를 쓰게 합니다. 이미 올려 둔 Tailscale이면 `sudo tailscale set --operator="$(id -un)"`입니다.
- **[사람]** Tailscale 관리 콘솔(https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다.

서버 앞에 `tailscale serve`를 둡니다 (`funnel`은 쓰지 않습니다 — 인터넷 전체에 엽니다) (verify):

```sh
tailscale serve --bg 7317
tailscale serve status
```

- `tailscale serve status`에 `https://<서버 PC 이름>.<tailnet>.ts.net`과 `http://127.0.0.1:7317`로 넘기는 줄이 보이면 됩니다.

그 주소를 서버의 **공개 주소**로, 이 PC의 Tailscale 로그인을 **받는 Tailscale 사용자**로 server.json에 더합니다:

```sh
node -e '
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const f = process.env.HOME + "/wook-data/server.json";
const ts = JSON.parse(execFileSync("tailscale", ["status", "--json", "--peers=false"], { encoding: "utf8" }));
const name = String(ts.Self?.DNSName ?? "").replace(/\.$/, "");
const login = ts.User?.[String(ts.Self?.UserID)]?.LoginName;
if (!name || !login) { console.error("tailscale status에서 이 PC의 이름이나 로그인을 읽지 못했습니다 - sudo tailscale up을 먼저 하세요"); process.exit(1); }
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.owner.tailscaleLogins = [login];
j.network = { publicOrigin: "https://" + name };
fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
console.log("server.json: 공개 주소 https://" + name + ", 받는 Tailscale 사용자 " + login);
'
scripts/wook-server config reload --data-dir "$HOME/wook-data"
```

나와야 하는 것:

```text
server.json: 공개 주소 https://<서버 PC 이름>.<tailnet>.ts.net, 받는 Tailscale 사용자 <Tailscale 로그인>
운영자 설정을 다시 읽었습니다: 바꾼 것 2개
  - 공개 주소 → https://<서버 PC 이름>.<tailnet>.ts.net
  - 받는 Tailscale 사용자 → 켬 (1명)
```

- (이 PC에는 Tailscale이 없어, `tailscale status --json --peers=false`가 내는 모양 — `Self.DNSName`, `Self.UserID`, `User[<ID>].LoginName` — 을 내는 대역 프로그램으로 이 블록을 돌렸습니다. 같은 칸을 Windows 편 6단계가 실제 Tailscale에서 읽었습니다.)
- 이제 server.json에 L4~L6단계의 값이 모두 있습니다. `cat ~/wook-data/server.json`으로 보면 `owner.tailscaleLogins`, `google.clientId`, `network.publicOrigin`이 더해져 있습니다.
- 받는 Tailscale 사용자, 같은 이름의 다른 `tailscale serve` 항목, 접근 규칙(ACL)은 Windows 편 6단계와 같습니다.

안 되면:

- `tailscale status에서 … 읽지 못했습니다`로 멈춤 → `sudo tailscale up`이 끝났는지, `tailscale status`가 이 PC를 보이는지 봅니다.
- `tailscale serve`가 권한이 없다며 거부함 → 위의 `--operator`를 하지 않은 것입니다 (verify — 이 PC에서는 그 글을 보지 못했습니다).

## L7. 절전 막기와 점검

서버 PC는 쉬는 동안 잠들지 않아야 합니다 — 잠든 PC는 휴대폰에서 닿지 않습니다. 화면 없는 서버면 절전 대상을 막아(mask) 둡니다 **[사람: sudo 암호]** (verify — 이 PC에서는 시스템 설정을 바꾸지 않습니다. 둘째 줄은 읽기만 하는 명령이라 돌려 봤습니다):

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
systemctl show -p Id -p LoadState sleep.target suspend.target hibernate.target hybrid-sleep.target
```

- 둘째 줄의 네 `LoadState`가 모두 `masked`면 됩니다. 막기 전에는 이렇게 `loaded`입니다(이 PC의 WSL):

  ```text
  Id=sleep.target
  LoadState=loaded

  Id=suspend.target
  LoadState=loaded
  …
  ```

- **작업 중 절전 방지와 `unavailable`**: 서버는 작업이 도는 동안 `systemd-inhibit --what=sleep --mode=block`을 쥐어 절전을 막습니다. 그런데 이 잠금은 polkit이 **그 PC 앞에 로그인한 활성 세션**에만 내줍니다. L8단계의 유닛(특히 linger로 부팅 때 뜬 것)이나 SSH로 띄운 서버는 `Access denied`를 받습니다. 그러면 `status`가 `절전 방지     unavailable — systemd-inhibit: Failed to inhibit: Access denied (작업 중에도 PC가 절전에 들 수 있습니다)`를 내고, 서버를 다시 시작할 때까지 다시 해 보지 않습니다. 절전 대상을 막아 두었으면 괜찮습니다 — `check`의 `절전 방지` 항목도 그때는 통과입니다. (이 PC의 WSL에서 `systemd-inhibit --what=sleep --who=욱채 --why=확인 --mode=block true`가 `Failed to inhibit: Access denied`로 끝나는 것을 봤습니다. 데스크톱 세션의 polkit이 이 잠금을 내주는지는 확인하지 못했습니다 — verify.)

그다음 점검합니다:

```sh
scripts/wook-server check --data-dir "$HOME/wook-data"
```

나와야 하는 것: 모든 줄이 `통과`(또는 `건너뜀`)이고 마지막 줄이 `결과: … 실패 0 …`입니다. 아래는 L4단계의 서버가 돌 때, 절전 대상을 막기 **전**, 유닛·linger·Tailscale·CLI가 없는 이 PC의 WSL에서 본 출력입니다. 경고마다 `할 일:`이 그 고칠 길이고, `wook-server` 명령에는 점검한 데이터 폴더가 `--data-dir`로 붙어 나옵니다(그대로 치면 됩니다 — `wook-server`는 `scripts/wook-server`):

```text
욱채 서버 배포 점검 (<시각> — 바꾼 것은 없습니다)
  통과   실행 사용자       <사용자> (uid 1000)
  통과   /proc             /proc을 읽을 수 있습니다 (실행 잠금·정지 확인)
  통과   procps            /usr/bin/ps, /usr/bin/pgrep
  통과   Node              Node 24.13.0
  경고   systemd 유닛      등록된 유닛이 없습니다 (wook-server-<8자>.service) — 다시 시작하면 서버가 스스로 뜨지 않습니다
                           할 일: wook-server install-task --data-dir /home/<사용자>/wook-data
  경고   linger            꺼져 있습니다 — 부팅한 뒤 <사용자>로 로그인하기 전에는 서버가 뜨지 않습니다
                           할 일: sudo loginctl enable-linger <사용자>  (관리자 권한이 드는 한 번)
  통과   데이터 폴더       /home/<사용자>/wook-data — 이 사용자만 열 수 있습니다 (700)
  통과   비밀 값 저장소    파일 (/home/<사용자>/wook-data/secrets — 이 사용자만, 암호화하지 않음)
  경고   절전              절전 대상이 막혀 있지 않습니다 (sleep.target, suspend.target, hibernate.target, hybrid-sleep.target) — 쉬는 동안 PC가 절전에 들면 휴대폰에서 닿지 않습니다. 사용자 유닛의 서버는 작업 중 절전 막기도 거부될 수 있습니다(polkit)
                           할 일: sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
  통과   절전 방지         idle
  경고   Claude CLI        찾지 못했습니다 — 이 AI를 쓰지 않으면 괜찮습니다 (Claude Code 실행 파일(claude)을 PATH와 기본 설치 위치에서 찾지 못했습니다. 설치했다면 운영 설정에서 실행 파일 경로를 지정하세요)
                           할 일: npm i -g @anthropic-ai/claude-code 뒤 claude auth login
  경고   Codex CLI         찾지 못했습니다 — 이 AI를 쓰지 않으면 괜찮습니다 (Codex 실행 파일(codex)을 PATH와 기본 설치 위치에서 찾지 못했습니다. 설치했다면 운영 설정에서 실행 파일 경로를 지정하세요)
                           할 일: npm i -g @openai/codex 뒤 codex login
  건너뜀 유닛의 PATH       유닛이 없거나 PATH를 적지 않아 견주지 못했습니다
  통과   API 키 환경 변수  구독 방식 AI에 걸리는 API 키 환경 변수가 없습니다
  통과   화면 조작         화면 조작을 꺼 두었습니다 (server.json screen.enabled false)
  통과   관리 채널         소켓 파일 — 이 사용자만 (다른 기기에서는 닿지 않습니다)
  경고   Tailscale         Tailscale이 없습니다 — 휴대폰에서 들어올 수 없습니다
                           할 일: curl -fsSL https://tailscale.com/install.sh | sh 뒤 sudo tailscale up --operator=<사용자>
결과: 통과 10 · 경고 6 (unit, linger, sleep, cli.claude, cli.codex, tailscale) · 실패 0 · 건너뜀 1 — 실패가 없습니다
```

- `systemd 유닛`·`linger` 경고는 L8단계에서, `절전` 경고는 위의 `mask`로, CLI 경고는 L1·L3단계로, `Tailscale` 경고는 L6단계로 없어집니다. `유닛의 PATH`는 유닛이 생기면 그 PATH에 `claude`·`codex`·`git`·`node`가 있는 폴더가 들었는지 봅니다.
- 점검은 아무것도 바꾸지 않습니다. 무엇을 읽는지 보려면 `scripts/wook-server check --dry-run --data-dir "$HOME/wook-data"` — `systemctl --user show-environment`, `systemctl --user show <유닛>`, 절전 대상의 `systemctl show`, `tailscale status --json`, `tailscale serve status --json`, CLI의 로그인 상태(유닛의 PATH로), 실행 중인 서버의 status, 그리고 `/proc`·유닛 파일·linger 파일·데이터 폴더·`secrets` 폴더를 읽는다고 보여 줍니다. 명령마다 4초(CLI는 15초) 안에 끝나지 않으면 그만 기다립니다.
- 실패가 하나라도 있으면 끝 코드가 1입니다. `--json`이면 ASCII JSON 한 줄입니다. 항목별 고칠 길은 [부록 D](#부록-d-문제-해결--linux-check-항목과-시작-거부)에 있습니다.

## L8. systemd 사용자 유닛으로 띄우기 (install-task)

설정용 서버를 끕니다(서버 셸은 아무 글도 더 내지 않고 끝 코드 0으로 프롬프트에 돌아옵니다 — 이 PC의 WSL에서 본 것):

```sh
scripts/wook-server shutdown --data-dir "$HOME/wook-data"
```

나와야 하는 것:

```text
서버를 종료했습니다.
```

이 사용자의 systemd 사용자 유닛으로 서버를 띄우게 등록합니다. 먼저 무엇을 등록하는지 봅니다:

```sh
scripts/wook-server install-task --dry-run --data-dir "$HOME/wook-data"
```

나와야 하는 것:

```text
[시험 실행 — 아무것도 바꾸지 않았습니다] 등록할 사용자 유닛: wook-server-<8자>.service
  Node          <Node 경로>/node
  서버 진입점   /home/<사용자>/wookagent/out/server/index.mjs
  데이터 폴더   /home/<사용자>/wook-data
  웹 화면       /home/<사용자>/wookagent/out/web
  유닛 파일     /home/<사용자>/.config/systemd/user/wook-server-<8자>.service
  PATH          <Node 경로>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  실행 계정     <사용자> (사용자 유닛 — 로그인할 때만 — linger가 꺼져 있어 부팅만으로는 뜨지 않습니다, root 없이)
실행할 명령 (유닛 파일을 0600으로 쓴 뒤)
  systemctl --user daemon-reload
  systemctl --user enable wook-server-<8자>.service
  systemctl --user show wook-server-<8자>.service -p LoadState -p FragmentPath -p DropInPaths -p UnitFileState -p KillMode -p WorkingDirectory -p ExecStart -p ActiveState
유닛 파일
# wook-server install-task가 쓴 파일입니다 — 바꾸려면 install-task를 다시 하세요 (손으로 고친 것은 check가 알립니다)
[Unit]
Description=욱채 서버 (/home/<사용자>/wook-data)
# 사용자 유닛은 시스템의 network-online.target을 기다릴 수 없습니다 — 서버는 이 PC 안(루프백)만 엽니다
StartLimitIntervalSec=600
StartLimitBurst=4

[Service]
Type=exec
WorkingDirectory=/home/<사용자>/wookagent
ExecStart="<Node 경로>/node" "/home/<사용자>/wookagent/out/server/index.mjs" "serve" "--data-dir" "/home/<사용자>/wook-data" "--web-dir" "/home/<사용자>/wookagent/out/web"
# install-task를 실행한 셸의 PATH — 사용자 유닛의 기본 PATH에는 ~/.local/bin·nvm이 없습니다 (claude·codex·git·node)
Environment="PATH=<Node 경로>:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
UMask=0077
# 끌 때 서버에만 SIGTERM — 서버가 턴을 차례로 끝낸 뒤, 남은 프로세스는 systemd가 SIGKILL로 끝냅니다
KillMode=mixed
TimeoutStopSec=45
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
```

- **이름**: `wook-server-<8자>.service` — 8자는 데이터 폴더의 실제 경로(링크를 푼 것)의 해시(16진)입니다. 데이터 폴더마다 유닛 하나입니다. 폴더가 아직 없으면 가장 가까운 있는 위 폴더의 실제 경로에 나머지를 붙여 셉니다 — 그래서 경로에 심볼릭 링크가 있어도 첫 시작으로 폴더가 생기기 전과 뒤의 이름이 같습니다(이 PC의 WSL에서 링크를 거친 경로로 폴더를 만들기 전·뒤, 실제 경로로 셋 다 같은 이름을 봤습니다).
- **자리**: `~/.config/systemd/user/`(사용자 관리자에 `XDG_CONFIG_HOME`이 있으면 그 아래). 파일은 0600입니다.
- **적어 두는 것**: Node의 절대 경로와 이 셸의 PATH(L1단계 — Node·CLI를 옮기면 다시 등록), 절대 경로의 `--data-dir`, 웹 화면(`out/web`을 저절로 넣습니다). 포트를 바꿨으면 `--port <번호>`를 붙입니다. `--allow-test-session`은 받지 않습니다.
- **끄는 순서** (`KillMode=mixed`, `TimeoutStopSec=45`): 유닛을 멈추면 서버에만 SIGTERM이 갑니다. 서버가 돌던 턴을 차례로 끝내고 나가면 systemd가 남은 프로세스를 SIGKILL로 끝냅니다. 45초 안에 나가지 않으면 모두 SIGKILL입니다.
- **다시 띄우기** (`Restart=on-failure`, `RestartSec=60`, 10분에 4번까지): 서버가 실패로 끝나면 60초 뒤 다시 띄웁니다. `wook-server shutdown`으로 정상 종료하면 다시 띄우지 않습니다.
- `UMask=0077`: 서버가 만드는 파일은 이 사용자만 읽습니다.
- 유닛으로 뜬 서버는 사용자 관리자의 환경을 받습니다 — 로그인 셸의 `DISPLAY`는 없습니다(L9단계의 `screen.display`). `dbus-user-session`이 있으면 `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/<uid>/bus`가 들어 있습니다(이 PC의 WSL에서 `systemctl --user show-environment`로 봤습니다).

맞으면 등록합니다 (verify — 이 PC에서는 유닛을 등록하지 않습니다. 아래는 명령이 성공할 때 내는 글을 코드에서 옮긴 것입니다. 실제 등록 → 다시 읽기 → 지우기는 `tests/real/realUnit.test.ts`(`WOOK_REAL_UNIT=1`)가 CI의 러너에서 하고, 2026-11-13에 통과했습니다):

```sh
scripts/wook-server install-task --data-dir "$HOME/wook-data"
```

```text
systemd 사용자 유닛을 등록했습니다: wook-server-<8자>.service
  …(위의 --dry-run과 같은 일곱 줄)
다음 할 일
  지금 띄우기   systemctl --user start wook-server-<8자>.service
  확인          wook-server status --data-dir /home/<사용자>/wook-data
  기록          journalctl --user -u wook-server-<8자>.service
  끄기          wook-server shutdown --data-dir /home/<사용자>/wook-data (유닛을 지워도 실행 중인 서버는 그대로입니다)
  부팅할 때도   sudo loginctl enable-linger <사용자>  (관리자 권한이 드는 한 번 — 이 명령은 그것을 부르지 않습니다)
```

- `install-task`는 유닛 파일을 쓰고 `daemon-reload`·`enable`을 한 뒤, systemd에서 그대로 다시 읽어(파일 글, `LoadState`·`FragmentPath`·덧붙인 설정(drop-in)·`UnitFileState`·`KillMode`·`WorkingDirectory`·`ExecStart`) 쓴 것과 같은지 봅니다. **서버를 띄우지는 않습니다.**

유닛을 지금 띄우고 확인합니다. 첫 줄은 유닛 이름을 `install-task --dry-run --json`에서 읽어 `$unit`에 둡니다:

```sh
unit=$(scripts/wook-server install-task --dry-run --json --data-dir "$HOME/wook-data" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.name')
echo "$unit"
systemctl --user start "$unit"
scripts/wook-server status --data-dir "$HOME/wook-data"
journalctl --user -u "$unit" --no-pager -n 20
```

- `echo`는 `wook-server-<8자>.service`를 냅니다(첫 두 줄은 이 PC에서 돌렸습니다).
- `status`는 L4단계와 같은 꼴이어야 합니다. 서버가 막 떴으면 몇 초 뒤 다시 칩니다. (verify — 유닛으로 띄우지 않았습니다.)
- `journalctl`은 서버의 콘솔 출력(준비 줄 등)을 보여 줍니다. 등록하지 않은 이름이면 `-- No entries --`입니다(이 PC에서 본 것). 설정 코드는 저널에 남지 않습니다(L4단계).
- **끌 때**는 `scripts/wook-server shutdown --data-dir "$HOME/wook-data"`입니다. `systemctl --user stop "$unit"`도 위의 끄는 순서대로 끕니다. 메인 에이전트의 `host_exec`는 이 유닛을 멈추거나 다시 띄우는 명령을 받지 않습니다.

**부팅하면 로그인 없이 뜨게** — linger를 켭니다 **[사람: sudo 암호]** (verify — 이 PC에서는 바꾸지 않습니다. 둘째 줄은 읽기만 합니다):

```sh
sudo loginctl enable-linger "$(id -un)"
loginctl show-user "$(id -un)" -p Linger
```

- `Linger=yes`면 됩니다(켜기 전 이 PC는 `Linger=no`). linger가 꺼져 있으면 사용자 유닛은 그 사용자가 로그인할 때만 뜨고, 마지막 세션이 끝나면 함께 멈춥니다.

안 되면:

- `로그인한 사용자 계정으로 실행해야 합니다 — root로는 사용자 유닛을 등록하지 않습니다 …` → L0단계의 사용자.
- `이 사용자의 systemd(사용자 관리자)에 닿지 못했습니다 — …` → `sudo -u`·`su`로 바꾼 셸입니다. 그 사용자로 직접 로그인(SSH 포함)해 다시 합니다.
- `Node 실행 파일 경로(…)에 systemd가 실행 파일 이름으로 받지 않는 글자(" ' \ $)가 있습니다 — …` → 그런 글자가 없는 폴더에 Node를 두고(L1단계) 다시 합니다.
- `서버 진입점이 없습니다` → L2단계의 `npm run build:server`.
- `등록한 유닛이 쓴 것과 다릅니다 (…)`로 끝 코드 1 → 괄호 안이 다른 칸입니다. `덧붙인 설정(drop-in: …)`이면 누가 `systemctl --user edit`로 덧붙인 것입니다 — 그 파일을 지우고 `install-task`를 다시 합니다. 그 밖에는 `systemctl --user cat "$unit"`으로 보고 `install-task`를 다시 합니다.
- `status`가 `실행 중인 욱채 서버가 없습니다` → `systemctl --user status "$unit"`과 `journalctl --user -u "$unit"`의 끝을 봅니다. `<데이터 폴더>/logs/server.log`도 봅니다.

## L9. 화면 조작 — Xvfb 가상 화면 (선택)

메인 에이전트가 서버 PC의 화면을 찍고 마우스·키보드를 쓰게 하려면 이 단계를 합니다. 쓰지 않으면 건너뜁니다(server.json의 `screen.enabled`는 `false` 그대로). `check`의 화면 조작 항목이 'SERVER_SETUP의 Linux 화면 절'이라고 가리키는 곳이 여기입니다.

- **지원하고 시험한 모양**: 이 사용자의 Xvfb 가상 화면 하나와 EWMH 창 관리자 openbox. 사람의 화면이 아니라, 메인 에이전트가 쓸 프로그램을 띄워 두는 따로 된 화면입니다.
- **실제 X 데스크톱**(사람이 쓰는 X11 세션)은 최선 노력입니다: 곁 도우미(python3·python3-xlib)가 멈춤 단축키(Ctrl+Alt+Shift+F12)를 잡고 조작 중 표시(주황 테두리)를 그려야 입력을 받고, 아니면 입력을 거부합니다. 잠금은 X 화면 보호기 상태로만 봅니다. (verify — 실제 X 데스크톱에서는 돌려 보지 않았습니다.)
- **Wayland**(Xwayland 포함)는 쓸 수 없습니다. 서버가 Wayland 세션에서 돌면 `status`의 화면 조작 줄이 `Wayland: X11 세션이나 Xvfb가 필요합니다 — 이 서버는 Wayland 세션에서 돌고 있어 화면 조작을 쓸 수 없습니다. 서버 PC의 운영자가 Xvfb 화면을 띄우고 server.json의 screen.display에 그 화면(예: ":99")을 적은 뒤 서버를 다시 시작해야 합니다`입니다(깨끗한 Ubuntu 루트에서 `WAYLAND_DISPLAY`를 두고 띄워 본 것). 이 단계의 Xvfb를 쓰면 됩니다.
- **화면이 없으면**(`screen.enabled`가 `true`인데 `DISPLAY`도 `screen.display`도 없음 — 유닛으로 뜬 서버가 그렇습니다) 그 줄은 `화면 없음 — 서버에 X 화면이 없습니다(DISPLAY 없음, server.json의 screen.display 없음). 서버 PC의 운영자가 Xvfb 화면을 띄우고 server.json의 screen.display에 그 화면(예: ":99")을 적은 뒤 서버를 다시 시작해야 합니다`입니다(같은 곳에서 본 것).

꾸러미 **[사람: sudo 암호]** (verify — sudo. 이름은 WSL의 `apt-cache policy`로, 설치된 모양은 깨끗한 Ubuntu 루트에서 확인했습니다):

```sh
sudo apt install -y xvfb xauth openbox xdotool maim x11-utils x11-xserver-utils xinput xprintidle python3 python3-xlib python3-gi gir1.2-atspi-2.0 at-spi2-core fonts-noto-cjk
```

- 서버는 X 도구를 PATH가 아니라 `/usr/local/bin`·`/usr/bin`·`/bin`에서만 찾습니다. 하나라도 없으면 화면 도구가 `sudo apt install …` 줄과 함께 거부합니다. `xmodmap`·`xset`(`x11-xserver-utils`)은 글자 입력에 씁니다 — 한글 등은 빈 키 자리에 먼저 넣고 칩니다. `fonts-noto-cjk`가 없으면 캡처의 한글이 네모로 보입니다.
- **`python3`는 꼭 있어야 합니다**: 서버는 X 도구를 하나라도 띄우기 전에 python3로 화면의 주인을 확인합니다(아래 '서버가 거부하는 화면'). `python3-xlib`(와 `python3-gi`·`gir1.2-atspi-2.0`·`at-spi2-core`)는 곁 도우미 — 멈춤 단축키, 조작 중 표시, 암호 칸 판정 — 에 쓰고, 없어도 Xvfb에서는 화면 조작이 됩니다(그때는 어떤 칸인지 가르지 못해 글자 입력이 막힙니다).

**화면의 쿠키**를 만듭니다 — 이 쿠키가 없는 프로그램은 그 화면에 붙지 못합니다:

```sh
(umask 077 && touch ~/.wook-xvfb.auth && xauth -f ~/.wook-xvfb.auth add :99 . "$(mcookie)")
xauth -f ~/.wook-xvfb.auth list | awk '{print $1, $2, "<쿠키>"}'
stat -c '%A %n' ~/.wook-xvfb.auth
```

나와야 하는 것:

```text
<PC 이름>/unix:99 MIT-MAGIC-COOKIE-1 <쿠키>
-rw------- /home/<사용자>/.wook-xvfb.auth
```

- 쿠키는 화면 번호(`:99`)로 적습니다. 번호 없는 쿠키(와일드카드)는 곁 도우미(python3-xlib)가 쓰지 않습니다. `:99`를 다른 프로그램이 쓰면 다른 번호로 바꾸고, 아래의 모든 `:99`·`X99`도 같이 바꿉니다.
- 아래 Xvfb 유닛의 `ExecStartPre`는 Xvfb가 뜰 때마다(`Restart=on-failure`로 다시 뜰 때도) 이 줄을 새 쿠키로 바꿉니다 — X 서버가 끝난 틈에 다른 프로그램이 받아 간 쿠키로는 다음에 뜬 화면에 붙지 못하게 하려는 것입니다. 이 블록은 첫 시작 전에 한 번만 돌리고, 쿠키 파일에는 그 화면 번호의 줄 하나만 둡니다(Xvfb는 `-auth` 파일의 쿠키를 모두 받으므로 다른 줄이 남으면 옛 쿠키가 통할 수 있습니다). `xauth`는 새 파일을 0600으로 만듭니다(깨끗한 Ubuntu 루트에서 본 것).

**두 사용자 유닛** — Xvfb와 openbox:

```sh
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/wook-xvfb.service <<'UNIT'
[Unit]
Description=Xvfb for wookagent screen control
[Service]
ExecStartPre=/bin/sh -c 'xauth -f %h/.wook-xvfb.auth add :99 . $(mcookie)'
ExecStart=/usr/bin/Xvfb :99 -auth %h/.wook-xvfb.auth -nolisten tcp -s 0 -screen 0 1920x1080x24
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
cat > ~/.config/systemd/user/wook-openbox.service <<'UNIT'
[Unit]
Description=욱채 화면 조작용 창 관리자 (openbox, :99)
Requires=wook-xvfb.service
After=wook-xvfb.service

[Service]
Environment=DISPLAY=:99 XAUTHORITY=%h/.wook-xvfb.auth
ExecStartPre=/usr/bin/timeout 10 /bin/sh -c 'until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.2; done'
ExecStart=/usr/bin/openbox
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT
```

- **`-nolisten local`을 쓰지 않습니다.** X 도구(libxcb)는 화면의 소켓 파일 `/tmp/.X11-unix/X99`보다 추상 소켓 이름 `@/tmp/.X11-unix/X99`에 먼저 붙으므로, X 서버가 그 이름을 스스로 쥐고 있어야 다른 프로그램이 그 이름을 가로채 X 도구의 연결과 쿠키를 받지 못합니다. 그 이름으로든 소켓 파일로든 쿠키 없는 프로그램이 붙지 못하게 하는 것은 `-auth`입니다. 그래서 서버는 `-nolisten local`로 띄운 화면을 쓰지 않습니다(아래 '서버가 거부하는 화면').
- `-auth`: 쿠키가 없는 연결을 거부합니다. `-nolisten tcp`: 네트워크(TCP)로는 받지 않습니다. `-s 0`: X 화면 보호기를 끕니다. `%h`는 systemd가 이 사용자의 집 폴더로 바꿉니다. `-displayfd`(빈 번호를 X가 고르게 함)는 유닛에 쓰지 않습니다 — 잠금 파일을 쓰지 않아 이미 떠 있는 다른 화면의 소켓 파일을 가로챌 수 있습니다. openbox 유닛의 `ExecStartPre`는 Xvfb의 소켓 파일이 생길 때까지(10초까지) 기다립니다.
- 욱채 서버의 유닛(L8단계)은 `PrivateTmp`·`PrivateNetwork`를 쓰지 않아 이 화면에 닿습니다(둘 다 화면을 가립니다).
- (이 블록은 두 곳에서 돌렸습니다: 깨끗한 Ubuntu 루트(호출마다 따로 된 네트워크 이름 공간)에서 파일을 쓰고, 두 유닛의 `ExecStartPre`·`ExecStart` 줄을 `%h`만 바꿔 손으로 띄웠습니다 — 그 Xvfb는 소켓 파일과 추상 이름을 둘 다 쥐었습니다(`/proc/net/unix`). 같은 쿠키 파일로 Xvfb를 두 번 잇달아 띄우니 `ExecStartPre`마다 쿠키가 바뀌었고(파일의 줄은 하나 그대로), 두 번째 Xvfb는 첫 번째의 쿠키를 거부했으며, 서버는 두 번 다 `화면 조작을 쓸 수 있습니다 (모니터 1개, …)`였습니다. WSL에서는 `systemd --user --test`가 `ExecStartPre`의 `$(mcookie)`를 그대로 셸에 넘기는 것을 봤고, `systemd-analyze --user verify`는 'Command /usr/bin/Xvfb·/usr/bin/openbox is not executable'만 말했습니다 — WSL에 그 꾸러미가 없어서입니다.)

켜고 띄웁니다 (verify — 이 PC에서는 사용자 유닛을 등록하지 않습니다):

```sh
systemctl --user daemon-reload
systemctl --user enable --now wook-xvfb.service wook-openbox.service
systemctl --user is-active wook-xvfb.service wook-openbox.service
```

- 마지막 줄이 `active` 두 줄이면 됩니다.

**그 화면에 붙어 봅니다**:

```sh
export DISPLAY=:99 XAUTHORITY=~/.wook-xvfb.auth
xdpyinfo | grep -E '^(name of display|vendor string):|dimensions:'
xinput list --name-only | grep Xvfb
xprop -root _NET_SUPPORTING_WM_CHECK
XAUTHORITY=/dev/null xdpyinfo >/dev/null 2>&1 || echo "쿠키 없이는 붙지 못합니다 (맞음)"
```

나와야 하는 것 (깨끗한 Ubuntu 루트에서 Xvfb와 openbox를 띄우고 돌린 것):

```text
name of display:    :99
vendor string:    The X.Org Foundation
  dimensions:    1920x1080 pixels (488x274 millimeters)
Xvfb mouse
Xvfb keyboard
_NET_SUPPORTING_WM_CHECK(WINDOW): window id # <창 번호>
쿠키 없이는 붙지 못합니다 (맞음)
```

- `Xvfb mouse`·`Xvfb keyboard`는 서버의 화면 도우미가 '가상 화면'으로 아는 표시입니다. `_NET_SUPPORTING_WM_CHECK` 줄은 EWMH 창 관리자(openbox)가 떠 있다는 뜻입니다.
- 이 셸의 `DISPLAY`는 확인용입니다. 서버는 셸의 `DISPLAY`가 아니라 아래 server.json을 봅니다.

**server.json에 화면을 적고** 서버를 다시 띄웁니다(`screen` 칸은 시작할 때만 읽습니다):

```sh
node -e '
const fs = require("node:fs");
const f = process.env.HOME + "/wook-data/server.json";
const j = JSON.parse(fs.readFileSync(f, "utf8"));
j.screen = { enabled: true, display: ":99", xauthority: process.env.HOME + "/.wook-xvfb.auth" };
fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(j.screen));
'
scripts/wook-server shutdown --data-dir "$HOME/wook-data"
systemctl --user start "$unit"
```

- 첫 블록은 `{"enabled":true,"display":":99","xauthority":"/home/<사용자>/.wook-xvfb.auth"}`를 냅니다. server.json의 `screen`은 이렇게 됩니다:

  ```json
  { "screen": { "enabled": true, "display": ":99", "xauthority": "/home/<사용자>/.wook-xvfb.auth" } }
  ```

- `screen.display`는 **이 기계의** X 화면 이름(`:99` 꼴, `unix:99`도 됩니다), `screen.xauthority`는 그 쿠키 파일의 **절대 경로**(`/`로 시작 — `~`·`$HOME`은 펼쳐지지 않습니다)입니다. 모양이 틀리면 서버가 시작하지 않고 그 칸을 말합니다 — 예: `localhost:10.0`처럼 다른 기계를 가리키면 `욱채 서버를 시작하지 못했습니다: 운영자 설정을 적용하지 못했습니다 — … server.json의 screen.display는 X 화면 이름이어야 합니다 (예: ":99")`(깨끗한 Ubuntu 루트에서 본 것). `display`·`xauthority`·`typeWithoutA11y`는 시작할 때만 읽습니다 — 바꾸고 `config reload`를 하면 `server.json의 screen.display는 서버를 다시 시작해야 바뀝니다 — 지금은 시작할 때의 값을 씁니다`처럼 경고만 합니다.
- `screen.display`가 없으면 서버 프로세스의 환경이 정합니다: `WAYLAND_DISPLAY`나 `XDG_SESSION_TYPE=wayland`면 Wayland(쓸 수 없음), `DISPLAY`가 이 기계의 화면이면 그 화면, 둘 다 없으면 '화면 없음'. 유닛으로 뜬 서버에는 보통 `DISPLAY`가 없으므로 `screen.display`를 적습니다. `ssh -X`로 들어온 셸처럼 `DISPLAY`가 다른 기계를 가리키면(`localhost:10.0`) 쓰지 않습니다 — `status`의 화면 조작 줄이 `화면 없음 — 서버의 DISPLAY가 다른 기계의 화면을 가리킵니다(ssh -X 등). 이 기계의 화면만 씁니다 — …`입니다(깨끗한 Ubuntu 루트에서 본 것).
- 셋째 줄의 `$unit`은 L8단계에서 정한 이름입니다. 새 셸이면 L8단계의 `unit=$(…)` 줄을 먼저 칩니다. (셋째 줄은 verify — 유닛으로 띄우지 않았습니다. 이 PC에서는 같은 server.json으로 서버를 두 번째 셸처럼 띄워 확인했습니다.)

확인:

```sh
scripts/wook-server status --data-dir "$HOME/wook-data"
```

나와야 하는 것 (그 가운데 — 깨끗한 Ubuntu 루트에서 세션 버스(`dbus-run-session`) 아래 서버를 띄워 본 것):

```text
  화면 조작     화면 조작을 쓸 수 있습니다 (모니터 1개, 마지막 확인 <시각>)
```

**서버가 거부하는 화면**: 화면 도우미는 그 화면의 주인을 이때 확인합니다 — 도우미가 시작할 때(X 도구를 하나라도 띄우기 전)와 화면 상태를 볼 때(`--probe`), 무장(ARM)할 때마다, 그 밖의 명령을 시작할 때·`type`의 네 글자 묶음과 끌기 한 걸음마다·무장한 동안 250ms마다 도는 사람 입력 보기·놓기(RELEASE·STOP)에서는 마지막 확인이 1초보다 오래됐을 때, 그리고 X 도구 하나라도 화면에 붙지 못하거나 시간 안에 답하지 않으면 그 즉시(그 뒤로는 확인이 통과할 때까지 X 도구를 띄우지 않습니다). 확인은 python3로 그 화면의 두 소켓 — 추상 이름 `@/tmp/.X11-unix/X99`와 소켓 파일 `/tmp/.X11-unix/X99` — 에 붙어 보기만 하고(아무것도 보내지 않습니다) 상대 프로세스를 봅니다. 아래면 그 화면을 쓰지 않고 쿠키도 보내지 않으며, 그 까닭이 `status`의 화면 조작 줄과 `check`의 화면 조작 항목에 그대로 나옵니다(`check`는 서버가 돌 때 `화면(서버): <글>`):

| 까닭 | 글 |
|---|---|
| `noabstract` — 추상 이름을 쥔 것이 없음(`-nolisten local`로 띄운 Xvfb) | `화면의 X 서버가 추상 소켓 이름(@/tmp/.X11-unix/X<번호>)을 쥐고 있지 않습니다 — -nolisten local로 띄운 화면은 다른 프로그램이 그 이름을 가로채 X 도구의 연결과 쿠키를 받을 수 있어 쓰지 않습니다. 서버 PC의 운영자가 Xvfb를 -nolisten local 없이(-auth와 -nolisten tcp는 둔 채) 다시 띄워야 합니다` (깨끗한 Ubuntu 루트에서 `-nolisten local`을 붙여 띄워 본 것) |
| `foreign` — 추상 이름을 쥔 프로세스가 소켓 파일의 X 서버와 다름 | `화면의 이름(추상 소켓)을 쥔 프로세스가 소켓 파일의 X 서버와 다릅니다 — 다른 프로그램이 그 화면의 이름을 가로챘을 수 있어 쓰지 않았습니다(쿠키도 보내지 않았습니다). …` (코드의 글) |
| `otheruser` — X 서버가 다른 사용자의 것 | `화면의 X 서버가 서버와 다른 사용자의 것입니다 — 쓰지 않았습니다(쿠키도 보내지 않았습니다). 서버 PC의 운영자가 서버를 돌리는 사용자로 Xvfb를 띄워야 합니다` (코드의 글) |
| `unverified` — python3로 확인하지 못함 | `화면의 X 서버가 누구인지 확인하지 못해(python3 확인 실패) 쓰지 않았습니다 — 서버 PC의 운영자가 python3를 설치하고 서버를 다시 시작해야 합니다` (코드의 글) |
| `remote` — 화면이 다른 기계(`ssh -X`의 `DISPLAY`) | 위의 `화면 없음 — 서버의 DISPLAY가 다른 기계의 화면을 가리킵니다(ssh -X 등). …` (깨끗한 Ubuntu 루트에서 본 것) |

- X 서버를 다시 띄우면(프로세스가 바뀌면) 새 X 서버를 다시 확인하고 받아들입니다.
- **남은 틈**: X 서버가 끝난 틈에 다른 프로그램이 그 이름을 잡으면, X 서버가 끝난 뒤에 떠서 그 가운데 첫 도구가 '붙지 못함'을 알리기 전까지 뜬 X 도구는 쿠키를 그쪽으로 보냅니다 — 무장해 쉬는 도우미에서는 연결 하나(약 250ms 뒤 — S10c2가 Xvfb에서 잰 것), 명령이 도는 중이면 그 명령이 그때 함께 띄운 도구 수만큼입니다(추론). 그 이름을 잡은 프로그램이 연결을 끊지 않고 X 서버처럼 답하면 도구가 '붙지 못함'을 알리지 않으므로, 다음 주인 확인(길어야 1초 뒤)이 그 화면을 거부할 때까지 뜬 도구의 입력(치던 글 포함)과 캡처가 그쪽으로 갑니다 [추론 — 다른 사용자의 프로세스로는 돌려 보지 못했습니다, 리드 결정 S10-18 F2-4]. 그렇게 받아 간 쿠키로는 그 쿠키를 받는 X 서버에 붙어 화면을 보고 입력을 보낼 수 있습니다. 그래서 위 유닛은 X 서버가 뜰 때마다 새 쿠키를 쓰고, 옛 쿠키는 다시 뜬 화면에 붙지 못합니다(아래 실행). [KNOWN_ISSUES.md](KNOWN_ISSUES.md)에도 있습니다.

알아 둘 것:

- **처음 30초**: Xvfb나 openbox가 막 뜨면 X 서버가 그 시작을 '마지막 사람 입력'으로 셉니다. 그래서 처음 30초는 화면 조작이 사람 입력을 기다리며 멈춥니다(Windows의 부팅 직후와 같습니다).
- **멈춤 단축키와 긴급 정지**: Xvfb에는 누를 키보드가 없어 멈춤 단축키 규칙을 쓰지 않습니다. 대표의 멈춤은 긴급 정지입니다.
- **사람 입력**: 무장한 동안 250ms마다 X의 '마지막 입력부터 지난 시간'을 보고, `type`과 끌기는 자기 걸음 사이마다 한 번 더 봅니다. 그 화면에서 사람(이나 다른 프로그램)이 계속 움직이거나 치면 도는 `type`도 다음 걸음 전에 `human_active`로 멈추고 화면 조작이 30초 쉽니다(Xvfb에서 600자 `type` 도중 포인터를 계속 움직이자 48자 뒤에 멈춤 — S10c2). 도우미의 한 걸음(네 글자 묶음, 포인터 한 걸음) 안에서 시작하고 끝난 짧은 입력 한 번은 보통 보지 못합니다([KNOWN_ISSUES.md](KNOWN_ISSUES.md)).
- **Xvfb를 다시 띄웠으면**: 도우미는 새 X 서버를 받아들이지만 곁 도우미는 옛 X 서버와 함께 끝나, 도우미가 다시 뜰 때까지(쓰지 않은 지 10분, 대표의 정지, 서버 다시 시작) 암호 칸을 가르지 못해 `type`이 막힙니다. 곧바로 되살리려면 대표가 정지했다가 풀거나 서버를 다시 시작합니다(S10c2 — 추론, 이 PC에서는 보지 않았습니다).
- **암호 칸**: 곁 도우미가 AT-SPI(접근성)로 포커스가 암호 칸인지 봅니다. 서버의 환경에 세션 버스(`DBUS_SESSION_BUS_ADDRESS`)가 있어야 합니다 — `dbus-user-session`을 깔면 유닛이 받습니다. 세션 버스가 없거나 주소가 죽었으면 곁 도우미는 AT-SPI만 빼고 떠서 멈춤 단축키와 조작 중 표시는 그대로이고, 어떤 칸인지 가르지 못합니다(아래처럼 막힙니다). 모르는 칸(어떤 칸인지 가르지 못함)에는 글자 입력(`type`)과 글자 키를 보내지 않습니다. GTK 4(4.14)는 암호 칸을 따로 표시하지 않아, GTK 4 프로그램의 한 줄 입력 칸은 모두 '모르는 칸'입니다(깨끗한 Ubuntu 루트의 `zenity --password`에서 본 것 — S10c). 그래도 치게 하려면 server.json의 `screen.typeWithoutA11y`를 `true`로 둡니다 — 이 설정은 글자 입력(`type`)에만 듣고 그 결과에 '가르지 못함'을 적습니다. 모르는 칸에 보내는 글자 키(`key a` 등)는 그래도 막고, 암호 칸으로 알아본 칸에는 여전히 치지 않습니다. 시작할 때와 `check`가 경고합니다. Qt 프로그램은 `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`, Chromium·Electron은 `--force-renderer-accessibility`로 띄워야 접근성을 내놓습니다(verify — 이 PC에서는 시험하지 않았습니다).
- **글자 입력과 잠금 키**: 글자 입력(`type`)과 키(`capslock` 말고)를 보내는 동안 Caps Lock과 Shift Lock을 잠깐 풀었다가 보낸 뒤 되돌립니다 — 켜져 있어도 대소문자가 바뀌지 않습니다. 치는 도중에 정지(STOP)·놓기가 오거나 도우미가 끝나도 답하기 전에 되돌립니다(Xvfb에서 `type` 도중 정지해도 Caps Lock이 켜진 채 — S10c2). 한글 같은 글자는 빈 키 자리에 먼저 넣고 칩니다. 둘째 자판 배치를 잠가 둔 것(locked group)은 다루지 않습니다([KNOWN_ISSUES.md](KNOWN_ISSUES.md)).
- **관리되지 않는 창**: 클릭할 자리의 창은 화면에 뜬 맨 위 창으로 정하고, 메뉴·팝업처럼 창 관리자가 관리하지 않는 창도 셉니다. 그런 창은 그 프로세스나 주인 창으로 판단하고, 누구 것인지 알 수 없으면 거부합니다(`unowned`). X 화면 보호기가 아닌 잠금 화면은 잠금으로 알아보지 못하고, 확인에서 입력까지 수백 ms가 걸립니다([KNOWN_ISSUES.md](KNOWN_ISSUES.md)).
- **그 화면의 프로그램은 운영자가 띄웁니다**: 서버는 `DISPLAY`·`XAUTHORITY`를 CLI 턴과 `host_exec`에 넘기지 않습니다. 운영자가 `DISPLAY=:99 XAUTHORITY="$HOME/.wook-xvfb.auth"`를 붙여 띄워 둡니다.
- **지원하지 않는 것**: Wayland·Xwayland, 가운데 단추 클릭(선택한 글이 붙여 넣어져 비밀 값 검사를 피합니다), Linux의 막힌 키 조합(super+l, ctrl+alt+l, ctrl+alt+backspace, ctrl+alt+F1~F12, ctrl+alt+escape, ctrl+alt+delete), 터미널의 암호 물음 알아보기. 입력기(ibus·fcitx)가 켜진 화면은 시험하지 않았습니다. X11은 프로그램 사이를 막지 않습니다 — 같은 화면의 모든 프로그램이 입력을 받습니다. 그 밖의 한계는 [KNOWN_ISSUES.md](KNOWN_ISSUES.md)에 있습니다.

## L10. 외부 에이전트와 처음 메인 자리

Windows 편 9·10단계와 같습니다. `scripts\wook-server.cmd` 대신 `scripts/wook-server`, 데이터 폴더 자리에는 `"$HOME/wook-data"`를 씁니다. 키 파일 `~/.wook/agent.json`은 [SERVER_INSTALL.md](SERVER_INSTALL.md) 10절 2의 Linux 블록(0700 폴더, `umask 077`)으로 씁니다. 배정과 확인은:

```sh
scripts/wook-server seat assign external:X-0001 --data-dir "$HOME/wook-data"
scripts/wook-server seat status --data-dir "$HOME/wook-data"
```

- 답의 꼴은 Windows 편 9단계와 같습니다. 9단계를 하지 않으면 메인 자리는 server.json의 `seat.initialHolder`대로 서버가 띄우는 Claude CLI입니다(Windows 편 10단계).

## L11. 대표의 첫 로그인 — [사람: 휴대폰]

Windows 편 11단계와 같습니다 (verify — 실제 구글 로그인과 휴대폰이 필요합니다). 확인은 `scripts/wook-server config show --data-dir "$HOME/wook-data"`의 `대표 계정` 줄이 `구글 계정 등록됨`으로 바뀐 것입니다.

## L12. 마지막 점검과 다시 시작 — [사람]

```sh
scripts/wook-server check --data-dir "$HOME/wook-data"
```

마지막 줄이 `결과: … 실패 0 …`이고 경고가 없어야 합니다(남은 경고마다 [부록 D](#부록-d-문제-해결--linux-check-항목과-시작-거부)).

**[사람]** `sudo reboot`으로 다시 시작합니다. 그다음 **로그인하지 않은 채** 다른 기기에서 차례로 봅니다 (verify — 이 PC에서는 다시 시작하지 않습니다):

1. 휴대폰 브라우저로 공개 주소가 열립니다(linger와 유닛 — L8단계).
2. SSH로 들어가 `scripts/wook-server status --data-dir "$HOME/wook-data"`가 L4단계와 같은 꼴입니다. `systemctl --user status "$unit"`이 `active (running)`입니다.
3. 대표의 휴대폰은 다시 로그인하지 않아도 화면이 열립니다(기기 세션은 쓰지 않고 14일, 최대 90일).
4. `config show`의 `구글 보안 비밀` 줄이 여전히 `등록됨 (데이터 폴더의 비밀 값 파일)`입니다.
5. 화면 조작을 켰으면 `status`의 `화면 조작` 줄이 `화면 조작을 쓸 수 있습니다 (…)`입니다(Xvfb·openbox 유닛이 함께 떴습니다).

## L13. 되돌리기

구글 보안 비밀만 지우려면 서버가 도는 동안 지웁니다(`secret clear`는 실행 중인 서버에 보내는 명령입니다):

```sh
scripts/wook-server secret clear google-client-secret --data-dir "$HOME/wook-data"
```

나와야 하는 것:

```text
구글 로그인 보안 비밀을 지웠습니다. 다시 넣기 전까지 기기 코드 로그인을 시작할 수 없습니다.
```

그다음 서버를 끄고 유닛을 지웁니다:

```sh
scripts/wook-server shutdown --data-dir "$HOME/wook-data"
scripts/wook-server uninstall-task --data-dir "$HOME/wook-data"
tailscale serve --https=443 off
```

- `uninstall-task`는 유닛만 지우고(`disable` → 파일 지우기 → `daemon-reload` → 다시 읽어 없어진 것을 봅니다) 실행 중인 서버는 끄지 않습니다. 그래서 `shutdown`을 먼저 합니다. 지우면 `사용자 유닛 wook-server-<8자>.service을 지웠습니다. 실행 중인 서버는 끄지 않았습니다 — 끄려면 wook-server shutdown --data-dir /home/<사용자>/wook-data`를 냅니다(코드의 글 — verify). 유닛이 없으면 `등록된 유닛이 없습니다 (wook-server-<8자>.service) — 바꾼 것이 없습니다`로 0입니다(이 PC에서 본 것). 유닛이 있는지 읽지 못하면 지우지 않고 1입니다. 다른 자리에 같은 이름의 유닛이 있으면 아무것도 지우지 않고 1입니다.
- **다른 이름의 유닛**: 유닛 폴더에 `install-task`가 쓴 유닛(첫 줄로 알아봅니다)인데 `--data-dir`이 같은 폴더를 가리키는 것이 다른 이름으로 있으면(데이터 폴더가 생기기 전에 예전 판으로 등록했거나 경로의 링크가 바뀐 경우), `uninstall-task`는 그것도 함께 지우고 `사용자 유닛 <이름>, <이름>을 지웠습니다. …`라고 냅니다. `--dry-run`은 `지울 사용자 유닛: <이름>, <이름> (같은 데이터 폴더를 가리키는 다른 이름의 유닛 포함)`으로 보여 줍니다. 하나라도 읽지 못하거나 다른 자리의 것이면 아무것도 지우지 않습니다. (코드의 글 — 이 PC에서는 유닛 폴더에 파일을 쓰지 않아 verify. S10b가 가짜 systemd로 시험했습니다.)
- 무엇을 지우는지 먼저 보려면 `scripts/wook-server uninstall-task --dry-run --data-dir "$HOME/wook-data"`:

  ```text
  [시험 실행 — 아무것도 바꾸지 않았습니다] 지울 사용자 유닛: wook-server-<8자>.service
  실행할 명령
    systemctl --user show wook-server-<8자>.service -p LoadState -p FragmentPath -p DropInPaths -p UnitFileState -p KillMode -p WorkingDirectory -p ExecStart -p ActiveState  (유닛이 있는지 읽습니다 — 지운 뒤에도 한 번 더)
    systemctl --user disable wook-server-<8자>.service
    rm /home/<사용자>/.config/systemd/user/wook-server-<8자>.service
    systemctl --user daemon-reload
  ```

- 화면 조작의 두 유닛 (verify): `systemctl --user disable --now wook-openbox.service wook-xvfb.service`, `rm ~/.config/systemd/user/wook-openbox.service ~/.config/systemd/user/wook-xvfb.service ~/.wook-xvfb.auth`, `systemctl --user daemon-reload`.
- **[사람: sudo 암호]** (verify): linger 끄기 `sudo loginctl disable-linger "$(id -un)"`, 절전 대상 풀기 `sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target`.
- 데이터 폴더(`~/wook-data` — 비밀 값 파일이 그 안에 있습니다)와 작업 폴더(`~/wook-workspace`)는 지우지 않으면 남습니다.
- (이 PC에서는 `secret clear`·`shutdown`을 임시 데이터 폴더의 서버로, `uninstall-task`를 등록한 유닛이 없을 때와 `--dry-run`으로 돌렸습니다. `tailscale serve --https=443 off`는 verify — 이 PC에는 Tailscale이 없습니다.)

## 부록 C. 깨끗한 Linux VM 점검표

새 Ubuntu 24.04 VM에서 이 문서만 보고 설치하며 확인할 것입니다. '이 PC'는 위 출력을 찍은 곳(대표의 Windows PC 안의 WSL2 Ubuntu 24.04와 깨끗한 Ubuntu 24.04 루트 — 시험 기계가 아님)입니다. 이 PC에서는 sudo, 유닛 등록, 시스템·전원 설정, Tailscale 설정, 실제 구글·CLI 로그인, 다시 시작을 하지 않았습니다(리드 결정 S10-9).

| # | 확인할 것 | 어떻게 | 이 PC 결과 |
|---|---|---|---|
| 1 | L0의 네 줄 (Ubuntu, uid ≠ 0, 사용자 systemd, `/proc`) | L0 | 확인함 (WSL) |
| 2 | `apt install` 줄이 sudo 암호 말고는 묻지 않고 끝난다 | L1 | (verify — sudo를 쓰지 않음). 꾸러미 이름은 `apt-cache policy`로 모두 확인함 |
| 3 | Node 압축 파일 블록 → `v24.13.0`, 새 로그인 셸에서도 `node`가 그 자리 | L1 | 블록은 깨끗한 Ubuntu 루트에서 확인함. 새 로그인 셸(SSH)이 `~/.profile`을 읽는 것은 (verify) |
| 4 | `npm i -g`로 CLI 둘, 판 확인 | L1 | (verify — `npm i -g`를 하지 않음) |
| 5 | `git clone`(비공개면 GitHub 로그인) | L2 | (verify) |
| 6 | `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`가 컴파일러 없이 끝난다 | L2 | WSL의 사본에서 확인함. 컴파일러가 없는 깨끗한 VM에서는 (verify) |
| 7 | 빌드 둘과 `scripts/wook-server --help`, 실행 권한 | L2 | 빌드·도움말 확인함. 저장소에서 받은 `scripts/wook-server`의 실행 권한은 (verify — 커밋에서 정해짐. POSIX에서는 `tests/server/wookServerScript.test.ts`가 실행 권한을 봄) |
| 8 | 브라우저 없는 로그인: `codex login --device-auth`, `claude auth login`(주소와 코드), `claude setup-token` → `~/.config/environment.d` | L3 | (verify — 실제 로그인을 하지 않음. environment.d를 사용자 관리자가 언제 읽는지, 그 토큰을 `claude auth status`가 로그인으로 보는지 확인하지 못함) |
| 9 | 데이터 폴더 블록(0700, 96바이트 줄), 설정용 서버, `status`, `shutdown`·Ctrl+C 때 서버 셸에 글이 더 나오지 않음(끝 코드 0) | L4·L8 | 확인함 (WSL, 임시 집 폴더) |
| 10 | `config google-client-id`, `secret set`(파일로), `config show`, `secrets`의 0700·0600, 값 파일이 0644면 서버가 시작하지 않고 `check`가 실패 | L5 | 확인함 (WSL). 붙여 넣는 꼴과, 쓰다 죽은 서버가 남긴 임시 파일 지우기는 (verify — 시험 `fileSecretStore.test.ts`로만) |
| 11 | Tailscale 설치, `tailscale up --operator`, MagicDNS·HTTPS, `tailscale serve --bg 7317` | L6 | (verify — sudo, Tailscale 바꾸기) |
| 12 | 공개 주소 블록과 `config reload` | L6 | 대역 `tailscale`로 확인함. 실제 `tailscale status --json`은 (verify) |
| 13 | `systemctl mask` 네 절전 대상 → `LoadState=masked` | L7 | (verify — sudo). 읽는 줄은 확인함(`loaded`) |
| 14 | linger로 뜬 유닛의 서버가 작업 중 `절전 방지 unavailable — systemd-inhibit: Failed to inhibit: Access denied`, 막아 둔 뒤 `check`의 `절전 방지` 통과(서버가 없거나 `systemd-inhibit`이 없어도). 데스크톱 세션에서 띄우면 polkit이 잠금을 내주는지 | L7 | `systemd-inhibit`의 `Access denied`만 확인함 (WSL). 막아 둔 뒤의 통과는 코드와 시험(`linuxCheck.test.ts`)으로만. 나머지는 (verify — sudo, polkit, 데스크톱 세션) |
| 15 | `check`의 17개 항목과 고칠 줄 — 링크인 데이터 폴더(`링크 →`, 고칠 줄은 실제 폴더), 가리키는 곳 없는 링크·링크 고리는 실패이고 서버도 시작하지 않음, X 도구가 없을 때 경고(`screen.enabled: true`면 실패), 화면 항목의 고칠 줄에 절대 경로 | L4·L7 | 확인함 (WSL — 유닛·linger·절전·CLI·Tailscale은 경고 상태로). 데이터 폴더를 실제로 다른 디스크(붙였다 뗐다 하는 디스크)에 두고 부팅할 때 붙기 전에 유닛이 뜨는 경우는 (verify — 디스크·부팅) |
| 16 | `install-task --dry-run`과 `--dry-run --json`의 이름, 링크를 거친 데이터 폴더가 생기기 전·뒤에 이름이 같음 | L8 | 확인함 (WSL) |
| 16a | 다른 이름으로 등록된 같은 폴더의 유닛을 `check`가 알리고 `uninstall-task`가 함께 지움 | L8·L13 | (verify — 이 PC에서는 유닛 폴더에 파일을 쓰지 않음. 가짜 systemd로 `unitLinux.test.ts`가 봄) |
| 17 | `install-task` 등록 → 다시 읽기, `systemctl --user start`, `status`, `journalctl --user -u` | L8 | (verify — 유닛을 등록하지 않음, S10-9). 실제 등록 → 다시 읽기 → 지우기는 `tests/real/realUnit.test.ts`가 CI(GitHub Actions ubuntu-24.04)에서 통과함(2026-11-13, 세 실행 모두 — 서버는 띄우지 않음). `systemctl --user start`·`status`·`journalctl`은 (verify — VM에서) |
| 18 | 유닛을 멈출 때 `KillMode=mixed`: 서버만 SIGTERM, 도는 CLI 턴이 차례로 끝나고 45초 안에 끝남 | L8 | 잠깐 띄우는 systemd 유닛(`systemd-run --user`)과 가짜 서버로만 확인함(서버만 SIGTERM, 0.8초 — S10b). 실제 서버와 CLI로는 (verify) |
| 19 | 사용자 저널에 서버의 출력이 남고 설정 코드는 남지 않음 | L8 | (verify — 저널). 설정 코드를 systemd 아래에서 내지 않는 것은 시험(`serveLinux.test.ts`)으로 확인함 |
| 20 | `sudo loginctl enable-linger` → `Linger=yes`, 부팅 뒤 로그인 없이 유닛이 뜸 | L8·L12 | (verify — linger, 다시 시작). 지금 `Linger=no`를 읽는 것만 확인함 |
| 21 | 화면 꾸러미, 쿠키, Xvfb·openbox 유닛 등록과 `is-active`, `ExecStartPre`가 Xvfb가 뜰 때마다 새 쿠키를 씀 | L9 | 쿠키 블록·두 유닛 파일·`ExecStartPre`·`ExecStart` 줄은 깨끗한 Ubuntu 루트에서 확인함(쿠키 0600, 손으로 두 번 띄우니 쿠키가 바뀌고 옛 쿠키는 거부, 서버는 두 번 다 받아들임). systemd가 `$(mcookie)`를 셸에 그대로 넘기는 것은 WSL의 `systemd --user --test`로 봄. 유닛 등록·부팅 때 뜨는 것과 `Restart=on-failure`로 다시 뜰 때도 `ExecStartPre`가 도는 것은 (verify) |
| 21a | 유닛으로 띄운 Xvfb를 `systemctl --user restart wook-xvfb.service`로 다시 띄운 뒤: 쿠키가 바뀌고, 서버의 화면 조작이 다시 쓸 수 있게 되며, 대표의 정지 → 해제(또는 서버 다시 시작) 뒤 곁 도우미가 돌아와 암호 칸 판정이 되돌아옴 | L9 | (verify — 유닛을 등록하지 않음. 곁 도우미가 돌아오는 길은 S10c2의 추론) |
| 22 | 화면에 붙어 보기(`xdpyinfo`·`xinput`·`xprop`, 쿠키 없이는 거부) | L9 | 확인함 (깨끗한 Ubuntu 루트) |
| 23 | server.json `screen.display`·`xauthority` → `status`의 `화면 조작을 쓸 수 있습니다`; `-nolisten local`로 띄운 Xvfb는 `noabstract` 글로 거부; `ssh -X`의 `DISPLAY`는 `remote` 글; `screen.display`에 다른 기계를 적으면 시작 거부 | L9 | 확인함 (깨끗한 Ubuntu 루트 — 호출마다 따로 된 네트워크 이름 공간, 세션 버스 아래 띄운 서버). `foreign`·`otheruser`·`unverified`는 코드와 S10c의 시험으로만. 유닛으로 띄운 서버는 (verify) |
| 24 | 유닛의 서버가 사용자 세션 버스를 받아 AT-SPI로 실제 프로그램(GTK 3·Qt·Chromium)의 암호 칸을 가름. 세션 버스 없이 띄운 서버에서는 멈춤 단축키·조작 중 표시는 되고 `type`이 막힘 | L9 | (verify — 실제 프로그램의 AT-SPI는 GTK 3의 mousepad와 GTK 4의 zenity만 시험함, S10c. 버스 없는 경우는 S10c2가 Xvfb에서 봄) |
| 25 | 실제 X 데스크톱(사람의 X11 세션)에서 곁 도우미, 멈춤 단축키, 주황 테두리 | L9 | (verify — 실제 X 데스크톱 없음) |
| 26 | 실제 화면 시험 `tests/real/realDesktop.linux.test.ts` (`WOOK_REAL_DESKTOP=1`, `WOOK_REAL_DESKTOP_HOST` — 시험이 띄운 Xvfb의 PID를 문에 적음): 정확한 글자 입력(Caps Lock·Shift Lock이 켜져 있어도, 도중에 정지해도 잠금이 되돌아옴), 긴 `type` 도중 계속된 사람 입력에 `human_active`로 멈춤, 관리되지 않는 창 거부, 화면 주인 확인 | L9 | 이 PC의 깨끗한 Ubuntu 루트에서 통과함(S10c·S10c2). CI(GitHub Actions ubuntu-24.04의 Xvfb)에서도 16 중 16 통과함(2026-11-13, 세 실행 모두). 사람이 실제 키보드·마우스로 한 번만 짧게 건드린 입력을 놓치는 것은 (verify — 실제 화면 없음, KNOWN_ISSUES) |
| 27 | 외부 에이전트 키 파일(SERVER_INSTALL 10절 2의 Linux 블록), `seat assign`·`seat status` | L10 | 확인함 (WSL) |
| 28 | 대표의 휴대폰이 Tailscale을 거쳐 구글로 로그인 | L11 | (verify — 대표와 함께) |
| 29 | 다시 시작 뒤: 로그인 없이 유닛 → 휴대폰 → `status` → 비밀 값 그대로 → 화면 조작 | L12 | (verify — 다시 시작) |
| 30 | `secret clear`, `shutdown`, `uninstall-task`(있는 유닛과 같은 폴더의 다른 이름 유닛을 지움), 화면 유닛 지우기, linger 끄기, unmask | L13 | `secret clear`·`shutdown`과 유닛이 없을 때의 `uninstall-task`·`--dry-run`만 확인함. 나머지는 (verify) |

## 부록 D. 문제 해결 — Linux check 항목과 시작 거부

### check 항목별

`check`의 각 줄은 `통과`·`경고`·`실패`·`건너뜀`이고, 경고·실패 밑의 `할 일:`이 고칠 길입니다. 고친 뒤 `check`를 다시 합니다. 아래 글은 점검 코드(`src/server/deployCheckLinux.ts`, 화면은 `src/main/desktop/x11Check.ts`)의 글이고, L7단계에 나온 줄은 실제 출력입니다.

| 항목 (`--json`의 id) | 이런 글이면 | 할 일 |
|---|---|---|
| 실행 사용자 (`user`) | 실패: `root(uid 0)로 돕니다` / 경고: `시스템 계정(<이름>, uid <n>)으로 돕니다` | 서버를 돌릴 로그인 사용자로, sudo 없이 다시 점검합니다(L0) |
| /proc (`proc`) | 실패: `/proc를 읽지 못합니다 …` 등 `/proc`의 글 | `/proc`이 마운트된 보통의 Linux에서 돌립니다 — 컨테이너는 지원하지 않습니다(아래 '서버가 시작하지 않을 때') |
| procps (`procps`) | 경고: `ps·pgrep이 PATH에 없습니다 — 서버는 /proc으로 보지만 운영자의 확인 명령(ps·pgrep)을 쓸 수 없습니다` | `sudo apt install procps` |
| Node (`node`) | 실패: `Node <판> — 24 이상이어야 합니다 (node:sqlite)` | L1의 Node 블록 뒤 `할 일:`의 `wook-server install-task --data-dir <폴더>`로 유닛을 다시 등록합니다(유닛은 Node의 절대 경로를 적어 둡니다) |
| systemd 유닛 (`unit`) | 경고: `등록된 유닛이 없습니다 (wook-server-<8자>.service)` | L8 (`할 일:`의 `wook-server install-task --data-dir <폴더>`) |
| | 경고: `이 데이터 폴더의 유닛이 다른 이름으로 등록돼 있습니다 (<이름>) — 데이터 폴더가 생기기 전에 등록했거나 경로의 링크가 바뀌었습니다` / 경고 안에 `같은 데이터 폴더의 유닛이 다른 이름으로도 있습니다 (<이름>) — 부팅하면 서버 둘이 같은 폴더로 뜨려 합니다` | `할 일:`의 `지우고 다시 등록하세요: wook-server uninstall-task … 뒤 wook-server install-task …`를 그대로 칩니다 — `uninstall-task`가 다른 이름의 유닛도 지웁니다(L13). (코드의 글 — verify: 이 PC에서는 유닛 폴더에 파일을 쓰지 않습니다) |
| | 경고: `사용자 systemd에 닿지 못해 유닛을 보지 못했습니다 (…)` | 서버를 돌릴 사용자로 직접 로그인한 셸(SSH 포함)에서 다시 점검합니다 — `sudo -u`·`su` 셸에는 사용자 버스가 없습니다 |
| | 경고: `Node가 지금 것과 다릅니다` / `서버 진입점이 지금 것과 다릅니다` / `데이터 폴더가 지금 것과 다릅니다` / `install-task가 쓰지 않는 인자가 있습니다 (…)` / `ExecStart=가 <n>개입니다` / `install-task가 쓴 파일이 아닙니다(첫 줄이 다릅니다)` / `덧붙인 설정(drop-in)이 있습니다 (…)` / `켜져(enable) 있지 않습니다` / `KillMode가 <값>입니다` / `systemd가 읽는 유닛이 install-task의 자리가 아닙니다` | `할 일:`의 `다시 등록하세요 (같은 이름을 바꿔 넣습니다): wook-server install-task … --data-dir <폴더>`를 그대로 칩니다 — 지금 유닛의 `--port`·`--public-origin` 등을 옮겨 적어 줍니다. drop-in이면 그 파일을 먼저 지웁니다 |
| | 실패: `--allow-test-session으로 띄웁니다 — 시험용 세션 발급이 켜집니다` | 누가 유닛을 손으로 바꿨습니다. `uninstall-task` 뒤 `install-task`를 다시 합니다 |
| linger (`linger`) | 경고: `꺼져 있습니다 — 부팅한 뒤 <사용자>로 로그인하기 전에는 서버가 뜨지 않습니다` | `sudo loginctl enable-linger <사용자>` (L8) |
| 데이터 폴더 (`dataDir`) | 경고: `그룹·다른 사용자도 열 수 있습니다 (755)` / `주인이 이 사용자가 아닙니다 (uid <n>)` | `할 일:`의 `chmod 700 <폴더>` / `sudo chown -R <사용자>: <폴더>` — 데이터 폴더가 링크면 `<폴더>`는 링크가 가리키는 실제 폴더입니다(`chown -R`은 명령줄의 링크를 따라가지 않아, 링크 경로로는 링크만 바뀝니다). (이 PC에서 0755로 바꿔 본 출력: `할 일: chmod 700 /home/<사용자>/d1`) |
| | 건너뜀: `데이터 폴더가 아직 없습니다 (…) — 서버가 처음 시작할 때 이 사용자만(0700) 열 수 있게 만듭니다` | L4를 합니다 |
| | 데이터 폴더 자신이 심볼릭 링크이면 서버처럼 링크를 따라가 그 폴더를 보고(경로 중간에만 링크가 있으면 `(링크 → …)` 없이 적은 경로 그대로 나옵니다 — 고칠 줄은 그대로 통합니다), 글에 `<폴더> (링크 → <실제 폴더>)`가 나옵니다 — 예: `통과 데이터 폴더 /home/<사용자>/link-data (링크 → /home/<사용자>/real-data) — 이 사용자만 열 수 있습니다 (700)`. 고칠 줄도 링크가 가리키는 폴더를 적습니다 — 예: `경고 데이터 폴더 /home/<사용자>/link-data (링크 → /home/<사용자>/real-data): 그룹·다른 사용자도 열 수 있습니다 (755) — …` 밑에 `할 일: chmod 700 /home/<사용자>/real-data` (둘 다 이 PC의 WSL에서 본 것) | 경고가 없으면 할 일이 없습니다. 경고는 링크가 가리키는 폴더에 대한 것이고, 고칠 줄을 그대로 칩니다 |
| | 실패: `<폴더>: 데이터 폴더가 링크인데 가리키는 곳이 없습니다 (링크 → <적힌 곳>) — 서버는 그 자리에 폴더를 만들 수 없습니다` (`할 일: 가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요`) / `<폴더>: 데이터 폴더가 링크인데 링크가 고리를 이뤄 폴더에 닿지 않습니다 (링크 → <적힌 곳>) — 서버는 그 자리에 폴더를 만들 수 없습니다` (`할 일: 링크를 고치거나 지우세요`) (둘 다 이 PC의 WSL에서 본 것, 끝 코드 1) | 디스크가 아직 붙지 않았으면 붙입니다(mount). 그렇지 않으면 `ls -l <폴더>`로 링크를 보고 고치거나 지웁니다 — 링크를 지우면 서버가 처음 시작할 때 그 자리에 새 폴더를 만듭니다(L4). 서버는 고칠 때까지 시작하지 않습니다(아래 '서버가 시작하지 않을 때'). 유닛이면 다시 띄우기를 되풀이하고, `journalctl --user -u "$unit"`에 그 시작 거부 줄이 남습니다 |
| | 실패: `<폴더>: 데이터 폴더 경로의 위 폴더(<위 폴더>)가 링크인데 가리키는 곳이 없습니다 (링크 → <적힌 곳>) — 서버는 데이터 폴더를 만들 수 없습니다` (예: `~/wook` → 붙지 않은 디스크, 데이터 폴더 `~/wook/wook-data`) / `<폴더>: 데이터 폴더 경로의 위 폴더 자리(<위 폴더>)에 폴더가 아닌 것이 있습니다 — 서버는 그 아래에 데이터 폴더를 만들 수 없습니다` (둘 다 이 PC의 WSL에서 본 것, 끝 코드 1 — 서버도 같은 글로 시작하지 않습니다) | 앞의 것은 위 줄과 같습니다(디스크를 붙이거나 링크를 고침). 뒤의 것은 `할 일: 그 자리의 파일을 옮기거나 지우세요, 아니면 다른 --data-dir을 쓰세요` |
| 비밀 값 저장소 (`secrets`) | 실패: `비밀 값 폴더(<폴더>/secrets)의 권한이 넓습니다 (755) — 그룹·다른 사용자가 열 수 있습니다. 고치기: chmod 700 '<폴더>/secrets'` / `비밀 값 파일(<폴더>/secrets/<64자>.json)의 권한이 넓습니다 (644) — 그룹·다른 사용자가 열 수 있습니다. 고치기: chmod 600 '<폴더>/secrets/<64자>.json'` (둘 다 이 PC의 WSL에서 본 것 — 서버도 같은 글로 시작하지 않았습니다) | 그 `chmod` 줄을 칩니다. 폴더나 값 파일의 주인이 다르면 `… 주인이 이 사용자(uid <n>)가 아닙니다 …`, 링크면 `… 심볼릭 링크입니다 …` — 이 사용자 것으로 다시 만들거나 링크를 지웁니다. 서버는 고칠 때까지 시작하지 않습니다 |
| | 경고: `비밀 값이 OS 키링에 있습니다 …` / 실패: `비밀 값이 메모리에 있습니다 …` | 서버를 다시 시작합니다(Linux의 서버는 파일 저장소를 씁니다). 메모리였다면 비밀 값을 다시 넣습니다 |
| 절전 (`sleep`) | 경고: `절전 대상이 막혀 있지 않습니다 (…)` | `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` (L7) |
| | 건너뜀: `절전 대상을 읽지 못했습니다 (…)` | `systemctl show -p Id -p LoadState sleep.target`을 직접 쳐 봅니다 |
| 절전 방지 (`power`) | 경고: `작업 중 절전 막기를 쓸 수 없습니다 — systemd-inhibit: Failed to inhibit: Access denied` | 절전 대상을 막아 둡니다(L7) |
| | 경고: `systemd-inhibit이 PATH에 없습니다 — 서버는 작업 중에도 절전을 막지 못합니다` | 절전 대상을 막아 둡니다(L7) |
| | 건너뜀: `서버가 돌지 않아 절전 방지 상태를 보지 못했습니다` | 서버를 띄운 뒤 다시 합니다 |
| | 절전 대상 넷을 모두 막아 두었으면 이 항목은 통과입니다 — 서버가 `unavailable`을 말해도, `systemd-inhibit`이 없어도, 서버가 돌지 않아도: `작업 중 절전 막기를 쓸 수 없지만(…)` / `systemd-inhibit이 PATH에 없지만` / `서버가 돌지 않아 절전 막기 상태는 보지 못했지만` 뒤에 `절전 대상을 막아 두어 괜찮습니다` (코드의 글 — verify: 이 PC에서는 막지 않습니다) | 할 일이 없습니다 |
| Claude CLI·Codex CLI (`cli.claude`·`cli.codex`) | 경고: `찾지 못했습니다 — 이 AI를 쓰지 않으면 괜찮습니다` / `로그인돼 있지 않습니다 …` | L1의 `npm i -g …` 뒤 L3. CLI는 유닛의 PATH로 찾습니다 — 설치한 뒤 `install-task`를 다시 해 그 PATH를 넣습니다. API 키 방식이면 `할 일:`의 `wook-server secret set claude-api-key\|codex-api-key --data-dir <폴더>`(표준 입력) |
| 유닛의 PATH (`path`) | 경고: `이 셸에서 찾은 <이름>(<자리>)이 유닛의 PATH 밖에 있습니다 — 서버(유닛)는 그것을 찾지 못합니다` | 그 PATH가 있는 셸에서 `install-task`를 다시 합니다 |
| | 건너뜀: `유닛이 없거나 PATH를 적지 않아 견주지 못했습니다` | L8 뒤 다시 합니다 |
| API 키 환경 변수 (`apikey-env`) | 경고: `구독 방식인데 API 키 환경 변수가 있습니다: ANTHROPIC_API_KEY(이 셸·사용자 관리자·유닛) …` — 값은 읽지 않습니다 | 구독이면 `~/.profile`·`~/.bashrc`·`~/.config/environment.d`에서 지우고 `systemctl --user unset-environment <이름>` 뒤 서버를 다시 시작합니다. API 키로 쓰려면 `secret set`(L3) |
| 화면 조작 (`screen`) | 경고(server.json의 `screen.enabled`가 `true`면 실패): `화면 도우미에 필요한 X 도구가 없습니다: xdotool, maim, xprop, xwininfo, xrandr, xinput, xprintidle, xdpyinfo, xmodmap, xset — 서버 PC의 운영자가 설치해야 합니다 (sudo apt install xdotool maim x11-utils x11-xserver-utils xinput xprintidle)` (python3가 없으면 그 목록에 `python3`도 나옵니다 — 이 PC의 WSL에서 `screen` 칸 없이·`true`로 본 것) | 화면 조작을 쓰면 L9의 꾸러미, 쓰지 않으면 server.json에 `"screen": { "enabled": false }`(L4) 뒤 서버를 다시 시작합니다 |
| | 경고: `화면 없음 — 서버에 X 화면이 없습니다(DISPLAY 없음, server.json의 screen.display 없음) …` / `화면 없음 — 서버의 DISPLAY가 다른 기계의 화면을 가리킵니다(ssh -X 등) …` / `Wayland: X11 세션이나 Xvfb가 필요합니다 …` | L9의 Xvfb와 server.json `screen.display`·`screen.xauthority`. `할 일:`이 `… server.json에 "screen": { "display": ":99", "xauthority": "/home/<사용자>/.wook-xvfb.auth" } 를 적은 뒤 서버를 다시 시작`처럼 이 사용자의 집 폴더로 쓴 절대 경로를 보여 줍니다(사용자 관리자의 `HOME` — 이 PC의 WSL에서 본 것). `-nolisten local`은 쓰지 않습니다 |
| | 경고: `화면(서버): 화면의 X 서버가 추상 소켓 이름(…)을 쥐고 있지 않습니다 …` / `… 소켓 파일의 X 서버와 다릅니다 …` / `… 다른 사용자의 것입니다 …` / `… 확인하지 못해(python3 확인 실패) …` | L9의 '서버가 거부하는 화면' 표. `-nolisten local` 없이 이 사용자로 Xvfb를 다시 띄우거나 python3를 설치한 뒤 서버를 다시 시작합니다 |
| | 경고: `세션 버스(DBUS_SESSION_BUS_ADDRESS)가 없어 AT-SPI로 암호 칸을 가를 수 없습니다 — 글자 입력(type)은 막힙니다` | `dbus-user-session`을 깔고 서버를 유닛(L8)으로 띄웁니다. 점검은 이 변수를 사용자 관리자의 환경(유닛이 받는 것)에서 보고, 사용자 관리자에 닿지 못하면 점검을 돌린 셸에서 봅니다 |
| | 경고: `server.json screen.typeWithoutA11y가 켜져 있습니다 …` | 일부러 켰으면 그대로 둡니다. 아니면 server.json에서 지우고 서버를 다시 시작합니다(L9) |
| | 건너뜀: `서버가 돌지 않아 …` | 서버를 띄운 뒤 다시 합니다 |
| 관리 채널 (`adminSocket`) | 경고: `관리 채널이 소켓 파일이 아닙니다 (…)` | 서버를 다시 시작합니다 |
| | 건너뜀: `서버가 돌지 않아 관리 채널을 보지 못했습니다` | 서버를 띄운 뒤 다시 합니다 |
| Tailscale (`tailscale`) | 경고: `Tailscale이 없습니다` / `tailscale status를 읽지 못했습니다 …` / `Tailscale이 돌고 있지 않습니다 (…)` | L6 (`curl -fsSL https://tailscale.com/install.sh \| sh` 뒤 `sudo tailscale up --operator=<사용자>`) |
| | 경고: `tailscale status가 4초 안에 끝나지 않았습니다 — tailscaled가 멈췄을 수 있습니다` | `sudo systemctl restart tailscaled` |
| | 실패: `tailscale funnel이 켜져 있습니다 — 인터넷 전체에 열립니다` | `tailscale funnel --https=443 off` |
| | 경고: `tailnet의 HTTPS 인증서가 꺼져 있습니다` / `이 서버(포트 7317)로 넘기는 tailscale serve 항목이 없습니다` / `같은 이름에 다른 항목이 있습니다: …` | L6 (`tailscale serve --bg 7317`, 공개 주소 블록, `config reload`). 다른 서비스는 다른 Tailscale 기기 이름에 둡니다 |

### 서버가 시작하지 않을 때

서버는 아래를 **데이터 폴더를 만들거나 잠그기 전에** 보고, 걸리면 `욱채 서버를 시작하지 못했습니다: <글>`을 내고 끝 코드 1로 끝납니다. 유닛이면 `journalctl --user -u "$unit"`에 이 줄이 남습니다.

| 까닭 | 글 | 할 일 |
|---|---|---|
| root | `root(uid 0)로는 서버를 띄우지 않습니다 — 로그인한 사용자 계정으로 띄우세요 (메인 에이전트의 Claude Code는 root에서 권한 확인 건너뛰기를 거부하고, root의 서버는 이 PC 전체를 쥡니다)` (코드의 글 — 이 PC에는 root가 없습니다) | 보통 사용자로 띄웁니다(L0) |
| `/proc` | `/proc를 읽지 못합니다 — 욱채 서버는 Linux에서 /proc로 프로세스를 확인합니다 (/proc가 마운트된 환경에서 실행하세요)`, 또는 `/proc/self/stat`·`/proc/sys/kernel/random/boot_id`·`/proc/stat`의 `btime`을 읽지 못한다는 글 (코드의 글) | `/proc`이 마운트된 보통의 Linux PC·VM에서 띄웁니다. `hidepid`로 막힌 `/proc`이나 컨테이너는 지원하지 않습니다 |
| 데이터 폴더 경로의 길이 | `데이터 폴더의 경로가 길어 관리 소켓(<폴더>/admin.sock)을 만들 수 없습니다 — 116바이트로 Linux의 한도 107바이트를 넘습니다. 96바이트 이하(UTF-8 — 한글 한 글자는 3바이트)의 데이터 폴더를 --data-dir로 주세요` (이 PC에서 본 것 — 그 폴더는 만들지 않았습니다) | 짧은 데이터 폴더를 씁니다(L4) |
| 데이터 폴더가 폴더에 닿지 않는 링크 | `데이터 폴더를 준비하지 못했습니다 (<폴더>) — 데이터 폴더가 링크인데 가리키는 곳이 없습니다 (링크 → <적힌 곳>) — 서버는 그 자리에 폴더를 만들 수 없습니다. 가리키는 곳의 디스크를 붙이거나(mount) 그 폴더를 만들거나, 링크를 고치세요` (고리면 `… 링크가 고리를 이뤄 폴더에 닿지 않습니다 (링크 → <적힌 곳>) — 서버는 그 자리에 폴더를 만들 수 없습니다. 링크를 고치거나 지우세요`, 위 폴더가 그런 링크면 `… 데이터 폴더 경로의 위 폴더(<위 폴더>)가 링크인데 가리키는 곳이 없습니다 …`) (이 PC의 WSL에서 본 것 — 아무것도 만들지 않았습니다) | 위 `dataDir`의 그 줄과 같습니다 |
| 비밀 값 폴더의 권한·주인 | `비밀 값 폴더(<폴더>/secrets)의 권한이 넓습니다 (755) — 그룹·다른 사용자가 열 수 있습니다. 고치기: chmod 700 '<폴더>/secrets'` (이 PC에서 본 것) | 그 `chmod` 줄을 칩니다. 위 `secrets` 항목도 봅니다 |
| server.json | `server.json의 … 모양이 아닙니다` 등 그 칸을 말하는 글 (예: `server.json의 screen.xauthority는 그 화면의 쿠키 파일의 절대 경로여야 합니다 (예: "/home/wook/.wook-xvfb.auth")`) | 그 칸을 고칩니다(L4·L9) |

더 볼 곳: 서버 기록 `<데이터 폴더>/logs/server.log`(시작·운영자 명령·배포 점검 요약)와 `backend.log`(업무), 유닛이면 `journalctl --user -u "$unit"`, [KNOWN_ISSUES.md](KNOWN_ISSUES.md)의 10단계 항목.
