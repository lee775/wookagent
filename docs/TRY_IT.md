# 욱채 직접 써 보기 (이 PC에서)

대표가 이 PC에서 욱채를 직접 써 보는 방법입니다. 명령은 모두 **저장소 폴더(`C:\WOOK\wookagent`)에서 PowerShell로** 실행합니다. 빌드가 소스보다 오래됐으면 도구가 먼저 다시 만들고(1~2분), 무엇을 하는지 먼저 말한 뒤에 합니다. 서버 PC에 실제로 설치하는 순서는 [SERVER_SETUP.md](SERVER_SETUP.md), 그 설명은 [SERVER_INSTALL.md](SERVER_INSTALL.md)에 있습니다.

이 체험 도구(`scripts\try-server.cmd`·`scripts\try-desktop.cmd`)는 Windows 전용입니다. Linux에는 체험 도구가 없습니다 — Linux 서버는 [SERVER_SETUP.md의 Linux 편](SERVER_SETUP.md#linux-편-ubuntu-2404)대로 설치합니다.

| 명령 | 보는 것 | 비용 | 데이터 |
|---|---|---|---|
| `scripts\try-server.cmd mock` | 모의 서버의 웹 화면 (모의 메인 에이전트, 모의 프로젝트 3개) | 없음 | 임시 폴더 — 끝나면 지웁니다 |
| `scripts\try-server.cmd` (`local`) | 실제 서버의 웹 화면 — 메인 에이전트는 이 PC의 실제 Claude | 명령마다 구독 사용량 | `%LOCALAPPDATA%\wookagent-try\server` — 남습니다 |
| `scripts\try-desktop.cmd` | 데스크톱 앱 | 명령마다 구독 사용량 | `%LOCALAPPDATA%\wookagent-try\desktop` — 남습니다 |
| `scripts\try-server.cmd phone --owner-email <메일>` | 휴대폰에서 Tailscale로 여는 실제 서버 | 명령마다 구독 사용량 | `%LOCALAPPDATA%\wookagent-try\phone` — 남습니다 |

준비물: Node.js 24 이상, 저장소 폴더에서 한 번 해 둔 `npm ci`, Microsoft Edge(창은 Edge로 엽니다). `local`·`try-desktop`·`phone`은 이 PC에 로그인된 Claude CLI도 있어야 합니다 — `claude auth status`가 `"loggedIn": true`를 내면 됩니다(아니면 `claude auth login`). 로그인돼 있지 않아도 화면은 열리지만, 명령을 보내면 메인 에이전트가 'claude 인증 만료 — 재로그인 필요'로 멈춥니다. `mock`에는 필요 없습니다.

## 1. 비용 없이 보기 — `mock`

```powershell
scripts\try-server.cmd mock
```

- 이 PC 안에 모의 서버를 띄우고 Edge 창을 엽니다. 가짜 구글 로그인을 도구가 대신 마치므로 바로 홈(프로젝트 현황)이 보입니다.
- 메인 에이전트와 팀원은 모의 실행입니다. 명령을 보내면 모의 메인 에이전트가 답하고 모의 팀이 일하는 흉내를 냅니다. Claude·Codex를 부르지 않습니다.
- 데이터는 그 실행의 임시 폴더(Windows 임시 폴더 아래 `wook-try-mock-…`)에만 두고, 끝나면 지웁니다 — Ctrl+C로 끝내도 지웁니다. 비밀 값 저장소(Windows 자격 증명 관리자)도 건드리지 않습니다.
- 끝내기: Edge 창을 닫습니다(끝 코드 0). 그 PowerShell 창에서 Ctrl+C도 됩니다 — '모의 무대를 닫았습니다. 모두 껐습니다.'가 나오고 끝 코드는 130입니다(오류가 아닙니다).
- 처음 몇십 초는 준비 시간입니다(vitest가 무대를 띄웁니다).

## 2. 실제 서버로 — `local`

```powershell
scripts\try-server.cmd
```

- 실제 욱채 서버를 이 PC 안(루프백)에서 띄우고, 이 PC 안에서만 열리는 https 중계(`https://wook-try.test:<포트>` — 실제 서버에서 `tailscale serve`가 하는 일)를 앞에 둡니다. 그다음 로그인한 Edge 창을 엽니다.
  - 로그인은 서버의 **운영자 시험 세션**으로 합니다. 대표의 구글 계정이 아니라 체험용 대표(`operator-test@wook.local`)이고, 세션 값은 화면에 나오지 않고 Edge 창의 쿠키로만 들어갑니다. 실행할 때마다 '운영자 시험 세션' 기기가 하나씩 생깁니다(쓰지 않으면 14일 뒤 끝납니다).
  - `http://127.0.0.1:…`로 바로 열지 않는 까닭: 로그인 쿠키는 https 공개 주소에서만 받습니다(같은 PC의 다른 프로그램에 쿠키가 가지 않게).
- **비용**: 메인 에이전트는 이 PC에 로그인된 실제 Claude CLI입니다. 명령을 보낼 때마다 Claude 구독 사용량이 들고, 팀원이 Codex를 쓰면 Codex 사용량도 듭니다. 명령을 보내기 전에는 들지 않습니다.
- **주의**: 메인 에이전트와 팀원은 이 PC에서 권한 확인 없이 명령을 실행하고 파일을 고칩니다. 메인 에이전트의 `host_exec`(서버 명령)도 이 PC에서 돕니다 — 기본 실행 위치는 `%LOCALAPPDATA%\wookagent-try\workspace\main`입니다. 프로젝트를 만들라고 하면 그 폴더도 이 PC에 생깁니다.
- 화면 조작(메인 에이전트가 이 PC의 마우스·키보드를 쓰는 것)은 꺼 둡니다.
- 데이터는 `%LOCALAPPDATA%\wookagent-try\server`에 남아, 다음에 실행하면 이어서 씁니다. 도구는 이 폴더와 작업 폴더(`…\wookagent-try\workspace`), 그리고 그 둘을 담는 `%LOCALAPPDATA%\wookagent-try`를 처음 만들 때 서버가 새 데이터 폴더를 만들 때처럼 이 Windows 사용자만 쓰게 만들고(다른 계정의 권한을 물려받지 않습니다), 안에 표시 파일 `.wook-try-folder`를 둡니다. 이미 있던 폴더는 권한을 바꾸지 않습니다.
- 처음부터 다시 하려면 `scripts\try-server.cmd local --fresh` — 체험 데이터 폴더와 작업 폴더를 지웁니다. 표시 파일이 없는 폴더(도구가 만들지 않은 폴더)는 지우지 않고, 그 폴더를 말한 뒤 아무것도 지우지 않고 끝납니다(끝 코드 1).
  - 도구는 두 폴더를 먼저 옆 이름(`.server.del-…`·`.workspace.del-…`)으로 옮긴 뒤에야 지웁니다. 그 폴더를 무엇이 쓰고 있으면 — 그 안을 현재 폴더로 둔 PowerShell·명령 프롬프트·탐색기 창, 메인 에이전트가 띄워 아직 도는 프로그램 — 옮기기가 바로 실패하고, 도구는 그 폴더와 닫을 것을 말한 뒤 아무것도 지우지 않고 끝납니다(끝 코드 1, 몇 초 안에). 그 창이나 프로그램을 닫고 다시 실행하세요.
  - 옮긴 폴더를 다 지우지 못하면 그 옆 이름 폴더를 말하고 새 폴더로 계속합니다. 그 폴더는 더 쓰지 않으니 손으로 지워도 됩니다(다음 `--fresh`도 남아 있다고 알려 줍니다).
  - 아주 드물게 옮긴 폴더를 제 이름으로 되돌리지도 못하면, 도구는 그 폴더가 어느 옆 이름에 있는지와 되돌리는 `Rename-Item` 명령을 말하고 그 안에 메모(`.wook-try-restore`)를 남깁니다. 지운 것은 없으니 그 폴더는 지우지 말고 그 명령으로 이름을 되돌리세요 — 그때까지 다음 실행은 새 빈 폴더로 시작하지 않고 같은 명령을 다시 알려 줍니다.
- 끝내기: Edge 창을 닫거나 그 PowerShell 창에서 Ctrl+C — 도구가 관리 채널로 서버를 정상 종료하고 중계를 닫은 뒤 끝납니다(몇 초 걸립니다). 다른 창에서는 `scripts\try-server.cmd stop`.
  - 빌드 중이나 서버가 아직 뜨는 중에 Ctrl+C를 누르면 도구가 하던 일을 멈춥니다. 뜨는 중이던 서버는 아직 관리 채널이 열리기 전이라 도구가 띄운 그 서버 프로세스를 바로 끝내고, 그렇다고 말한 뒤 끝납니다. 그 서버의 실행 잠금 파일(`server.lock`)이 남지만, 다음 실행이 끝난 서버의 것으로 알아보고 그대로 시작합니다.
  - Ctrl+C로 끝내면 도구의 끝 코드는 130입니다(Edge 창을 닫아 끝내면 0). Edge 창이 아직 열리는 중이거나 `--smoke` 점검 중에 눌러도 같습니다 — 마지막 줄은 '모두 껐습니다. …'이고 오류 글이 없습니다.
- 체험 서버가 이미 돌고 있을 때 다시 실행하면 새 서버를 띄우지 않고 그 서버에 Edge 창만 하나 더 엽니다(이 창을 닫아도 서버는 그대로입니다). 서버를 띄운 창을 닫거나 그 도구를 끝내면 그 서버도 함께 끝납니다.

## 3. 데스크톱 앱 — `try-desktop`

```powershell
scripts\try-desktop.cmd
```

- 데스크톱 앱(Electron)을 체험 데이터 폴더 `%LOCALAPPDATA%\wookagent-try\desktop`으로 엽니다. 실제 데이터와 따로입니다. 그 폴더가 없으면 도구가 먼저 이 Windows 사용자만 쓰게 만듭니다.
- 패키징하지 않은 실행이라 로그인 화면의 '개발 모드로 시작하기'로 구글 없이 들어갑니다.
- 메인 에이전트는 이 PC의 실제 Claude CLI입니다 — 명령마다 구독 사용량이 듭니다.
- **비밀 값은 실제 앱과 같은 자리입니다**: 앱의 설정에서 넣는 구글 로그인 보안 비밀과 API 키는 Windows 자격 증명 관리자의 욱채 항목(`wookagent`)에 들어갑니다. 데이터 폴더와 상관없는 자리라, 여기서 넣거나 지우면 실제 앱이 쓰는 값도 바뀝니다.
- 끝내기: 앱 창을 닫습니다.
- 할 일만 보려면 `scripts\try-desktop.cmd --dry-run`(아무것도 띄우지 않습니다).

실제 데이터(`%APPDATA%\wookagent`)로 열려면 `scripts\try-desktop.cmd real-data` — 도구가 먼저 묻고, `y`를 쳐야 엽니다. 이 빌드가 그 DB에 지금 판의 표를 더하고 판 번호를 올립니다(마이그레이션 — 되돌리지 않습니다). 그 폴더를 먼저 복사해 두세요. 실제 앱이 켜져 있으면 열리지 않습니다.

## 4. 휴대폰으로 — `phone`

휴대폰 브라우저에서 Tailscale을 거쳐 실제 구글 로그인까지 해 봅니다. 도구는 Tailscale 설정을 **바꾸지 않습니다** — 읽기만 하고(`tailscale status --json`, `tailscale serve status --json`), 켜고 끄는 명령은 보여 주기만 합니다.

준비(한 번):

1. 이 PC와 휴대폰에 Tailscale을 깔고 같은 계정으로 로그인합니다.
2. Tailscale 관리 콘솔의 DNS 설정에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다. 꺼져 있으면 도구가 그렇다고 말하고 멈춥니다.
3. 구글 클라우드 콘솔에서 **'TV 및 입력 제한 기기'** 종류의 OAuth 클라이언트를 만듭니다 — [SERVER_INSTALL.md](SERVER_INSTALL.md) 2절. 게시 상태가 '테스트'면 테스트 사용자에 대표의 구글 계정을 넣습니다.

실행:

```powershell
scripts\try-server.cmd phone --owner-email <대표의 구글 메일> --google-client-id <클라이언트 ID>
```

- `%LOCALAPPDATA%\wookagent-try\phone\server.json`에 대표 이메일, 공개 주소(`https://<이 PC의 Tailscale 이름>`), 받는 Tailscale 사용자(이 PC의 로그인 계정), 화면 조작 끔을 적고, 서버를 이 PC 안의 포트 7330에서 띄웁니다. 클라이언트 ID는 한 번 넣으면 그 파일에 남아 다음에는 빼도 됩니다. `phone` 폴더와 그 작업 폴더도 `local`처럼 이 Windows 사용자만 쓰게 만듭니다.
- 구글 보안 비밀이 아직 없으면 넣는 명령을 보여 줍니다(다른 PowerShell 창에서, 값은 명령 줄에 쓰지 않고 표준 입력으로):
  ```powershell
  Get-Content .\google-secret.txt | scripts\wook-server.cmd secret set google-client-secret --data-dir "$env:LOCALAPPDATA\wookagent-try\phone"
  ```
  이 비밀은 Windows 자격 증명 관리자의 욱채 항목(`wookagent`)에 들어갑니다. 데이터 폴더와 상관없는 자리라, 이 PC에 실제 욱채 서버를 둔다면 그 서버의 구글 보안 비밀도 이 값으로 바뀝니다(데스크톱 앱의 구글 로그인 비밀은 따로라 바뀌지 않습니다).
- 다른 창에서 직접 `tailscale serve --bg 7330`을 실행한 뒤, 휴대폰 브라우저에서 도구가 보여 준 주소를 열고 구글 계정으로 로그인합니다.
- 이 PC의 Tailscale 이름에 이미 다른 `tailscale serve` 항목(예: TCP 7878)이 있으면 도구가 알려 줍니다. 체험에는 그대로 써도 되지만, 실제로 쓸 때는 그 이름에 욱채만 두세요 — 같은 이름의 다른 서비스에도 욱채의 로그인 쿠키가 갑니다. 도구는 그 항목을 지우지 않습니다.

되돌리기:

1. 서버를 띄운 창에서 Ctrl+C(또는 `scripts\try-server.cmd stop`). Ctrl+C로 끝내면 끝 코드는 130입니다.
2. `tailscale serve --https=443 off` — `tailscale serve reset`은 다른 항목(TCP 7878 등)까지 지우니 쓰지 마세요.
3. 구글 보안 비밀까지 지우려면 서버가 돌 때 `scripts\wook-server.cmd secret clear google-client-secret --data-dir "$env:LOCALAPPDATA\wookagent-try\phone"` — 위의 까닭으로 같은 PC의 실제 욱채 서버의 값도 지워집니다.

## 5. 끄기와 지우기

- 체험 서버 끄기: 띄운 창을 닫거나 Ctrl+C. 다른 창에서는
  ```powershell
  scripts\try-server.cmd stop
  ```
  `local`과 `phone` 체험 서버에 관리 채널의 정상 종료(`shutdown`)를 보냅니다. 각 체험 데이터 폴더의 관리 토큰으로 서로 증명한 그 서버만 끄고, 프로세스 번호로 끄지 않으므로 다른 프로그램은 건드리지 않습니다. `mock`은 그 창으로만 끝납니다.
- Ctrl+C 뒤에 `일괄 작업을 끝내시겠습니까 (Y/N)?`가 나오면 `Y`를 누르세요(`.cmd`로 띄워서 나오는 Windows의 질문입니다).
- 체험 데이터 모두 지우기: 체험 서버와 체험 앱을 모두 끈 뒤 `%LOCALAPPDATA%\wookagent-try` 폴더를 지웁니다. 실제 욱채 데이터(`%APPDATA%\wookagent`)는 그 밖이라 남습니다.
- 체험 폴더 자리를 바꾸려면 환경 변수 `WOOK_TRY_ROOT`에 절대 경로를 넣고 실행합니다(실제 데이터 폴더와 겹치면 — 글자 크기만 달라도 — 도구가 아무것도 하지 않습니다). 그 자리에 이미 `server`·`workspace` 폴더가 있으면 도구는 그 폴더를 그대로 쓰고(권한을 바꾸지 않습니다), `--fresh`는 표시 파일이 없어 지우지 않습니다. 빈 새 폴더를 정하는 것이 안전합니다.

## 6. 한계

- `mock`과 `local`의 주소(`https://wook-try.test:…`)는 이 PC 안의 Edge 창에서만 열립니다. 휴대폰은 `phone`으로 봅니다.
- `local`의 로그인은 체험용 대표의 시험 세션입니다 — 구글 로그인 화면은 `mock`(가짜 구글)과 `phone`(실제 구글)에서 봅니다.
- 체험 창은 임시 프로필의 Edge입니다(즐겨찾기·로그인 없음, 닫으면 지워짐). 시험용 인증서를 받으려고 켠 설정 때문에 창 위에 자동화·명령줄 플래그 안내 띠가 보일 수 있습니다 — 그 창에만 해당합니다.
- 체험 서버는 모두 화면 조작을 꺼 둡니다. 실제 화면 조작 시험(메모장에 글 치기 등)은 마우스·키보드를 잠깐 가져가므로 대표가 자리에 있을 때 따로 합니다.
- 이 PC가 잠자기에 들어가면 휴대폰에서 닿지 않습니다.
- 외부 에이전트(그록봇 등)를 체험 서버에 붙여 보려면 [SERVER_INSTALL.md](SERVER_INSTALL.md) 10절과 [AGENT_GUIDE.md](AGENT_GUIDE.md)를 그대로 따르고, 데이터 폴더 자리에 체험 데이터 폴더(`%LOCALAPPDATA%\wookagent-try\server`)를 넣습니다.
- 체험 서버도 실제 서버처럼 시작 뒤 한 번 서버 PC 점검을 하고 그 요약을 서버 기록(`<체험 데이터 폴더>\logs\server.log`)에 남깁니다. 읽기만 하는 점검입니다. 이 PC의 결과(자동 로그온 꺼짐 등)는 체험에는 상관없습니다.

## 7. 처음 써 볼 때 보아 주실 것

자동 시험으로 볼 수 없어 대표가 처음 쓸 때 보아 주실 것입니다. 이상하면 그 창의 글을 그대로 알려 주세요.

1. `local`: Edge 창을 닫으면 그 PowerShell 창이 '모두 껐습니다'를 내고 끝나는지. (그 창의 Ctrl+C는 자동 시험이 봅니다 — 콘솔에서 Ctrl+C를 받은 도구가 서버를 끄고, 실행 잠금·중계 파일·남은 프로세스가 없는지)
2. `mock`: Edge 창을 닫거나 Ctrl+C를 누르면 Edge와 그 창의 vitest가 함께 끝나는지. Ctrl+C면 마지막 줄이 'Ctrl+C — 모의 무대를 닫았습니다. 모두 껐습니다.'이고 '모의 무대가 끝 코드 …(으)로 끝났습니다' 같은 오류 글이 없습니다.
3. `phone`: 휴대폰에서 구글 로그인까지 되는지, 그 창의 Ctrl+C로 서버가 끝나는지(곧바로 '휴대폰 체험 서버를 끕니다'가 나옵니다), 다 쓴 뒤 `tailscale serve --https=443 off`로 되돌려지는지.
