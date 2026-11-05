# 욱채 서버 설치 안내 (초안, 5단계)

서버 PC에 욱채 서버를 띄우고, 대표가 휴대폰이나 다른 PC에서 Tailscale로 들어오게 하는 순서입니다. 서버를 설치하고 운영하는 사람(운영자)이 읽습니다. 설계는 [SERVER_DESIGN.md](SERVER_DESIGN.md) 3.4–3.7(메인 에이전트 자리는 4장)에, 코드 안내는 [ARCHITECTURE.md](ARCHITECTURE.md) 20장에 있습니다.

> 초안입니다. 웹 화면은 8단계에서 붙고, Windows 서비스 등록과 실제 휴대폰 시험은 9단계에서 합니다. 지금은 서버와 API, 로그인까지 준비할 수 있습니다.

## 0. 준비물

- 서버 PC: Windows 10·11. 서버를 돌릴 **그 사용자 계정**으로 Claude CLI·Codex CLI에 로그인해 둡니다(LocalSystem 서비스 계정으로 돌리지 않습니다).
- Node.js 24 이상과 이 저장소. 저장소 폴더에서 `npm ci` 뒤 `npm run build:server`를 하면 `out/server/index.mjs`가 생깁니다.
- 대표의 구글 계정 하나 — 이 계정만 대표로 받습니다.
- Tailscale 계정 하나. 서버 PC와 대표의 휴대폰(또는 다른 PC)을 같은 tailnet에 넣습니다.

아래 명령의 `wook-server`는 `node out/server/index.mjs`를 줄여 쓴 것입니다. 운영자 명령에는 서버를 띄운 데이터 폴더를 `--data-dir`로 알려 주세요(서버와 같은 `WOOK_DATA_DIR`를 쓰면 생략해도 됩니다).

## 1. 데이터 폴더와 대표 이메일

1. 데이터 폴더를 정합니다. 정하지 않으면 데스크톱 앱과 같은 `%APPDATA%\wookagent`를 씁니다. 한 데이터 폴더는 데스크톱 앱이든 서버든 하나만 쓸 수 있습니다.
2. 대표 이메일을 미리 정해 두면 처음 들어온 사람이 대표가 되는 일이 없습니다. 둘 중 하나로 정합니다.
   - 데이터 폴더의 `server.json`에 적기 (권장):
     ```json
     { "owner": { "email": "owner@example.com" } }
     ```
   - 서버를 띄울 때 `--owner-email owner@example.com` (이 인자가 파일보다 먼저입니다. 그때 `server.json`의 `owner.email`은 쓰지 않고, 시작 기록과 `config reload`가 그렇다고 알려 줍니다)
   - 이메일 모양이 틀리면 서버는 아무것도 만들지 않고 바로 끝납니다. `--owner-email`이 틀리면 '--owner-email: 대표 이메일 모양이 아닙니다'와 사용법을 보여 주고(끝 코드 2), `server.json`의 값(대표 이메일·구글 클라이언트 ID·CLI 위치)이 틀리면 'server.json의 대표 이메일(owner.email) 모양이 아닙니다'처럼 그 칸을 말합니다(끝 코드 1). 어느 쪽이든 실행 잠금(`server.lock`)과 저장소(`wook.db`)를 만들기 전입니다
3. 둘 다 없으면 서버가 시작할 때 **설정 코드**(8자, 1시간, 한 번만)를 콘솔과 `<데이터 폴더>\setup-code.txt`에 냅니다(`ABCD-EFGH`처럼 보입니다). 대표가 로그인 화면의 서버 설정에 그 코드와 이메일을 넣으면 대표 이메일이 정해지고 파일은 지워집니다. 운영자가 `wook-server config owner-email <이메일>`로 정해도 됩니다.
   - 코드는 줄표를 빼거나 소문자로 넣어도 됩니다. 받는 꼴(줄표가 있든 없든, 대소문자, 줄표 대신 띄어쓰기)은 명령 글, 운영자 명령에 넣은 값, CLI 출력에 섞여 들어가도 서버 기록·활동 기록·대화에 가려진 채로 남습니다. 그래도 코드는 대표에게만 알려 주세요.
   - 코드는 보이는 그대로의 영문자·숫자로 넣습니다. 전각 글자나 'ſ'·'ß' 같은 다른 글자로 바꿔 쓴 코드는 받지 않고 틀린 것으로 셉니다.

