# 문제 해결

증상 → 까닭 → 할 일을 모았습니다. 원본은 [../SERVER_SETUP.md](../SERVER_SETUP.md)의 `## 부록 D. 문제 해결 — Linux check 항목과 시작 거부`와 [../KNOWN_ISSUES.md](../KNOWN_ISSUES.md)의 `## Linux 서버의 한계`입니다. 아래의 따옴표 안 글은 서버·점검이 내는 글이고, `…`은 줄인 곳입니다. 고치기 전에 [../../AGENTS.md](../../AGENTS.md)의 '꼭 지킬 것'을 다시 봅니다. `[사람]`이 붙은 할 일은 사람에게 넘깁니다.

## 먼저 볼 것

한 호출로 칩니다(앱 폴더에서):

```sh
scripts/wook-server status --data-dir "$HOME/wook-data"
scripts/wook-server check --data-dir "$HOME/wook-data"
unit=$(scripts/wook-server install-task --dry-run --json --data-dir "$HOME/wook-data" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.name')
systemctl --user status "$unit"
journalctl --user -u "$unit" --no-pager -n 20
```

그리고 `<데이터 폴더>/logs/server.log`(시작·운영자 명령·배포 점검 요약)와 `backend.log`(업무)의 끝을 읽습니다. 기록 파일은 읽기만 합니다.

## 서버가 시작하지 않을 때

서버는 아래를 **데이터 폴더를 만들거나 잠그기 전에** 보고, 걸리면 `욱채 서버를 시작하지 못했습니다: <글>`을 내고 끝 코드 1로 끝납니다. 유닛이면 그 줄이 `journalctl --user -u "$unit"`에 남고, systemd가 60초 뒤 다시 띄우기를 되풀이합니다(10분에 4번까지).

