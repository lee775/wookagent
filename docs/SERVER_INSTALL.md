# 욱채 서버 설치 안내

서버 PC에 욱채 서버를 띄우고, 대표가 휴대폰이나 다른 PC에서 Tailscale로 들어오게 하는 방법과 그 까닭입니다. 서버를 설치하고 운영하는 사람(운영자)이 읽습니다. 설계는 [SERVER_DESIGN.md](SERVER_DESIGN.md) 3.4–3.7(메인 에이전트 자리는 4장)에, 코드 안내는 [ARCHITECTURE.md](ARCHITECTURE.md) 20장에 있습니다.

- **처음부터 명령 순서대로 설치하려면** [SERVER_SETUP.md](SERVER_SETUP.md)를 따릅니다(Windows — 에이전트가 그대로 따라 할 수 있게 쓴 차례, 깨끗한 VM 점검표와 `wook-server check` 항목별 문제 해결이 있습니다). 이 문서는 그 단계들의 설명입니다.
- **서버를 두기 전에 이 PC에서 먼저 써 보려면** [TRY_IT.md](TRY_IT.md)(체험 도구 `scripts\try-server.cmd`·`scripts\try-desktop.cmd`)를 봅니다.
- 작업 스케줄러 등록(`install-task`)과 서버 PC 점검(`check`)은 7절의 표에 있습니다. 실제 휴대폰 로그인과 다시 시작 뒤 확인은 아직 대표와 함께 하거나 깨끗한 VM에서 할 일입니다(SERVER_SETUP 부록 A).

## 0. 준비물

- 서버 PC: Windows 10·11. 서버를 돌릴 **그 사용자 계정**으로 Claude CLI·Codex CLI에 로그인해 둡니다(LocalSystem 서비스 계정으로 돌리지 않습니다).
- Node.js 24 이상과 이 저장소. 저장소 폴더에서 `npm ci` 뒤 `npm run build:server`를 하면 `out/server/index.mjs`(와 외부 에이전트의 명령 `out/server/wook.mjs` — 10절)가 생기고, `npm run build:web`을 하면 대표가 브라우저로 쓰는 웹 화면이 `out/web`에 생깁니다.
- 대표의 구글 계정 하나 — 이 계정만 대표로 받습니다.
- Tailscale 계정 하나. 서버 PC와 대표의 휴대폰(또는 다른 PC)을 같은 tailnet에 넣습니다.

아래 명령의 `wook-server`는 `node out/server/index.mjs`를 줄여 쓴 것입니다. 저장소 폴더에서는 `scripts\wook-server.cmd`가 같은 일을 합니다(SERVER_SETUP이 이렇게 씁니다). 운영자 명령에는 서버를 띄운 데이터 폴더를 `--data-dir`로 알려 주세요(서버와 같은 `WOOK_DATA_DIR`를 쓰면 생략해도 됩니다).

## 1. 데이터 폴더와 대표 이메일

