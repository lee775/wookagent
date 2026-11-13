# 욱채 서버 Linux 묶음 — AI가 먼저 읽는 문서

이 문서는 이 폴더를 받아 욱채 서버를 설치·점검·운영하는 AI 에이전트(Claude Code, Codex CLI 같은 것)가 가장 먼저 읽습니다. 다른 문서로 가기 전에 끝까지 읽습니다.

- **당신**: 이 Linux PC(Ubuntu 24.04)에서 서버를 돌릴 보통의 로그인 사용자로 도는 AI입니다. 셸 명령을 치고, 사람과 대화로 일합니다.
- **사람**: 이 PC를 맡은 사람(운영자)입니다. 관리자 암호(sudo), 브라우저 로그인, 비밀 값, 휴대폰, 다시 시작은 사람만 합니다.
- **대표**: 욱채의 주인입니다. 구글 계정으로 로그인해 휴대폰이나 다른 PC의 브라우저로 욱채를 씁니다. 사람과 대표는 같은 사람일 수 있습니다.
- 용어는 [docs/ai/SYSTEM.md](docs/ai/SYSTEM.md)의 '용어' 절에 한 번씩 정의했습니다.

## 이 폴더

- 욱채 서버(화면 없는 Node 서버)를 미리 빌드한 묶음입니다. 순수 JavaScript라 x86_64와 arm64에서 돕니다. 이 PC에 **Node.js 24 이상**과 `git`이 있어야 합니다. Ubuntu의 `nodejs` 꾸러미는 18판이라 쓰지 않습니다(서버가 쓰는 `node:sqlite`가 없습니다).
- 묶음 파일 `wook-server-<판>-linux-<커밋 7자>.tar.gz`를 `tar -xzf <파일> -C ~`로 풀면 이 폴더 `~/wookagent`가 생깁니다. 이 폴더를 **앱 폴더**라 부릅니다.
- `scripts/wook-server` — 운영자 명령입니다. `node out/server/index.mjs`와 같고 PATH의 `node`로 띄웁니다.
- `out/server/` — 빌드한 서버(`index.mjs`)와 외부 에이전트의 명령 `wook`(`wook.mjs`). `out/web/` — 웹 화면. `resources/` — X11 화면 도우미 등. `node_modules/` — 실행에 드는 꾸러미만.
- `BUILD-INFO.json` — 판·커밋·빌드 시각·필요한 Node(묶는 스크립트가 만든 파일). `package.json` — 이름과 판(서버가 판을 읽습니다).
- `docs/` — 저장소의 문서 그대로. `docs/ai/` — AI용 문서(아래 '문서 지도').
- **없는 것**: `.git`, `src/`, `package-lock.json`, 개발용 꾸러미. 그래서 `git clone`, `npm ci`, `npm run build:server`, `npm run build:web`을 이 PC에서 치지 않습니다. [docs/SERVER_SETUP.md](docs/SERVER_SETUP.md)의 Linux 편 가운데 `## L2. 저장소와 빌드`는 이 묶음이 대신합니다(그 절에 묶음의 단락 '묶음으로 (저장소와 빌드 없이)'가 있으면 그것만 해당합니다). L0·L1·L3~L13과 부록 C·D는 그대로이고, 저장소 폴더 자리에 `~/wookagent`, 명령은 이 폴더에서 `scripts/wook-server …`로 칩니다.
- 서버의 자료는 **데이터 폴더** `~/wook-data`(명령에는 `"$HOME/wook-data"`)에 따로 둡니다. 앱 폴더는 새 판으로 통째로 바꿀 수 있지만 데이터 폴더는 바꾸거나 지우지 않습니다.
- 앱 폴더의 파일은 고치지 않습니다. 새 판으로 바꿀 때 통째로 바뀝니다.

## 꼭 지킬 것

