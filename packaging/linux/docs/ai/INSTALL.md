# 설치 — 묶음으로 처음 설치하기

[../../AGENTS.md](../../AGENTS.md)를 읽은 AI가 처음 설치할 때 위에서부터 따라 합니다. 원본은 [../SERVER_SETUP.md](../SERVER_SETUP.md)의 Linux 편(`## L. 읽기 전에 (Linux)`부터 `## 부록 D. 문제 해결 — Linux check 항목과 시작 거부`까지)이고, 이 문서는 그 단계를 묶음에 맞춰 적은 것입니다. 긴 출력 전문과 까닭은 원본의 같은 이름의 절에 있습니다.

## 읽는 법

- **누가**: 단계마다 `AI`(당신 혼자), `[사람]`(사람이 함 — 당신은 칠 줄을 그대로 보여 주고 기다림)을 적었습니다.
- **어디서**: 명령은 모두 앱 폴더 `~/wookagent`에서 칩니다(B단계 전에는 집 폴더). 데이터 폴더는 `"$HOME/wook-data"`입니다. 다른 경로를 쓰려면 모든 줄에서 같이 바꿉니다.
- **블록**: `( … )`로 감싼 블록은 안에서 `set -eu`를 켜, 한 줄이라도 실패하면 거기서 멈춥니다. 통째로 칩니다.
- **(verify)**: 원본이 실제 기계에서 확인하지 못한 줄입니다(sudo, 유닛 등록·시작, 다시 시작, 실제 Tailscale·구글·CLI 로그인, 실제 X 데스크톱). 해 보고 나온 것을 그대로 보고합니다. 문서와 다르면 멈춥니다.
- **묶음으로 까는 길**: 원본의 출력은 저장소를 받아 빌드한 PC에서 찍은 것입니다. 이 묶음으로 깐 PC의 출력은 원본에 없습니다. 판(`버전` 줄)·경로·시각처럼 달라도 되는 것 말고 다른 것이 나오면 보고합니다.
- **당신의 셸 도구**: 부를 때마다 새 셸이 뜨는 도구라면 앞 호출의 변수와 PATH가 남지 않습니다. L1 뒤에 `node`를 찾지 못하면 같은 호출의 맨 앞에 `. ~/.profile`을 붙입니다. L8의 `$unit`은 쓰는 줄과 같은 호출에서 `unit=$(…)` 줄을 먼저 칩니다.
- **멈출 때**: 단계의 '멈춤' 줄, 그리고 AGENTS.md의 '멈추고 사람에게 묻는 때'.

## 차례

| 단계 | 무엇 | 누가 |
|---|---|---|
| 준비 | 사람에게 받을 것 | AI가 묻고 사람이 답함 |
| L0 | Ubuntu, 사용자, 사용자 systemd, /proc 확인 | AI |
| L1 | 꾸러미, Node 24, CLI 둘 | 꾸러미는 [사람], 나머지 AI |
| B | 묶음 놓기 (L2 대신) | 파일은 [사람]이 둠, 나머지 AI |
| L3 | CLI 로그인 | [사람], 확인은 AI |
| L4 | 데이터 폴더와 server.json, 설정용 서버 | AI (대표 메일은 사람에게서) |
| L5 | 구글 로그인 클라이언트와 보안 비밀 | [사람], ID 넣기와 확인은 AI |
| L6 | Tailscale | [사람], `serve`와 공개 주소는 AI |
| L7 | 절전 막기와 점검 | 막기는 [사람], 점검은 AI |
| L8 | systemd 사용자 유닛 | AI, linger는 [사람] |
| L9 | 화면 조작 (선택) | 꾸러미는 [사람], 나머지 AI |
| L10 | 외부 에이전트와 처음 메인 자리 (선택) | 사람이 정하고 AI가 침 |
| L11 | 대표의 첫 로그인 | [사람], 확인은 AI |
| L12 | 마지막 점검과 다시 시작 | 점검은 AI, 다시 시작은 [사람] |
| L13 | 되돌리기 | AI, sudo 줄은 [사람] |

## 준비 — 사람에게 받을 것

시작하기 전에 사람에게 묻습니다.

1. 대표의 구글 메일 — server.json의 `owner.email`에 씁니다. 비밀 값이 아닙니다.
2. `sudo` 줄을 사람이 쳐 줄 수 있는지(이 PC 앞이나 SSH).
3. Claude·Codex를 구독 로그인으로 쓸지, API 키로 쓸지(L3).
4. Tailscale 계정과 구글 클라우드 콘솔을 쓸 수 있는지(L5·L6). 대표의 휴대폰에 Tailscale 앱을 깔 수 있는지.
5. 화면 조작(L9)을 쓸지.
6. 외부 에이전트(L10)를 둘지. 둔다면 이름(1~40자)과, 메인 자리를 그 에이전트에게 줄지.
7. 묶음 파일 두 개(`….tar.gz`와 `….tar.gz.sha256`)가 이 PC의 어느 폴더에 있는지, 이미 풀었는지(풀었다면 풀기 전에 체크섬을 봤는지).

## L0. 확인 — AI

```sh
. /etc/os-release; echo "$PRETTY_NAME"
id -un; id -u
systemctl --user show-environment >/dev/null && echo "사용자 systemd: 있음 ($XDG_RUNTIME_DIR)"
test -r /proc/self/stat && test -r /proc/sys/kernel/random/boot_id && grep -q '^btime ' /proc/stat && echo "/proc: 읽힘"
```

나와야 하는 것: `Ubuntu 24.04.… LTS`, 사용자 이름, 0이 아닌 uid(보통 1000 이상), `사용자 systemd: 있음 (/run/user/<uid>)`, `/proc: 읽힘`.

멈춤:

- uid가 0 → root의 셸입니다. 멈추고 사람에게 보통 사용자를 만들어(**[사람]** `sudo adduser <이름>`) 그 사용자로 다시 로그인한 뒤 당신을 그 사용자로 다시 띄워 달라고 합니다.
- `Failed to connect to bus` → `sudo -u`·`su`로 바꾼 셸입니다. 사람에게 그 사용자로 직접 로그인(SSH 포함)한 셸에서 당신을 다시 띄워 달라고 합니다.
- `/proc` 줄이 나오지 않음 → 컨테이너 같은 곳입니다. 서버는 거기서 시작하지 않습니다. 보통의 Linux PC나 VM이 필요하다고 보고합니다.