1. 데이터 폴더를 정합니다. 정하지 않으면 데스크톱 앱과 같은 `%APPDATA%\wookagent`를 씁니다. 한 데이터 폴더는 데스크톱 앱이든 서버든 하나만 쓸 수 있습니다.
   - 없는 폴더로 서버를 띄우면 서버가 그 폴더를 이 사용자만 쓰게 만듭니다(물려받은 권한을 끊습니다). 이미 있는 폴더는 권한을 바꾸지 않습니다 — 그래서 `server.json`을 먼저 쓰려고 폴더를 손으로 만들면, 만든 바로 뒤에 같은 권한으로 좁힙니다(PowerShell). 특히 `D:\` 아래처럼 다른 계정(Authenticated Users 등)이 쓸 수 있는 자리에서는 꼭 합니다:
     ```powershell
     New-Item -ItemType Directory -Force D:\wook-data | Out-Null
     icacls D:\wook-data /inheritance:r /grant:r "$($env:USERDOMAIN)\$($env:USERNAME):(OI)(CI)F"
     ```
     `icacls`는 `1 파일을 처리했으며 0 파일은 처리하지 못했습니다`처럼 끝나야 합니다. 그 안에 생기는 `server.json`·DB·기록·관리 토큰이 이 권한을 물려받습니다. 차례대로 따라 하는 [SERVER_SETUP.md](SERVER_SETUP.md) 4단계는 이 줄을 블록 안에 넣어 두었습니다.
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

같은 데이터 폴더를 데스크톱 앱과 번갈아 쓰다가 데스크톱 앱이 다른 구글 계정을 대표로 등록하면, 서버는 대표 이메일의 계정을 `대표 이메일은 맞지만 이 서버에는 다른 이메일의 구글 계정이 대표로 등록되어 있습니다 — …`라며 거부합니다(같은 이메일의 다른 구글 계정이면 `대표 이메일은 맞지만 처음 등록한 구글 계정이 아닙니다 — …`). 그때는 운영자가 같은 대표 이메일로 `wook-server config owner-email <대표 이메일>`을 다시 실행하세요. 다른 이메일의 등록을 지우고(기기 세션도 끊깁니다) 다음 로그인한 대표 계정이 등록됩니다. 그때 끊긴 기기 세션은 데스크톱 앱이 그 계정으로 다시 로그인해도 되살아나지 않습니다.

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
   - 클라이언트 종류가 틀리면 로그인 화면이 `구글이 이 클라이언트 ID로 기기 코드를 내주지 않았습니다 (invalid_client) — 'TV 및 입력 제한 기기' 종류의 클라이언트 ID인지 확인하세요`처럼 알려 줍니다(괄호 안은 `unauthorized_client`일 수도 있습니다).

## 3. 서버 띄우기

```powershell
wook-server --data-dir D:\wook-data --web-dir out\web
# 욱채 서버 준비 완료: 주소 http://127.0.0.1:7317 (127.0.0.1과 ::1에서 받음) · 실행 ID … · 데이터 폴더 D:\wook-data
```

- **웹 화면** (8단계): `--web-dir`에는 `npm run build:web`이 만든 `out/web`을 넘깁니다. 저장소 폴더에서 띄우면 `out\web`, 다른 폴더에서 띄우면 그 절대 경로를 씁니다. 이 화면은 서버에 붙어 실제 자료를 보여 줍니다.
  - 개발용 화면(가짜 자료로 도는 `npm run dev:web`용 빌드나 8단계 전의 `out/web`)을 넘기면 서버가 '--web-dir 폴더가 서버용 웹 화면이 아닙니다: … npm run build:web으로 다시 만든 out/web을 넘기세요'라고 알리고 시작하지 않습니다(끝 코드 1). 실제 서버 주소에서 가짜 자료가 보이지 않게 하려는 것입니다.
  - `--web-dir` 없이 띄우면 API만 열리고, 주소를 열면 웹 화면을 붙이는 방법을 알려 주는 안내 쪽이 보입니다.
  - `npm run build:web`은 시작할 때 `out/web`을 먼저 비웁니다. 빌드가 실패하면(빌드 검사가 가짜 자료나 루프백 주소를 찾은 경우 포함) `out/web`은 빈 채로 남습니다 — 그대로 서버를 띄우면 '서버용 웹 화면이 아닙니다'로 시작하지 않고, 이미 돌던 서버의 화면은 열리지 않습니다. 까닭을 고친 뒤 `npm run build:web`을 다시 해서 성공한 다음 서버를 (다시) 띄우세요.
  - 저장소를 새로 받은 뒤에는 `npm run build:server`와 `npm run build:web`을 다시 하고 서버를 다시 띄웁니다. 화면 파일 이름에 내용 해시가 붙어 있어 브라우저는 새 화면을 바로 받고, 바뀌지 않은 파일(3D 모델 등)은 다시 받지 않습니다. 서버는 화면 파일을 gzip으로 줄여 보내므로 휴대폰이 받는 양은 4분의 1쯤으로 줄어듭니다.

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
6. **Tailscale 쪽의 SMB(TCP 445)를 막습니다 (겹 방어).** 운영자 명령이 쓰는 관리 채널은 Windows 이름 있는 파이프이고, 이름 있는 파이프는 SMB로 다른 기기에서도 열 수 있습니다. 9단계부터 서버는 그 파이프를 서버 도우미(`<데이터 폴더>\bin\WookServerHelper.exe` — 서버가 처음 시작할 때 Windows의 .NET Framework(csc.exe)로 컴파일해 둡니다)가 만들게 해, 다른 기기(SMB)에서 온 연결을 증명 전에 거부하고 지금 사용자 말고는 아무도 열지 못하게 합니다.
   - 확인: `wook-server status --json --data-dir D:\wook-data`의 `adminPipe`가 `"mode":"helper","rejectsRemote":true`면 도우미가 막고 있습니다.
   - 도우미를 쓸 수 없으면(csc가 없음, 컴파일 실패, 백신이 실행 파일을 바꿈, 10초 안에 준비되지 않음 등) 서버는 멈추지 않고 Node 파이프로 엽니다. 그때 `adminPipe`는 `"mode":"node","rejectsRemote":false`와 까닭(`reason`)을 말하고, `logs\server.log`에 '관리 채널이 다른 기기(SMB)의 연결을 거부하지 못합니다 (<까닭>) — Tailscale 쪽 TCP 445를 막아 두세요' 한 줄이 남습니다(운영자 활동 기록에도 한 줄). 관리 토큰 없이 명령을 실행하거나 토큰·비밀 값을 얻을 수는 없지만(서로 증명), 파이프를 열어 두드리는 것은 막지 못합니다 — 까닭을 고치고 서버를 다시 시작하세요.
   - 그래서 도우미가 막고 있어도 tailnet에서 들어오는 445는 막아 둡니다(같은 PC에서는 445가 닫혔는지 증명할 수 없어, 서버는 이것을 시작 조건으로 쓰지 않습니다). 관리자 PowerShell에서:
   ```powershell
   New-NetFirewallRule -DisplayName "욱채 - Tailscale SMB 막기" -Direction Inbound -Protocol TCP -LocalPort 445 -InterfaceAlias "Tailscale" -Action Block
   Get-NetFirewallRule -DisplayName "욱채 - Tailscale SMB 막기" | Get-NetFirewallPortFilter   # 445가 보이면 됩니다
   ```
   - `Tailscale`은 Tailscale이 만든 네트워크 어댑터의 이름입니다. 다르면 `Get-NetAdapter`로 이름을 확인해 `-InterfaceAlias`에 넣으세요.
   - 막는 규칙은 허용 규칙보다 먼저입니다. 이 PC 안과 집·회사 네트워크의 파일 공유는 그대로 됩니다.
   - 확인: tailnet의 다른 기기에서 `Test-NetConnection <서버 PC의 Tailscale 주소> -Port 445`가 실패하면 됩니다.

## 5. 대표가 처음 로그인하기

1. 대표가 휴대폰 브라우저로 공개 주소에 들어갑니다(서버를 `--web-dir out\web`으로 띄웠어야 화면이 열립니다 — 3절).
2. 로그인 화면이 코드(예: `ABCD-EFGH`)와 google.com/device 링크를 보여 줍니다. **그 화면에서 시작한 코드만 넣으세요.** 다른 사람이 보내 준 코드를 넣으면 그 사람의 브라우저가 대표 세션을 얻습니다.
3. google.com/device에서 코드를 넣고 대표 이메일의 구글 계정으로 승인하면, 그 브라우저에 기기 세션이 생깁니다(쓰지 않고 14일, 최대 90일).
4. 새 기기가 로그인하면 다른 기기에 '새 기기 로그인' 알림이 갑니다. 대표가 한 로그인이 아니면 내 계정의 기기 목록에서 바로 끊으세요.
5. 대표 이메일과 같은 계정만 들어옵니다. 이름이 닮은 다른 계정(예: `xowner@…`, 다른 도메인의 같은 이름)은 거부되고, 기록에는 그 계정의 도메인만 남습니다.

브라우저가 아닌 도구(`curl` 등)로 로그인을 시험할 때도 공개 주소로 보냅니다(이 PC 안의 주소로는 로그인을 받지 않습니다). 로그인을 시작한 응답이 준 `__Host-wos_login` 쿠키를 결과를 물을 때 다시 보내면서 `X-Wook-Client: 1`과 `Origin: https://grok-pc.tailnet-name.ts.net`(공개 주소)도 함께 실어야 합니다. 쿠키만 보내면 403입니다 — 다른 사이트가 대표의 브라우저로 대신 보내는 요청을 막는 검사이고, 브라우저가 아닌 도구에도 똑같이 적용됩니다. 이미 기기 세션 토큰을 가진 도구(`Authorization: Bearer`)는 이 PC 안의 주소로도 씁니다.

