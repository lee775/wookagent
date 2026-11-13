# systemd 없이 돌리기 — 컨테이너, 1번 프로세스가 tini인 곳

[INSTALL.md](INSTALL.md)와 [OPERATE.md](OPERATE.md)는 systemd가 도는 Ubuntu 24.04를 기준으로 썼습니다. 이 PC에 systemd가 돌지 않으면(컨테이너 등) 이 문서가 그 둘에서 **달라지는 것만** 적습니다. 나머지는 그대로이고, 규칙은 [../../AGENTS.md](../../AGENTS.md)의 '꼭 지킬 것'이 먼저입니다.

## 이 문서를 쓸 때

```sh
ps -p 1 -o comm=
test -d /run/systemd/system && echo "systemd가 돕니다" || echo "systemd가 돌지 않습니다"
cat /proc/self/cgroup
```

- 첫 줄이 `systemd`가 아니고(`tini` 등) 둘째 줄이 `systemd가 돌지 않습니다`면 이 문서를 씁니다. `systemctl` 같은 도구가 깔려 있어도 systemd가 돌지 않으면 같습니다.
- 이 배치로 갈지는 **사람이 정합니다.** 원본([../KNOWN_ISSUES.md](../KNOWN_ISSUES.md)의 '컨테이너 안의 서버는 지원하지 않음')은 서버 PC나 VM에 바로 설치하라고 합니다. 사람에게 아래 '조건'과 '없는 것'을 보여 주고 확인을 받은 뒤 진행합니다.
- 셋째 줄(`0::/` 같은 한 줄)은 보고에 적습니다. `0::`로 시작하는 줄도 `name=systemd` 줄도 없으면(systemd 계층이 없는 cgroup v1) 정지 뒤 프로세스 그룹을 떠난 후손을 끝내지 않고 '확인하지 못함'이라고 합니다 — 사람에게 알립니다.

## 조건

| 조건 | 까닭 |
|---|---|
| 1번 프로세스가 좀비를 거두는 init입니다 (`tini`, `docker run --init`) | 거두는 것이 없으면 정지마다 '남은 프로세스 있음'으로 끝납니다 |
| 데이터 폴더를 **이 컨테이너 하나만** 씁니다 | 프로세스 번호가 컨테이너마다 따로라, 다른 컨테이너나 호스트의 서버가 같은 데이터 폴더를 열어도 실행 잠금이 서로를 보지 못합니다 |
| root가 아닌 보통 사용자입니다 | 서버는 root로 시작하지 않습니다 |
| `/proc`을 읽을 수 있습니다 | INSTALL.md L0의 넷째 줄이 `/proc: 읽힘`을 내야 합니다 |

## 확인한 것과 확인하지 못한 것

2026-11-13에 개발 PC에서 같은 모양의 환경을 만들어 돌린 것입니다 — Debian 13(trixie) 공식 이미지, systemd 돌지 않음, 1번 프로세스 `tini`, uid 1000, 따로 된 프로세스·cgroup 이름 공간(`/proc/self/cgroup`이 `0::/`), Node 24.13.0.

- 이 묶음을 풀어 `check`(실패 0, 끝 코드 0), 서버 직접 띄우기, `status`, 웹 화면, `shutdown`(끝 코드 0), SIGTERM으로 정상 종료(끝 코드 0), 남은 프로세스 없음. systemd 도구가 깔려 있을 때와 아예 없을 때 둘 다.
- `install-task`는 거부합니다(끝 코드 1, 유닛 파일을 남기지 않음).
- 전체 시험 4,443개를 두 번 돌렸습니다. 이 배치 때문에 실패한 것은 시험 쪽의 가정 다섯 곳뿐이었고 시험을 고쳤습니다(서버의 동작은 맞았습니다). 그 밖에 가끔 실패한 것은 그 시험 환경의 탓(뒤로 가는 WSL 시계, 메모리에 둔 임시 폴더)이라 따로 돌리면 통과했습니다. Xvfb의 실제 화면 시험 16개 통과 — Debian 13의 Xvfb 21.1.16, xdotool, maim 5.8.0, openbox, Python 3.13.5, python3-xlib 0.33.
- 아래 '서버 띄우기'와 '화면 조작'의 줄 그대로.

확인하지 못한 것: 진짜 Docker·Podman(시스템 호출·권한을 막는 설정에 따라 다를 수 있음), systemd 계층이 없는 cgroup v1, arm64, 서버가 띄운 Claude·Codex CLI의 실제 턴. 이 PC에서 다르게 나오면 실제 출력을 보고합니다.

## 설치에서 달라지는 것 (INSTALL.md)