## L1. 꾸러미, Node.js 24, CLI 둘

**[사람: sudo 암호]** (verify — 원본은 sudo를 쓰지 않았습니다. 꾸러미 이름만 확인했습니다):

```sh
sudo apt update
sudo apt install -y git curl xz-utils ca-certificates procps dbus-user-session
```

- `procps`(`ps`·`pgrep`)는 운영자가 프로세스를 볼 때 씁니다. `dbus-user-session`은 사용자 세션 버스를 줍니다 — L8의 유닛이 물려받고, L9의 암호 칸 판정이 씁니다.

**Node.js 24 — AI** (sudo가 들지 않습니다). 이미 `node --version`이 `v24` 이상이면 건너뛰어도 됩니다 — 그 Node의 자리가 L8의 유닛에 적힙니다. 아니면 통째로 칩니다:

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

나와야 하는 것: `node-v24.13.0-linux-x64.tar.xz: OK`(arm64면 `arm64`), `v24.13.0`, npm 판, `/home/<사용자>/.local/opt/node-v24.13.0-linux-<x64|arm64>/bin/node`.

- B단계의 `BUILD-INFO.json`이 더 높은 Node를 요구하면 이 블록의 `v=`를 그 판으로 바꿔 다시 칩니다.
- **Node의 자리는 L8의 유닛에 그대로 적힙니다.** 나중에 Node를 다른 폴더(새 판)로 바꾸면 `install-task`를 다시 합니다. Node의 경로에 `"` `'` `\` `$`가 있으면 `install-task`가 거부합니다.
- NodeSource의 apt 저장소나 nvm으로 깔아도 됩니다(verify — 원본은 돌려 보지 않았습니다).

**CLI 둘 — AI** (verify — 원본은 `npm i -g`를 하지 않았습니다):

```sh
npm i -g @anthropic-ai/claude-code @openai/codex
git --version
claude --version
codex --version
```

- 위의 Node(집 폴더)라면 `npm i -g`가 sudo 없이 Node와 같은 `bin` 폴더에 `claude`·`codex`를 넣습니다. `git --version`은 `git version 2.43.0`쯤이면 됩니다.
- 당신이 이 PC에 이미 깔린 Claude Code나 Codex CLI라면 `command -v claude`·`command -v codex`가 그 자리를 보입니다. 그 폴더는 L8에서 `install-task`를 칠 셸의 PATH에 있어야 합니다(유닛이 그 PATH로 CLI를 찾습니다).

멈춤: `sha256sum`이 `FAILED`(받은 파일이 깨짐 — `~/.local/opt`의 그 `.tar.xz`를 지우고 블록을 다시), `. ~/.profile` 뒤에도 `node --version`이 `v18…`이거나 `command -v node`가 `/usr/bin/node`(옛 apt Node가 PATH 앞에 있음 — `~/.profile`의 그 줄이 PATH 맨 앞에 오는지 봄), `curl: command not found`나 `xz: Cannot exec`(위의 `apt install`을 사람이 먼저).

## B. 묶음 놓기 (L2 대신) — AI

이 문서들은 앱 폴더가 **`~/wookagent`**라고 가정합니다(유닛이 그 경로를 적어 둡니다). 사람이 묶음을 이미 풀어 두었는지에 따라 둘 가운데 하나를 합니다. 당신이 `~/wookagent` 안의 이 문서를 읽고 있다면 대개 이미 풀린 것입니다. 원본 L2의 첫 단락 '묶음으로 (저장소와 빌드 없이)'와 같은 일입니다.

- 묶음 이름의 끝에 `-dirty`가 붙어 있으면(`…-<커밋 7자>-dirty.tar.gz`) 커밋하지 않은 변경이 있는 채 만든 묶음입니다. 아래 명령의 파일 이름을 그대로 바꿔 쓰고, 보고에 적습니다.

**체크섬** — 묶음 파일 두 개가 이 PC에 있으면 **[사람]**에게 그 폴더를 묻고 그 폴더에서 봅니다(`<…>` 자리는 실제 파일 이름):

```sh
cd <두 파일이 있는 폴더>
sha256sum -c wook-server-<판>-linux-<커밋 7자>.tar.gz.sha256
```

나와야 하는 것: `wook-server-<판>-linux-<커밋 7자>.tar.gz: OK`.

- `FAILED`나 `No such file` → 풀지 않고 멈춥니다(이미 풀었으면 그 폴더를 쓰지 않습니다). 사람에게 두 파일을 다시 받아 달라고 합니다.
- 사람이 묶음을 풀고 파일을 지웠으면 체크섬을 볼 수 없습니다. 사람이 풀기 전에 봤는지 묻고, 그 답을 보고에 적습니다.

**아직 풀지 않았으면** — 앱 폴더가 없을 때만 풉니다. 통째로 칩니다:

```sh
(
  set -eu
  if test -e ~/wookagent; then echo "~/wookagent가 이미 있어 풀지 않았습니다" >&2; exit 1; fi
  tar -xzf wook-server-<판>-linux-<커밋 7자>.tar.gz -C ~
)
```

- `이미 있어 풀지 않았습니다`가 나오면 아래 '이미 풀려 있으면'으로 갑니다.

**이미 풀려 있으면** — 그것이 이 묶음인지 봅니다:

```sh
test -f ~/wookagent/BUILD-INFO.json && echo "BUILD-INFO.json 있음"
test -e ~/wookagent/.git && echo ".git이 있음 — 이 묶음이 아닙니다"
```

- `BUILD-INFO.json 있음`만 나와야 합니다. `.git`이 있거나 `BUILD-INFO.json`이 없으면 저장소 사본이나 다른 것입니다 — 멈추고 사람에게 묻습니다.
- 예전에 설치해 쓰던 PC(데이터 폴더 `~/wook-data`가 있음)를 새 판으로 바꾸는 일이면 이 문서가 아니라 [OPERATE.md](OPERATE.md)의 '새 묶음으로 바꾸기'입니다.
- 묶음이 `~/wookagent`가 아닌 곳에 풀려 있으면 멈추고, 집 폴더에 다시 풀지 사람에게 묻습니다.

확인:

```sh
cd ~/wookagent
cat BUILD-INFO.json
node --version
scripts/wook-server --help
node out/server/wook.mjs --help
```

나와야 하는 것:

- `BUILD-INFO.json`의 필요한 Node보다 `node --version`이 낮지 않습니다. 낮으면 L1의 Node 블록을 그 판으로 다시 합니다.
- `scripts/wook-server --help`의 첫 줄이 `욱채 서버 (이 PC의 루프백 — 다른 기기는 tailscale serve로)`이고, `이 PC에서만 하는 명령 (실행 중인 서버가 없어도 됩니다)` 아래에 `install-task`·`uninstall-task`·`check`가 있습니다.
- `wook.mjs --help`의 첫 줄이 `욱채 에이전트 명령 wook — …`입니다.

멈춤:

- `scripts/wook-server: Permission denied` → 실행 권한이 빠진 사본입니다. `sh scripts/wook-server --help`처럼 앞에 `sh `를 붙여도 같습니다. 묶음에는 실행 권한이 있어야 하므로 보고합니다.
- `node: command not found` → `. ~/.profile`을 먼저 칩니다.
- 그 밖의 오류(파일이 없음 등) → 묶음이 덜 풀렸거나 깨졌습니다. 빌드하지 않고 멈춰 사람에게 묶음을 다시 받아 달라고 합니다.

## L3. CLI 로그인 — [사람]

서버가 띄우는 Claude Code·Codex CLI는 **서버를 돌리는 이 사용자**의 로그인을 씁니다. 화면 없는 PC면 브라우저 없이 로그인합니다. 모두 사람이 자기 터미널(이 사용자)에서 칩니다 (verify — 원본은 실제 로그인을 하지 않았습니다):

- **Codex**: `codex login --device-auth` — 나온 주소와 코드를 다른 기기의 브라우저에 넣습니다.
- **Claude**: `claude auth login` — 브라우저를 열 수 없으면 주소를 보여 줍니다. 그 주소를 다른 기기의 브라우저에서 열고 받은 코드를 셸에 붙여 넣습니다. 로그인 정보는 이 사용자의 `~/.claude`에 남습니다.
- 또는 브라우저가 있는 다른 PC에서 `claude setup-token`으로 긴 토큰을 받아 이 사용자의 `~/.config/environment.d/` 아래 파일(예: `50-claude.conf`, 권한 600)에 `CLAUDE_CODE_OAUTH_TOKEN=<토큰>` 한 줄로 둡니다. 이 파일은 사람이 쓰고, 당신은 읽지 않습니다. 사용자 관리자가 언제 다시 읽는지와 `claude auth status`가 이 토큰을 로그인으로 보는지는 원본이 확인하지 못했습니다(verify).

당신이 이 사용자로 로그인한 Claude Code나 Codex라면 이미 로그인돼 있을 수 있습니다. 당신 스스로 로그아웃하거나 다시 로그인하지 않습니다.

확인 — AI (verify):

```sh
claude auth status --json
codex login status
```

나와야 하는 것: `"loggedIn": true`와 `Logged in using ChatGPT`.

- 쓰지 않을 AI는 로그인하지 않아도 됩니다(`check`가 '이 AI를 쓰지 않으면 괜찮습니다'라고 경고만 합니다).
- **API 요금으로 쓸 때**: L4의 서버가 뜬 뒤 **[사람]**이 `scripts/wook-server secret set claude-api-key --data-dir "$HOME/wook-data"`(`codex-api-key`도 같음)를 치고 키를 붙여 넣습니다. Linux에서는 키가 그 데이터 폴더의 비밀 값 파일에 들어갑니다.
- **구독으로 쓸 때**: `ANTHROPIC_API_KEY`·`OPENAI_API_KEY` 같은 환경 변수를 `~/.profile`·`~/.bashrc`·`~/.config/environment.d`에 두지 않습니다.

## L4. 데이터 폴더와 server.json, 설정용 서버 — AI

사람에게 받은 대표의 구글 메일을 `owner@example.com` 자리에 넣고 통째로 칩니다:

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

나와야 하는 것: 바이트 수가 96 이하, `drwx------ /home/<사용자>/wook-data`, `-rw------- /home/<사용자>/wook-data/server.json`, 그리고 `$HOME`이 펼쳐진 server.json.

- **96바이트**: 운영자 명령은 데이터 폴더의 관리 소켓 `admin.sock`으로 서버에 붙습니다. Linux의 소켓 주소 한도 때문에 데이터 폴더의 경로는 UTF-8로 96바이트 이하여야 합니다(한글은 한 글자가 3바이트).
- `owner.email`을 정해 두면 서버가 설정 코드를 내지 않습니다. 이 메일의 구글 계정만 대표로 받습니다.
- `seat.initialHolder`: 처음 메인 자리는 서버가 띄우는 Claude CLI입니다(L10에서 바꿀 수 있습니다). `workspaceRoot`: 메인 에이전트가 그 아래 `main`에서 일합니다.
- `screen.enabled`: L9에서 켭니다. 쓰지 않으면 `false` 그대로 둡니다.
- server.json에는 비밀 값을 넣지 않습니다.
- 집 폴더의 경로에 `"`나 `\`가 있으면 이 블록을 쓰지 않고 멈춥니다(원본은 손으로 쓰라고 합니다 — 사람에게 묻습니다).