| 글 | 까닭 | 할 일 |
|---|---|---|
| `root(uid 0)로는 서버를 띄우지 않습니다 — 로그인한 사용자 계정으로 띄우세요 …` | root의 셸 | 보통 사용자로 띄웁니다. 사용자가 없으면 **[사람]** `sudo adduser <이름>` (INSTALL.md L0) |
| `/proc를 읽지 못합니다 — 욱채 서버는 Linux에서 /proc로 프로세스를 확인합니다 …`, 또는 `/proc/self/stat`·`/proc/sys/kernel/random/boot_id`·`/proc/stat`의 `btime`을 읽지 못한다는 글 | `/proc`이 없거나 막힘(컨테이너, `hidepid`) | 보통의 Linux PC·VM에서 띄웁니다. 멈추고 보고합니다 |
| `데이터 폴더의 경로가 길어 관리 소켓(<폴더>/admin.sock)을 만들 수 없습니다 — …바이트로 Linux의 한도 107바이트를 넘습니다. …` | 데이터 폴더의 경로가 96바이트를 넘음(UTF-8, 한글은 3바이트) | 짧은 데이터 폴더를 씁니다. 모든 명령의 `--data-dir`이 바뀌므로 사람에게 묻습니다 |
| `데이터 폴더를 준비하지 못했습니다 (<폴더>) — 데이터 폴더가 링크인데 가리키는 곳이 없습니다 (링크 → <적힌 곳>) — …` | 링크가 가리키는 디스크가 붙지 않았거나 폴더가 없음 | 디스크를 붙이는(mount) 일은 **[사람]**. 링크를 고칠지는 사람에게 묻습니다 |
| `… 링크가 고리를 이뤄 폴더에 닿지 않습니다 …`, `… 데이터 폴더 경로의 위 폴더(<위 폴더>)가 링크인데 가리키는 곳이 없습니다 …`, `… 위 폴더 자리(<위 폴더>)에 폴더가 아닌 것이 있습니다 …` | 링크 고리, 위 폴더의 끊긴 링크, 경로 중간의 파일 | `ls -l <폴더>`로 보고 사람에게 묻습니다 |
| `비밀 값 폴더(<폴더>/secrets)의 권한이 넓습니다 (755) — 그룹·다른 사용자가 열 수 있습니다. 고치기: chmod 700 '<폴더>/secrets'` (값 파일이면 `chmod 600 '<폴더>/secrets/<64자>.json'`) | 비밀 값 폴더나 파일의 권한이 넓음 | 그 `chmod` 줄을 그대로 칩니다(AI). 그 뒤 서버를 띄웁니다 |
| `… 주인이 이 사용자(uid <n>)가 아닙니다 …`, `… 심볼릭 링크입니다 …` (비밀 값) | 비밀 값 폴더·파일의 주인이 다르거나 링크 | 지우거나 다시 만드는 일이므로 사람에게 묻습니다 |
| `server.json의 … 모양이 아닙니다` 등 그 칸을 말하는 글 (예: `server.json의 screen.xauthority는 그 화면의 쿠키 파일의 절대 경로여야 합니다 …`, `… server.json의 screen.display는 X 화면 이름이어야 합니다 (예: ":99")`) | server.json의 그 칸이 틀림 | 그 칸만 고칩니다(INSTALL.md L4·L9의 블록) |
| `--owner-email: 대표 이메일 모양이 아닙니다` (끝 코드 2) | 서버 인자가 틀림 | 인자를 고칩니다. 보통은 server.json의 `owner.email`을 씁니다 |
| `--web-dir 폴더가 서버용 웹 화면이 아닙니다: …` (끝 코드 1) | 서버용 웹 빌드가 아닌 폴더 | 앱 폴더에서 `--web-dir out/web`을 줬는지 봅니다. 맞는데도 나면 묶음이 깨졌습니다 — 빌드하지 않고 보고합니다 |
| 작업 폴더 위치가 데이터 폴더나 등록된 프로젝트 폴더와 겹친다는 글 (끝 코드 1) | `workspaceRoot` 아래 `main`이 그 폴더와 같거나 안이거나 품음 | `workspaceRoot`를 고칩니다(절대 경로). 사람에게 묻습니다 |
| `이 데이터 폴더는 이미 다른 욱채(서버, pid <pid>)가 쓰고 있습니다` | 같은 데이터 폴더로 도는 서버가 있음(설정용 서버와 유닛을 함께 띄움 등) | `status`로 그 서버를 봅니다. 두 번째를 띄우지 않습니다. `server.lock`을 지우지 않습니다 — 죽은 서버의 잠금은 다음 시작이 스스로 치웁니다 |
| `이 데이터는 실행 중인 욱채(…)가 쓰고 있는 데이터입니다(복사본이거나 잠금 파일이 지워짐) — 그 욱채를 끝낸 뒤 다시 시작하세요` (끝 코드 1) | 다른 곳에서 도는 욱채의 데이터를 복사한 폴더이거나 잠금 파일이 지워짐 | 멈추고 사람에게 보고합니다 |
| 포트를 다른 프로그램이 씀 | 7317을 다른 프로그램이 씀 | 그 프로그램을 끌지, `--port <번호>`(서버를 띄우는 줄과 `install-task`, `tailscale serve`도 그 번호)를 쓸지 사람에게 묻습니다. 그때의 글은 원본에 없습니다 |

## 운영자 명령이 안 될 때

| 증상 | 할 일 |
|---|---|
| `이 데이터 폴더(…)로 실행 중인 욱채 서버가 없습니다 (server.lock 없음)` (끝 코드 1) | 서버가 떠 있는지(`systemctl --user status "$unit"`), `--data-dir`이 서버와 같은지 봅니다 |
| `--port`를 붙여 거부됨 | 운영자 명령에는 `--port`를 붙이지 않습니다(데이터 폴더로 서버를 찾습니다) |
| `scripts/wook-server: Permission denied` | `sh scripts/wook-server …`로 칩니다. 묶음의 실행 권한이 빠졌다고 보고합니다 |
| `node: command not found`, 또는 `node --version`이 `v18…` | 같은 호출의 맨 앞에 `. ~/.profile`. `command -v node`가 `/usr/bin/node`면 `~/.profile`의 PATH 줄이 맨 앞에 오는지 봅니다 |
| `알 수 없는 명령입니다: … (뒤의 낱말은 값일 수 있어 보이지 않습니다)` | 명령을 잘못 쳤습니다. `scripts/wook-server --help`로 꼴을 봅니다 |
| 비밀 값을 명령 줄에 붙였음 | 그 값은 쓰이지 않습니다. **[사람]** `history -d <번호>`로 셸 기록의 줄을 지우고(`~/.bash_history`에도), 구글 클라우드 콘솔에서 보안 비밀을 새로 만들어 `secret set`으로 넣습니다 |

## `check` 항목