| 단계 | 달라지는 것 |
|---|---|
| L0 | 첫 줄은 `Debian GNU/Linux 13 (trixie)`여도 됩니다. 셋째 줄(`systemctl --user …`)은 **실패하는 것이 맞습니다** — 멈추지 않고 위 '이 문서를 쓸 때'의 세 줄을 봅니다 |
| L1 | 꾸러미 이름은 Debian 13에서도 같습니다. `dbus-user-session`은 빼도 됩니다(사용자 관리자가 없습니다). Debian 13의 `nodejs` 꾸러미는 20판이라 nodejs.org의 블록을 그대로 씁니다 |
| L4 | 그대로입니다(서버를 손으로 띄우는 단계입니다) |
| L6 | Tailscale은 이 컨테이너가 아니라 호스트나 다른 길에 있을 수 있습니다. 어떻게 들어올지는 사람이 정합니다 — 문서의 `tailscale serve` 말고 다른 길로 포트를 열지 않습니다 |
| L7 | 절전 대상 막기(`sudo systemctl mask …`)는 **건너뜁니다** — 절전은 호스트의 일입니다 |
| L8 | **건너뜁니다.** `install-task`·linger는 쓸 수 없습니다. 대신 아래 '서버 띄우기' |
| L9 | 두 사용자 유닛 대신 아래 '화면 조작'의 줄로 Xvfb와 openbox를 띄웁니다 |
| L12 | 컨테이너나 호스트를 다시 시작하면 서버·Xvfb·openbox가 스스로 뜨지 않습니다 — 아래 '없는 것' |
| L13 | `uninstall-task`·linger 끄기·절전 대상 풀기는 할 것이 없습니다 |

## 서버 띄우기와 끄기

유닛 대신 작은 시작 스크립트로 띄웁니다. 한 번만 만듭니다:

```sh
cat > ~/wook-start.sh <<'SH'
#!/bin/sh
# 욱채 서버를 띄운다. 세션 버스 아래에서 불렸으면 그 주소를 적어 둔다 — 그 화면의 프로그램이 같은 버스를 쓰게 (이 사용자만 읽음)
if [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then (umask 077 && printf '%s\n' "$DBUS_SESSION_BUS_ADDRESS" > "$HOME/.wook-session-bus"); else rm -f "$HOME/.wook-session-bus"; fi
cd "$HOME/wookagent" || exit 1
exec scripts/wook-server --data-dir "$HOME/wook-data" --web-dir out/web
SH
chmod 700 ~/wook-start.sh
```

띄우기 — 당신의 셸 도구가 끝나도 서버가 남게 새 세션으로 떼어 띄우고, 떴는지 봅니다:

```sh
setsid nohup ~/wook-start.sh >/dev/null 2>&1 &
cd ~/wookagent
scripts/wook-server status --data-dir "$HOME/wook-data"
```

- 막 띄웠으면 `status`가 1일 수 있습니다. 몇 초 뒤 다시 칩니다.
- 콘솔 출력을 버리는 까닭: 대표 이메일을 정하기 전에는 서버가 설정 코드를 콘솔에 냅니다(INSTALL.md L4). 서버가 뜨지 않으면 까닭은 `~/wook-data/logs/server.log`의 끝과, `~/wook-start.sh`를 앞에서(`setsid nohup`과 `>/dev/null 2>&1 &` 없이) 띄워 본 출력에 있습니다(설정 코드가 보이면 보고에 옮기지 않습니다).
- 포트는 스크립트의 마지막 줄에 `--port <번호>`를 붙입니다(기본 7317).
- 끄기: `scripts/wook-server shutdown --data-dir "$HOME/wook-data"` — `서버를 종료했습니다.`, 끝 코드 0. 서버에 SIGTERM을 보내도 같은 차례로 끝납니다(`logs/server.log`에 `종료 신호 받음 (SIGTERM)`, 끝 코드 0) — 서버를 컨테이너의 주 프로세스로 띄웠다면 컨테이너를 멈출 때 그렇게 끝납니다.
- 다시 띄우기: `shutdown` 뒤 위의 띄우는 줄(`setsid nohup …`). OPERATE.md의 `systemctl --user start "$unit"`·`journalctl` 줄은 쓰지 않습니다 — 기록은 `~/wook-data/logs/server.log`와 `backend.log`입니다.
- 새 묶음으로 바꾸기(OPERATE.md)는 같습니다. 6번의 '켜기'만 위의 띄우는 줄로 바꿉니다.

## 서버를 따로 만든 사용자로 돌릴 때

당신이 지금 도는 사용자와 서버를 돌릴 사용자가 다르면(당신이 root이거나, 서버용 사용자를 따로 두기로 한 때) 아래를 따릅니다.