## 6. 메인 에이전트 자리

대표의 명령을 받아 팀을 움직이는 메인 에이전트는 한 번에 하나입니다. 서버가 띄우는 Claude CLI(`launched:claude`)나 Codex CLI(`launched:codex`)가 그 자리에 앉습니다. 외부 에이전트(`external:<ID>`, 그록봇 등)는 운영자가 `wook-server agent add --label <이름>`으로 등록한 뒤 `wook-server seat assign external:<ID>`로 앉힙니다(키는 등록할 때 한 번만 보입니다).

1. **처음 보유자와 자리 정책**은 `server.json`의 `seat`에 적습니다.
   ```json
   { "seat": { "initialHolder": "launched:claude", "holders": ["launched:claude", "launched:codex"], "drainMs": 120000 } }
   ```
   - `initialHolder`: 자리가 비어 있을 때(새 데이터 폴더로 처음 띄울 때)만 씁니다. 이미 앉은 자리는 이 값을 바꾸고 `config reload`해도 그대로입니다 — 바꾸려면 아래 `seat assign`을 씁니다. 없으면 운영 설정의 메인 AI(기본 Claude CLI)로 앉습니다. `holders` 안에 있어야 합니다
   - `holders`: 앉을 수 있는 보유자 목록입니다. 기본은 모두(`launched:claude`, `launched:codex`, `external:*`)이고, `external:*`는 등록하고 폐기하지 않은 외부 에이전트 모두입니다. 서버가 띄우는 보유자를 하나는 넣어야 합니다 — 외부 에이전트가 응답하지 않을 때 배정할 곳입니다
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
| `wook-server status` | 상태(pid, 주소, 실행 ID, 진행 중 작업, 긴급 정지, 비밀 값 저장소, 화면 조작의 마지막으로 안 상태, 관리 채널(서버 도우미인지 — 4절 6번), 절전 방지(awake·pending·idle·off·unavailable — `pending`은 작업이 막 시작돼 절전 방지 도우미의 답을 기다리는 동안, Windows 밖에서는 `unsupported`), 배포 점검의 요약, 버전) |
| `wook-server stop` | 긴급 정지 (대표의 긴급 정지와 같습니다. 해제는 대표 화면에서) |
| `wook-server shutdown` | 정상 종료 |
| `wook-server config show` | 운영자 설정 보기 — 대표 이메일, 구글 클라이언트, 보안 비밀 등록 여부, CLI 위치, AI의 API 키(등록 여부와 인증 방식만), 공개 주소, Tailscale 사용자, 메인 작업 폴더 |
| `wook-server config reload` | `server.json`을 다시 읽어 적용하고 바뀐 것을 모두 알려 줌 — 공개 주소, 받는 Tailscale 사용자(켬·끔·사람 수)까지. 틀린 파일이면 아무것도 바꾸지 않습니다(JSON이 아니면 틀린 줄과 글자만 말합니다). `workspaceRoot`와 `screen.enabled`는 다시 시작해야 바뀝니다 |
| `wook-server config owner-email <이메일>` | 대표 이메일 바꾸기 (등록된 대표 계정과 모든 기기 세션이 끊깁니다) |
| `wook-server config google-client-id <ID>` | 서버의 구글 로그인 클라이언트 ID 바꾸기 |
| `wook-server secret set google-client-secret` | 구글 보안 비밀 넣기 (표준 입력으로만) |
| `wook-server secret clear google-client-secret` | 구글 보안 비밀 지우기 |
| `wook-server secret set claude-api-key\|codex-api-key` | AI의 API 키 넣기 (표준 입력으로만) — 데스크톱 앱과 같은 Windows 자격 증명 관리자 자리라 같은 PC의 데이터 폴더가 모두 함께 씁니다. 그 AI가 API 키 방식(메인 에이전트가 `account.authMode`로 정함)일 때만 턴이 씁니다 — API 키 방식이면 넣은 뒤 CLI를 다시 확인합니다 |
| `wook-server secret clear claude-api-key\|codex-api-key` | 그 API 키 지우기 |
| `wook-server session test` | 운영자 시험 세션 (`--allow-test-session`으로 띄운 서버만 — 시험용) |
| `wook-server seat status` | 메인 에이전트 자리 보기 — 보유자·세대·응답 없음·교체 중인지·자리 정책·최근 이력 (6절) |
| `wook-server seat assign <보유자> [--force]` | 메인 에이전트 자리를 `launched:claude`·`launched:codex`·`external:<ID>`에게 넘김 (운영자 배정, 6절) |
| `wook-server agent add --label <이름>` | 외부 에이전트 등록 — ID와 키(`wsk_…`, 이때 한 번만 보입니다) (10절) |
| `wook-server agent revoke <ID>` | 외부 에이전트의 키 폐기 (되풀이해도 0) (10절) |
| `wook-server agent list` | 등록한 외부 에이전트 — 이름·등록·폐기·마지막 접속·메인 자리·연결(임대) — 키는 보이지 않습니다 (10절) |
| `wook-server install-task [서버 옵션]` | 서버를 이 사용자의 작업 스케줄러 '로그온할 때' 작업(`WookServer-<8자>`, 로그온 30초 뒤, 관리자 권한 없이)으로 등록 — 실행 중인 서버가 없어도 됩니다. 서버 옵션(`--port`·`--web-dir`·`--config`·`--owner-email`·`--public-origin`·`--workspace-root`)을 작업에 옮기고, `--allow-test-session`은 받지 않습니다. 등록한 뒤 작업 스케줄러 COM으로 그대로 다시 읽어(콘솔 코드 페이지를 거치지 않음) Node·인자·실행 계정·로그온 방식·권한 수준(관리자 권한 없이)·동작이 쓴 것과 같은지 확인하고, 서버는 띄우지 않습니다(다음 할 일: `schtasks /run /tn <이름>`). 다시 하면 바꿔 넣습니다 |
| `wook-server uninstall-task` | 그 작업 지우기 (없으면 그대로 0, 있는지 읽지 못하면 지우지 않고 1, 실행 중인 서버는 끄지 않습니다 — `shutdown`) |
| `wook-server check` | 서버 PC 점검 — 세션, 자동 로그온, 화면 잠금, 절전, 작업, 데이터 폴더 권한, Node, CLI 로그인, API 키 환경 변수, 화면 조작, SMB(관리 채널), Tailscale(13개). 바꾸는 것은 없고 항목마다 고칠 길을 말합니다 — 고칠 길이 `wook-server` 명령이면 점검한 데이터 폴더를 `--data-dir`로 붙여, 그대로 치면 그 폴더에 듣습니다. 실패가 있으면 끝 코드 1. 서버도 시작 뒤 한 번 같은 점검을 하고 `status`의 '배포 점검' 줄에 요약을 둡니다 |