대표 이메일을 나중에 바꾸면 등록된 대표 계정을 지우고 모든 기기 세션을 끊습니다. 바꾸는 일은 운영자만 합니다(`config owner-email`).

같은 데이터 폴더를 데스크톱 앱과 번갈아 쓰다가 데스크톱 앱이 다른 구글 계정을 대표로 등록하면, 서버는 대표 이메일의 계정을 '처음 등록한 계정이 아니라'며 거부합니다. 그때는 운영자가 같은 대표 이메일로 `wook-server config owner-email <대표 이메일>`을 다시 실행하세요. 다른 이메일의 등록을 지우고(기기 세션도 끊깁니다) 다음 로그인한 대표 계정이 등록됩니다. 그때 끊긴 기기 세션은 데스크톱 앱이 그 계정으로 다시 로그인해도 되살아나지 않습니다.

## 2. 구글 로그인 클라이언트 ('TV 및 입력 제한 기기')

서버는 휴대폰에 코드를 넣는 구글 기기 코드 로그인을 씁니다. 이 흐름은 **'TV 및 입력 제한 기기'(TVs and Limited Input devices)** 종류의 클라이언트만 쓸 수 있습니다. 데스크톱 앱의 '데스크톱 앱' 클라이언트와는 따로 만듭니다.