| 하지 않는 것 | 까닭 |
|---|---|
| root로, 또는 `sudo -u`·`su`로 바꾼 셸에서 서버나 운영자 명령을 돌리기 | 서버는 root로 시작하지 않습니다(root의 서버는 이 PC 전체를 쥐고, 메인 에이전트의 Claude Code는 root에서 권한 확인 건너뛰기를 거부합니다). 바꾼 셸에는 사용자 systemd에 닿는 `XDG_RUNTIME_DIR`가 없어 `install-task`가 거부합니다. |
| `sudo`로 시작하는 줄을 직접 치기 | 관리자 암호가 드는 줄이고 암호는 사람만 넣습니다. 그 줄을 그대로 보여 주고 사람에게 부탁합니다. |
| 비밀 값(구글 보안 비밀, AI의 API 키, Claude 긴 토큰)을 대화로 묻거나 받기, 명령 줄에 쓰기 | `secret set`은 표준 입력으로만 받습니다. 명령 줄은 셸 기록과 프로세스 목록에 남습니다. 넣는 것은 사람입니다. |
| 설정 코드, 외부 에이전트 키(`wsk_…`), 턴 토큰(`wtt_…`), 관리 토큰(`admin.token`), `agent-endpoint.json`의 `proof`, 화면 쿠키를 자기 출력·파일·보고에 내기 | 이 값을 가진 쪽은 대표 자리나 서버, 화면을 쥘 수 있습니다. 이런 값이 든 파일(`setup-code.txt`, `~/.wook/agent.json`, `secrets/` 등)을 `cat`하지 않습니다. |
| 서버를 루프백 밖에 열기, `tailscale funnel`, 공유기 포트 열기, `tailscale serve reset` | 서버는 루프백(127.0.0.1·::1)에서만 엽니다. 다른 기기는 `tailscale serve`로만 들어옵니다. funnel은 인터넷 전체에 엽니다. `reset`은 같은 이름의 다른 항목까지 지웁니다. |
| 데이터 폴더(`~/wook-data`)의 파일을 손으로 고치거나 지우거나 옮기기 | DB·실행 잠금·관리 토큰·비밀 값은 서버가 다룹니다. 예외는 문서에 적힌 것뿐입니다: 문서의 블록이나 `config` 명령으로 `server.json` 바꾸기, `check`가 내는 `chmod` 고칠 줄. |
| 새 판으로 바꿀 때 데이터 폴더나 작업 폴더(`~/wook-workspace`)를 바꾸기·지우기 | 대표의 모든 기록과 비밀 값이 그 안에 있습니다. 바꾸는 것은 앱 폴더뿐입니다. |
| `--allow-test-session`, `session test` | 시험용 세션 발급을 켜고, 등록된 대표가 없으면 시험용 대표를 만듭니다. `install-task`는 받지 않고, 유닛에 있으면 `check`가 실패로 봅니다. |
| 사람의 확인 없이 서버를 컨테이너(Docker 등)에 두기, WSL에 진짜 서버로 두기 | 컨테이너는 지원하는 배치가 아닙니다 — 데이터 폴더를 여러 컨테이너가 열면 실행 잠금이 맞지 않고, 좀비를 거두는 init이 없으면 정지가 늘 '남은 프로세스 있음'으로 끝납니다. 사람이 그 배치로 정했으면 [docs/ai/NO_SYSTEMD.md](docs/ai/NO_SYSTEMD.md)의 조건을 지킵니다. WSL2는 시계가 30초쯤마다 0.5초쯤 뒤로 갑니다. |
| 사람이 시키지 않았는데 `scripts/wook-server stop` 치기, 서버를 `kill`·`pkill`로 끝내기 | `stop`은 긴급 정지이고 풀기는 대표만 합니다. 서버를 끄는 것은 `shutdown`입니다. |
| 유닛 파일을 손으로 고치거나 `systemctl --user edit`로 덧붙이기 | `install-task`가 쓴 것과 다르면 `check`가 알립니다. 바꾸려면 `install-task`를 다시 합니다. |
| 서버 PC의 브라우저에 대표로 로그인하기 | 그 화면에는 대표만 누르는 버튼(정지 해제, 결과 승인)이 있습니다. |
| 구독으로 쓰는 AI의 API 키 환경 변수(`ANTHROPIC_API_KEY`·`OPENAI_API_KEY`)를 `~/.profile`·`~/.bashrc`·`~/.config/environment.d`에 두기 | `check`가 경고합니다. API 키로 쓸 때는 사람이 `secret set`으로 넣습니다. |