모든 명령은 `--data-dir <폴더>`와 `--json`(결과를 JSON 한 줄로)을 받습니다. `install-task`·`uninstall-task`·`check`는 `--dry-run`(아무것도 바꾸거나 띄우지 않고 할 일 — 작업 XML·실행할 명령·점검 스크립트 — 만 보입니다)도 받습니다. 운영자 명령은 데이터 폴더의 `admin.token`으로 서버와 서로 증명한 뒤에만 실행됩니다 — 데이터 폴더의 권한을 넓히지 마세요. 명령을 잘못 쳐도 오류 글은 친 값을 되풀이하지 않습니다(명령 이름과 숫자 같은 것만 보입니다). 그래도 비밀 값은 명령 줄에 쓰지 마세요.

## 8. 지켜야 할 것

- `server.json`에는 비밀 값을 넣지 않습니다. 보안 비밀은 `secret set`으로만 넣습니다.
- 서버 PC의 운영자와 그 PC에서 도는 에이전트를 믿는다는 전제입니다. 같은 OS 계정의 프로그램은 데이터 폴더를 읽을 수 있습니다(SERVER_DESIGN 9.2).
- 업로드한 파일은 `<데이터 폴더>\uploads`에 24시간 남았다가 지워집니다. 서버 PC의 파일을 원격 화면에서 경로로 붙이는 길은 없습니다.
- 업로드는 50MB까지이고, 60초 동안 데이터가 오지 않거나 한 파일이 60분 넘게 걸리면 멈춥니다(408 — '올리는 중 60초 동안 데이터가 오지 않아 멈췄습니다 …'). 60분이면 50MB를 약 120kbit/s로도 올릴 수 있습니다. 멈춘 업로드의 받다 만 파일은 남지 않습니다. 명령 같은 보통 요청은 본문이 30초 안에 다 와야 합니다.
- 문제가 생기면 `<데이터 폴더>\logs\server.log`(HTTP·운영자 명령·한살이)와 `backend.log`(업무)를 봅니다. 요청 인자와 토큰은 기록에 남지 않습니다.

## 9. 메인 에이전트의 화면 조작 (6단계, Windows)

메인 에이전트는 서버 PC의 화면을 찍고(`screen_capture`) 마우스·키보드를 움직일 수 있습니다(`gui_input`). 서버 모드의 Windows에서만 쓰고, 데스크톱 앱에서는 쓰지 않습니다. 대표는 웹 화면의 '자리와 인계 → 화면 조작'에서 상태와 최근 캡처·동작 기록을 보기만 합니다 — 시작·멈춤 버튼은 없고, 멈추려면 긴급 정지를 씁니다.

> 실제 화면에서의 시험(`WOOK_REAL_DESKTOP`)은 마우스·키보드를 잠깐 가져가므로 대표가 정한 때에 대표가 자리에 있을 때 합니다(아직 하지 않았습니다). 지금까지는 가짜 화면 도우미로만 시험했습니다.

1. **화면이 있는 세션에서 띄웁니다.** 서버는 로그온한 사용자의 화면 안에서 돌아야 합니다. Windows 서비스(세션 0)나 '사용자의 로그온 여부에 관계없이 실행' 작업으로 띄우면 화면이 없어 화면 도구가 '화면 세션 없음'으로 거부됩니다.
2. **자동 로그온을 쓰고 화면 잠금을 끕니다.** 잠긴 화면은 검게 찍히고 입력이 먹지 않습니다. 화면 보호기와 자동 잠금(절전 뒤 암호 요구 포함)을 끄세요. 잠기면 화면 도구는 '화면 잠김'으로 거부되고, 대표에게 '서버 PC 운영자에게 잠금 해제·다시 로그온을 부탁하세요'라는 알림이 갑니다 — 풀 수 있는 사람은 그 PC 앞의 운영자뿐입니다.
3. **원격 데스크톱(RDP)을 끊기 전에 세션을 콘솔로 돌립니다.** RDP로 접속했다가 그냥 끊으면 그 세션의 화면이 없어집니다('세션 연결 끊김'). 클라우드 Windows라면 끊기 전에 관리자 PowerShell에서:
   ```powershell
   query session                     # 내 세션 번호(ID)를 본다
   tscon <세션 번호> /dest:console     # 세션을 콘솔로 돌린다 — RDP 창은 닫히고 화면은 살아 있다
   ```