`check`의 줄은 `통과`·`경고`·`실패`·`건너뜀`이고, 경고·실패 밑의 `할 일:`이 고칠 길입니다. `wook-server …` 고칠 줄은 `scripts/wook-server …`로 바꿔 그대로 칩니다. 고친 뒤 `check`를 다시 합니다. 괄호 안은 `--json`의 id입니다.

| 항목 | 이런 글이면 | 할 일 |
|---|---|---|
| 실행 사용자 (`user`) | 실패 `root(uid 0)로 돕니다` / 경고 `시스템 계정(<이름>, uid <n>)으로 돕니다` | 서버를 돌릴 로그인 사용자로, sudo 없이 다시 점검합니다 |
| /proc (`proc`) | 실패 `/proc를 읽지 못합니다 …` | 보통의 Linux에서 돌립니다(컨테이너는 지원하지 않음) |
| procps (`procps`) | 경고 `ps·pgrep이 PATH에 없습니다 — …` | **[사람]** `sudo apt install procps` |
| Node (`node`) | 실패 `Node <판> — 24 이상이어야 합니다 (node:sqlite)` | INSTALL.md L1의 Node 블록, 그다음 `install-task`를 다시(유닛이 Node의 절대 경로를 적어 둠) |
| systemd 유닛 (`unit`) | 경고 `등록된 유닛이 없습니다 (wook-server-<8자>.service)` | INSTALL.md L8 |
| | 경고 `이 데이터 폴더의 유닛이 다른 이름으로 등록돼 있습니다 (<이름>) — …` / `같은 데이터 폴더의 유닛이 다른 이름으로도 있습니다 (<이름>) — 부팅하면 서버 둘이 같은 폴더로 뜨려 합니다` | `할 일:`에 나온 두 줄(`uninstall-task` 다음 `install-task`)을 옵션까지 그대로, 명령 이름만 `scripts/wook-server`로 바꿔 칩니다(verify — 원본은 이 경우를 가짜 systemd로만 시험) |
| | 경고 `사용자 systemd에 닿지 못해 유닛을 보지 못했습니다 (…)` | `sudo -u`·`su` 셸입니다. 사람에게 직접 로그인한 셸에서 당신을 띄워 달라고 합니다 |
| | 경고 `Node가 지금 것과 다릅니다` / `서버 진입점이 지금 것과 다릅니다` / `데이터 폴더가 지금 것과 다릅니다` / `install-task가 쓰지 않는 인자가 있습니다 (…)` / `ExecStart=가 <n>개입니다` / `install-task가 쓴 파일이 아닙니다(첫 줄이 다릅니다)` / `덧붙인 설정(drop-in)이 있습니다 (…)` / `켜져(enable) 있지 않습니다` / `KillMode가 <값>입니다` / `systemd가 읽는 유닛이 install-task의 자리가 아닙니다` | `할 일:`의 `다시 등록하세요 (같은 이름을 바꿔 넣습니다): wook-server install-task …`를 그대로 칩니다(지금 유닛의 `--port`·`--public-origin` 등을 옮겨 적어 줍니다). drop-in이면 누가 만든 것이므로 그 파일을 지울지 사람에게 먼저 묻습니다 |
| | 실패 `--allow-test-session으로 띄웁니다 — 시험용 세션 발급이 켜집니다` | 누가 유닛을 손으로 바꿨습니다. 사람에게 알리고 `uninstall-task` 뒤 `install-task` |
| linger (`linger`) | 경고 `꺼져 있습니다 — 부팅한 뒤 <사용자>로 로그인하기 전에는 서버가 뜨지 않습니다` | **[사람]** `sudo loginctl enable-linger <사용자>` |
| 데이터 폴더 (`dataDir`) | 경고 `그룹·다른 사용자도 열 수 있습니다 (755)` | `할 일:`의 `chmod 700 <폴더>`(AI). 링크면 그 줄이 실제 폴더를 적습니다 |
| | 경고 `주인이 이 사용자가 아닙니다 (uid <n>)` | **[사람]** `할 일:`의 `sudo chown -R <사용자>: <폴더>` |
| | 건너뜀 `데이터 폴더가 아직 없습니다 (…) — …` | INSTALL.md L4 |
| | 실패 `<폴더>: 데이터 폴더가 링크인데 가리키는 곳이 없습니다 …` / `… 링크가 고리를 이뤄 폴더에 닿지 않습니다 …` / 위 폴더의 같은 글 | 위 '서버가 시작하지 않을 때'의 같은 줄 |
| 비밀 값 저장소 (`secrets`) | 실패 `비밀 값 폴더(…)의 권한이 넓습니다 …` / `비밀 값 파일(…)의 권한이 넓습니다 …` (그 글에 `chmod` 줄) | 그 `chmod` 줄을 칩니다(AI). 주인이 다르거나 링크면 사람에게 묻습니다 |
| | 경고 `비밀 값이 OS 키링에 있습니다 …` / 실패 `비밀 값이 메모리에 있습니다 …` | 서버를 다시 시작합니다(Linux의 서버는 파일 저장소를 씁니다). 메모리였다면 **[사람]**이 비밀 값을 다시 넣습니다 |
| 절전 (`sleep`) | 경고 `절전 대상이 막혀 있지 않습니다 (…)` | **[사람]** `sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target` |
| | 건너뜀 `절전 대상을 읽지 못했습니다 (…)` | `systemctl show -p Id -p LoadState sleep.target`을 쳐 보고 보고합니다 |
| 절전 방지 (`power`) | 경고 `작업 중 절전 막기를 쓸 수 없습니다 — systemd-inhibit: Failed to inhibit: Access denied` / `systemd-inhibit이 PATH에 없습니다 — …` | 절전 대상을 막아 둡니다(위). 막아 두면 이 항목은 통과입니다 |
| | 건너뜀 `서버가 돌지 않아 절전 방지 상태를 보지 못했습니다` | 서버를 띄운 뒤 다시 |
| Claude CLI·Codex CLI (`cli.claude`·`cli.codex`) | 경고 `찾지 못했습니다 — 이 AI를 쓰지 않으면 괜찮습니다` / `로그인돼 있지 않습니다 …` | INSTALL.md L1의 `npm i -g …` 뒤 L3(로그인은 **[사람]**). CLI는 유닛의 PATH로 찾으므로 설치한 뒤 `install-task`를 다시 합니다. API 키 방식이면 **[사람]** `secret set claude-api-key`·`codex-api-key` |
| 유닛의 PATH (`path`) | 경고 `이 셸에서 찾은 <이름>(<자리>)이 유닛의 PATH 밖에 있습니다 — 서버(유닛)는 그것을 찾지 못합니다` | 그 PATH가 있는 셸(`. ~/.profile` 뒤)에서 `install-task`를 다시 합니다 |
| | 건너뜀 `유닛이 없거나 PATH를 적지 않아 견주지 못했습니다` | INSTALL.md L8 뒤 다시 |
| API 키 환경 변수 (`apikey-env`) | 경고 `구독 방식인데 API 키 환경 변수가 있습니다: ANTHROPIC_API_KEY(이 셸·사용자 관리자·유닛) …` (값은 읽지 않음) | 구독이면 `~/.profile`·`~/.bashrc`·`~/.config/environment.d`의 그 줄을 지울지 사람에게 묻고, 지운 뒤 `systemctl --user unset-environment <이름>`과 서버 다시 시작. API 키로 쓰려면 **[사람]** `secret set` |
| 화면 조작 (`screen`) | 경고(`screen.enabled`가 `true`면 실패) `화면 도우미에 필요한 X 도구가 없습니다: … — 서버 PC의 운영자가 설치해야 합니다 (sudo apt install …)` | 화면 조작을 쓰면 **[사람]** INSTALL.md L9의 꾸러미. 쓰지 않으면 server.json `"screen": { "enabled": false }` 뒤 다시 시작 |
| | 경고 `화면 없음 — …` / `Wayland: …` / `화면(서버): …` / 세션 버스 / `typeWithoutA11y` | 아래 '화면 조작' |
| | 건너뜀 `서버가 돌지 않아 …` | 서버를 띄운 뒤 다시 |
| 관리 채널 (`adminSocket`) | 경고 `관리 채널이 소켓 파일이 아닙니다 (…)` | 서버를 다시 시작합니다 |
| | 건너뜀 `서버가 돌지 않아 관리 채널을 보지 못했습니다` | 서버를 띄운 뒤 다시 |
| Tailscale (`tailscale`) | 경고 `Tailscale이 없습니다` / `tailscale status를 읽지 못했습니다 …` / `Tailscale이 돌고 있지 않습니다 (…)` | **[사람]** INSTALL.md L6 |
| | 경고 `tailscale status가 4초 안에 끝나지 않았습니다 — tailscaled가 멈췄을 수 있습니다` | **[사람]** `sudo systemctl restart tailscaled` |
| | 실패 `tailscale funnel이 켜져 있습니다 — 인터넷 전체에 열립니다` | `tailscale funnel --https=443 off`를 곧바로 치고 사람에게 알립니다 |
| | 경고 `tailnet의 HTTPS 인증서가 꺼져 있습니다` | **[사람]** 관리 콘솔에서 HTTPS Certificates를 켭니다 |
| | 경고 `이 서버(포트 7317)로 넘기는 tailscale serve 항목이 없습니다` | `tailscale serve --bg 7317`, 공개 주소 블록, `config reload` (INSTALL.md L6) |
| | 경고 `같은 이름에 다른 항목이 있습니다: …` | 그 이름에는 욱채만 둡니다. 다른 서비스를 어디로 옮길지 사람에게 묻습니다. `tailscale serve reset`은 치지 않습니다 |

