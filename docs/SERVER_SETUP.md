# 욱채 서버 설치 순서 (Windows)

서버 PC에 욱채 서버를 처음부터 설치하는 순서입니다. 서버 PC에서 셸을 쓰는 에이전트(그록봇 등)가 위에서부터 그대로 따라 하도록 명령 순서로 썼습니다. **[사람]** 표시가 있는 단계는 사람이 해야 합니다(브라우저 로그인, 암호, 휴대폰, 다시 시작). 에이전트는 그 단계에서 멈추고 사람에게 부탁합니다.

왜 그렇게 하는지는 [SERVER_INSTALL.md](SERVER_INSTALL.md)에 있습니다. 서버를 두기 전에 이 PC에서 먼저 써 보려면 [TRY_IT.md](TRY_IT.md)를 봅니다.

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
  wook-server uninstall-task          그 작업을 지웁니다 (실행 중인 서버는 끄지 않습니다)
  wook-server check                   서버 PC를 점검합니다 — 세션·자동 로그온·잠금·절전·작업·데이터 폴더·CLI·SMB·Tailscale
```

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