4. **관리자 권한으로 띄우지 않습니다.** 서버가 관리자 권한이면 화면 도우미도 관리자 권한이라 관리자 권한 창까지 조작할 수 있습니다. 보통 사용자 권한으로 띄우면 관리자 권한 창과 권한 확인(UAC) 화면에는 입력이 가지 않고, 메인 에이전트는 그 사실을 거부로 받습니다. `wook-server status`의 '화면 조작' 줄이 관리자 권한이면 그렇게 말합니다.
5. **서버 PC의 브라우저에 대표로 로그인해 두지 않습니다.** 그 화면에는 대표만 누르는 버튼(정지 해제, 결과 승인)이 있습니다. 화면 도우미는 제목이 '욱채'로 시작하는 창을 막지만, 다른 탭이 앞에 있는 브라우저 창은 제목으로 가려내지 못합니다. 대표는 자기 기기(휴대폰·다른 PC)에서 로그인하세요.
6. **서버 창을 그대로 둡니다.** 서버는 자기 콘솔 창의 제목을 `욱채 서버 (pid …)`로 바꾸고, 화면 도우미는 그 창과 서버를 띄운 프로그램의 창을 모두 막습니다 — 서버의 조상 프로세스(서버를 띄운 셸과 터미널)가 가진 보이는 창이면 종류와 상관없이 막습니다. 이렇게 막히는 경우: cmd·PowerShell 콘솔 창에서 띄움, Windows Terminal의 탭에서 띄움(그 Windows Terminal의 창 모두), Git Bash(mintty)·VS Code·JetBrains의 터미널·ConEmu 같은 다른 터미널에서 띄움(그 프로그램의 창 모두 — VS Code에서 띄우면 VS Code 창 모두가 막힙니다). 바탕 화면·작업 표시줄·탐색기(`explorer.exe`)는 막지 않습니다. 막지 못하는 경우: Windows Terminal이 Windows의 기본 터미널로 콘솔을 넘겨받은 창(그 창은 서버의 조상이 아닙니다)에서 서버의 탭이 뒤에 있을 때, 작업 표시줄의 미리 보기·작업 보기(Win+Tab)에서 서버 창을 닫는 클릭. 서버는 따로 연 창에서 띄우거나 9단계의 작업 스케줄러 실행을 쓰세요.
7. **서버 PC 앞의 사람이 먼저입니다.** 그 PC에서 사람이 마우스·키보드를 쓰면 화면 조작이 30초 멈춥니다. 조작 중에는 화면 가장자리에 주황 테두리와 띠가 뜹니다. **Ctrl+Alt+Shift+F12**를 누르면 화면 조작이 5분 멈춥니다(다시 누르면 그때부터 5분) — 그 PC 앞의 사람만 쓰는 멈춤이고, 메인 에이전트도 대표도 풀 수 없습니다. 이 단축키는 화면 도우미가 떠 있는 동안만 걸려 있습니다: 메인 에이전트가 처음 화면 도구를 쓰기 전과, 10분 쉬어 도우미가 끝난 뒤에는 눌러도 아무 일이 없습니다 — 띠가 떠 있을 때 누르세요. 다른 프로그램이 같은 단축키를 쓰고 있으면 띠에 단축키 글이 없고 메인 에이전트는 입력을 보내지 못합니다(캡처만 됩니다) — 그 프로그램을 닫거나 서버를 다시 시작하세요. 원격 제어 프로그램(원격 지원 도구 등)으로 보낸 입력은 사람 입력으로 보이지 않을 수 있습니다.
   메인 에이전트가 놓기(`gui_input release`)를 하거나 턴이 끝나 놓을 때는 Windows가 눌렸다고 하는 Shift·Ctrl·Alt·Win과 마우스 버튼을 모두 뗍니다 — 그때 그 PC 앞에서 손으로 누르고 있던 키·버튼도 떼어집니다(끌던 것이 끊기면 다시 누르세요).
8. **끄려면** `server.json`에 적고 서버를 다시 시작합니다. `config reload`로는 바뀌지 않습니다.
   ```json
   { "screen": { "enabled": false } }
   ```
   끄면 화면 도구는 '운영자가 화면 조작을 꺼 두었습니다'로 거부되고 화면 도우미는 뜨지 않습니다.