## 유닛

| 증상 | 할 일 |
|---|---|
| `install-task`가 `로그인한 사용자 계정으로 실행해야 합니다 — root로는 사용자 유닛을 등록하지 않습니다 …` | INSTALL.md L0 |
| `install-task`가 `이 사용자의 systemd(사용자 관리자)에 닿지 못했습니다 — …` | `sudo -u`·`su` 셸입니다. 직접 로그인한 셸(SSH 포함)에서 |
| `install-task`가 `Node 실행 파일 경로(…)에 systemd가 실행 파일 이름으로 받지 않는 글자(" ' \ $)가 있습니다 — …` | 그런 글자가 없는 폴더에 Node를 둡니다(INSTALL.md L1) |
| `install-task`가 `서버 진입점이 없습니다` | 묶음이 깨졌습니다. 빌드하지 않고 보고합니다 |
| `등록한 유닛이 쓴 것과 다릅니다 (…)` (끝 코드 1) | 괄호 안이 다른 칸입니다. `덧붙인 설정(drop-in: …)`이면 누가 `systemctl --user edit`로 덧붙인 것 — 그 파일을 지울지 사람에게 묻고, 지운 뒤 `install-task`를 다시. 그 밖에는 `systemctl --user cat "$unit"`으로 보고 `install-task`를 다시 |
| 유닛을 띄웠는데 `status`가 `실행 중인 욱채 서버가 없습니다` | `systemctl --user status "$unit"`, `journalctl --user -u "$unit"`의 끝, `logs/server.log`를 봅니다. 시작 거부 줄이 있으면 위 '서버가 시작하지 않을 때' |
| 다시 시작한 뒤 서버가 뜨지 않음 | linger를 봅니다: `loginctl show-user "$(id -un)" -p Linger`가 `Linger=yes`인지. 아니면 **[사람]** `sudo loginctl enable-linger "$(id -un)"` |
| 유닛의 서버가 CLI를 찾지 못함 | `check`의 `유닛의 PATH`와 CLI 항목. 고친 PATH로 `install-task`를 다시 하고 다시 띄웁니다 |
| `~/.config/environment.d`의 `CLAUDE_CODE_OAUTH_TOKEN`이 듣지 않는 듯함 | 사용자 관리자가 언제 그 폴더를 다시 읽는지(다시 로그인, linger면 다시 시작)와 `claude auth status`가 그 토큰을 로그인으로 보는지는 원본이 확인하지 못했습니다(verify). 본 것을 보고합니다 |