**설정용 서버를 띄웁니다.** L5·L6·L10의 운영자 명령이 이 서버에 붙고, L8에서 끄고 유닛으로 다시 띄웁니다. 이 서버는 L8까지 떠 있어야 하므로 **두 번째 셸**에서 띄웁니다 — 당신의 도구에 오래 도는 명령을 뒤에서 돌리는 기능이 있으면 그것으로, 없으면 사람에게 두 번째 터미널(새 터미널이나 두 번째 SSH)에서 쳐 달라고 합니다:

```sh
cd ~/wookagent
scripts/wook-server --data-dir "$HOME/wook-data" --web-dir out/web
```

나와야 하는 것(이 셸은 서버가 끝날 때까지 이대로입니다):

```text
(node:<pid>) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
욱채 서버 준비 완료: 주소 http://127.0.0.1:7317 (127.0.0.1과 ::1에서 받음) · 실행 ID <…> · 데이터 폴더 /home/<사용자>/wook-data
```

- `ExperimentalWarning` 두 줄은 그대로 두면 됩니다.
- 그 셸의 Ctrl+C는 정상 종료(`shutdown`과 같음)입니다. 끄는 것은 L8의 `shutdown`으로 합니다.

원래 셸에서 확인합니다:

```sh
cd ~/wookagent
scripts/wook-server status --data-dir "$HOME/wook-data"
```