9. **캡처는 잠깐만 남습니다.** 메인 에이전트 작업 폴더의 `screens\`에 24시간 또는 최근 500장까지만 두고, 백업과 내보내기에는 들어가지 않습니다. 화면에 띄워 둔 내용이 AI 서비스로 전송된다는 점은 그대로입니다 — 서버 PC의 화면에는 메인 에이전트가 봐도 되는 것만 띄워 두세요. Claude Code·Codex CLI가 스스로 남기는 기록(`~/.claude`, `~/.codex`)에 든 캡처 사본은 앱이 지우지 못합니다.
10. **비밀번호는 메인 에이전트가 치지 않습니다.** 암호 칸(과 어떤 칸인지 모르는 포커스)에는 글자를 넣지 않고, 붙여넣기 키(Ctrl+V·Ctrl+Shift+V·Shift+Insert·Win+V)도 보내지 않습니다. 탭·줄바꿈이 든 글은 한 번에 치지 않습니다 — 칸을 옮기는 키는 따로 보내고 그다음 칸을 다시 확인합니다. 치는 동안 프로그램이 스스로 포커스를 옮기면(칸을 다 채우면 다음 칸으로 넘어가는 양식) 4자마다 포커스를 다시 보고 암호 칸이면 멈추지만, 멈추기 전의 몇 글자는 그 칸에 들어갈 수 있습니다. 로그인이 필요한 프로그램은 운영자가 미리 로그인해 두세요. 실수를 막는 장치일 뿐입니다: 비밀을 여러 번에 나눠 치거나 대소문자를 바꿔 치는 것, 마우스 오른쪽 메뉴·메뉴 막대의 붙여넣기는 막지 못합니다 — 서버 PC의 클립보드에 비밀을 두지 마세요.
11. **서버가 갑자기 꺼지면** 화면 도우미도 함께 꺼지지만, 그 순간 눌려 있던 키는 뗄 기회가 없을 수 있습니다. 다음에 서버를 시작하면 한 번 떼어 줍니다. 그 사이 Shift·Ctrl·Alt가 눌린 것처럼 굴면 그 키를 한 번씩 눌렀다 떼세요.
12. `<데이터 폴더>\bin\WookDesktopHelper.exe`는 서버가 원본에서 컴파일해 두는 화면 도우미입니다. 띄울 때마다 해시를 봅니다 — 누가 바꾸면 띄우지 않고 대표에게 '화면 도우미 파일이 바뀜' 알림이 갑니다. 컴파일에는 Windows의 .NET Framework(csc.exe)가 필요합니다.

## 10. 외부 에이전트 (7단계)

서버가 띄우는 Claude CLI·Codex CLI 대신, 이 PC에서 도는 다른 프로그램(외부 에이전트 — 그록봇 등)을 메인 자리에 앉힐 수 있습니다. 에이전트는 루프백의 에이전트 API로 붙고, 명령 `wook`(`node out\server\wook.mjs` — `npm run build:server`가 `index.mjs`와 함께 만듭니다)이나 HTTP로 일합니다. 에이전트 쪽 안내는 [AGENT_GUIDE.md](AGENT_GUIDE.md)에 있습니다. 서버 모드에서만 됩니다 — 데스크톱 앱은 외부 에이전트를 메인 자리에 앉히지 않습니다.

1. **등록** — 서버 PC에서:
   ```powershell
   wook-server agent add --label 그록봇 --data-dir D:\wook-data
   # 외부 에이전트를 등록했습니다: X-0001 (그록봇)
   # 에이전트 키 — 지금 한 번만 보입니다. 서버는 해시만 저장해 다시 보여 줄 수 없습니다 (잃어버리면 agent revoke로 폐기하고 agent add로 새로 받습니다):
   #   wsk_…
   # 이 키는 에이전트에게 환경 변수 WOOK_AGENT_KEY나 그 사용자만 읽는 ~/.wook/agent.json으로 넘기세요 — 명령 줄 인자로는 넘기지 마세요(다른 프로그램이 볼 수 있습니다).
   # 메인 자리에 앉히려면: wook-server seat assign external:X-0001
   ```
   - 이름은 1~40자이고, 줄바꿈·탭 같은 글자 없이, 폐기하지 않은 에이전트끼리 겹치지 않게(대소문자 무시) 짓습니다.
   - 이렇게 하면 키가 터미널 화면(과 그 스크롤 기록)에 남습니다. 남기지 않으려면 다음 2의 방법으로 등록과 동시에 파일에 씁니다.
2. **키를 에이전트에게** — 에이전트가 같은 Windows 계정으로 돈다면 등록과 동시에 `~/.wook/agent.json`(그 계정만 읽는 파일)에 바로 씁니다. 키가 화면과 셸 기록에 남지 않습니다. 저장소 폴더에서 Windows PowerShell 5.1에 아래 블록을 통째로 붙여 넣습니다:
   ```powershell
   & {
     $ErrorActionPreference = 'Stop'
     $dir = Join-Path $HOME '.wook'
     $f = Join-Path $dir 'agent.json'
     if (Test-Path $f) { throw "키 파일이 이미 있습니다($f) — 등록하지 않았습니다. 그 파일을 지우거나 옮긴 뒤 다시 하세요" }
     $me = "$($env:USERDOMAIN)\$($env:USERNAME)"
     New-Item -ItemType Directory -Force $dir | Out-Null
     icacls $dir /inheritance:r /grant:r "${me}:(OI)(CI)F" | Out-Null
     if ($LASTEXITCODE -ne 0) { throw '.wook 폴더의 권한을 좁히지 못했습니다 — 등록하지 않았습니다' }
     New-Item -ItemType File $f | Out-Null
     icacls $f /inheritance:r /grant:r "${me}:F" | Out-Null
     if ($LASTEXITCODE -ne 0) { Remove-Item $f; throw 'agent.json의 권한을 좁히지 못했습니다 — 등록하지 않았습니다' }
     $n = $Error.Count
     try { $r = node out\server\index.mjs agent add --label 그록봇 --json --data-dir D:\wook-data | ConvertFrom-Json }
     catch { while ($Error.Count -gt $n) { $Error.RemoveAt(0) }; Remove-Item $f; throw '운영자 명령을 실행하지 못했거나 그 답을 읽지 못했습니다 — wook-server agent list로 등록됐는지 보고, 됐으면 agent revoke로 폐기한 뒤 다시 하세요' }
     if (-not $r.ok -or -not $r.result.key) { Remove-Item $f; throw "등록하지 못했습니다: $($r.error.message)" }
     @{ key = $r.result.key } | ConvertTo-Json -Compress | Set-Content -Encoding utf8 $f
     "등록: $($r.result.id) — 키는 $f 에 두었습니다"
     node out\server\wook.mjs seat status --data-dir D:\wook-data
     if ($LASTEXITCODE -ne 0) { throw "키는 썼지만 wook seat status가 끝 코드 $LASTEXITCODE(으)로 끝났습니다 — 바로 위의 글이 까닭입니다" }
     '확인: wook이 키 파일을 읽고 서버를 확인했습니다'
   }
   ```
   - 블록(`& { … }`) 안의 어느 줄이든 실패하면 그 자리에서 멈춥니다(`$ErrorActionPreference = 'Stop'`과 위의 확인들). 블록으로 감싸는 것은 콘솔에 여러 줄을 붙여 넣으면 PowerShell이 줄마다 따로 실행해, 한 줄이 실패해도 다음 줄이 돌기 때문입니다.
   - 순서: `~/.wook/agent.json`이 이미 있으면 등록하지 않고 멈춥니다(덮어쓰지 않습니다 — 그 파일을 지우거나 옮긴 뒤 다시 합니다). 그다음 `.wook` 폴더와 빈 `agent.json`의 권한을 좁히고, 그것이 된 뒤에만 등록합니다 — 권한을 좁히지 못하면 등록하지 않으므로, 등록만 되고 키를 잃는 일이 없습니다. 등록하지 못했으면 만들어 둔 빈 파일을 지우고, 실패한 답의 글(키가 들었을 수 있는)을 화면에 내지 않고 '등록하지 못했습니다: <까닭>'만 냅니다. 운영자 명령의 답을 읽지 못하면 그 오류를 세션의 `$Error`에서도 지웁니다(그 오류에 답의 글이 들 수 있습니다). 키가 든 변수(`$r`)는 블록이 끝나면 사라집니다.
   - 운영자 명령의 `--json`은 ASCII만 냅니다(한글은 `\uXXXX`로) — PowerShell 5.1은 다른 프로그램의 출력을 콘솔 코드 페이지(한국어 Windows는 949)로 읽지만, ASCII는 어느 코드 페이지로 읽어도 같습니다.
   - 마지막 줄 '확인: wook이 키 파일을 읽고 서버를 확인했습니다'가 나오면 키 파일과 서버 확인이 맞은 것입니다(그 위의 `wook seat status`는 '메인 자리: 세대 n · …'와 '이 에이전트에게 배정됨: 아니요'를 냅니다 — 배정은 다음 3에서). 이 판정은 `wook`의 끝 코드로 합니다 — 출력을 파이프나 파일로 받으면 PowerShell 5.1이 `wook`의 한글을 코드 페이지 949로 다시 읽어 깨져 보일 수 있지만, 마지막 줄은 PowerShell이 낸 글이라 그대로입니다. `wook`이 0이 아니면 그 끝 코드를 말하고 멈춥니다 — 2면 바로 위의 글이 까닭(키 파일의 권한 등)을 말합니다.
   - `.wook` 폴더와 그 파일의 권한부터 좁힌 뒤에 키를 씁니다. `wook`은 이 파일의 권한(ACL)에 지금 사용자·SYSTEM·Administrators 밖의 계정이 있으면 키를 쓰지 않고 끝 코드 2로 끝납니다(그 글에 열린 계정과 차례로 할 `icacls` 명령이 나옵니다). 프로필 폴더가 다른 계정에도 권한을 주는 PC라면 그냥 만든 파일은 그 권한을 물려받아 거부됩니다 — 위처럼 상속을 끊으세요. 폴더도 좁혀 두면 그 안에 새로 만드는 파일(`wook`의 `state.json`, curl의 머리 파일 — AGENT_GUIDE 3절)이 지금 사용자 권한만 물려받습니다.
   - 또는 에이전트를 띄우는 쪽이 환경 변수 `WOOK_AGENT_KEY`로 넘깁니다. 명령 줄 인자로는 넘기지 않습니다(`wook`에는 키를 받는 옵션이 없습니다).
   - Linux·macOS에서는 폴더를 0700으로 만들고 키를 `umask 077` 아래에서 씁니다(키가 한 순간도 다른 사용자에게 열리지 않게 — 그룹·다른 사용자 권한이 있으면 `wook`이 쓰지 않습니다). 저장소 폴더에서:
     ```sh
     mkdir -p ~/.wook && chmod 700 ~/.wook && { [ ! -e ~/.wook/agent.json ] || { echo "키 파일(~/.wook/agent.json)이 이미 있어 등록하지 않았습니다 — 그 파일을 지우거나 옮긴 뒤 다시 하세요" >&2; false; }; } && (umask 077; node out/server/index.mjs agent add --label 그록봇 --json --data-dir ~/wook-data | node -e 'let t="";process.stdin.on("data",(d)=>(t+=d)).on("end",()=>{let r=null;try{r=JSON.parse(t)}catch{}if(!r||!r.ok||!r.result||!r.result.key){console.error("등록하지 못했습니다: "+((r&&r.error&&r.error.message)||"답을 읽지 못함"));process.exit(1)}try{require("fs").writeFileSync(process.argv[1],JSON.stringify({key:r.result.key})+"\n",{mode:0o600,flag:"wx"})}catch(e){console.error("등록한 "+r.result.id+"의 키를 쓰지 못했습니다 ("+e.code+") — wook-server agent revoke "+r.result.id+"로 폐기한 뒤 다시 하세요");process.exit(1)}console.log("등록: "+r.result.id)})' ~/.wook/agent.json)
     node out/server/wook.mjs seat status --data-dir ~/wook-data
     ```
     키는 화면에 나오지 않습니다. `~/.wook/agent.json`이 이미 있으면 등록하지 않고 멈춥니다(지우거나 옮긴 뒤 다시 합니다). 그 확인과 쓰기 사이에 그 파일이 생겨도 덮어쓰지 않고(`flag: "wx"`), 그때는 방금 등록한 에이전트를 폐기하라고 말합니다. `wook`이 이 파일을 거부하면 그 글에 따옴표로 감싼 `chmod 600 "<파일>"`이 나옵니다. (이 순서는 Linux·macOS에서 돌려 보지 못했습니다 — Windows의 Git Bash에서 등록과 파일 쓰기만 확인했습니다. 거기서는 `chmod`·`umask`가 듣지 않습니다.)
3. **배정**: `wook-server seat assign external:X-0001 --data-dir D:\wook-data` (답은 6절 4와 같습니다). `seat.holders`에 `external:X-0001`이나 `external:*`(기본)가 있어야 합니다. 처음 보유자로 쓰려면 `seat.initialHolder`에 `external:X-0001`을 적습니다(6절 1).
4. **에이전트 띄우기**: 에이전트는 이 저장소의 `out\server\wook.mjs`를 `node`로 부르거나 HTTP로 바로 붙습니다. 서버와 같은 데이터 폴더를 알려 주세요 — `WOOK_DATA_DIR=D:\wook-data`(또는 `wook … --data-dir D:\wook-data`). 서버는 시작할 때마다 새 포트와 새 확인값(`proof`)을 `<데이터 폴더>\agent-endpoint.json`에 적고(주소와 확인값만 — 키는 적지 않습니다), `wook`은 그 파일을 매번 읽고, 키·임대 ID·턴 토큰을 어떤 연결에 쓰기 전에 그 연결에서 먼저 그 확인값으로 듣는 쪽이 이 서버인지 봅니다(`POST /agent/v1/hello` — 새 연결마다, AGENT_GUIDE 2절). 그래서 서버가 끝나고(갑자기든 정상 종료든, 명령이 기다리는 중이든) 그 포트를 다른 프로그램이 차지해도 키는 가지 않습니다(끝 코드 5). curl처럼 직접 붙는 에이전트는 이것을 스스로 해야 합니다(AGENT_GUIDE 3절 — curl은 확인하지 않습니다).
   - `WOOK_AGENT_URL`로 주소를 넘기면 `wook`은 듣는 쪽을 확인하지 않습니다 — 그 파일의 `proof`를 `WOOK_AGENT_PROOF`로 함께 넘기고, 서버를 다시 시작할 때마다 두 값을 새 파일의 값으로 바꿔야 합니다. 되도록 데이터 폴더(파일)로 넘기세요.
   - 에이전트 API는 이 PC의 루프백(앱 도구 서버와 같은 리스너, `127.0.0.1`)에만 열립니다. `tailscale serve`가 넘겨 주는 대표용 포트에는 없고, 다른 PC의 에이전트는 받지 않습니다.
   - `wook`은 한 계정의 `~/.wook\state.json`에 임대를 둡니다 — 한 계정에서 에이전트를 둘 돌리려면 집 폴더(`USERPROFILE`)를 따로 주세요.
5. **보기**:
   ```powershell
   wook-server agent list --data-dir D:\wook-data
   # 욱채 외부 에이전트 (1개 — 폐기한 것 포함)
   #   X-0001 그록봇 — 등록 2026-11-11T02:00:00.000Z, 마지막 접속 2026-11-11T02:05:12.000Z, 메인 자리에 앉아 있음, 연결됨(임대 있음)
   wook-server seat status --data-dir D:\wook-data
   ```
   대표 화면의 자리 보기에도 같은 목록이 보기로만 나옵니다(등록·폐기 버튼은 없습니다).
6. **응답하지 않을 때**: 에이전트가 60초 동안 heartbeat 같은 임대를 싣는 요청을 보내지 않으면 임대가 끝나고, 돌던 턴은 비정상 종료로 끝나 다시 대기열에 들어갑니다. 자리는 '응답 없음'('외부 에이전트 임대 만료 — 60초 동안 heartbeat 없음')으로 남고 대표에게 5분·30분·2시간에 알립니다. 배정한 뒤 60초 안에 자리를 잡지 않아도 같습니다('외부 에이전트가 메인 자리를 잡지 않음 — 60초 동안 claim하지 않음'). **서버는 다른 AI로 바꾸지 않습니다**(6절 3). 살리려면 에이전트를 다시 띄우거나(다시 자리를 잡으면 응답 없음이 풀립니다) `wook-server seat assign launched:claude`로 넘깁니다 — 쌓인 일은 새 보유자가 이어 받습니다.
7. **폐기**: `wook-server agent revoke X-0001 --data-dir D:\wook-data` — 그 뒤 그 키의 모든 요청은 401입니다. 이미 폐기된 것을 다시 폐기해도 0으로 끝나고, 모르는 ID는 1, `X-0001` 꼴이 아니면 2입니다. 앉아 있던(또는 들어올 차례인) 에이전트면 자리는 그대로이고 '응답 없음 — 키가 폐기됨 (운영자)'이 됩니다 — 다른 보유자에게 `seat assign`하세요. 키를 바꾸는 명령은 없습니다 — 폐기한 뒤 `agent add`로 새로 등록합니다(새 ID).
8. **정지**: 대표의 긴급 정지, `wook-server stop`, 에이전트의 `wook stop`은 모두 같은 긴급 정지입니다. 외부 에이전트의 임대와 턴 토큰을 곧바로 폐기하고, 정지 요약에 '외부 메인 에이전트: 턴 토큰과 임대를 폐기함 — 프로세스 종료는 확인할 수 없음 (종료 확인 불가)'을 적습니다. 에이전트의 프로세스는 서버가 띄운 것이 아니라서 서버가 끄지 못합니다 — 필요하면 운영자가 끕니다. 정지 해제는 대표만 합니다.
9. **지켜야 할 것**: 같은 OS 계정에서 도는 에이전트는 데이터 폴더(DB·토큰 파일)와 `~/.wook`도 읽을 수 있습니다 — 그 계정에는 믿는 프로그램만 두세요(SERVER_DESIGN 9.2). 서버는 키의 해시만 두고, 기록·활동·메인 일지에는 `wsk_`·`wtt_` 꼴의 값을 가립니다.