## 화면 조작

`status`의 `화면 조작` 줄과 `check`의 `screen` 항목이 까닭을 말합니다(`check`는 서버가 돌 때 `화면(서버): <글>`).

| 글 | 까닭 | 할 일 |
|---|---|---|
| `화면 없음 — 서버에 X 화면이 없습니다(DISPLAY 없음, server.json의 screen.display 없음). …` | 유닛의 서버에는 `DISPLAY`가 없음 | INSTALL.md L9의 Xvfb와 server.json `screen.display`·`screen.xauthority` 뒤 다시 시작. `check`의 `할 일:`이 이 사용자의 집 폴더로 쓴 절대 경로를 보여 줍니다 |
| `화면 없음 — 서버의 DISPLAY가 다른 기계의 화면을 가리킵니다(ssh -X 등). …` | `ssh -X`의 `DISPLAY`(`localhost:10.0`) | 같습니다 — 이 기계의 화면(`:99`)만 씁니다 |
| `Wayland: X11 세션이나 Xvfb가 필요합니다 — …` | Wayland(Xwayland 포함)는 쓸 수 없음 | Xvfb를 씁니다(L9) |
| `화면의 X 서버가 추상 소켓 이름(@/tmp/.X11-unix/X<번호>)을 쥐고 있지 않습니다 — …` (`noabstract`) | `-nolisten local`로 띄운 Xvfb | `-nolisten local` 없이(`-auth`·`-nolisten tcp`는 둔 채) Xvfb를 다시 띄우고 서버를 다시 시작 |
| `화면의 이름(추상 소켓)을 쥔 프로세스가 소켓 파일의 X 서버와 다릅니다 — …` (`foreign`) | 다른 프로그램이 그 화면의 이름을 가로챘을 수 있음. `-displayfd`로 띄운 둘째 X 서버가 소켓 파일을 차지한 경우도 이렇게 보입니다 | 멈추고 사람에게 보고합니다. 그 X 서버를 다시 시작할지는 사람이 정합니다 |
| `화면의 X 서버가 서버와 다른 사용자의 것입니다 — …` (`otheruser`) | 다른 사용자가 띄운 X 서버 | 서버를 돌리는 사용자로 Xvfb를 띄웁니다(L9의 사용자 유닛) |
| `화면의 X 서버가 누구인지 확인하지 못해(python3 확인 실패) 쓰지 않았습니다 — …` (`unverified`) | python3가 없음 | **[사람]** L9의 꾸러미(python3) 뒤 서버를 다시 시작 |
| `세션 버스(DBUS_SESSION_BUS_ADDRESS)가 없어 AT-SPI로 암호 칸을 가를 수 없습니다 — 글자 입력(type)은 막힙니다` | 서버의 환경에 사용자 세션 버스가 없음 | **[사람]** `dbus-user-session`(L1), 서버는 유닛으로 띄웁니다 |
| `server.json screen.typeWithoutA11y가 켜져 있습니다 …` | 운영자가 켬 | 일부러 켰으면 그대로. 아니면 server.json에서 지우고 다시 시작 |