나와야 하는 것(그 가운데 — 전문은 원본의 `## L4. 데이터 폴더와 server.json, 설정용으로 서버 띄우기`):

```text
  비밀 값 저장  파일 (/home/<사용자>/wook-data/secrets — 이 사용자만, 암호화하지 않음)
  관리 채널     소켓 파일 — 이 사용자만
  절전 방지     idle — 진행 중 작업이 없어 막지 않습니다
  배포 점검     <시각>에 — 통과 10 · 경고 6 (unit, linger, sleep, cli.claude, cli.codex, tailscale) · 실패 0 · 건너뜀 1 (wook-server check로 자세히)
  시험용 세션   꺼짐 (--allow-test-session 없이 시작)
```

- 경고 6개는 이 시점에 정상입니다. L5~L9에서 차례로 없어집니다(CLI를 깔고 로그인했으면 `cli.*` 경고는 없을 수 있습니다).
- `비밀 값 저장` 뒤에 `— 쓸 수 없음: …`이 붙으면 [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '`check` 항목'에서 `secrets` 줄을 봅니다.

멈춤: 서버 셸에 `욱채 서버를 시작하지 못했습니다: …`(그 글이 까닭 — [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '서버가 시작하지 않을 때'), `--web-dir 폴더가 서버용 웹 화면이 아닙니다`(묶음의 `out/web`이 깨짐 — 빌드하지 않고 보고), 포트 7317을 다른 프로그램이 씀(서버를 띄우는 줄과 L8의 `install-task`에만 `--port <번호>`, L6의 `tailscale serve`도 그 번호 — 사람에게 알림), `status`가 `이 데이터 폴더(…)로 실행 중인 욱채 서버가 없습니다 (server.lock 없음)`(서버 셸이 준비 줄을 냈는지, `--data-dir`이 같은지 봄).

## L5. 구글 로그인 클라이언트와 보안 비밀 — [사람]

**[사람]** 구글 클라우드 콘솔에서 **'TV 및 입력 제한 기기'** 종류의 OAuth 클라이언트를 만듭니다. 차례는 [../SERVER_INSTALL.md](../SERVER_INSTALL.md)의 `## 2. 구글 로그인 클라이언트 ('TV 및 입력 제한 기기')`에 있습니다 — OAuth 동의 화면은 '외부', 게시 상태가 '테스트'면 테스트 사용자에 대표의 구글 계정을 꼭 넣습니다. 사람에게 받은 **클라이언트 ID**(비밀 값이 아닙니다)를 당신이 넣습니다:

```sh
scripts/wook-server config google-client-id <클라이언트 ID> --data-dir "$HOME/wook-data"
```

나와야 하는 것:

```text
구글 클라이언트 ID를 server.json에 쓰고 적용했습니다: 바꾼 것 1개
  - 구글 클라이언트 ID → <클라이언트 ID>
```

**보안 비밀은 [사람]이 넣습니다.** 당신은 값을 받지도 보지도 않습니다. 사람에게 사람의 터미널(이 사용자)에서 이 줄을 쳐 달라고 합니다 — 친 뒤 값을 붙여 넣으면 화면에 보이지 않습니다:

```sh
cd ~/wookagent
scripts/wook-server secret set google-client-secret --data-dir "$HOME/wook-data"
```

파일로 받은 사람은 원본의 방법(`cat ~/google-secret.txt | scripts/wook-server secret set google-client-secret --data-dir "$HOME/wook-data"` 뒤 `rm ~/google-secret.txt`)을 씁니다. 그 파일은 당신이 열거나 옮기지 않습니다.

나와야 하는 것(사람의 터미널): `구글 로그인 보안 비밀을 데이터 폴더의 비밀 값 파일에 넣었습니다 (값은 다시 보여 주지 않습니다).`

확인 — AI:

```sh
scripts/wook-server config show --data-dir "$HOME/wook-data"
stat -c '%A %n' "$HOME/wook-data/secrets" "$HOME/wook-data/secrets"/*
```

나와야 하는 것: `config show`에 `구글 클라이언트 <클라이언트 ID>`와 `구글 보안 비밀  등록됨 (데이터 폴더의 비밀 값 파일)`, `stat`에 `drwx------ …/secrets`와 `-rw------- …/secrets/<64자>.json`.

- Linux의 비밀 값은 `<데이터 폴더>/secrets/`의 파일이고 **암호화하지 않습니다.** 막는 것은 이 PC의 다른 사용자뿐입니다. 같은 사용자로 도는 프로세스(당신 포함)는 읽을 수 있으므로 그 폴더를 읽지 않습니다.
- 실수로 비밀 값을 명령 줄에 붙였으면 그 값은 쓰이지 않습니다. **[사람]** `history -d <번호>`로 셸 기록의 그 줄을 지우고(`~/.bash_history`에 이미 쓰였으면 거기서도), 구글 클라우드 콘솔에서 보안 비밀을 새로 만듭니다.

## L6. Tailscale — [사람]

**[사람: sudo 암호]** (verify — 원본은 Tailscale을 설치하거나 바꾸지 않았습니다):

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --operator="$(id -un)"
```

- `tailscale up`이 낸 로그인 주소를 사람이 브라우저에서 열고 Tailscale 계정으로 로그인합니다. 대표의 휴대폰에도 Tailscale 앱을 깔고 같은 tailnet에 로그인합니다.
- `--operator=<사용자>`는 이 사용자가 `sudo` 없이 `tailscale serve`를 쓰게 합니다. 이미 올려 둔 Tailscale이면 `sudo tailscale set --operator="$(id -un)"`입니다.
- **[사람]** Tailscale 관리 콘솔(https://login.tailscale.com/admin/dns)에서 **MagicDNS**와 **HTTPS Certificates**를 켭니다. 원하면 접근 규칙(ACL)으로 이 PC에는 대표의 기기만 닿게 합니다.

서버 앞에 `tailscale serve`를 둡니다 — AI (verify). `funnel`은 쓰지 않습니다(인터넷 전체에 엽니다):

```sh
tailscale serve --bg 7317
tailscale serve status
```

- `https://<서버 PC 이름>.<tailnet>.ts.net`과 `http://127.0.0.1:7317`로 넘기는 줄이 보이면 됩니다. 포트를 바꿨으면 그 번호로 합니다.
- 권한이 없다며 거부하면 `--operator`가 빠졌습니다 — 사람에게 위의 `tailscale set` 줄을 부탁합니다. Tailscale 판에 따라 인자 모양이 다를 수 있습니다([../SERVER_INSTALL.md](../SERVER_INSTALL.md) 4절은 `tailscale serve --bg http://127.0.0.1:7317`로 적었습니다).
- 그 Tailscale 이름에는 욱채만 둡니다. 다른 서비스는 다른 기기 이름에 둡니다. `tailscale serve reset`은 다른 항목까지 지우니 치지 않습니다.

공개 주소와 받는 Tailscale 사용자를 server.json에 더합니다 — AI:

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

- 원본은 이 블록을 실제 Tailscale이 아닌 대역 프로그램으로 돌렸습니다. 실제 `tailscale status --json`으로 돈 결과를 보고합니다(verify).
- 받는 Tailscale 사용자는 이 PC의 Tailscale 로그인입니다. 대표의 휴대폰이 다른 Tailscale 계정이면 그 로그인 이름을 server.json의 `owner.tailscaleLogins`에 더하고 `config reload`를 다시 합니다.

멈춤: 블록이 `tailscale status에서 … 읽지 못했습니다`로 멈춤(사람의 `sudo tailscale up`이 끝났는지, `tailscale status`가 이 PC를 보이는지), `config reload`가 `공개 주소 … 모양이 아닙니다`로 아무것도 바꾸지 않음(`network.publicOrigin`이 `https://<이름>` 꼴인지).

## L7. 절전 막기와 점검

서버 PC는 쉬는 동안 잠들지 않아야 합니다 — 잠든 PC는 휴대폰에서 닿지 않습니다. **[사람: sudo 암호]** (verify):

```sh
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
```

확인 — AI:

```sh
systemctl show -p Id -p LoadState sleep.target suspend.target hibernate.target hybrid-sleep.target
```

나와야 하는 것: 네 `LoadState`가 모두 `masked`. 막기 전에는 `loaded`입니다.

- 서버는 작업 중에 `systemd-inhibit`으로 절전을 막으려 하지만, polkit은 그 PC 앞의 활성 세션 밖(유닛, SSH)에는 그 잠금을 내주지 않습니다. 그러면 `status`가 `절전 방지     unavailable — systemd-inhibit: Failed to inhibit: Access denied …`를 냅니다. 절전 대상을 막아 두었으면 괜찮습니다.

점검 — AI:

```sh
scripts/wook-server check --data-dir "$HOME/wook-data"
```

나와야 하는 것: 줄마다 `통과`·`경고`·`실패`·`건너뜀`이고 마지막 줄이 `결과: … 실패 0 …`. 이 시점에는 `systemd 유닛`·`linger` 경고가 남는 것이 정상입니다(L8에서 없어집니다). 출력 전문은 원본의 `## L7. 절전 막기와 점검`.

- 경고·실패 밑의 `할 일:`이 고칠 길입니다. `wook-server`로 시작하는 고칠 줄은 `scripts/wook-server`로 바꿔 그대로 칩니다(점검한 데이터 폴더가 `--data-dir`로 붙어 나옵니다). `sudo`로 시작하는 고칠 줄은 사람에게 넘깁니다.
- 항목별 뜻과 고칠 길은 [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '`check` 항목'.
- 무엇을 읽는지 보려면 `scripts/wook-server check --dry-run --data-dir "$HOME/wook-data"`.

멈춤: `실패`가 하나라도 있음(끝 코드 1) — 고칠 길을 찾아 고치고 다시 점검합니다. 찾지 못하면 보고합니다.

## L8. systemd 사용자 유닛으로 띄우기 — AI

설정용 서버를 끕니다:

```sh
scripts/wook-server shutdown --data-dir "$HOME/wook-data"
```

나와야 하는 것: `서버를 종료했습니다.` 서버 셸은 글을 더 내지 않고 끝 코드 0으로 끝납니다. 당신의 도구 뒤에서 돌렸으면 그 일이 끝났는지 봅니다.

유닛은 **`install-task`를 친 셸의 `node` 절대 경로와 PATH**를 적어 둡니다(사용자 유닛은 `~/.profile`을 읽지 않습니다). 그래서 먼저 그 셸에 `node`·`claude`·`codex`·`git`이 다 보이는지 보고, 무엇을 등록할지 봅니다(한 호출로):

```sh
. ~/.profile
command -v node claude codex git
scripts/wook-server install-task --dry-run --data-dir "$HOME/wook-data"
```

나와야 하는 것: `[시험 실행 — 아무것도 바꾸지 않았습니다] 등록할 사용자 유닛: wook-server-<8자>.service`, 그리고

- `서버 진입점   /home/<사용자>/wookagent/out/server/index.mjs`, `데이터 폴더   /home/<사용자>/wook-data`, `웹 화면       /home/<사용자>/wookagent/out/web`
- `PATH` 줄에 `command -v`가 보인 폴더(쓰지 않을 CLI는 빼도 됨)가 모두 있음
- `실행 계정` 줄이 `… root 없이)`로 끝남
- 유닛 파일의 `ExecStart=`에 `--allow-test-session`이 없음

전문은 원본의 `## L8. systemd 사용자 유닛으로 띄우기 (install-task)`. 맞으면 등록합니다 (verify — 원본은 이 PC에서 등록하지 않았고, 실제 등록 → 다시 읽기 → 지우기만 CI에서 통과했습니다):

```sh
. ~/.profile
scripts/wook-server install-task --data-dir "$HOME/wook-data"
```

나와야 하는 것: `systemd 사용자 유닛을 등록했습니다: wook-server-<8자>.service`, `--dry-run`과 같은 줄들, 그리고 `다음 할 일`(지금 띄우기·확인·기록·끄기·부팅할 때도). `install-task`는 유닛 파일을 쓰고 `daemon-reload`·`enable` 뒤 다시 읽어 견줄 뿐 **서버를 띄우지 않습니다.**

띄우고 확인합니다 (verify — 원본은 유닛으로 띄우지 않았습니다). 한 호출로 칩니다:

```sh
unit=$(scripts/wook-server install-task --dry-run --json --data-dir "$HOME/wook-data" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.name')
echo "$unit"
systemctl --user start "$unit"
scripts/wook-server status --data-dir "$HOME/wook-data"
journalctl --user -u "$unit" --no-pager -n 20
```

나와야 하는 것: `echo`가 `wook-server-<8자>.service`, `status`가 L4와 같은 꼴(막 떴으면 몇 초 뒤 `status`를 다시), `journalctl`에 서버의 준비 줄. 설정 코드는 저널에 남지 않습니다.

**부팅하면 로그인 없이 뜨게** — **[사람: sudo 암호]** (verify):

```sh
sudo loginctl enable-linger "$(id -un)"
```

확인 — AI:

```sh
loginctl show-user "$(id -un)" -p Linger
```

나와야 하는 것: `Linger=yes`. linger가 꺼져 있으면 사용자 유닛은 그 사용자가 로그인할 때만 뜨고, 마지막 세션이 끝나면 함께 멈춥니다.

유닛에 대해 알 것:

- 이름 `wook-server-<8자>.service`의 8자는 데이터 폴더의 실제 경로의 해시입니다. 데이터 폴더마다 유닛 하나입니다. 자리는 `~/.config/systemd/user/`, 파일은 0600입니다.
- 끄면(`shutdown`이나 `systemctl --user stop`) 서버에만 SIGTERM이 가고, 서버가 턴을 차례로 끝낸 뒤 남은 프로세스는 systemd가 끝냅니다. 45초 안에 나가지 않으면 모두 SIGKILL입니다.
- 서버가 실패로 끝나면 60초 뒤 다시 띄웁니다(10분에 4번까지). `shutdown`으로 정상 종료하면 다시 띄우지 않습니다.
- 유닛의 서버에는 로그인 셸의 `DISPLAY`가 없습니다(L9의 `screen.display`).

멈춤:

- `로그인한 사용자 계정으로 실행해야 합니다 — root로는 사용자 유닛을 등록하지 않습니다 …` → L0.
- `이 사용자의 systemd(사용자 관리자)에 닿지 못했습니다 — …` → `sudo -u`·`su`로 바꾼 셸입니다. 사람에게 직접 로그인한 셸에서 당신을 띄워 달라고 합니다.
- `Node 실행 파일 경로(…)에 systemd가 실행 파일 이름으로 받지 않는 글자(" ' \ $)가 있습니다 — …` → 그런 글자가 없는 폴더에 Node를 둡니다(L1).
- `서버 진입점이 없습니다` → 묶음이 깨졌습니다. 빌드하지 않고 보고합니다.
- `등록한 유닛이 쓴 것과 다릅니다 (…)`로 끝 코드 1 → [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '유닛'.
- `status`가 `실행 중인 욱채 서버가 없습니다` → `systemctl --user status "$unit"`, `journalctl --user -u "$unit"`의 끝, `<데이터 폴더>/logs/server.log`를 봅니다.

## L9. 화면 조작 — Xvfb 가상 화면 (선택)

메인 에이전트가 서버 PC의 화면을 찍고 마우스·키보드를 쓰게 하려면 합니다. 쓰지 않으면 건너뜁니다(server.json의 `screen.enabled`는 `false` 그대로). 지원하고 시험한 모양은 **이 사용자의 Xvfb 가상 화면 하나와 창 관리자 openbox**입니다. 사람이 쓰는 실제 X 데스크톱은 최선 노력이고(verify), Wayland는 쓸 수 없습니다. 원본은 `## L9. 화면 조작 — Xvfb 가상 화면 (선택)`.

꾸러미 — **[사람: sudo 암호]** (verify):

```sh
sudo apt install -y xvfb xauth openbox xdotool maim x11-utils x11-xserver-utils xinput xprintidle python3 python3-xlib python3-gi gir1.2-atspi-2.0 at-spi2-core fonts-noto-cjk
```

- **`python3`는 꼭 있어야 합니다** — 서버가 X 도구를 띄우기 전에 python3로 화면의 주인을 확인합니다. `python3-xlib`·`python3-gi`·`gir1.2-atspi-2.0`·`at-spi2-core`는 곁 도우미(멈춤 단축키, 조작 중 표시, 암호 칸 판정)에 씁니다. `fonts-noto-cjk`가 없으면 캡처의 한글이 네모로 보입니다.

화면의 쿠키 — AI. 쿠키 값은 출력하지 않습니다(둘째 줄은 쿠키 자리를 `<쿠키>`로 바꿔 냅니다 — `xauth … list`를 그대로 치지 않습니다):

```sh
(umask 077 && touch ~/.wook-xvfb.auth && xauth -f ~/.wook-xvfb.auth add :99 . "$(mcookie)")
xauth -f ~/.wook-xvfb.auth list | awk '{print $1, $2, "<쿠키>"}'
stat -c '%A %n' ~/.wook-xvfb.auth
```

나와야 하는 것: `<PC 이름>/unix:99 MIT-MAGIC-COOKIE-1 <쿠키>`와 `-rw------- /home/<사용자>/.wook-xvfb.auth`.

- 이 블록은 첫 시작 전에 한 번만 칩니다. 쿠키 파일에는 그 화면 번호의 줄 하나만 둡니다. `:99`를 다른 프로그램이 쓰면 다른 번호로 바꾸고 아래의 모든 `:99`·`X99`도 같이 바꿉니다.

두 사용자 유닛 — AI. 그대로 칩니다:

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

- **`-nolisten local`을 붙이지 않습니다.** 서버는 그렇게 띄운 화면을 거부합니다(`noabstract`). `-auth`와 `-nolisten tcp`는 그대로 둡니다. `-displayfd`도 쓰지 않습니다.
- Xvfb 유닛은 뜰 때마다 쿠키를 새로 씁니다.

켜고 띄웁니다 — AI (verify):

```sh
systemctl --user daemon-reload
systemctl --user enable --now wook-xvfb.service wook-openbox.service
systemctl --user is-active wook-xvfb.service wook-openbox.service
```

나와야 하는 것: `active` 두 줄.

그 화면에 붙어 봅니다 — AI:

```sh
export DISPLAY=:99 XAUTHORITY=~/.wook-xvfb.auth
xdpyinfo | grep -E '^(name of display|vendor string):|dimensions:'
xinput list --name-only | grep Xvfb
xprop -root _NET_SUPPORTING_WM_CHECK
XAUTHORITY=/dev/null xdpyinfo >/dev/null 2>&1 || echo "쿠키 없이는 붙지 못합니다 (맞음)"
```

나와야 하는 것: `name of display:    :99`, `vendor string:    The X.Org Foundation`, `dimensions:    1920x1080 pixels …`, `Xvfb mouse`, `Xvfb keyboard`, `_NET_SUPPORTING_WM_CHECK(WINDOW): window id # <창 번호>`, `쿠키 없이는 붙지 못합니다 (맞음)`. 이 셸의 `DISPLAY`는 확인용입니다 — 서버는 server.json을 봅니다.

server.json에 화면을 적고 서버를 다시 띄웁니다 — AI. `screen` 칸은 시작할 때만 읽습니다. 한 호출로 칩니다:

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
unit=$(scripts/wook-server install-task --dry-run --json --data-dir "$HOME/wook-data" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.name')
systemctl --user start "$unit"
```

나와야 하는 것: `{"enabled":true,"display":":99","xauthority":"/home/<사용자>/.wook-xvfb.auth"}`, `서버를 종료했습니다.` (유닛으로 다시 띄우는 줄은 verify.)

- `shutdown` 앞에 `status`의 `진행 중 작업`이 `없음`인지 봅니다(AGENTS.md).
- `screen.xauthority`는 절대 경로여야 합니다(`~`·`$HOME`은 펼쳐지지 않습니다). 모양이 틀리면 서버가 시작하지 않고 그 칸을 말합니다.

확인 — AI:

```sh
scripts/wook-server status --data-dir "$HOME/wook-data"
```

나와야 하는 것: `  화면 조작     화면 조작을 쓸 수 있습니다 (모니터 1개, 마지막 확인 <시각>)`. 다른 글이면 [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '화면 조작'.

알아 둘 것:

- 그 화면의 프로그램은 운영자(사람이나 당신)가 `DISPLAY=:99 XAUTHORITY="$HOME/.wook-xvfb.auth"`를 붙여 띄워 둡니다. 서버는 `DISPLAY`·`XAUTHORITY`를 CLI 턴과 `host_exec`에 넘기지 않습니다. 그 화면에는 메인 에이전트가 봐도 되는 것만 띄웁니다.
- Xvfb나 openbox가 막 뜨면 처음 30초는 화면 조작이 사람 입력을 기다리며 멈춥니다.
- Xvfb에는 멈춤 단축키를 누를 키보드가 없습니다. 대표의 멈춤은 긴급 정지입니다.

## L10. 외부 에이전트와 처음 메인 자리 (선택)

하지 않으면 메인 자리는 server.json의 `seat.initialHolder`대로 서버가 띄우는 Claude CLI입니다. 외부 에이전트(예: 나중에 메인 자리에 앉을 당신)를 둘지, 그 이름, 메인 자리를 줄지는 **사람이 정합니다.** 차례의 원본은 [../SERVER_INSTALL.md](../SERVER_INSTALL.md) 10절, 에이전트 쪽은 [../AGENT_GUIDE.md](../AGENT_GUIDE.md)입니다.

**등록과 키 파일** — AI. 같은 사용자로 돌 에이전트라면 아래 블록 하나가 등록(`agent add`)과 키 파일 `~/.wook/agent.json`(0700 폴더, 0600 파일) 쓰기를 함께 하고, 키를 화면에 내지 않습니다. `그록봇` 자리에 사람이 정한 이름을 넣고 앱 폴더에서 칩니다(SERVER_INSTALL 10절 2의 Linux 블록 그대로):

```sh
mkdir -p ~/.wook && chmod 700 ~/.wook && { [ ! -e ~/.wook/agent.json ] || { echo "키 파일(~/.wook/agent.json)이 이미 있어 등록하지 않았습니다 — 그 파일을 지우거나 옮긴 뒤 다시 하세요" >&2; false; }; } && (umask 077; node out/server/index.mjs agent add --label 그록봇 --json --data-dir ~/wook-data | node -e 'let t="";process.stdin.on("data",(d)=>(t+=d)).on("end",()=>{let r=null;try{r=JSON.parse(t)}catch{}if(!r||!r.ok||!r.result||!r.result.key){console.error("등록하지 못했습니다: "+((r&&r.error&&r.error.message)||"답을 읽지 못함"));process.exit(1)}try{require("fs").writeFileSync(process.argv[1],JSON.stringify({key:r.result.key})+"\n",{mode:0o600,flag:"wx"})}catch(e){console.error("등록한 "+r.result.id+"의 키를 쓰지 못했습니다 ("+e.code+") — wook-server agent revoke "+r.result.id+"로 폐기한 뒤 다시 하세요");process.exit(1)}console.log("등록: "+r.result.id)})' ~/.wook/agent.json)
node out/server/wook.mjs seat status --data-dir ~/wook-data
```

나와야 하는 것: `등록: X-0001`, 그리고 `wook seat status`가 `메인 자리: 세대 1 · 앉아 있음 · 보유자 Claude CLI`와 `이 에이전트에게 배정됨: 아니요`. (원본은 이 블록을 WSL2의 Ubuntu 24.04에서 그대로 돌렸습니다.)

- `~/.wook/agent.json`이 이미 있으면 등록하지 않고 멈춥니다. 그 파일을 지우거나 옮길지는 사람에게 묻습니다.
- 위 블록 밖에서 `agent add`를 따로 치지 않습니다 — 그 꼴은 키를 터미널에 냅니다. `~/.wook/agent.json`을 `cat`하지 않습니다.
- 에이전트를 다른 계정·다른 방법으로 띄우는 경우는 SERVER_INSTALL 10절 1과 AGENT_GUIDE 2절(환경 변수 `WOOK_AGENT_KEY`)을 따르고, 키를 받는 일은 사람이 합니다.

**배정** — AI, 사람이 정한 뒤. 배정하고 60초 안에 그 에이전트가 `wook seat claim`을 하지 않으면 자리가 '응답 없음'이 됩니다. 그 에이전트가 곧바로 자리를 잡을 수 있을 때 칩니다(ID는 등록에서 받은 것):

```sh
scripts/wook-server seat assign external:X-0001 --data-dir "$HOME/wook-data"
scripts/wook-server seat status --data-dir "$HOME/wook-data"
```

나와야 하는 것: `메인 자리를 <이름>에게 넘겼습니다 (세대 1 → 2, 운영자 배정). …`, 그리고 `seat status`의 `보유자  <이름> (세대 2, <시각>부터)`. L10을 하지 않았을 때의 `seat status`는 `보유자  Claude CLI (세대 1, <시각>부터)`, `상태  앉아 있음`, `응답  응답함`입니다.

## L11. 대표의 첫 로그인 — [사람: 휴대폰]

**[사람]** (verify — 실제 구글 로그인과 휴대폰이 필요합니다): 대표가 휴대폰의 Tailscale 앱을 켜고, 휴대폰 브라우저로 `https://<서버 PC 이름>.<tailnet>.ts.net`을 엽니다. 로그인 화면의 코드를 google.com/device에 넣고 대표 메일의 구글 계정으로 승인합니다. **그 화면에서 시작한 코드만 넣습니다.** 서버 PC의 브라우저에서는 대표로 로그인하지 않습니다.

확인 — AI:

```sh
scripts/wook-server config show --data-dir "$HOME/wook-data"
```

나와야 하는 것: `대표 계정` 줄이 `구글 계정 등록됨`(로그인 전에는 `아직 등록 전 — …`), `기기 세션` 줄의 수가 1 늚.

멈춤: 휴대폰에서 주소가 열리지 않음(휴대폰의 Tailscale이 켜졌는지, `tailscale serve status`에 그 주소가 있는지), 403(휴대폰의 Tailscale 계정이 `owner.tailscaleLogins`에 있는지), 구글이 로그인을 막음(L5의 테스트 사용자), `invalid_client`(클라이언트 종류가 'TV 및 입력 제한 기기'인지). [TROUBLESHOOT.md](TROUBLESHOOT.md)의 'Tailscale과 대표 로그인'.

## L12. 마지막 점검과 다시 시작

점검 — AI:

```sh
scripts/wook-server check --data-dir "$HOME/wook-data"
```

나와야 하는 것: 마지막 줄이 `결과: … 실패 0 …`이고 경고가 없습니다. 남은 경고는 [TROUBLESHOOT.md](TROUBLESHOOT.md)로 고치거나, 고칠 수 없으면(쓰지 않는 CLI 등) 까닭과 함께 보고합니다.

**[사람]** `sudo reboot`으로 다시 시작합니다 (verify). 당신의 세션도 함께 끝납니다. 그다음 **로그인하지 않은 채** 다른 기기에서 차례로 봅니다 — 2·4·5는 사람이 SSH로 들어가 당신을 다시 띄우면 당신이 봅니다:

1. 휴대폰 브라우저로 공개 주소가 열립니다(linger와 유닛).
2. `scripts/wook-server status --data-dir "$HOME/wook-data"`가 L4와 같은 꼴이고, `systemctl --user status "$unit"`이 `active (running)`입니다(`$unit`은 같은 호출에서 L8의 `unit=$(…)` 줄로 먼저 정합니다).
3. 대표의 휴대폰은 다시 로그인하지 않아도 화면이 열립니다(기기 세션은 쓰지 않고 14일, 최대 90일).
4. `config show`의 `구글 보안 비밀` 줄이 여전히 `등록됨 (데이터 폴더의 비밀 값 파일)`입니다.
5. 화면 조작을 켰으면 `status`의 `화면 조작` 줄이 `화면 조작을 쓸 수 있습니다 (…)`입니다.

설치를 마치면 사람에게 단계별 결과, verify 줄의 실제 결과, 남은 경고, 사람이 할 남은 일을 한 번에 보고합니다.

## L13. 되돌리기

지우는 일이므로 하기 전에 사람에게 묻습니다. 구글 보안 비밀만 지우려면 서버가 도는 동안 지웁니다(`secret clear`는 실행 중인 서버에 보내는 명령입니다):

```sh
scripts/wook-server secret clear google-client-secret --data-dir "$HOME/wook-data"
```

나와야 하는 것: `구글 로그인 보안 비밀을 지웠습니다. 다시 넣기 전까지 기기 코드 로그인을 시작할 수 없습니다.`

서버를 끄고 유닛을 지웁니다. 먼저 무엇을 지울지 봅니다:

```sh
scripts/wook-server uninstall-task --dry-run --data-dir "$HOME/wook-data"
scripts/wook-server shutdown --data-dir "$HOME/wook-data"
scripts/wook-server uninstall-task --data-dir "$HOME/wook-data"
tailscale serve --https=443 off
```

- `uninstall-task`는 유닛만 지우고 실행 중인 서버는 끄지 않습니다 — 그래서 `shutdown`을 먼저 합니다. 같은 데이터 폴더를 가리키는 다른 이름의 유닛이 있으면 그것도 지웁니다.
- 끝 코드: 유닛이 없으면 `등록된 유닛이 없습니다 (…) — 바꾼 것이 없습니다`로 0, 유닛이 있는지 읽지 못하거나 다른 자리에 같은 이름의 유닛이 있으면 아무것도 지우지 않고 1입니다. 지웠을 때의 글(`사용자 유닛 … 을 지웠습니다. …`)과 `tailscale serve … off`는 verify입니다.
- 화면 조작의 두 유닛 (verify): `systemctl --user disable --now wook-openbox.service wook-xvfb.service`, `rm ~/.config/systemd/user/wook-openbox.service ~/.config/systemd/user/wook-xvfb.service ~/.wook-xvfb.auth`, `systemctl --user daemon-reload`.
- **[사람: sudo 암호]** (verify): linger 끄기 `sudo loginctl disable-linger "$(id -un)"`, 절전 대상 풀기 `sudo systemctl unmask sleep.target suspend.target hibernate.target hybrid-sleep.target`.
- 데이터 폴더(`~/wook-data` — 비밀 값 파일이 그 안에 있습니다)와 작업 폴더(`~/wook-workspace`), 앱 폴더는 지우지 않으면 남습니다. 지우는 것은 사람이 정하고 사람이 합니다.