## 멈추고 사람에게 묻는 때

- `[사람]` 단계와 `sudo` 줄에 닿았을 때.
- 서버를 끄거나 다시 띄우기 전에 `status`의 `진행 중 작업`이 `없음`이 아닐 때 — 끄면 돌던 턴이 끝납니다.
- 되돌리기 어려운 명령 앞: `uninstall-task`, `secret clear`, `config owner-email`(등록된 대표 계정과 모든 기기 세션이 끊깁니다), `agent revoke`, `seat assign`(특히 `--force`), 데이터 폴더·앱 폴더 지우기.
- 시작 거부, `check`의 실패, 명령의 거부가 문서의 어느 줄과도 맞지 않을 때.
- `(verify — …)`로 적힌 줄이 문서와 다르게 나왔을 때. 실제 출력을 그대로 보고합니다.
- uid가 0일 때, `systemctl --user`에 닿지 못할 때. 닿지 못하는 까닭이 systemd가 돌지 않는 곳(컨테이너, 1번 프로세스가 `tini` 등)이면 사람에게 그 배치로 갈지 확인받고 [docs/ai/NO_SYSTEMD.md](docs/ai/NO_SYSTEMD.md)를 따릅니다.
- 앱 폴더가 `~/wookagent`가 아닌 곳에 있을 때, `~/wookagent`가 이 묶음이 아닐 때(`.git`이 있거나 `BUILD-INFO.json`이 없음). 이 문서들과 유닛은 `~/wookagent`를 가정합니다.
- 고칠 줄이 `sudo chown`처럼 관리자 권한을 요구할 때.

## 사람만 하는 일

- `sudo`가 드는 줄 전부: L1 꾸러미, L6 Tailscale 설치와 `tailscale up`, L7 절전 대상 막기, L8 linger 켜기, L9 화면 꾸러미, L12 `sudo reboot`, L13 linger 끄기와 절전 대상 풀기, 그 밖에 `check`가 내는 `sudo` 고칠 줄.
- L3 CLI 로그인(다른 기기의 브라우저에 주소와 코드를 넣음), `claude setup-token`으로 받은 토큰 두기.
- L5 구글 클라우드 콘솔에서 OAuth 클라이언트 만들기, 구글 보안 비밀 넣기. API 키 방식이면 AI의 API 키 넣기.
- L6 Tailscale 계정 로그인, 관리 콘솔의 MagicDNS·HTTPS Certificates 켜기, 대표 휴대폰의 Tailscale 앱.
- L10 외부 에이전트를 둘지, 그 이름, 메인 자리를 누구에게 줄지 정하기.
- L11 대표의 휴대폰 첫 로그인. L12 다시 시작과 그 뒤 다른 기기에서 보기.
- 새 묶음 파일을 이 PC에 가져오기, 옛 앱 폴더와 데이터 폴더 지우기, 긴급 정지 풀기(대표 화면).

## 처음 할 일