알려진 한계(고치는 일이 아니라 알고 쓰는 것):

- **글자 입력이 막힘(`secret_blocked`)**: 어떤 칸인지 가르지 못한 칸(GTK 4의 한 줄 입력 칸은 늘 그렇습니다)과 암호 칸에는 `type`과 글자 키를 보내지 않습니다. `typeWithoutA11y: true`는 `type`만 풉니다. Qt 프로그램은 `QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1`, Chromium·Electron은 `--force-renderer-accessibility`로 띄워야 접근성을 내놓습니다(verify). 터미널의 비밀번호 묻기는 알아보지 못합니다.
- **멈춤**: 처음 30초(Xvfb·openbox가 막 뜬 뒤), 그리고 사람(이나 다른 프로그램)이 그 화면에서 계속 움직이거나 치면 `human_active`로 30초 멈춥니다. 한 걸음 안의 짧은 입력 한 번은 보지 못할 수 있습니다.
- **Xvfb를 다시 띄운 뒤 `type`이 막힘**: 곁 도우미가 옛 X 서버와 함께 끝나, 도우미가 다시 뜰 때까지 암호 칸을 가르지 못합니다. 대표의 정지 → 해제나 서버 다시 시작으로 되살립니다(추론 — 원본도 보지 못함).
- **받지 않는 입력**: 가운데 단추 클릭, super+l, ctrl+alt+l, ctrl+alt+backspace, ctrl+alt+F1~F12, ctrl+alt+escape, ctrl+alt+delete.
- **주인을 모르는 창(`unowned`)**: 메뉴·팝업처럼 관리되지 않는 창은 그 프로세스나 주인 창으로 판단하고, 모르면 거부합니다.
- **격리가 아님**: X11은 같은 화면의 프로그램끼리 막지 않습니다. 그 화면에는 메인 에이전트가 쓸 프로그램만 띄웁니다. 입력기(ibus·fcitx)는 시험하지 않았으니 켜지 않습니다.
- **실제 X 데스크톱**: 곁 도우미(python3-xlib)가 멈춤 단축키(Ctrl+Alt+Shift+F12)와 주황 테두리를 맡아야 입력을 받습니다. 잠금은 X 화면 보호기 상태로만 압니다(verify).

## 절전