1. [구글 클라우드 콘솔](https://console.cloud.google.com/)에서 프로젝트를 고릅니다(없으면 만듭니다).
2. **OAuth 동의 화면**을 만듭니다. 사용자 유형은 '외부'로 두고, 범위는 기본(openid·email·profile)만 씁니다.
   - 게시 상태를 '테스트'로 두면 **테스트 사용자에 대표의 구글 계정을 꼭 넣으세요.** 넣지 않으면 대표가 코드를 넣어도 구글이 로그인을 막습니다.
3. **사용자 인증 정보 → 사용자 인증 정보 만들기 → OAuth 클라이언트 ID**에서 애플리케이션 유형을 **'TV 및 입력 제한 기기'**로 고릅니다.
4. 나온 클라이언트 ID와 보안 비밀을 서버에 넣습니다.
   ```powershell
   wook-server config google-client-id 1234567890-abc.apps.googleusercontent.com --data-dir D:\wook-data
   Get-Content .\google-secret.txt | wook-server secret set google-client-secret --data-dir D:\wook-data
   Remove-Item .\google-secret.txt
   ```
   - 클라이언트 ID는 `server.json`의 `google.clientId`에 쓰입니다.
   - 보안 비밀은 표준 입력으로만 받아 Windows 자격 증명 관리자에 넣습니다. 명령 줄에 직접 쓰지 마세요(받지 않습니다). 파일 없이 `secret set`만 실행하면 화면에 보이지 않게 붙여 넣을 수 있습니다.
   - 실수로 `wook-server config google-client-secret GOCSPX-…`처럼 명령 줄에 값을 붙여도 서버는 그 값을 쓰지 않고, 오류 글도 그 값을 되풀이하지 않습니다 — 'secret'이 든 명령은 비밀 값 명령의 바른 꼴을 알려 주고, 알 수 없는 명령은 앞의 명령 이름만 보입니다('알 수 없는 명령입니다: config … (뒤의 낱말은 값일 수 있어 보이지 않습니다)'). 그래도 셸 기록(PowerShell의 `(Get-PSReadLineOption).HistorySavePath`)에는 쳤던 줄이 남으니, 그 줄을 지우고 구글 클라우드 콘솔에서 보안 비밀을 새로 만드는 것이 안전합니다.
   - 클라이언트 종류가 틀리면 로그인 화면이 '구글이 클라이언트를 받지 않습니다 — TV 및 입력 제한 기기 종류인지 보세요'처럼 알려 줍니다.

## 3. 서버 띄우기

```powershell
wook-server --data-dir D:\wook-data
# 욱채 서버 준비 완료: 주소 http://127.0.0.1:7317 (127.0.0.1과 ::1에서 받음) · 실행 ID … · 데이터 폴더 D:\wook-data
```

- 서버는 이 PC 안(루프백 — 같은 포트의 127.0.0.1과 ::1)에서만 열립니다. `--bind`에 다른 주소를 주면 시작하지 않습니다. 다른 기기는 다음 절의 `tailscale serve`로 들어옵니다.
- 포트는 기본 7317이고 `--port`로 바꿉니다.
- 상태는 `wook-server status --data-dir D:\wook-data`, 운영자 설정은 `wook-server config show --data-dir D:\wook-data`로 봅니다.
- **메인 에이전트 작업 폴더** (5단계): 메인 에이전트는 데이터 폴더 밖의 작업 폴더 위치 아래 `main` 폴더에서 일합니다(서버 PC의 명령·설치를 돌리는 `host_exec`의 기본 실행 위치도 그곳). 위치는 `--workspace-root <폴더>` → `server.json`의 `workspaceRoot` → 기본 `~/wook-workspace`(서버를 띄운 사용자의 홈) 차례로 정합니다.
  ```json
  { "workspaceRoot": "D:\\wook-workspace" }
  ```
  - 절대 경로여야 하고, 그 아래 `main`이 데이터 폴더나 등록된 프로젝트 폴더와 같거나 그 안이거나 그 폴더를 품으면 서버가 시작하지 않습니다(끝 코드 1 — 데이터 폴더와 겹치는지는 실행 잠금 전에 봅니다).
  - 서버를 시작할 때만 정합니다. `server.json`의 값을 바꾸고 `config reload`를 하면 바꾸지 않고 '다시 시작해야 바뀝니다'라고 알려 줍니다. `config show`의 '메인 작업 폴더' 줄이 지금 쓰는 폴더와 정한 곳을 말합니다.
  - 처음 쓸 때 그 사용자만 쓰게 만들고 git 저장소로 시작합니다. 이미 있는 폴더를 지정하면 권한은 그대로 둡니다 — 미리 만들어 둔 폴더라면 다른 계정이 읽지 못하게 직접 좁혀 두세요. 예전 폴더(`<데이터 폴더>\main-agent`)는 지우지 않고 남겨 두며, 옮겼다는 기록이 활동 기록에 한 줄 남습니다.
  - 메인 에이전트의 `host_exec`는 토큰·API 키 이름의 환경 변수를 받지 않습니다. 토큰이 필요한 설치(비공개 저장소의 패키지 등)는 운영자가 직접 합니다.
  - `host_exec`는 운영자 명령(`wook-server`, `node out\server\index.mjs …`, `npm run start:server` — `status`까지 모두)과 데이터 폴더·`admin.token`·`admin.endpoint`·`setup-code.txt`를 가리키는 명령을 돌리지 않습니다. 명령 글자만 보는 실수 방지 장치라, 출력에 관리 토큰·설정 코드·`secret set`으로 넣은 값이 찍혀도 서버가 기록과 도구 결과에서 가립니다. 서버를 띄운 셸에서 `ANTHROPIC_API_KEY`·`OPENAI_API_KEY` 같은 AI 키를 내보냈다면 그 값도 가리지만, CLI 턴에는 아직 그대로 넘어갑니다(구독 방식이면 내보내지 않는 편이 낫습니다).

## 4. Tailscale로 열기

1. 서버 PC와 대표의 휴대폰에 Tailscale 앱을 깔고 같은 tailnet에 로그인합니다.
2. Tailscale 관리 콘솔의 DNS 설정에서 **MagicDNS**와 **HTTPS 인증서**를 켭니다. 그래야 `https://<서버 PC 이름>.<tailnet>.ts.net` 주소와 인증서가 생깁니다.
3. 서버 PC에서 서버 앞에 `tailscale serve`를 둡니다.
   ```powershell
   tailscale serve --bg http://127.0.0.1:7317
   tailscale serve status        # 생긴 https 주소를 확인
   ```
   Tailscale 버전에 따라 인자 모양이 다를 수 있습니다. `tailscale serve --help`에서 'https로 받아 로컬 http로 넘기는' 모양을 찾으세요.
   - **`tailscale funnel`은 쓰지 않습니다.** funnel은 인터넷 전체에 엽니다.
   - 인터넷 공유기에 포트를 열지 않습니다.
4. 생긴 주소를 서버의 **공개 주소**로 알려 줍니다. 서버는 이 주소의 Host와 Origin만 더 받습니다(그 밖의 이름은 403 — DNS 재바인딩 막기).
   - `server.json`에 적기:
     ```json
     { "network": { "publicOrigin": "https://grok-pc.tailnet-name.ts.net" } }
     ```
     적은 뒤 `wook-server config reload --data-dir D:\wook-data`로 바로 적용됩니다(서버를 다시 시작하지 않아도 됩니다). 답에 '공개 주소 → https://…'가 나옵니다.
   - 또는 서버를 띄울 때 `--public-origin https://grok-pc.tailnet-name.ts.net` (파일보다 먼저입니다. 그때 파일의 `network.publicOrigin`은 쓰지 않고, 시작 기록과 `config reload`가 그렇다고 경고합니다)
   - `https://<이름>` 모양만 받습니다. `http://`, 경로(`/app`), 쿼리가 붙거나 이 PC 안의 이름(`localhost`, `127.0.0.1`, `[::1]`)이면 시작하지 않습니다.
   - **서버 PC에서도 이 공개 주소로 엽니다.** 브라우저 로그인은 공개 주소에서만 받습니다. `http://127.0.0.1:7317`로 열면 로그인 화면이 '이 PC 안의 주소로는 브라우저 로그인을 받지 않습니다 … 공개 주소(…)로 여세요.'라고 알려 줍니다. 쿠키는 포트로 나뉘지 않아, 이 PC 안의 주소로 받은 로그인 쿠키는 같은 PC에서 다른 포트로 듣는 프로그램(다른 Windows 계정의 프로그램 포함)에도 가기 때문입니다. 서버 PC의 Tailscale은 제 공개 주소에 그대로 닿습니다.
   - **같은 tailscale serve 이름에는 욱채만 올립니다.** 같은 이름의 다른 포트(`https://grok-pc…:8443`)나 다른 경로 앞부분(`/other`)에 다른 서비스를 올리지 마세요. 그 이름의 로그인 쿠키가 그 서비스에도 갑니다. 다른 서비스가 필요하면 다른 기기 이름(다른 Tailscale 노드)에 두세요.
   - **한 tailnet의 기계는 브라우저에게 모두 같은 사이트입니다.** `ts.net`은 공공 접미사라, `grok-pc.<tailnet>.ts.net`과 `other.<tailnet>.ts.net`은 브라우저의 SameSite 규칙으로 나뉘지 않습니다. 다른 기계의 페이지가 욱채에 상태를 바꾸는 요청을 대신 보내는 것은 욱채 화면의 머리(`X-Wook-Client: 1`)와 정확한 Origin 검사가 막습니다. 다른 기계의 페이지가 욱채의 로그인 쿠키를 던져 넣는 것은 쿠키 이름(`__Host-wos_session`·`__Host-wos_login` — 브라우저가 다른 기계에서 온 그 이름을 받지 않습니다)과 서버 쪽 검사가 막습니다.
   - 막지 못하는 것이 하나 있습니다: 믿지 못하는 다른 기계의 페이지는 다른 이름의 쿠키를 잔뜩 심어 이 주소의 쿠키 단지를 채울 수 있습니다. 그러면 요청 머리가 너무 커져 욱채가 읽지 못하고 '요청 머리글이 너무 커서 읽지 못했습니다. 이 주소에 쿠키가 너무 많이 쌓였을 수 있습니다. 브라우저에서 이 사이트의 쿠키를 지운 뒤 다시 여세요.'라고 답합니다(431). 브라우저 설정에서 `<tailnet>.ts.net`의 쿠키를 지우고 다시 로그인하면 됩니다. **tailnet에는 믿는 기기와 서비스만 두세요** — 다른 사람의 기기를 tailnet에 넣거나 tailnet의 다른 기기에서 모르는 웹 서비스를 열어 두지 마세요.
   - 공개 주소를 지우고 `config reload`하면 그 주소로 열려 있던 화면의 실시간 연결(SSE)도 바로 끊깁니다.
5. (권장) **받는 Tailscale 사용자**를 정하면 그 사용자의 요청만 받습니다. `tailscale serve`가 요청에 붙이는 `Tailscale-User-Login` 머리를 봅니다.
   ```json
   { "owner": { "email": "owner@example.com", "tailscaleLogins": ["owner@example.com"] } }
   ```
   - 목록에 없는 사용자나 머리가 없는 요청은 로그인 화면도 열지 못합니다(403).
   - 이것은 인증이 아니라 추가 방어입니다. 같은 PC의 프로그램은 이 머리를 꾸며 루프백으로 바로 붙을 수 있습니다.
   - 목록을 켜면 이 PC 안에서 `curl` 같은 도구로 바로 붙을 때도 그 머리를 실어야 합니다. 운영자 명령(`wook-server …`)은 HTTP가 아니라 상관없습니다.
   - 목록을 비우면(`[]`) 검사하지 않습니다.
   - `config reload`는 켬·끔과 사람 수가 바뀐 것을 알려 줍니다(주소는 기록에 남기지 않습니다). 목록을 켜거나 바꾸면 목록 밖 사용자에게 열려 있던 실시간 연결(SSE)도 바로 끊깁니다.
   - **켜 두기를 권합니다.** 진행 중인 기기 코드 로그인은 모두 합쳐 6개, 한 Tailscale 사용자(머리가 없는 접속은 모두 하나로 칩니다)마다 2개까지입니다. 목록을 비워 두면 같은 tailnet의 다른 사용자도 로그인 화면을 열어 자리를 2개씩 쥘 수 있고, 여러 계정을 가진 쪽은 자리를 모두 채워 대표의 로그인 시작을 10분 동안 막을 수 있습니다. 목록을 켜면 다른 사용자는 자리를 하나도 쥐지 못합니다. 같은 PC의 프로그램은 머리를 꾸며 이것도 피할 수 있으니, 서버 PC에는 믿지 못하는 계정·프로그램을 두지 마세요.
6. **Tailscale 쪽의 SMB(TCP 445)를 막습니다.** 운영자 명령이 쓰는 관리 채널(Windows 이름 있는 파이프)은 SMB로 다른 기기에서도 열립니다. 관리 토큰 없이 명령을 실행하거나 토큰·비밀 값을 얻을 수는 없지만(서로 증명), 파이프를 열어 두드리는 것까지 막으려면 tailnet에서 들어오는 445를 막습니다. 원격 파이프를 아예 거부하는 설치 도우미는 9단계(Windows 배포)에서 붙습니다. 관리자 PowerShell에서:
   ```powershell
   New-NetFirewallRule -DisplayName "욱채 - Tailscale SMB 막기" -Direction Inbound -Protocol TCP -LocalPort 445 -InterfaceAlias "Tailscale" -Action Block
   Get-NetFirewallRule -DisplayName "욱채 - Tailscale SMB 막기" | Get-NetFirewallPortFilter   # 445가 보이면 됩니다
   ```
   - `Tailscale`은 Tailscale이 만든 네트워크 어댑터의 이름입니다. 다르면 `Get-NetAdapter`로 이름을 확인해 `-InterfaceAlias`에 넣으세요.
   - 막는 규칙은 허용 규칙보다 먼저입니다. 이 PC 안과 집·회사 네트워크의 파일 공유는 그대로 됩니다.
   - 확인: tailnet의 다른 기기에서 `Test-NetConnection <서버 PC의 Tailscale 주소> -Port 445`가 실패하면 됩니다.

## 5. 대표가 처음 로그인하기

1. 대표가 휴대폰 브라우저로 공개 주소에 들어갑니다(웹 화면은 8단계에서 붙습니다 — 그 전에는 API만 열려 있습니다).
2. 로그인 화면이 코드(예: `ABCD-EFGH`)와 google.com/device 링크를 보여 줍니다. **그 화면에서 시작한 코드만 넣으세요.** 다른 사람이 보내 준 코드를 넣으면 그 사람의 브라우저가 대표 세션을 얻습니다.
3. google.com/device에서 코드를 넣고 대표 이메일의 구글 계정으로 승인하면, 그 브라우저에 기기 세션이 생깁니다(쓰지 않고 14일, 최대 90일).
4. 새 기기가 로그인하면 다른 기기에 '새 기기 로그인' 알림이 갑니다. 대표가 한 로그인이 아니면 내 계정의 기기 목록에서 바로 끊으세요.
5. 대표 이메일과 같은 계정만 들어옵니다. 이름이 닮은 다른 계정(예: `xowner@…`, 다른 도메인의 같은 이름)은 거부되고, 기록에는 그 계정의 도메인만 남습니다.

브라우저가 아닌 도구(`curl` 등)로 로그인을 시험할 때도 공개 주소로 보냅니다(이 PC 안의 주소로는 로그인을 받지 않습니다). 로그인을 시작한 응답이 준 `__Host-wos_login` 쿠키를 결과를 물을 때 다시 보내면서 `X-Wook-Client: 1`과 `Origin: https://grok-pc.tailnet-name.ts.net`(공개 주소)도 함께 실어야 합니다. 쿠키만 보내면 403입니다 — 다른 사이트가 대표의 브라우저로 대신 보내는 요청을 막는 검사이고, 브라우저가 아닌 도구에도 똑같이 적용됩니다. 이미 기기 세션 토큰을 가진 도구(`Authorization: Bearer`)는 이 PC 안의 주소로도 씁니다.

## 6. 메인 에이전트 자리

대표의 명령을 받아 팀을 움직이는 메인 에이전트는 한 번에 하나입니다. 서버가 띄우는 Claude CLI(`launched:claude`)나 Codex CLI(`launched:codex`)가 그 자리에 앉습니다. 외부 에이전트(`external:<ID>`, 그록봇 등)는 7단계에서 붙습니다 — 그 전에는 어디에 적어도 앉히지 않습니다.

1. **처음 보유자와 자리 정책**은 `server.json`의 `seat`에 적습니다.
   ```json
   { "seat": { "initialHolder": "launched:claude", "holders": ["launched:claude", "launched:codex"], "drainMs": 120000 } }
   ```
   - `initialHolder`: 자리가 비어 있을 때(새 데이터 폴더로 처음 띄울 때)만 씁니다. 이미 앉은 자리는 이 값을 바꾸고 `config reload`해도 그대로입니다 — 바꾸려면 아래 `seat assign`을 씁니다. 없으면 운영 설정의 메인 AI(기본 Claude CLI)로 앉습니다. `holders` 안에 있어야 합니다
   - `holders`: 앉을 수 있는 보유자 목록입니다. 기본은 모두(`launched:claude`, `launched:codex`, `external:*`)이고, `external:*`는 적어도 7단계 전까지 앉히지 않습니다. 서버가 띄우는 보유자를 하나는 넣어야 합니다
   - `drainMs`: 자리를 넘길 때 나가는 메인 턴의 마무리를 기다리는 시간(밀리초, 0~3600000, 기본 120000). 넘으면 그 턴을 멈추고 넘깁니다
   - 값이 틀리면 서버는 시작하지 않고(끝 코드 1, 잠금·저장소를 만들기 전), `config reload`는 아무것도 바꾸지 않고 그 칸을 말합니다. 바뀐 것은 `config reload`의 답과 활동 기록(행위자 operator)에 남고, `config show`의 '메인 자리' 줄에 보입니다
2. **자리는 메인 에이전트가 넘깁니다.** 대표가 "Codex에게 메인을 넘겨"라고 명령하면 메인 에이전트가 판단해 `hand_off_seat`로 넘깁니다. 대표 화면에는 자리를 바꾸는 버튼이 없습니다. 넘어가면 새 메인은 이전 메인이 하던 일을 정리한 인계 꾸러미를 받습니다.
3. **응답하지 않는 메인 에이전트.** 메인 턴이 사용량 한도·재로그인 필요·시작 실패로 연달아 3번 끝나거나, 메인 일이 쌓였는데 그 CLI를 쓸 수 없으면(사용량 한도를 기다림, CLI 확인 필요) 서버는 '응답 없음'으로 표시합니다.
   - **서버는 자리를 다른 AI에게 넘기지 않습니다**(대표 결정). 대표에게 5분·30분·2시간에 알리고, `backend.log`에 '메인 에이전트 응답 없음 …' 줄을 남깁니다. 대표의 명령은 쌓였다가 메인이 돌아오면(다음 메인 턴이 정상으로 끝나면) 이어서 처리됩니다. 긴급 정지한 동안은 세지 않습니다
   - 그동안 자리를 살리는 길은 운영자의 `seat assign`뿐입니다.
4. **운영자 배정** — 서버 PC에서:
   ```powershell
   wook-server seat status --data-dir D:\wook-data                        # 보유자·세대·응답 없음·교체 중인지·자리 정책·최근 이력 (보기만)
   wook-server seat assign launched:codex --data-dir D:\wook-data         # 나가는 메인 턴의 마무리(drainMs)와 인계 메모 턴(최대 2분)을 기다려 넘김
   wook-server seat assign launched:claude --force --data-dir D:\wook-data  # 실행 중인 메인 턴을 바로 멈추고 기다리지 않음
   ```
   - 자리 이력과 활동 기록에 바꾼 쪽 '운영자'로 남고, 대표에게 '메인 에이전트가 바뀌었습니다' 알림이 갑니다. 까닭은 '운영자 복구 배정 (wook-server seat assign)'입니다
   - 답이 '넘기는 중입니다'면 아직 기다리는 중입니다 — `seat status`로 봅니다
   - 나가는 메인 턴의 종료를 확인하지 못하면 교체가 멈춥니다(끝 코드 1). 두 메인이 겹쳐 돌지 않게 새 보유자를 앉히지 않고 메인 에이전트를 일시정지해 둡니다. 작업 관리자에서 남은 CLI 프로세스가 모두 사라졌는지 확인한 뒤 대표가 화면에서 '정지 해제'를 누르면 일시정지가 풀리고 이어 갑니다 — 그동안의 `seat assign`은 `--force`여도 받지 않습니다
   - 다른 종류로 넘길 CLI는 이 PC에 설치되고 로그인돼 있어야 합니다(그 사용자 계정으로). 아니면 그 까닭과 할 일(그 CLI에 로그인한 뒤 서버를 다시 시작하면 시작할 때 다시 확인합니다)을 말하고 바꾸지 않습니다
   - 보유자를 틀리게 적으면 서버에 붙지 않고 끝 코드 2로 끝나며, 적은 값은 되풀이하지 않습니다

## 7. 운영자 명령

| 명령 | 하는 일 |
|---|---|
| `wook-server status` | 상태(pid, 주소, 실행 ID, 진행 중 작업, 긴급 정지, 비밀 값 저장소, 버전) |
| `wook-server stop` | 긴급 정지 (대표의 긴급 정지와 같습니다. 해제는 대표 화면에서) |
| `wook-server shutdown` | 정상 종료 |
| `wook-server config show` | 운영자 설정 보기 — 대표 이메일, 구글 클라이언트, 보안 비밀 등록 여부, CLI 위치, 공개 주소, Tailscale 사용자, 메인 작업 폴더 |
| `wook-server config reload` | `server.json`을 다시 읽어 적용하고 바뀐 것을 모두 알려 줌 — 공개 주소, 받는 Tailscale 사용자(켬·끔·사람 수)까지. 틀린 파일이면 아무것도 바꾸지 않습니다(JSON이 아니면 틀린 줄과 글자만 말합니다). `workspaceRoot`는 다시 시작해야 바뀝니다 |
| `wook-server config owner-email <이메일>` | 대표 이메일 바꾸기 (등록된 대표 계정과 모든 기기 세션이 끊깁니다) |
| `wook-server config google-client-id <ID>` | 서버의 구글 로그인 클라이언트 ID 바꾸기 |
| `wook-server secret set google-client-secret` | 구글 보안 비밀 넣기 (표준 입력으로만) |
| `wook-server secret clear google-client-secret` | 구글 보안 비밀 지우기 |
| `wook-server session test` | 운영자 시험 세션 (`--allow-test-session`으로 띄운 서버만 — 시험용) |
| `wook-server seat status` | 메인 에이전트 자리 보기 — 보유자·세대·응답 없음·교체 중인지·자리 정책·최근 이력 (6절) |
| `wook-server seat assign <보유자> [--force]` | 메인 에이전트 자리를 `launched:claude`나 `launched:codex`에게 넘김 (운영자 배정, 6절) |

모든 명령은 `--data-dir <폴더>`와 `--json`(결과를 JSON 한 줄로)을 받습니다. 운영자 명령은 데이터 폴더의 `admin.token`으로 서버와 서로 증명한 뒤에만 실행됩니다 — 데이터 폴더의 권한을 넓히지 마세요. 명령을 잘못 쳐도 오류 글은 친 값을 되풀이하지 않습니다(명령 이름과 숫자 같은 것만 보입니다). 그래도 비밀 값은 명령 줄에 쓰지 마세요.

## 8. 지켜야 할 것

- `server.json`에는 비밀 값을 넣지 않습니다. 보안 비밀은 `secret set`으로만 넣습니다.
- 서버 PC의 운영자와 그 PC에서 도는 에이전트를 믿는다는 전제입니다. 같은 OS 계정의 프로그램은 데이터 폴더를 읽을 수 있습니다(SERVER_DESIGN 9.2).
- 업로드한 파일은 `<데이터 폴더>\uploads`에 24시간 남았다가 지워집니다. 서버 PC의 파일을 원격 화면에서 경로로 붙이는 길은 없습니다.
- 업로드는 50MB까지이고, 60초 동안 데이터가 오지 않거나 한 파일이 60분 넘게 걸리면 멈춥니다(408 — '올리는 중 60초 동안 데이터가 오지 않아 멈췄습니다 …'). 60분이면 50MB를 약 120kbit/s로도 올릴 수 있습니다. 멈춘 업로드의 받다 만 파일은 남지 않습니다. 명령 같은 보통 요청은 본문이 30초 안에 다 와야 합니다.
- 문제가 생기면 `<데이터 폴더>\logs\server.log`(HTTP·운영자 명령·한살이)와 `backend.log`(업무)를 봅니다. 요청 인자와 토큰은 기록에 남지 않습니다.