1. 이 PC가 처음 설치하는 PC인지, 이미 설치된 PC인지 가립니다.
   - `node --version`이 없거나 `v24`보다 낮으면 처음 설치입니다 — [docs/ai/INSTALL.md](docs/ai/INSTALL.md)의 '준비'와 L0부터.
   - 있으면 앱 폴더에서 `scripts/wook-server check --data-dir "$HOME/wook-data"`를 칩니다. `데이터 폴더`가 `건너뜀 데이터 폴더가 아직 없습니다 …`면 처음 설치(INSTALL.md), 아니면 설치된 PC입니다 — [docs/ai/OPERATE.md](docs/ai/OPERATE.md)와 `status`부터.
   - 다른 데이터 폴더를 쓰는 PC일 수 있으면 사람에게 그 경로를 묻습니다.
2. 사람에게 무엇을 할지(설치, 점검, 새 묶음으로 바꾸기, 문제 해결) 확인하고, 그 일의 문서를 엽니다.
3. 일을 시작하기 전에 사람만 할 일이 언제 생기는지 미리 알려 둡니다(아래 '사람만 하는 일'을 그 일에 맞춰).

## 문서 지도

| 문서 | 언제 읽나 |
|---|---|
| [docs/ai/INSTALL.md](docs/ai/INSTALL.md) | 처음 설치할 때. 단계마다 누가 무엇을 치고 언제 멈추는지. |
| [docs/ai/OPERATE.md](docs/ai/OPERATE.md) | 설치한 뒤: 상태, 켜고 끄기, 기록, 점검, 설정, 새 묶음으로 바꾸기, 지우기, 끝 코드. |
| [docs/ai/TROUBLESHOOT.md](docs/ai/TROUBLESHOOT.md) | 서버가 뜨지 않거나 `check`가 경고·실패를 낼 때, 유닛·화면 조작·남은 프로세스 문제. |
| [docs/ai/SYSTEM.md](docs/ai/SYSTEM.md) | 욱채가 무엇인지, 역할, 프로세스와 폴더, 네트워크, 외부 에이전트의 Linux 다른 점, 용어. |
| [docs/ai/NO_SYSTEMD.md](docs/ai/NO_SYSTEMD.md) | systemd가 돌지 않는 곳(컨테이너, 1번 프로세스가 `tini`)일 때. 유닛 없이 서버·Xvfb를 띄우는 줄, 설치에서 달라지는 단계, 없는 것. Debian 13에서 확인한 것. |
| [docs/SERVER_SETUP.md](docs/SERVER_SETUP.md) | 원본 설치 순서. `## L. 읽기 전에 (Linux)`부터 끝까지만 이 PC에 해당합니다. 출력 전문과 까닭. |
| [docs/SERVER_INSTALL.md](docs/SERVER_INSTALL.md) | 운영자 명령과 설정의 설명. 7절 명령 표, 4절 Tailscale, 6절 메인 자리, 10절 외부 에이전트. |
| [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) | `## Linux 서버의 한계` 절. 알려진 한계와 정리하는 법. |
| [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md) | 당신이 메인 자리에 외부 에이전트로 앉을 때. Windows 기준이라 Linux 다른 점은 SYSTEM.md에. |
| `docs/ARCHITECTURE.md` 20장, `docs/SERVER_DESIGN.md` | 설계. 둘 다 크므로 필요한 낱말만 찾아 읽습니다. |
| `docs/TRY_IT.md` | Windows 전용 체험 도구입니다. 이 PC에서는 쓰지 않습니다. |
| `docs/기획서_v0.5.md`, `docs/기획서_v0.6_변경목록.md` | 제품의 요구사항과 용어. |

## 자주 쓰는 명령

모두 앱 폴더에서 칩니다. 도움말에 있는 명령만 적었습니다.