- 서버용 사용자는 사람이 만듭니다(**[사람: sudo]** `sudo adduser <이름>` — INSTALL.md L0). root는 서버를 띄우지 못합니다.
- **모든 것을 그 사용자로 합니다**: 묶음 풀기(`~/wookagent`), Node(L1의 블록 — 그 사용자의 집 폴더에 깔립니다), 데이터 폴더, 서버 띄우기, 운영자 명령, `wook`, Xvfb와 openbox, CLI 로그인(L3 — 사람). 데이터 폴더는 그 사용자만 열 수 있어(0700) 다른 사용자가 친 운영자 명령과 `wook`은 서버를 찾지 못합니다(관리 소켓과 `agent-endpoint.json`을 읽지 못합니다). 그 사용자로 치면 서버가 다시 시작할 때마다 바뀌는 포트와 확인값(`proof`)을 `wook`이 그 파일에서 다시 읽습니다.
- **그 사용자가 되는 길은 로그인 셸입니다.** AGENTS.md의 '`sudo -u`·`su`로 바꾼 셸에서 돌리지 않는다'의 까닭은 그 셸이 사용자 systemd에 닿지 못한다는 것입니다. systemd가 돌지 않는 이 배치에는 그 까닭이 없습니다 — 서버는 어떻게 로그인했는지를 보지 않습니다(같은 모양의 환경에서 로그인 세션 없이 띄워 확인했습니다). 대신 **환경이 그 사용자의 것**이어야 합니다: 집 폴더(`HOME`)·`USER`·PATH(그 사용자의 Node 24와 CLI)가 그 사용자의 것이고, 당신 쪽 사용자의 API 키 환경 변수가 따라 들어오지 않아야 합니다.
  - **이 PC에 sshd가 이미 돌고 있으면** SSH로 들어갑니다: `ssh <서버 사용자>@127.0.0.1`. sshd는 `127.0.0.1`에서만 받고(`ListenAddress 127.0.0.1`) 키 인증만 쓰게(`PasswordAuthentication no`) 합니다 — sshd 설정과 키 등록은 **[사람: sudo]**입니다.
  - **sshd가 없으면 이 일 때문에 새로 깔지 않습니다**(손으로 띄워야 하는 것이 하나 늘고 포트가 하나 더 열립니다). 로그인 셸로 바꿉니다: `sudo -iu <서버 사용자>` 또는 `su - <서버 사용자>`. `-i`나 `-` 없이(`sudo -u <사용자> <명령>`, `su <사용자>`) 바꾸면 집 폴더나 PATH가 당신 쪽 것으로 남을 수 있어 쓰지 않습니다.
  - 세 길(`ssh`, `sudo -i`, `su -`) 모두 개발 PC에서는 돌려 보지 못했습니다 (verify). 들어간 뒤 아래로 확인하고, 나온 것을 보고합니다:

    ```sh
    id -un; echo "$HOME"; command -v node; node --version
    env | grep -c -E '^(ANTHROPIC_API_KEY|OPENAI_API_KEY)='
    ```

    서버 사용자의 이름, 그 사용자의 집 폴더, 그 사용자의 Node(24 이상)가 나오고 마지막 줄은 `0`이어야 합니다. 그다음 `scripts/wook-server check --data-dir "$HOME/wook-data"`의 `실행 사용자`와 `API 키 환경 변수` 항목을 봅니다.
- **사람에게 알립니다**: 당신이 서버 사용자로 들어가 일하면 그 사용자의 데이터 폴더와 비밀 값 파일을 읽을 수 있는 자리가 됩니다(읽지 않습니다 — AGENTS.md). 사용자를 따로 둔다고 당신으로부터 서버의 자료가 막히지는 않습니다.
- 다시 시작한 뒤에는 (쓴다면) sshd, 서버, Xvfb, openbox를 차례로 다시 띄웁니다.

## check에 늘 남는 줄

이 배치에서는 아래가 늘 나옵니다. 실패가 아니고 끝 코드는 0입니다. **이 줄들의 `할 일:`은 따르지 않습니다**(systemd가 있어야 되는 줄입니다).

```text
  경고   systemd 유닛      사용자 systemd에 닿지 못해 유닛을 보지 못했습니다 (XDG_RUNTIME_DIR이 없습니다)
  경고   linger            꺼져 있습니다 — 부팅한 뒤 <사용자>로 로그인하기 전에는 서버가 뜨지 않습니다
  건너뜀 절전              절전 대상을 읽지 못했습니다 (…)
```

