# 운영 — 설치한 뒤

[INSTALL.md](INSTALL.md)로 설치를 마친 서버를 날마다 다룰 때 읽습니다. 규칙은 [../../AGENTS.md](../../AGENTS.md)의 '꼭 지킬 것'이 먼저입니다. 명령의 설명 원본은 [../SERVER_INSTALL.md](../SERVER_INSTALL.md)의 `## 7. 운영자 명령`입니다.

## 기본

- 명령은 앱 폴더에서 칩니다: `cd ~/wookagent`. 데이터 폴더는 `"$HOME/wook-data"`입니다.
- 유닛 이름은 데이터 폴더로 정해집니다. 쓰는 줄과 같은 호출에서 먼저 정합니다:

  ```sh
  unit=$(scripts/wook-server install-task --dry-run --json --data-dir "$HOME/wook-data" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.name')
  ```

- 운영자 명령(`status`·`stop`·`shutdown`·`config …`·`secret …`·`seat …`·`agent …`)은 실행 중인 서버에 데이터 폴더의 관리 소켓(`admin.sock`)과 관리 토큰으로 붙습니다. 서버가 없으면 `이 데이터 폴더(…)로 실행 중인 욱채 서버가 없습니다`로 1입니다. `install-task`·`uninstall-task`·`check`는 서버 없이 됩니다.
- 운영자 명령은 친 값을 오류 글에 되풀이하지 않습니다. 그래도 비밀 값은 명령 줄에 쓰지 않습니다.

## 상태 보기

```sh
scripts/wook-server status --data-dir "$HOME/wook-data"
```