```sh
cd ~/wookagent
scripts/wook-server --help                                         # 명령과 옵션
scripts/wook-server status --data-dir "$HOME/wook-data"            # 실행 중인 서버의 상태
scripts/wook-server check --data-dir "$HOME/wook-data"             # 이 PC 점검 (서버 없이도, 바꾸는 것 없음)
scripts/wook-server config show --data-dir "$HOME/wook-data"       # 운영자 설정 (비밀 값은 등록 여부만)
scripts/wook-server config reload --data-dir "$HOME/wook-data"     # server.json을 다시 읽어 적용
scripts/wook-server seat status --data-dir "$HOME/wook-data"       # 메인 자리 보기 (바꾸지 않음)
scripts/wook-server agent list --data-dir "$HOME/wook-data"        # 외부 에이전트 목록 (키는 안 보임)
scripts/wook-server shutdown --data-dir "$HOME/wook-data"          # 정상 종료
unit=$(scripts/wook-server install-task --dry-run --json --data-dir "$HOME/wook-data" | node -p 'JSON.parse(require("node:fs").readFileSync(0, "utf8")).result.name')
systemctl --user start "$unit"                                     # 유닛으로 띄우기
journalctl --user -u "$unit" --no-pager -n 20                      # 유닛의 콘솔 기록
```

- `status`·`config`·`secret`·`seat`·`agent`·`shutdown`·`stop`은 실행 중인 서버에 관리 채널로 붙습니다. `install-task`·`uninstall-task`·`check`는 서버 없이도 됩니다.
- `--json`은 결과를 JSON 한 줄로 냅니다. `--dry-run`은 `install-task`·`uninstall-task`·`check`에서 아무것도 바꾸지 않고 할 일만 보입니다.
- `--port <번호>`는 서버를 띄우는 줄과 `install-task`에만 붙입니다. 운영자 명령에 붙이면 쓰임새 오류로 거부합니다.
- 끝 코드: `check`는 실패가 있으면 1, 서버가 시작을 거부하면 1, 운영자 명령이 붙을 서버가 없으면 1입니다. 자세한 표는 [docs/ai/OPERATE.md](docs/ai/OPERATE.md)의 '끝 코드'.

## 나중에 메인 자리에 앉게 되면

운영자가 당신을 외부 에이전트로 등록하고 메인 자리를 배정하면, 당신은 대표의 명령을 받아 일하는 메인 에이전트가 됩니다.

- 일하는 법은 [docs/AGENT_GUIDE.md](docs/AGENT_GUIDE.md)를 그대로 따릅니다. Linux에서 다른 점(`wook`의 자리, 데이터 폴더, 키 파일 권한, 화면)은 [docs/ai/SYSTEM.md](docs/ai/SYSTEM.md)의 '외부 에이전트로 메인 자리에 앉을 때'에 있습니다.
- 메인 자리에서 일하는 규칙은 턴마다 받는 `instructions`가 정합니다. 그 턴 안에서는 운영자 명령(`scripts/wook-server …`)을 쓰지 않습니다 — 서버가 띄우는 메인 에이전트는 그 명령을 돌리지 못하게 막혀 있고, 외부 에이전트의 셸에는 그 막음이 없을 뿐입니다. 운영자의 일이 필요하면 사람에게 알립니다.
- 위 '꼭 지킬 것'은 그 역할에서도 그대로입니다.

## 사람에게 보고하기

- 단계가 끝날 때마다: 한 단계(INSTALL.md의 단계 이름), 친 명령, 결과의 핵심 줄(그대로 옮김), 판정(됨·경고·실패), 다음 할 일.
- 사람에게 부탁할 때: 무엇을 왜 하는지 한 줄, 사람이 칠 줄을 그대로 코드 블록으로, 끝나면 알려 달라는 말, 그 뒤 당신이 확인할 명령.
- `(verify)` 줄은 "원본에서 실제 기계로 확인하지 못한 줄입니다. 이 PC에서는 이렇게 나왔습니다:"로 실제 출력을 붙입니다.
- 비밀 값·설정 코드·키·토큰·쿠키는 보고에 넣지 않습니다. 출력에 그런 값이 섞였으면 그 자리를 `<가림>`으로 바꿔 옮깁니다.
- 실패와 모르는 것은 숨기지 않습니다. 고칠 길을 문서에서 찾지 못하면 찾지 못했다고 말하고 멈춥니다.