- `절전 방지`는 `idle`이다가 일이 시작되면 `unavailable — systemd-inhibit: Failed to connect to system scope bus …`(도구가 없으면 `systemd-inhibit이 PATH에 없습니다`)로 바뀌어 경고가 됩니다. 한 번만 해 보고 다시 띄우지 않습니다.
- 그 밖의 경고·실패는 [TROUBLESHOOT.md](TROUBLESHOOT.md)대로 봅니다.

## 화면 조작 (Xvfb)

꾸러미는 INSTALL.md L9와 같습니다(**[사람: sudo]**). 쿠키 파일을 만들고 Xvfb와 openbox를 띄웁니다 — L9의 두 유닛이 하는 줄과 같습니다:

```sh
(umask 077 && touch ~/.wook-xvfb.auth)
xauth -f ~/.wook-xvfb.auth add :99 . "$(mcookie)"
setsid nohup /usr/bin/Xvfb :99 -auth "$HOME/.wook-xvfb.auth" -nolisten tcp -s 0 -screen 0 1920x1080x24 >/dev/null 2>&1 &
timeout 10 /bin/sh -c 'until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.2; done'
DISPLAY=:99 XAUTHORITY="$HOME/.wook-xvfb.auth" setsid nohup /usr/bin/openbox >/dev/null 2>&1 &
```

- 둘째 줄은 **Xvfb를 띄울 때마다** 다시 칩니다(뜰 때마다 새 쿠키). `-nolisten local`은 쓰지 않습니다. 까닭은 원본 L9에 있습니다.
- 붙어 보기와 server.json의 `screen` 칸은 INSTALL.md L9의 블록 그대로입니다. 그 뒤 서버를 다시 띄웁니다. `status`의 화면 조작 줄이 `화면 조작을 쓸 수 있습니다 (모니터 1개, …)`면 됩니다.

**글자 입력(`type`)에는 세션 버스가 듭니다.** 사용자 관리자가 없어 세션 버스도 없습니다. 그대로 두면 캡처와 마우스는 되지만 `type`과 글자 키는 막힙니다(암호 칸인지 가르지 못함). 쓰려면 서버를 세션 버스 아래에서 띄우고(위의 시작 스크립트를 `dbus-run-session`으로 감쌉니다), 그 화면의 프로그램도 **같은 버스**로 띄웁니다:

```sh
setsid nohup dbus-run-session -- ~/wook-start.sh >/dev/null 2>&1 &
```

- 시작 스크립트가 버스 주소를 `~/.wook-session-bus`(이 사용자만 읽음)에 적어 둡니다.

그 화면에 프로그램을 띄울 때(운영자의 일 — 원본 L9 '그 화면의 프로그램은 운영자가 띄웁니다'):

```sh
DBUS_SESSION_BUS_ADDRESS="$(cat ~/.wook-session-bus)" DISPLAY=:99 XAUTHORITY="$HOME/.wook-xvfb.auth" setsid nohup <프로그램> >/dev/null 2>&1 &
```

- 버스는 서버와 함께 끝납니다. 서버를 다시 띄우면 주소가 바뀌므로 그 화면의 프로그램도 다시 띄웁니다.
- `check`의 화면 조작 항목은 **`check`를 친 셸**에 세션 버스가 있는지를 봅니다. 그래서 다른 셸에서 치면 서버가 버스 아래에서 돌아도 `세션 버스(DBUS_SESSION_BUS_ADDRESS)가 없어 … 글자 입력(type)은 막힙니다` 경고가 나옵니다. 서버의 것으로 보려면 같은 주소를 줍니다: `DBUS_SESSION_BUS_ADDRESS="$(cat ~/.wook-session-bus)" scripts/wook-server check --data-dir "$HOME/wook-data"` → `통과   화면 조작`.
- 세션 버스 없이 `type`을 쓰는 길(server.json의 `screen.typeWithoutA11y`)은 암호 칸에도 글자를 치게 됩니다. 쓸지는 사람이 정합니다(원본 L9).

## 없는 것

- **스스로 다시 뜨기**: 서버가 죽거나 컨테이너·호스트가 다시 시작해도 서버·Xvfb·openbox가 다시 뜨지 않습니다. 컨테이너의 시작 명령에 넣을지는 사람이 정합니다. 다시 시작한 뒤에는 `status`로 보고, 꺼져 있으면 위의 줄로 띄웁니다.
- **절전 막기**: 작업 중에도 호스트가 절전에 들 수 있습니다. 호스트의 설정은 사람의 일입니다.
- **저널**: `journalctl`이 없습니다. 기록은 데이터 폴더의 `logs/`입니다.
- **cgroup으로 가르기**: 서버가 뿌리 cgroup(`0::/`)에 있으면 정지 뒤 남은 프로세스를 실행 표시만으로 찾습니다(KNOWN_ISSUES의 'Linux 정지' 항목들).