- `status`의 `절전 방지     unavailable — systemd-inhibit: Failed to inhibit: Access denied (작업 중에도 PC가 절전에 들 수 있습니다)` → polkit이 활성 로컬 세션 밖(유닛, SSH)의 막기를 거부한 것입니다. 서버를 다시 시작할 때까지 다시 해 보지 않습니다. **[사람]** 절전 대상을 막아 두면(INSTALL.md L7) 해가 없습니다. 데스크톱 세션의 polkit이 이 막기를 내주는지는 원본이 확인하지 못했습니다(verify).

## Tailscale과 대표 로그인

| 증상 | 할 일 |
|---|---|
| 휴대폰에서 주소가 열리지 않음 | 휴대폰의 Tailscale이 켜졌는지(사람), `tailscale serve status`에 그 주소가 있는지(AI), 서버가 도는지(`status`) |
| 로그인 화면도 열리지 않고 403 | 휴대폰의 Tailscale 계정이 server.json의 `owner.tailscaleLogins`에 있는지. 없으면 더하고 `config reload`(OPERATE.md '설정') |
| `구글이 이 클라이언트 ID로 기기 코드를 내주지 않았습니다 (invalid_client) — …` (또는 `unauthorized_client`) | 클라이언트 종류가 'TV 및 입력 제한 기기'가 아닙니다. **[사람]** 구글 클라우드 콘솔에서 바로 만들고, AI가 `config google-client-id`, 사람이 `secret set` |
| 구글이 로그인을 막음 | **[사람]** OAuth 동의 화면의 테스트 사용자에 대표의 구글 계정을 넣습니다 |
| `이 PC 안의 주소로는 브라우저 로그인을 받지 않습니다 … 공개 주소(…)로 여세요.` | 브라우저 로그인은 공개 주소(`https://…ts.net`)에서만 받습니다 |
| `요청 머리글이 너무 커서 읽지 못했습니다. …` (431) | 그 브라우저에 `<tailnet>.ts.net`의 쿠키가 너무 많이 쌓였습니다. **[사람]** 브라우저에서 그 사이트의 쿠키를 지우고 다시 로그인 |
| `대표 이메일은 맞지만 이 서버에는 다른 이메일의 구글 계정이 대표로 등록되어 있습니다 — …` / `대표 이메일은 맞지만 처음 등록한 구글 계정이 아닙니다 — …` | 같은 데이터 폴더를 다른 곳에서 쓰다 다른 계정이 등록된 경우입니다. 같은 대표 이메일로 `config owner-email <대표 이메일>`을 다시 하면 그 등록을 지우고 기기 세션도 끊깁니다 — 사람이 정할 때만 |

## 메인 자리

- **응답 없음**: 메인 턴이 사용량 한도·재로그인 필요·시작 실패로 연달아 3번 끝나거나, 메인 일이 쌓였는데 그 CLI를 쓸 수 없으면 서버가 '응답 없음'으로 표시합니다. 서버는 다른 AI로 바꾸지 않습니다. CLI 로그인(`check`의 CLI 항목)을 보고 보고합니다. 다른 보유자로 넘길지(`seat assign`)는 사람이 정합니다.
- **`seat assign`이 끝 코드 1로 멈추고 메인 에이전트가 일시정지됨**: 나가는 메인 턴의 종료를 확인하지 못한 것입니다. 두 메인이 겹쳐 돌지 않게 새 보유자를 앉히지 않습니다. 남은 CLI 프로세스를 `ps -eo pid,pgid,cmd`로 찾아 사람에게 보고합니다. 남은 것이 모두 사라진 뒤 **대표가 화면에서 '정지 해제'**를 누르면 이어 갑니다. 그동안의 `seat assign`은 `--force`여도 받지 않습니다.
- **외부 에이전트가 자리를 잡지 않음**: 배정한 뒤 60초 안에 `wook seat claim`이 없거나 60초 동안 heartbeat가 없으면 '응답 없음'입니다. 에이전트를 다시 띄우거나 `seat assign launched:claude`(사람이 정함). 에이전트 쪽 끝 코드별 할 일은 [../AGENT_GUIDE.md](../AGENT_GUIDE.md)의 `## 10. 문제가 생기면 — 끝 코드별`.
- **`seat assign`이 다른 종류의 CLI를 거부함**: 그 CLI가 이 사용자로 설치·로그인돼 있지 않습니다. 로그인(사람) 뒤 서버를 다시 시작하면 시작할 때 다시 확인합니다.

## 정지 뒤에 남은 프로세스