| 줄 | 뜻 |
|---|---|
| `프로세스` | 서버의 pid와 실행 시간 |
| `주소` | `http://127.0.0.1:7317 (이 PC 안에서만 — 127.0.0.1과 ::1에서 받습니다)` |
| `데이터 폴더`, `실행 ID`, `버전` | 쓰는 데이터 폴더, 이번 실행의 ID, 판(`package.json`의 판) |
| `진행 중 작업` | `없음`이 아니면 끄거나 다시 띄우기 전에 사람에게 묻습니다 |
| `긴급 정지` | `꺼짐`이 보통입니다. 켜져 있으면 대표만 풉니다 |
| `비밀 값 저장` | `파일 (…/secrets — 이 사용자만, 암호화하지 않음)`이어야 합니다. `— 쓸 수 없음: …`이면 [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '`check` 항목'에서 `secrets` 줄 |
| `화면 조작` | 화면 조작의 마지막으로 안 상태. 꺼 두었으면 그렇다고 말합니다 |
| `관리 채널` | `소켓 파일 — 이 사용자만`이어야 합니다 |
| `절전 방지` | `idle`(작업 없음), `awake`(작업 중 막음), `pending`(막 시작해 `systemd-inhibit`의 답을 기다림), `unavailable — …`(polkit 거부 — 절전 대상을 막아 두었으면 괜찮음) |
| `배포 점검` | 서버가 시작 뒤 한 번 돌린 `check`의 요약 |
| `시험용 세션` | `꺼짐 (--allow-test-session 없이 시작)`이어야 합니다 |

- `--json`을 붙이면 JSON 한 줄입니다.
- 다른 보기: `config show`(대표 이메일, 대표 계정, 기기 세션, 구글 클라이언트, 보안 비밀 등록 여부, CLI 위치, AI의 API 키(등록 여부와 인증 방식만), 공개 주소, Tailscale 사용자, 메인 자리, 메인 작업 폴더), `seat status`(보유자·세대·응답·자리 정책·최근 이력), `agent list`(외부 에이전트 — 키는 보이지 않음). 모두 아무것도 바꾸지 않습니다.

## 켜기

```sh
unit=$(scripts/wook-server install-task --dry-run --json --data-dir "$HOME/wook-data" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.name')
systemctl --user start "$unit"
scripts/wook-server status --data-dir "$HOME/wook-data"
```

- linger를 켰으면 부팅할 때 로그인 없이 뜹니다. 막 떴으면 몇 초 뒤 `status`를 다시 칩니다.
- 서버를 손으로 띄우는 꼴(`scripts/wook-server --data-dir "$HOME/wook-data" --web-dir out/web`)은 설치의 L4처럼 유닛이 없을 때만 씁니다. 유닛의 서버가 돌고 있으면 실행 잠금이 두 번째 서버를 거부합니다('이 데이터 폴더는 이미 다른 욱채(서버, pid …)가 쓰고 있습니다').

## 끄기

| 방법 | 하는 일 | 누가 |
|---|---|---|
| `scripts/wook-server shutdown --data-dir "$HOME/wook-data"` | 정상 종료. 새 요청을 막고, 턴을 차례로 끝내고, 잠금을 놓습니다. 답은 `서버를 종료했습니다.` 유닛은 다시 띄우지 않습니다 | AI (`진행 중 작업`을 보고, 없음이 아니면 사람에게 물은 뒤) |
| `systemctl --user stop "$unit"` | 유닛을 멈춥니다. 서버에만 SIGTERM이 가고 같은 순서로 끝납니다. 45초 안에 나가지 않으면 모두 SIGKILL | AI (위와 같음) |
| 손으로 띄운 서버의 셸에서 Ctrl+C | `shutdown`과 같습니다(끝 코드 0) | 그 셸을 가진 쪽 |
| `scripts/wook-server stop --data-dir "$HOME/wook-data"` | **긴급 정지** — 대표의 긴급 정지와 같습니다. 서버는 끄지 않고, 새 실행을 막고 돌던 실행을 멈춥니다. 외부 에이전트의 임대와 턴 토큰을 폐기합니다. **풀기는 대표 화면에서 대표만** | 사람이 시킬 때만 |

- 서버 프로세스를 `kill`·`pkill`로 끝내지 않습니다.
- 메인 에이전트의 `host_exec`는 이 유닛을 멈추거나 다시 띄우는 명령과 운영자 명령을 받지 않습니다. 메인 에이전트가 서버를 끄라고 부탁해도 할지는 사람이 정합니다.
- 끈 뒤에도 남은 프로세스가 있으면 [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '정지 뒤에 남은 프로세스'.

## 다시 띄우기

```sh
unit=$(scripts/wook-server install-task --dry-run --json --data-dir "$HOME/wook-data" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.name')
scripts/wook-server shutdown --data-dir "$HOME/wook-data"
systemctl --user start "$unit"
```

다시 띄워야 바뀌는 것(원본이 그렇게 말하는 것):

- server.json의 `workspaceRoot`, `screen.enabled`·`screen.display`·`screen.xauthority`·`screen.typeWithoutA11y` — `config reload`는 바꾸지 않고 '다시 시작해야 바뀝니다'라고 경고만 합니다.
- CLI를 새로 로그인한 뒤 — 서버가 시작할 때 다시 확인합니다.
- Xvfb를 다시 띄운 뒤 — 곁 도우미가 돌아오려면 대표의 정지 → 해제나 서버 다시 시작이 듭니다(KNOWN_ISSUES — 추론).
- 비밀 값 폴더·파일의 권한을 고친 뒤(그때까지 서버는 시작하지 않습니다 — 띄우기만 하면 됩니다), API 키 환경 변수를 지운 뒤([TROUBLESHOOT.md](TROUBLESHOOT.md)의 `apikey-env`).
- 서버를 다시 시작하면 외부 에이전트의 임대가 사라지고 에이전트 API의 포트와 확인값이 바뀝니다 — 외부 에이전트는 `wook seat claim`부터 다시 합니다. 대표의 기기 세션은 그대로입니다.

## 기록

```sh
journalctl --user -u "$unit" --no-pager -n 20
```

- 저널: 유닛으로 뜬 서버의 콘솔 출력(준비 줄, 시작 거부 줄). 설정 코드는 저널에 남지 않습니다(저널은 다른 계정 — adm·systemd-journal 그룹 — 도 읽을 수 있기 때문입니다).
- `<데이터 폴더>/logs/server.log`: HTTP·운영자 명령·한살이·배포 점검 요약. 손으로 띄운 서버를 Ctrl+C로 끝내면 `종료 신호 받음 (SIGINT)` … `욱채 서버 종료 (코드 0)` 줄이 남습니다.
- `<데이터 폴더>/logs/backend.log`: 업무 기록. 메인 에이전트가 응답하지 않으면 '메인 에이전트 응답 없음 …' 줄이 남습니다.
- 기록은 5MB마다 회전하고, 비밀 값·토큰·설정 코드를 가립니다. 요청 인자와 토큰은 남기지 않습니다.
- 기록 파일은 읽기만 합니다. 고치거나 지우지 않습니다.

## 점검

```sh
scripts/wook-server check --data-dir "$HOME/wook-data"
```

- 17개 항목(실행 사용자, /proc, procps, Node, systemd 유닛, linger, 데이터 폴더, 비밀 값 저장소, 절전, 절전 방지, Claude CLI, Codex CLI, 유닛의 PATH, API 키 환경 변수, 화면 조작, 관리 채널, Tailscale)을 보고 아무것도 바꾸지 않습니다. 줄마다 `통과`·`경고`·`실패`·`건너뜀`, 경고·실패 밑에 `할 일:`이 있습니다.
- 실패가 하나라도 있으면 끝 코드 1입니다. `--json`이면 ASCII JSON 한 줄입니다. `--dry-run`은 무엇을 읽을지만 보입니다.
- 서버가 돌지 않으면 일부 항목(절전 방지, 화면 조작, 관리 채널)은 `건너뜀`입니다.
- 새 묶음으로 바꾼 뒤, 다시 시작한 뒤, Node·CLI·Tailscale·server.json을 바꾼 뒤에 칩니다. 항목별 고칠 길은 [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '`check` 항목'.

## 설정 — server.json

server.json은 운영자의 파일입니다. 비밀 값은 넣지 않습니다(비밀 값처럼 보이는 칸은 쓰지 않고 경고합니다). 칸을 바꾸는 길은 `config` 명령, 또는 INSTALL.md의 `node -e` 블록과 같은 꼴(JSON으로 읽어 그 칸만 바꾸고 0600으로 씀) 뒤 `config reload`뿐입니다.

```sh
scripts/wook-server config show --data-dir "$HOME/wook-data"
scripts/wook-server config reload --data-dir "$HOME/wook-data"
```

| 칸 | 바꾸는 길 | 적용 |
|---|---|---|
| `owner.email` | `config owner-email <이메일>` — **등록된 대표 계정과 모든 기기 세션이 끊깁니다.** 사람이 정한 때만 | 곧바로 |
| `owner.tailscaleLogins` | server.json 편집 뒤 `config reload` (빈 목록 `[]`이면 검사하지 않음) | reload — 켬·끔과 사람 수를 알립니다 |
| `google.clientId` | `config google-client-id <ID>` | 곧바로 |
| `network.publicOrigin` | INSTALL.md L6의 블록 뒤 `config reload`. `https://<이름>` 꼴만 받습니다 | reload |
| `seat.initialHolder` | 자리가 비었을 때(새 데이터 폴더)만 씁니다. 앉은 자리를 바꾸려면 `seat assign` | 처음 시작 |
| `seat.holders`, `seat.drainMs` | server.json 편집 뒤 `config reload` | reload |
| `workspaceRoot` | server.json 편집 (절대 경로) | 다시 시작 |
| `screen.enabled`·`display`·`xauthority`·`typeWithoutA11y` | INSTALL.md L9의 블록 | 다시 시작 |

- 틀린 파일이면 `config reload`는 아무것도 바꾸지 않고 그 칸을(JSON이 아니면 틀린 줄과 글자를) 말합니다. 시작할 때 틀리면 서버가 시작하지 않습니다.
- 포트는 server.json이 아니라 서버 인자 `--port`로 정합니다(`install-task`에 붙임). `config show`의 '아직 쓰지 않음'은 그런 칸입니다.
- 대표의 휴대폰이 다른 Tailscale 계정이면 그 로그인 이름을 `owner.tailscaleLogins`에 더합니다. L6의 블록과 같은 꼴로:

  ```sh
  node -e '
  const fs = require("node:fs");
  const f = process.env.HOME + "/wook-data/server.json";
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.owner.tailscaleLogins = [...(j.owner.tailscaleLogins ?? []), "<더할 Tailscale 로그인>"];
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(j.owner.tailscaleLogins));
  '
  scripts/wook-server config reload --data-dir "$HOME/wook-data"
  ```

## 비밀 값

| 이름 | 무엇 | 넣기 |
|---|---|---|
| `google-client-secret` | 구글 로그인 보안 비밀 | **[사람]** `scripts/wook-server secret set google-client-secret --data-dir "$HOME/wook-data"` (표준 입력) |
| `claude-api-key`, `codex-api-key` | AI의 API 키 — 그 AI가 API 키 방식일 때만 턴이 씁니다 | **[사람]** `scripts/wook-server secret set claude-api-key --data-dir "$HOME/wook-data"` (`codex-api-key`도 같음) |

- 지우기: `scripts/wook-server secret clear <이름> --data-dir "$HOME/wook-data"` — 실행 중인 서버에 보내는 명령입니다. 사람이 시킬 때만 칩니다. 구글 보안 비밀을 지우면 다시 넣기 전까지 대표의 기기 코드 로그인을 시작할 수 없습니다.
- 확인은 `config show`(`등록됨 (데이터 폴더의 비밀 값 파일)`)와 `status`의 `비밀 값 저장` 줄로 합니다. 값은 어디에도 다시 보이지 않습니다.
- 값은 `<데이터 폴더>/secrets/`(0700)의 파일(0600)이고 암호화하지 않습니다. 데이터 폴더마다 따로입니다. 데이터 폴더를 지우면 함께 지워집니다.

## 메인 자리와 외부 에이전트

```sh
scripts/wook-server seat status --data-dir "$HOME/wook-data"
scripts/wook-server agent list --data-dir "$HOME/wook-data"
```

- 메인 자리는 한 번에 하나입니다. 바꾸는 것은 메인 에이전트(`hand_off_seat`)와 운영자의 `seat assign`뿐이고, **서버는 응답하지 않는 메인을 스스로 바꾸지 않습니다.** 응답 없음이면 대표에게 5분·30분·2시간에 알리고 대표의 명령은 쌓였다가 이어집니다.
- `seat assign <보유자> [--force]` — 보유자는 `launched:claude`·`launched:codex`·`external:<ID>`. 나가는 메인 턴의 마무리(`seat.drainMs`, 기본 120초)와 인계 메모 턴(최대 2분)을 기다립니다. `--force`는 실행 중인 메인 턴을 바로 멈춥니다. 사람이 정한 때만 칩니다.
  - 답이 '넘기는 중입니다'면 아직 기다리는 중입니다 — `seat status`로 봅니다.
  - 나가는 메인 턴의 종료를 확인하지 못하면 교체가 멈추고(끝 코드 1) 메인 에이전트가 일시정지됩니다. [TROUBLESHOOT.md](TROUBLESHOOT.md)의 '메인 자리'.
  - 보유자를 틀리게 적으면 끝 코드 2입니다. 다른 종류로 넘길 CLI는 이 사용자로 설치·로그인돼 있어야 합니다.
- 외부 에이전트 등록은 INSTALL.md L10의 블록으로 합니다(키가 화면에 남지 않음). 폐기: `scripts/wook-server agent revoke <ID> --data-dir "$HOME/wook-data"` — 그 뒤 그 키의 모든 요청은 401입니다. 이미 폐기됐으면 0, 모르는 ID는 1, `X-0001` 꼴이 아니면 2입니다. 앉아 있던 에이전트면 자리는 '응답 없음 — 키가 폐기됨 (운영자)'으로 남습니다. 키를 바꾸는 명령은 없습니다 — 폐기한 뒤 새로 등록합니다(새 ID). 사람이 시킬 때만 칩니다.
- 외부 에이전트가 60초 동안 임대를 싣는 요청을 보내지 않으면 임대가 끝나고 자리는 '응답 없음'입니다. 살리려면 에이전트를 다시 띄우거나 `seat assign launched:claude`로 넘깁니다.

## 새 묶음으로 바꾸기

바꾸는 것은 **앱 폴더뿐**입니다. 데이터 폴더(`~/wook-data`), 작업 폴더(`~/wook-workspace`), `~/.wook`, 유닛 파일, 화면 유닛과 쿠키는 그대로 둡니다.

원본이 말하는 것:

- 유닛은 Node의 절대 경로, 서버 진입점(`~/wookagent/out/server/index.mjs`), 작업 디렉터리(`~/wookagent`), 웹 화면(`~/wookagent/out/web`), 데이터 폴더, PATH를 적어 둡니다(SERVER_SETUP L8). 새 묶음을 같은 자리 `~/wookagent`에 풀면 이 경로는 그대로입니다. 어긋나면 `check`의 `systemd 유닛` 항목이 무엇이 다른지(예: `Node가 지금 것과 다릅니다`)와 다시 등록할 줄을 `할 일:`에 냅니다.
- Node를 새 판(다른 폴더)으로 바꾸면 `install-task`를 다시 합니다(SERVER_SETUP L1).
- 새 판의 서버가 앞 판의 DB를 열면 새 표만 더해집니다(SERVER_DESIGN의 '데이터 폴더 안'). 손으로 옮기는 단계는 원본에 없습니다.
- 데이터 폴더의 `bin/`에 있는 화면 도우미 사본은 서버가 스스로 준비하고 해시로 고정합니다. 손대지 않습니다.
- 원본이 말하지 않는 것: 새 판이 잘못됐을 때 옛 판으로 돌아가도 되는지(새 판이 연 데이터 폴더를 옛 판이 열 수 있는지). 그 판단은 사람이 합니다.

차례:

1. **[사람]** 새 묶음 두 파일을 이 PC에 둡니다.
2. AI — 체크섬(그 폴더에서): `sha256sum -c wook-server-<판>-linux-<커밋 7자>.tar.gz.sha256` → `…: OK`. 아니면 멈춥니다.
3. AI — `scripts/wook-server status --data-dir "$HOME/wook-data"`의 `진행 중 작업`을 봅니다. `없음`이 아니면 사람에게 언제 끌지 묻습니다.
4. AI — 끄고, 옛 앱 폴더를 옆으로 옮기고, 새 묶음을 풉니다. 통째로 칩니다:

   ```sh
   (
     set -eu
     if test -e ~/wookagent.old; then echo "~/wookagent.old가 이미 있어 멈췄습니다 — 사람에게 물어봅니다" >&2; exit 1; fi
     cd ~/wookagent
     scripts/wook-server shutdown --data-dir "$HOME/wook-data"
     cd ~
     mv ~/wookagent ~/wookagent.old
     tar -xzf "<새 묶음 파일의 경로>" -C ~
   )
   ```

   - 서버가 이미 꺼져 있으면 `shutdown`이 1로 끝나 블록이 거기서 멈춥니다(아무것도 옮기지 않음). 그때는 `status`로 꺼진 것을 확인하고 `shutdown` 줄을 뺀 블록을 칩니다.
   - `<새 묶음 파일의 경로>`는 절대 경로로 씁니다(블록이 집 폴더로 옮겨 간 뒤에 풉니다).

5. AI — 새 앱 폴더를 확인합니다: `cd ~/wookagent`, `cat BUILD-INFO.json`, `node --version`(필요한 Node보다 낮지 않아야 함 — 낮으면 SERVER_SETUP L1의 Node 블록을 새 판으로 하고 6에서 `install-task`를 다시), `scripts/wook-server --help`.
6. AI — 띄우고 봅니다: [켜기](#켜기)의 블록, 그다음 `journalctl --user -u "$unit" --no-pager -n 20`. `status`의 `버전` 줄이 새 판인지 봅니다.
7. AI — `scripts/wook-server check --data-dir "$HOME/wook-data"`. `systemd 유닛`이 경고하면 그 `할 일:` 줄(`install-task …`)을 `scripts/wook-server`로 바꿔 치고, [다시 띄우기](#다시-띄우기)를 합니다.
8. AI — 외부 에이전트를 쓰면 그 에이전트가 `wook seat claim`부터 다시 하게 합니다.
9. 보고합니다: 옛 판과 새 판(`BUILD-INFO.json`), `status`, `check`의 결과. 옛 폴더 `~/wookagent.old`는 사람이 새 판을 확인한 뒤 사람이 지웁니다.

새 판이 시작하지 않으면 [TROUBLESHOOT.md](TROUBLESHOOT.md)를 보고, 고칠 길이 없으면 멈춰 보고합니다. 옛 판으로 되돌릴지는 사람이 정합니다.

## 백업과 옮기기

- 데이터 폴더에는 DB(`wook.db`), `server.json`, 기록(`logs/`), 비밀 값(`secrets/` — 암호화하지 않음), 작업 사본(`worktrees/`), 보고서(`reports/`), 자동 백업(`backups/<YYYY-MM-DD>/`, 7개) 등이 있습니다. 자동 백업은 데이터 폴더 **안**에 있습니다.
- 데이터 폴더나 집 폴더를 통째로 백업하면 `secrets/`의 값도 그대로 들어갑니다. 그 백업은 비밀로 다룹니다.
- 메인 에이전트의 화면 캡처(작업 폴더의 `screens/`, 24시간·최근 500장)는 앱의 백업과 내보내기에 들어가지 않습니다.
- 실행 중인 서버의 데이터 폴더를 복사해 다른 서버로 띄우면 데이터의 주인 확인이 거부합니다('…복사본이거나 잠금 파일이 지워짐').
- 데이터를 다른 디스크에 두려면 `~/wook-data`를 그 폴더로 가는 심볼릭 링크로 둬도 됩니다(SERVER_SETUP L4). 링크가 가리키는 곳이 없으면 서버가 시작하지 않습니다.
- 데이터 폴더를 다른 경로로 옮기는 차례는 원본에 없습니다. 유닛 이름이 데이터 폴더의 실제 경로로 정해지고 비밀 값이 데이터 폴더마다 따로이므로, 옮기기 전에 사람에게 묻습니다.
- eCryptfs로 암호화한 집 폴더에서는 긴 파일 이름이 실패할 수 있습니다. 데이터 폴더를 그 밖에 둡니다.

## 지우기

[INSTALL.md](INSTALL.md)의 `## L13. 되돌리기`를 따릅니다. 앱 폴더·데이터 폴더·작업 폴더를 지우는 것은 사람이 정하고 사람이 합니다.

## 끝 코드

| 명령 | 끝 코드 |
|---|---|
| 서버 시작 (`serve` — 명령 없이 옵션만 적은 꼴도 같음) | 시작 거부 1(`욱채 서버를 시작하지 못했습니다: <글>`, server.json의 틀린 칸, 서버용이 아닌 `--web-dir`, 데이터의 주인 확인 거부 등). `--owner-email` 모양이 틀림 2. Ctrl+C로 정상 종료 0 |
| 운영자 명령 (`status`·`config`·`secret`·`seat`·`agent`·`shutdown`·`stop`) | 붙을 서버가 없음 1 |
| `check` | 실패가 하나라도 있으면 1 |
| `install-task` | `등록한 유닛이 쓴 것과 다릅니다 (…)` 1 |
| `uninstall-task` | 유닛 없음 0, 있는지 읽지 못함 1, 다른 자리에 같은 이름의 유닛 1 |
| `seat assign` | 나가는 메인 턴의 종료를 확인하지 못함 1, 틀린 보유자 2 |
| `agent revoke` | 이미 폐기됨 0, 모르는 ID 1, `X-0001` 꼴이 아님 2 |
| `wook` (`node out/server/wook.mjs`) | 0 됨 · 1 거부·도구의 거부 · 2 쓰임새·설정 · 3 인증 실패(401) · 4 충돌(409) · 5 서버에 닿지 못함 |

원본에 끝 코드가 적히지 않은 경우(`status`·`shutdown`이 성공할 때 등)는 이 표에 넣지 않았습니다.