- **무엇**: Linux의 정지는 그 실행의 프로세스 그룹과, `/proc`에서 찾은 그 실행의 후손(실행 표시 `WOOK_RUN_TAG`를 가졌거나 살아 있는 부모로 이어진 것)을 끝냅니다. 표시를 지운 것(`env -i`, `env_reset`의 `sudo`), 프로세스 제목을 덮어쓴 것(nginx·PostgreSQL·Redis 등), 스스로 데몬이 되어 부모가 먼저 끝난 것, `systemd --user`·D-Bus·컨테이너 런타임이 띄운 것은 남을 수 있고, 그래도 정지가 '종료 확인'이라고 말할 수 있습니다. 환경을 읽지 못하고 이어진 데가 없는 후손은 끝내지 않고 서버 기록에 이름만 적습니다.
- **유닛이면**: 서버가 끝날 때(`shutdown`이나 `systemctl --user stop`) `KillMode=mixed`가 유닛 cgroup의 남은 것을 모두 끝냅니다. 그 cgroup 밖의 것(제 scope에 든 tmux 창, `systemd-run --scope`로 띄운 자식)은 남을 수 있습니다. 손으로 띄운 서버는 이 정리가 없습니다 — 서버는 유닛으로 띄웁니다.
- **찾기**: `ps -eo pid,pgid,cmd`로 남은 CLI 후손을 봅니다. 재시작 복구 알림에 적힌 그룹은 `pgrep -a -g <번호>`로 봅니다. 서버 기록(`logs/`)의 '정지: …'·'CLI가 끝난 뒤 …' 경고에 PID가 있습니다.
- **얼린 채 남은 것**: 정지가 SIGSTOP으로 얼린 직후 서버가 죽으면 그 프로세스가 멈춘 채(`/proc`의 상태 T) 남을 수 있습니다. `kill -CONT <pid>`나 `kill -KILL <pid>`를 보낼 때까지 멈춰 있습니다(추론).
- **끝내기**: 찾은 목록을 사람에게 보고하고, 욱채 서버의 실행에서 나온 것으로 확인된 것만 끝냅니다. 서버 자신과 다른 프로그램은 건드리지 않습니다.

## 시계, WSL, 컨테이너, 그 밖의 한계

- **시계**: 서버의 기록 시각은 10초 이하의 되돌림에는 뒤로 가지 않고, 그보다 큰 되돌림은 따라갑니다(그 앞뒤 기록의 차례가 바뀔 수 있음). 서버가 꺼진 동안 시계가 뒤로 가면 새 시각이 옛 시각보다 앞설 수 있습니다. 서버는 NTP가 시계를 천천히 맞추는 PC에 둡니다. 큰 바로잡기는 부팅 때, VM을 되살릴 때, 손으로 날짜를 바꿀 때 생깁니다.
- **WSL2**: 시험하는 곳이지 서버 자리가 아닙니다. 벽시계가 약 30초마다 0.5초쯤 뒤로 갑니다. 손으로 띄운 서버의 cgroup은 `wsl.exe`로 띄운 모든 것과 나뉘지 않습니다.
- **컨테이너**: 지원하지 않습니다. PID 이름 공간이 다르면 실행 잠금이 서로를 보지 못해 같은 데이터 폴더를 둘이 열 수 있고, init이 없으면 정지가 늘 남은 프로세스를 말합니다.
- **eCryptfs 집 폴더**: 파일 이름이 143바이트까지라 긴 이름이 실패할 수 있습니다. 데이터 폴더를 그 밖에 둡니다.
- **프로젝트 등록이 거부됨**: 저장소 안의 심볼릭 링크가 막는 자리(앱 데이터, 다른 프로젝트 등)를 가리키면 등록을 거부합니다(Linux에서는 지나친 거부 — 받아들인 한계). 링크를 없애거나 다른 자리를 가리키게 합니다.
- **`/proc` 읽기가 느림**: 멈춘 FUSE·NFS 매핑에 걸린 프로세스가 있으면 정지가 느려질 수 있습니다.

## 그래도 모르면

멈추고 사람에게 보고합니다: 친 명령, 나온 글 전부(비밀 값은 `<가림>`), `check --json`의 결과, `journalctl`의 끝, 이 문서에서 맞춰 본 줄과 맞지 않은 까닭. 원본 문서의 더 자세한 글은 SERVER_SETUP 부록 D, KNOWN_ISSUES의 `## Linux 서버의 한계`, SERVER_DESIGN(크므로 낱말로 찾음)에 있습니다.
