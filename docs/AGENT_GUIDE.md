# 욱채 외부 에이전트 안내서 (7단계)

욱채 서버의 메인 자리에 앉는 **외부 에이전트**(그록봇 같은, 운영자가 등록한 프로그램)가 읽습니다. 에이전트는 서버와 **같은 PC**에서 돌고, 루프백 HTTP(에이전트 API)로 자리를 잡고 일을 받아 처리한 뒤 답을 보냅니다. 설계는 [SERVER_DESIGN.md](SERVER_DESIGN.md) 4.5, 운영자 쪽 준비는 [SERVER_INSTALL.md](SERVER_INSTALL.md) 10절에 있습니다.

## 명령 한눈에

`wook`은 `node out/server/wook.mjs`를 줄여 쓴 것입니다(`npm run build:server`가 만듭니다).

```text
wook seat claim                         메인 자리를 잡습니다 (운영자가 이 에이전트에게 배정했을 때만)
wook seat status                        메인 자리와 이 에이전트의 임대를 봅니다 (임대를 늘리지 않습니다)
wook seat heartbeat                     임대를 늘립니다 — 임대 시간 안에 되풀이하세요
wook seat release [--note <글>]         메인 자리에서 스스로 물러납니다
wook work next [--wait]                 일 하나를 받아 JSON으로 냅니다 — --wait면 일이 올 때까지 기다립니다
wook work progress <턴 ID> --text <글>  진행 상황을 남깁니다
wook work done <턴 ID> --file <파일> [--outcome completed|failed]
                                        턴을 마칩니다 — 그 파일의 글(UTF-8)이 마지막 답입니다
wook tool <도구 이름> [--json '<인자 JSON 객체>' | --json-file <파일>]
                                        받은 턴의 토큰으로 도구를 부르고 결과를 JSON으로 냅니다 (--json-file은 UTF-8 JSON 파일)
wook screen capture --out <파일.png>    서버 PC의 화면을 찍어 PNG로 저장합니다
wook stop                               긴급 정지 (대표의 긴급 정지와 같습니다 — 풀기는 대표만)
```

끝 코드: **0** 됨 · **1** 거부·도구의 거부 · **2** 쓰임새·설정 · **3** 인증 실패(401) · **4** 충돌(409 — 서버의 글을 그대로 냅니다) · **5** 서버에 닿지 못함. 자세한 것은 [10절](#10-문제가-생기면--끝-코드별)에 있습니다.

## 1. 역할과 정지

- 메인 에이전트는 대표(욱채의 주인)의 명령을 받아 AI 팀을 움직이는 자리입니다. 한 번에 하나만 앉습니다. 서버가 띄우는 Claude CLI·Codex CLI가 앉을 수도 있고, 운영자가 배정하면 외부 에이전트가 앉습니다.
- 외부 에이전트는 서버가 띄운 CLI와 **같은 일**을 **같은 규칙**으로 합니다. 받는 일(`message`)과 지켜야 할 규칙(`instructions` — 서버가 CLI에 주는 시스템 프롬프트와 같은 글)도 같고, 도구도 같습니다.
- 자리는 키만으로 얻지 못합니다. 서버 PC의 운영자가 배정한(`wook-server seat assign external:<ID>`) 에이전트만 `seat claim`할 수 있습니다.
- 대표는 언제든 긴급 정지할 수 있습니다. 정지하면 서버는 이 에이전트의 임대와 턴 토큰을 곧바로 폐기합니다. 에이전트의 프로세스까지 끝났는지는 서버가 알 수 없어서, 정지 요약에는 '종료 확인 불가'라고 적힙니다. 정지 중에는 일을 받지 못하고, 대표가 정지를 풀면 다시 `seat claim`합니다.
- 서버는 응답하지 않는 에이전트를 다른 보유자로 바꾸지 않습니다. 자리는 '응답 없음'으로 남고, 바꾸는 것은 운영자(`seat assign`)나 메인 자신(`hand_off_seat` 도구)입니다.

## 2. 준비

운영자가 서버 PC에서 등록하고 배정합니다 ([SERVER_INSTALL.md](SERVER_INSTALL.md) 10절).

1. 등록: `wook-server agent add --label 그록봇` → ID(`X-0001`)와 키(`wsk_…`)가 **한 번만** 나옵니다.
2. 배정: `wook-server seat assign external:X-0001`
3. 키 넘기기 — 둘 중 하나:
   - 환경 변수 `WOOK_AGENT_KEY` (에이전트를 띄우는 쪽이 넣습니다)
   - `~/.wook/agent.json`: `{"key": "wsk_…"}`. **지금 사용자만 읽는 파일이어야 합니다.** Windows는 그 파일의 권한(ACL)에 지금 사용자·SYSTEM·Administrators 밖의 계정이 있으면, Linux·macOS는 그룹·다른 사용자 권한이 있으면 `wook`이 키를 쓰지 않고 2로 끝납니다. 그 글에 열린 계정(이름과 SID, 물려받은 권한인지 따로 준 권한인지)과 차례로 할 `icacls` 명령이 나옵니다. 만드는 법은 SERVER_INSTALL 10절에 있습니다.
   - 명령 줄로는 키를 받지 않습니다 — 명령 줄은 같은 PC의 다른 프로세스가 볼 수 있습니다.
4. 주소: `wook`이 스스로 찾습니다.
   - 데이터 폴더의 `agent-endpoint.json`을 읽습니다. 데이터 폴더는 `wook-server`와 같이 `--data-dir <폴더>` → `WOOK_DATA_DIR` → 기본 위치(Windows `%APPDATA%\wookagent`) 차례입니다. 서버는 **시작할 때마다 새 포트와 새 확인값(`proof`)**을 이 파일에 씁니다.
   - **키를 보내기 전에 서버를 확인합니다 — 연결마다.** 서버가 끝나면(갑자기든 정상 종료든) 그 포트를 다른 프로그램(다른 계정의 것일 수도 있습니다)이 곧바로 차지할 수 있습니다. 그래서 `wook`은 그 파일에서 주소를 읽었으면, 키·임대 ID·턴 토큰을 어떤 TCP 연결에 쓰기 전에 **그 연결에서** 먼저 `POST /agent/v1/hello`에 듣는 쪽이 이 파일의 `proof`로 맞게 답했는지 봅니다(아래 '서버 확인'). 새 연결이면 그 연결에서 hello부터 합니다 — 기다리는 동안 보내는 heartbeat와 `work next --wait`의 다음 롱폴도 같습니다. 그래서 서버가 끝나고 그 포트를 다른 프로그램이 차지해도, 그 프로그램은 새 연결에서 맞게 답하지 못하므로 키가 가지 않습니다. 200에 맞는 답이 아니거나(넘겨 주는 답·429 포함), 답이 없거나, 5초 안에 끝나지 않으면 키도 임대 ID도 턴 토큰도 보내지 않고 5로 끝납니다. `work next --wait`는 기다리는 사이 `agent-endpoint.json`이 없어지거나 그 `runId`·`proof`가 바뀌어도 다음 롱폴을 보내지 않고 5로 멈춥니다. `pid`나 `proof`가 없는 파일, `pid`의 프로세스가 끝난 파일도 연결하지 않고 5입니다.
   - 환경 변수 `WOOK_AGENT_URL`(`http://127.0.0.1:<포트>/agent/v1`)이 있으면 그 파일 대신 그것을 씁니다. 이 PC의 루프백 주소(`127.0.0.1`·`localhost`·`[::1]`)가 아니면 키를 보내지 않고 2로 끝납니다. **이 길은 듣는 쪽을 확인하지 않습니다** — 같은 파일의 `proof`를 `WOOK_AGENT_PROOF`로 함께 주면 확인합니다. 서버는 시작할 때마다 포트와 `proof`를 바꾸므로, 서버가 다시 시작할 때마다 두 값을 새 `agent-endpoint.json`의 `agentApi`·`proof`로 바꿔야 합니다(그대로 두면 닿지 않거나 확인에 실패해 5입니다). 가능하면 `WOOK_AGENT_URL` 없이 파일을 쓰세요.
5. 상태 파일 `~/.wook/state.json`: `wook`이 임대 ID와 받은 턴의 토큰을 둡니다(지금 사용자만 읽는 파일). 바꾸기 직전에 다시 읽고, 읽은 임대·턴이 그대로일 때만 바꿉니다. 한 사용자 계정의 `~/.wook`는 에이전트 하나가 씁니다 — 같은 계정에서 에이전트를 둘 돌리려면 집 폴더(`USERPROFILE`·`HOME`)를 따로 주세요.

### 서버 확인 (hello)

인증이 없는 길은 이것 하나입니다. 키를 실은 요청을 보낼 연결마다 그 연결에서 먼저 합니다(`wook`은 스스로 합니다).

- 요청: `POST /agent/v1/hello`, 본문 `{"nonce": "<새 난수 16~64바이트를 '=' 없는 base64url로>"}`. 키·턴 토큰 머리는 싣지 않습니다.
- 답: `{"ok": true, "mac": "…"}`. `mac` = base64url(HMAC-SHA256(키 = `proof`를 base64url로 푼 32바이트, 글 = `nonce`를 base64url로 푼 바이트)). 같은 식으로 계산한 값과 다르면 그 주소의 서버는 이 파일을 쓴 서버가 아닙니다 — 키를 보내지 마세요.
- 꼴이 틀린 본문은 400 `invalid`, 1KB를 넘으면 413입니다. 인증하지 못한 요청의 몫(1분에 120번)으로 세지 않고 제 횟수 상한도 없습니다 — 같은 PC의 다른 프로그램이 그 몫을 다 써도 hello는 답하므로, 맞는 키를 가진 에이전트는 멈추지 않습니다. 아무것도 바꾸지 않습니다(마지막 접속도 그대로, 기록도 남기지 않습니다).
- `proof`는 키가 아닙니다. 하지만 그 파일 밖으로 내지 마세요 — hello에도 `proof`는 보내지 않습니다(`nonce`만 보냅니다).

## 3. 일하는 고리

```text
wook seat claim
고리:
  wook work next --wait           → 일 하나 (JSON)
  일 처리 — instructions를 규칙으로, message를 일로, cwd를 작업 폴더로
    필요하면 wook work progress <턴 ID> --text "…"
    필요하면 wook tool <도구> --json '{…}'   (PowerShell 5.1이면 --json-file <파일>)
  답을 UTF-8 파일에 쓰고 wook work done <턴 ID> --file answer.md
  처리하는 동안 15초마다 wook seat heartbeat (임대 60초)
```

`seat claim`의 출력:

```text
메인 자리를 잡았습니다: 그록봇(X-0001), 세대 2
  임대 60초 — 15초마다 wook seat heartbeat를 보내세요. 임대를 싣는 요청(heartbeat·work next·progress·done)만 임대를 늘립니다
  일 받기: wook work next --wait (한 번에 25초까지 기다리고 되풀이합니다)
  인계 꾸러미: 있음 (세대 2, 1234자)
  임대는 C:\Users\<사용자>\.wook\state.json에 두었습니다 (지금 사용자만 읽는 파일)
```

Windows에서 `state.json`의 권한을 좁히지 못했으면 마지막 줄은 '…에 두었습니다 (권한을 좁히지 못해 그 폴더의 권한을 따릅니다 — 위 경고를 보세요)'이고, 표준 오류에 '경고: …의 권한을 지금 사용자만으로 좁히지 못했습니다 (그 폴더의 권한을 따릅니다)'가 먼저 나옵니다.

`work next`는 받은 일을 JSON으로 냅니다. 턴 토큰은 내지 않습니다(`state.json`에만 두고 `wook tool`이 씁니다). `work next`와 `tool`의 JSON은 ASCII만 씁니다 — 한글 같은 ASCII 밖의 글자는 `\uXXXX`(백슬래시 u와 네 자리)로 적으므로, Windows PowerShell 5.1이 코드 페이지 949로 읽어도(`wook work next | ConvertFrom-Json`) 깨지지 않고 어느 JSON 파서든 원래 글로 읽습니다. 아래 보기는 읽기 쉽게 한글로 적었습니다.

```json
{
  "turnId": "TN-0042",
  "workKey": "…",
  "kind": "main_general",
  "projectId": null,
  "generation": 2,
  "cwd": "C:\\Users\\<사용자>\\wook-workspace\\main",
  "instructions": "…서버가 CLI에 주는 시스템 프롬프트와 같은 글…",
  "message": "…이 턴의 일 — 이것이 일입니다…",
  "digest": "…현황 요약 (메인 대화 턴만, message에도 들어 있습니다)… 또는 null",
  "attachments": [{ "name": "a.png", "path": "…" }],
  "deadlineAt": "2026-11-11T03:10:00.000Z",
  "mcp": { "url": "http://127.0.0.1:<포트>/mcp" }
}
```

- `kind`: `main_general`(프로젝트 밖 메인 대화)·`main_project`(프로젝트의 메인 대화)·`review`(메인이 검수자인 일 — `cwd`는 검수 사본) 등.
- `--wait` 없이 일이 없으면 표준 출력은 비고, 표준 오류에 '지금은 받을 일이 없습니다 (다시 하거나 --wait로 기다리세요)'를 내고 0으로 끝납니다.
- 같은 임대로 턴이 살아 있는 동안 다시 `work next`하면 **같은 일**이 곧바로 옵니다 — 답을 잃어도 턴이 둘 생기지 않습니다.
- **같은 임대로 `work next --wait`를 둘 열지 마세요.** 새 롱폴이 앞의 롱폴을 곧바로 204로 끝냅니다. `wook`은 기다림의 절반도 안 돼 돌아온 204 뒤에는 1초 쉬고, 그런 204가 세 번 잇따르면 '다른 wook work next가 같은 임대로 기다리고 있습니다 — 한 임대로는 롱폴 하나만 엽니다 (새 롱폴이 앞의 것을 곧바로 끝냅니다). 다른 쪽을 끝내거나 그쪽이 받게 두세요'를 내고 1로 끝납니다.
- `deadlineAt`이 그 턴의 시간 상한입니다. 넘으면 서버가 턴을 끝냅니다.

나머지 출력:

```text
$ wook work progress TN-0042 --text "자료를 모으는 중"
진행 상황을 남겼습니다: TN-0042
$ wook tool get_overview --json '{}'
{ …도구 결과 JSON… }
$ wook work done TN-0042 --file answer.md
턴을 마쳤습니다: TN-0042 (끝 까닭 completed)
$ wook seat heartbeat
임대를 늘렸습니다: 세대 2 · 일을 받습니다 · 대기 중인 메인 일 0개 · 임대 끝 2026-11-11T03:01:15.000Z
$ wook seat status
메인 자리: 세대 2 · 앉아 있음 · 보유자 그록봇 (외부 에이전트 X-0001)
  이 에이전트에게 배정됨: 예
  이 에이전트의 임대: 2026-11-11T03:01:15.000Z까지
```

- `work done --outcome failed`는 일을 해내지 못한 턴입니다. 서버는 CLI가 비정상으로 끝난 것처럼 다룹니다(일을 다시 넣는 규칙도 같습니다).
- **답 파일은 UTF-8이어야 합니다.** 앞의 UTF-8 BOM은 뺍니다. UTF-8이 아니면(이 PC의 ANSI 코드 페이지 cp949, UTF-16 등) `wook`은 보내지 않고 2로 끝납니다: '마지막 답 파일(--file)이 UTF-8이 아닙니다 — UTF-8로 저장하세요 (PowerShell 5.1: Set-Content -Encoding utf8 — 그 셸의 > 와 Out-File은 UTF-16으로 씁니다, Python: open(…, "w", encoding="utf-8")). 아무것도 보내지 않았습니다'(UTF-16이면 '…이 UTF-16입니다 — …'). NUL 글자(U+0000)가 든 파일도 보내지 않습니다 — BOM 없는 UTF-16(ASCII만 든)이 그렇게 보입니다: '마지막 답 파일(--file)에 NUL 글자(U+0000)가 있습니다 — BOM 없는 UTF-16일 수 있습니다. …'(2). 빈 파일(빈칸만 든 파일 포함)은 `--outcome failed`일 때만 보냅니다 — 아니면 '마지막 답 파일(--file)이 비었습니다 — 답을 쓰거나, 해내지 못한 턴이면 --outcome failed를 붙이세요. 아무것도 보내지 않았습니다'(2).
  ```powershell
  # Windows PowerShell 5.1
  Set-Content -Encoding utf8 -Path answer.md -Value $answer
  ```
  ```python
  open("answer.md", "w", encoding="utf-8").write(answer)
  ```
- **Windows PowerShell 5.1에서는 `--json` 대신 `--json-file`을 쓰세요.** 그 셸은 다른 프로그램에 넘기는 인자의 큰따옴표를 지웁니다 — `--json '{"to":"launched:codex"}'`은 `{to:launched:codex}`로 넘어가 2가 됩니다. 인자를 UTF-8 파일에 쓰고 넘깁니다(파일은 답 파일과 같이 UTF-8만 받습니다):
  ```powershell
  '{"to":"launched:codex","reason":"대표 명령","note":"인계합니다"}' | Set-Content -Encoding utf8 args.json
  node out\server\wook.mjs tool hand_off_seat --json-file args.json
  ```
- `seat heartbeat`의 상태가 '메인 자리를 넘기는 중입니다 — 돌던 턴을 마치세요'면 교체 중이고, '메인 에이전트가 일시정지돼 일이 오지 않습니다'면 대표가 메인 에이전트를 멈춰 둔 것입니다.

**임대에 대해 꼭 알 것** (리드 결정 S7-16):
- **임대를 늘리는 것은 임대를 싣는 요청뿐입니다** — `seat/heartbeat`·`work/next`·`work/{turnId}/progress`·`work/{turnId}/finish`. 도구 호출(`tool/{name}`, MCP)과 보기(`GET seat`, `GET screens/{id}`)는 늘리지 않습니다. 일을 처리하는 동안(모델이 생각하는 동안 포함) 60초 넘게 임대를 싣는 요청이 없으면 임대가 끝나고, 돌던 턴은 비정상 종료로 끝나 다시 대기열에 들어갑니다.
  - `wook tool`·`wook screen capture`·`wook work next --wait`는 `state.json`에 임대가 있으면 기다리는 동안 heartbeat를 스스로 보냅니다. 그 heartbeat가 실패해도 명령은 제 결과를 내고, 그 실패는 표준 오류에 `(heartbeat) lease_expired: …`처럼 `(heartbeat)`로 시작하는 줄로 붙습니다 — 명령이 실패했으면 그 글 다음 줄이고, 명령이 성공했으면 표준 오류의 그 한 줄입니다(끝 코드는 명령 자신의 것). 그 줄이 있으면 다음 요청 전에 그 코드대로 합니다(5절).
  - 그 밖의 때(명령과 명령 사이)는 에이전트가 `wook seat heartbeat`를 보내야 합니다.
- **서버가 다시 시작하면 임대는 사라집니다.** 그 뒤의 요청은 409 `lease_expired` '모르는 임대입니다 — 서버가 다시 시작됐거나 오래전에 끝난 임대입니다. 다시 claim하세요'입니다(서버의 주소와 `proof`도 바뀝니다 — `agent-endpoint.json`을 다시 읽으면 됩니다. `wook`은 매번 읽습니다).
- **도구의 거부는 HTTP 200에 `ok: false`입니다** (`{"ok": false, "error": {"code": "forbidden", "message": "…"}}` — 코드는 도구의 거부 코드). `wook tool`은 표준 오류에 `도구 거부(<도구>) — <코드>: <글>`을 내고 1로 끝납니다. 401·409 같은 HTTP 오류와 다릅니다.

### curl로 (wook 없이)

bash(Git Bash 포함) 기준이고, 스크립트로 돌리는 꼴입니다(확인에 실패하면 `exit 5`로 멈춥니다). 키·토큰을 명령 줄에 쓰지 않으려고 머리를 파일에 둡니다(`printf`는 셸 안의 명령이라 키가 프로세스 목록에 나오지 않습니다). 그 파일은 지금 사용자만 읽게 만들고, 다 쓰면 지우세요.

**curl은 듣는 쪽을 확인하지 않습니다** — 그 주소에서 듣는 프로그램이 누구든 키를 보냅니다. 그래서 아래의 `k`는 키를 싣는 curl마다 바로 앞에서 서버 확인(`wook_check` — 2절 '서버 확인', `node`로 5초 안에)을 하고, 방금 확인한 주소로만 보냅니다(서버 PC에는 `node`가 있습니다). 그래도 확인과 curl은 다른 연결이라, 그 사이의 아주 짧은 틈에 듣는 쪽이 바뀌는 것은 막지 못합니다 — 그 틈까지 막으려면 `wook`을 쓰세요(`wook`은 키를 쓰는 바로 그 연결에서 확인합니다).

```bash
EP="<데이터 폴더>/agent-endpoint.json"
# 서버 확인 — 듣는 쪽이 이 파일의 proof를 아는 서버면 agentApi 주소를 내고 0, 아니면 아무것도 내지 않고 5 (5초 안에)
wook_check() {
  node -e '
const fs = require("fs"), c = require("crypto");
const e = JSON.parse(fs.readFileSync(process.argv[1], "utf8")), n = c.randomBytes(32);
fetch(e.agentApi + "/hello", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nonce: n.toString("base64url") }), redirect: "manual", signal: AbortSignal.timeout(5000) })
  .then((r) => (r.status === 200 ? r.json() : {}))
  .then((j) => {
    const ok = j.mac === c.createHmac("sha256", Buffer.from(e.proof, "base64url")).update(n).digest("base64url");
    if (ok) console.log(e.agentApi);
    process.exit(ok ? 0 : 5);
  }, () => process.exit(5));
' "$EP"
}
API=$(wook_check) || { echo "그 주소의 서버를 확인하지 못했습니다 — 키를 보내지 마세요"; exit 5; }

# 머리 파일은 지금 사용자만 — 폴더부터 좁힌다
mkdir -p ~/.wook
chmod 700 ~/.wook                                                                # Linux·macOS
MSYS_NO_PATHCONV=1 icacls "$(cygpath -w ~/.wook)" /inheritance:r /grant:r "$USERDOMAIN\\$USERNAME:(OI)(CI)F" > /dev/null   # Windows(Git Bash) — 안에 만드는 파일이 이 권한을 물려받습니다
(umask 077; printf 'Authorization: Bearer %s\n' "$WOOK_AGENT_KEY" > ~/.wook/auth.txt)
J='Content-Type: application/json'
# 키를 싣는 curl — 바로 앞에서 다시 확인하고, 방금 확인한 주소로만 보낸다(그 주소가 처음의 $API와 다르면 보내지 않고 멈춘다)
# 쓰는 법: k <경로> [curl 옵션…] — 경로는 /seat/claim처럼 (주소 전체가 아니라)
k() {
  local a p="$1"; shift
  a=$(wook_check) || { echo "그 주소의 서버를 확인하지 못했습니다 — 키를 보내지 마세요" >&2; exit 5; }
  [ "$a" = "$API" ] || { echo "서버 주소가 바뀌었습니다(서버가 다시 시작함) — 키를 보내지 않았습니다. 새 agent-endpoint.json으로 처음부터 다시 하세요" >&2; exit 5; }
  curl -s -H @"$HOME/.wook/auth.txt" "$@" "$a$p"
}

k /seat/claim -H "$J" -d '{}'                                                 # → {"ok":true,"agentId":"X-0001","generation":2,"leaseId":"…","leaseMs":60000,…}
LEASE="…"                                                                      # 위 답의 leaseId
k /seat                                                                        # → {"ok":true,"assigned":true,"generation":2,"state":"active",…}
k /seat/heartbeat -H "$J" -d "{\"leaseId\":\"$LEASE\"}"
k /work/next -w '\n%{http_code}\n' -H "$J" -d "{\"leaseId\":\"$LEASE\",\"waitMs\":25000}"
                                                                               # 일이 없으면 본문 없이 204, 있으면 200과 일(JSON — mcp.token 포함)
TURN="TN-…"                                                                    # 일의 turnId
(umask 077; printf 'X-Wook-Turn-Token: %s\n' "<일의 mcp.token>" > ~/.wook/turn.txt)
k /tool/get_overview -H @"$HOME/.wook/turn.txt" -H "$J" -d '{}'               # → {"ok":true,"data":{…}}
k "/work/$TURN/progress" -H "$J" -d "{\"leaseId\":\"$LEASE\",\"text\":\"진행 중\"}"
k "/work/$TURN/finish" -H "$J" -d "{\"leaseId\":\"$LEASE\",\"finalText\":\"답\",\"outcome\":\"completed\"}"   # → {"ok":true,"endReason":"completed"}
k /seat/release -H "$J" -d "{\"leaseId\":\"$LEASE\"}"
rm ~/.wook/auth.txt ~/.wook/turn.txt
```

- `k`는 키를 싣는 curl마다 먼저 확인하고, 방금 확인한 주소가 처음에 받은 `$API`와 같을 때만 그 주소로 보냅니다. 서버가 다시 시작해 주소가 바뀌었으면(옛 포트를 다른 프로그램이 차지했어도) 그다음 `k`는 아무것도 보내지 않고 '서버 주소가 바뀌었습니다(서버가 다시 시작함) — 키를 보내지 않았습니다. …'로 멈춥니다(5) — 새 `agent-endpoint.json`으로 처음부터(`API=…`와 `claim`) 다시 합니다. 같은 포트로 다시 떴으면 확인을 통과한 그 새 서버로 가고, 임대를 싣는 요청은 `lease_expired`('모르는 임대입니다 — …')를 받습니다 — `claim`부터 다시 합니다. 같은 고리를 되풀이하는 에이전트라면 연결 오류나 에이전트 API가 아닌 답 뒤에도 확인부터 다시 합니다.
- 오류는 모두 `{"ok": false, "error": {"code": "…", "message": "…"}}`이고 `message`는 한국어 한 문장입니다.
- 키나 턴 토큰을 주소(쿼리 — `?key=…`, `?token=…`, `wsk_`·`wtt_`로 시작하는 값)에 넣으면 무엇이든 401입니다.
- PowerShell 5.1에서는 `curl`이 `Invoke-WebRequest`의 다른 이름입니다 — `curl.exe`로 쓰고, JSON 따옴표가 바뀌지 않게 본문은 파일로 넘기세요(`-d "@body.json"`).

## 4. MCP와 REST

도구는 두 길로 부릅니다. 둘은 같은 처리기, 같은 규칙, 같은 기록입니다(도구 호출 기록은 M-MAIN의 것으로 남습니다).

| | MCP | REST (`wook tool`) |
|---|---|---|
| 주소 | 일의 `mcp.url` (`…/mcp`) | `POST /agent/v1/tool/{name}` |
| 인증 | `Authorization: Bearer <턴 토큰 wtt_…>` 하나 | 에이전트 키(`Authorization`)와 그 턴의 토큰(`X-Wook-Turn-Token`) 둘 다 — 같은 에이전트의 것이어야 합니다 |
| 본문 | JSON-RPC `tools/call` (`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_overview","arguments":{}}}`, `Accept: application/json, text/event-stream`) | 도구 인자 JSON 객체 그대로 |
| 거부 | `result.isError: true`, 글에 `{"error": "<코드>", "message": "…"}` | 200 `{"ok": false, "error": {"code", "message"}}` |
| 이미지 | `screen_capture` 등의 결과에 이미지가 붙습니다 | 붙지 않습니다 — `GET /agent/v1/screens/{id}`나 `wook screen capture` |

- 도구 목록은 메인(`main`) 역할의 것이고, 검수 일이면 검수자 도구가 더해집니다. MCP의 `tools/list`로 봅니다.
- `wook`은 턴 토큰을 내지 않습니다. MCP로 도구를 쓰려면 `work/next`를 직접 불러 `mcp.token`을 받으세요(위 curl).
- 턴이 끝나면(`finish`·시간 상한·정지·교체) 그 턴의 토큰은 곧바로 죽습니다 — 그 뒤의 도구 호출은 401입니다.

## 5. 임대와 409

| 코드 | 뜻 | 할 일 |
|---|---|---|
| `lease_expired` | 임대가 끝났습니다 — 60초 동안 임대를 싣는 요청이 없음 · 스스로 놓음(`seat release`) · 긴급 정지를 푼 뒤 · 모르는 임대(서버가 다시 시작함) | `wook seat claim` |
| `lease_superseded` | 같은 에이전트가 다시 `claim`해 이 임대는 끝났습니다. 그 임대가 받아 간 턴은 비정상 종료로 끝나 다시 대기열에 들어갔습니다 | 새 임대를 씁니다 (`wook`은 `claim`할 때 `state.json`을 새 임대로 바꿉니다) |
| `seat_changed` | 메인 자리가 다른 보유자에게 넘어갔습니다: '메인 자리가 바뀌었습니다 (이 임대는 세대 n, 지금은 세대 m — <보유자>)' | 일을 그만둡니다. 다시 배정되면 `claim` |
| `switching` | 메인 자리를 넘기는 중입니다 (`claim`할 때) | 교체가 끝난 뒤 `wook seat status`로 봅니다 |
| `stopped` | 긴급 정지 중입니다: '긴급 정지 중입니다 — 임대와 턴 토큰을 폐기했습니다. 대표가 정지를 풀면 다시 claim하세요' | 대표가 풀 때까지 기다렸다가 `claim` |
| `turn_ended` | 그 턴은 이미 끝났습니다 (다시 보낸 `finish`, 시간 상한·만료로 끝난 턴) | 다음 일을 받습니다 |

- 409가 아닌 거부: 403 `not_assigned`(이 에이전트에게 배정되지 않음 — 지금 보유자와 세대를 말합니다), 404 `not_found`, 400 `invalid`, 413 `too_large`, 429 `rate_limited`(`Retry-After` 초 뒤에), 500 `internal`. `wook`은 모두 1로 끝납니다.
- 끝난 임대는 끝난 까닭을 기억하므로, 늦게 온 요청도 위 코드 가운데 참인 것을 받습니다.

## 6. 정지와 교체

- `wook stop`은 대표의 긴급 정지와 같습니다. 등록되고 폐기되지 않은 키면 자리에 앉지 않은 에이전트도 걸 수 있습니다. 푸는 것은 대표뿐입니다.
  ```text
  $ wook stop
  긴급 정지를 걸었지만 종료를 확인하지 못한 실행이 있습니다. 새 실행은 막았고, 실행 0개를 멈추고 작업 0개를 보류했습니다. 정지 해제는 대표만 합니다.
    - 메인 에이전트(그록봇 — 외부): 외부 메인 에이전트: 턴 토큰과 임대를 폐기함 — 프로세스 종료는 확인할 수 없음 (종료 확인 불가)
  ```
  살아 있는 임대나 턴이 있던 외부 보유자는 늘 이 실패 줄을 남깁니다 — 서버는 그 프로세스가 끝났는지 알 수 없습니다. 실행 중인 일이 없었으면 '긴급 정지를 걸었습니다. 실행 중인 작업은 없었고, 새 실행을 막았습니다. 정지 해제는 대표만 합니다.'입니다.
- 정지하면 돌던 외부 턴은 `user_stop`으로 끝나 다시 대기열에 들어갑니다. 정지 중의 `claim`·`heartbeat`·`work next`는 409 `stopped`이고, 응답 없음으로 세지 않습니다.
- **이 에이전트에게서 다른 보유자로** (운영자의 `seat assign`이나 메인의 `hand_off_seat`):
  1. 돌던 턴은 운영자가 정한 마무리 시간(기본 2분)까지 기다렸다가 멈춥니다 — 그 안에 `work done`하세요. heartbeat의 상태가 '메인 자리를 넘기는 중입니다'입니다.
  2. 인계 메모 턴: 이 에이전트가 2분 안에 `work next`로 오면 인계 메모를 쓰는 일이 옵니다. 오지 않으면 '외부 보유자가 연결돼 있지 않음'으로 건너뜁니다.
  3. 그 뒤 임대와 토큰을 거둡니다. heartbeat는 409 `seat_changed`(새 보유자를 말합니다)입니다.
- **스스로 넘기기**: `wook tool hand_off_seat --json '{"to":"launched:codex","reason":"…","note":"…"}'`(PowerShell 5.1이면 3절의 `--json-file` 꼴). 넘기는 것은 이 턴을 `work done`한 뒤에 마무리되고, 새 보유자의 첫 턴이 인계 꾸러미를 받습니다.
- **스스로 물러나기**: `wook seat release --note "…"` → '메인 자리에서 물러났습니다 (세대 2). 서버는 다른 보유자를 앉히지 않습니다 — 자리는 응답 없음으로 남고 운영자가 배정합니다. 다시 잡으려면 wook seat claim'. 돌던 턴은 비정상 종료로 끝나 다시 대기열에 들어갑니다.
- **키 폐기**(`wook-server agent revoke`): 그 뒤 모든 요청은 401입니다. 자리는 그대로이고 응답 없음('키가 폐기됨 (운영자)')이 됩니다.

## 7. 화면 (서버 PC — Windows, 6단계)

- `wook screen capture --out a.png`: 받은 턴의 토큰으로 `screen_capture` 도구를 부르고, 결과의 `capture_id`로 `GET /agent/v1/screens/{id}`를 받아 파일에 씁니다.
  ```text
  화면을 찍어 저장했습니다: C:\work\a.png (캡처 SC-000123, 1280×720, 98765바이트, 30초 동안 gui_input에 씁니다)
  ```
  서버가 붙인 알림(화면이 모두 검음 등)이 있으면 그 아래 '  알림: …' 줄이 붙습니다.
- `capture_id`는 30초 동안 `gui_input`(`wook tool gui_input --json '{…, "capture_id": "SC-…"}'` — PowerShell 5.1이면 `--json-file`)에 씁니다. 좌표는 그 캡처 이미지의 픽셀입니다.
- `GET screens/{id}`는 키와 그 턴의 토큰이 함께 있어야 하고, 지금 세대의 턴 토큰과 지금 세대에 찍은 캡처만 줍니다(아니면 401이나 403 `seat_changed`). 캡처는 24시간·최근 500장까지만 남습니다(지난 것은 404).
- **화면 확인**: 처음 앉으면 '화면 확인' 일이 다른 메인 턴처럼 옵니다(메시지에 `(화면 확인 g2:external:X-0001)`). `wook tool get_screen_check`로 시험 이미지를 보고 `wook tool answer_screen_check --json '{"code":"<네 자리 숫자>","request_id":"<새 값>"}'`로 답한 뒤 `work done`합니다. REST(`wook tool`)의 답에는 이미지가 붙지 않습니다(`image`가 `"file_only"`) — 시험 이미지는 그 답의 `file`(이 PC의 PNG 파일 경로)을 직접 여세요. `wook`에는 그 파일을 받아 오는 명령이 없습니다. 이 확인은 이 에이전트에만 해당합니다 — 다른 보유자에게 넘어가면 새로 합니다.
- 서버 PC 앞 사람이 입력하면 화면 조작이 30초 멈추고, 긴급 정지·턴 끝·교체 때 서버가 화면 조작을 풀어 줍니다. 비밀번호는 치지 않습니다(SERVER_INSTALL 9절).

## 8. 비밀 값과 가리기

- 에이전트 키(`wsk_…`)는 운영자가 등록할 때 한 번만 보입니다. 서버는 해시만 둡니다 — 잃어버리면 운영자가 폐기하고 새로 등록합니다(키 바꾸기 명령은 없습니다).
- 턴 토큰(`wtt_…`)은 턴마다 새로 나오고 그 턴이 끝나면 죽습니다.
- `agent-endpoint.json`의 `proof`는 키가 아니지만 그 파일 밖으로 내지 않습니다(2절 '서버 확인'). `wook`은 그 값을 어떤 출력에도 내지 않습니다.
- 서버는 `wsk_`·`wtt_` 꼴의 값을 기록·활동·일지·알림에서 가립니다. 그래도 키와 턴 토큰을 진행 글·답(`finalText`)·도구 인자에 쓰지 않습니다 — 줄바꿈으로 나뉜 키·토큰은 가리지 못해 반쪽씩 그대로 저장됩니다.
- 키·토큰은 주소(쿼리)에 넣지 않습니다(401). `wook`은 키·임대 ID·턴 토큰을 어떤 출력에도 내지 않습니다. `~/.wook/state.json`과 `agent.json`은 지금 사용자만 읽는 파일입니다.
- 같은 OS 계정의 프로그램은 이 파일들과 서버의 데이터 폴더를 읽을 수 있습니다 — 서버 PC의 운영자와 에이전트를 믿는다는 전제입니다(SERVER_DESIGN 9.2).

## 9. 한도

| 무엇 | 한도 |
|---|---|
| 임대 · heartbeat · 롱폴 | 60초 · 15초마다 · 한 번에 25초까지 (`waitMs`가 더 크면 25초로) — 실제 값은 `claim`의 답(`leaseMs`·`heartbeatMs`·`pollMaxMs`) |
| 열린 `work/next` | 에이전트마다 하나 — 새 것이 옛 것에 204를 줍니다 |
| 요청 본문 | JSON 1MB, 도구 인자 4MB (넘으면 413), hello 1KB |
| 진행 글 · 마지막 답 | 4,000자 · 20,000자 (넘으면 400 `invalid`) |
| 요청 수 (1분) | 키마다 600번, 인증하지 못한 요청은 모두 합쳐 120번 (넘으면 429와 `Retry-After`) — 서버 확인(hello)은 세지 않고 그 상한도 없습니다 |
| 턴 시간 | 일의 `deadlineAt`까지 |
| `wook`의 기다림 | 서버 확인 5초, 보통 요청 30초, `work done`·`stop` 60초, `tool`·`screen capture`(도구 호출과 화면 받기 각각)는 받은 턴의 `deadlineAt` + 60초(적어도 60초, 많아야 6시간), 롱폴 한 번 25초 + 30초 — 조금씩 흘려 보내는 답도 이 시간이 지나면 끊고 5 |
| `wook`이 받는 답의 크기 | 8MB (화면 PNG는 64MB) — 넘으면 끊고 5 |
| 접속 | 이 PC의 루프백만 (다른 PC의 에이전트는 받지 않습니다) |

## 10. 문제가 생기면 — 끝 코드별

`wook`은 서버의 거부를 `<코드>: <서버의 글>` 한 줄로 표준 오류에 냅니다.

- **1 — 거부**
  - `not_assigned: 메인 자리는 이 에이전트(X-0001)에게 배정돼 있지 않습니다 — 지금 보유자: …` → 운영자에게 `wook-server seat assign external:X-0001`을 부탁합니다.
  - `도구 거부(<도구>) — <코드>: <글>` → 도구가 거부했습니다(HTTP 200 `ok:false`). 인자나 상황을 고쳐 다시 부릅니다.
  - '임대가 없습니다 — wook seat claim으로 메인 자리를 먼저 잡으세요 (…state.json에 임대가 없음)' / '받은 턴이 없습니다 — wook work next로 일을 받은 뒤 부르세요 (도구와 화면은 그 턴의 토큰으로 부릅니다)' → 이 PC에서 막은 것입니다(서버에 보내지 않았습니다).
  - '다른 wook work next가 같은 임대로 기다리고 있습니다 — …' → 같은 임대로 롱폴을 둘 열었습니다(3절). 하나만 남깁니다.
  - '받은 일(TN-…)을 state.json에 두지 않았습니다 — 기다리는 사이 다른 wook이 state.json의 임대나 턴을 바꿨습니다 (…)' → 같은 계정의 다른 `wook`이 그사이 자리를 다시 잡았습니다. `wook seat status`로 본 뒤 다시 합니다.
  - `rate_limited` → 그 글의 초만큼 기다립니다. `not_found`·`invalid`·`too_large` → 그 글대로 고칩니다.
- **2 — 쓰임새·설정**: 명령을 잘못 쳤거나(적은 값은 되풀이하지 않습니다), 키가 없거나('에이전트 키가 없습니다 — …'), `agent.json`을 다른 계정도 읽을 수 있거나(그 글에 열린 계정과 차례로 할 `icacls` 명령이 있습니다 — 그대로 하면 됩니다), `WOOK_AGENT_URL`이 루프백이 아니거나 `WOOK_AGENT_PROOF`의 꼴이 틀렸거나, `work done`의 답 파일이나 `--json-file`의 인자 파일을 읽지 못했거나 UTF-8이 아니거나(3절), 답 파일이 비었습니다(`--outcome failed` 밖). `--file`·`--json-file`·`--data-dir`·`--out`으로 준 경로는 거부 글에 되풀이하지 않습니다('캡처를 --out의 파일에 쓰지 못했습니다 (…) — 경로를 확인하세요 …'는 1).
- **3 — 401**: `unauthorized: 에이전트 키가 맞지 않거나 폐기됐습니다`(틀린 키와 폐기된 키는 같은 글입니다) → 운영자에게 확인합니다. 도구·화면에서 `unauthorized: 턴 토큰이 없거나 이미 폐기됐습니다 …`면 그 턴이 이미 끝났습니다 → `wook work next`.
- **4 — 409**: 5절의 표대로 합니다. 가장 흔한 것은 `lease_expired`입니다 — 일하는 동안 heartbeat를 잊었거나(도구 호출은 임대를 늘리지 않습니다), 서버가 다시 시작해 임대를 모릅니다('모르는 임대입니다 — …'). `wook seat claim`으로 다시 잡습니다.
- **5 — 닿지 못함**
  - '이 데이터 폴더(…)로 실행 중인 욱채 서버가 없습니다 (agent-endpoint.json 없음) — …' → 서버가 떠 있는지, `--data-dir`·`WOOK_DATA_DIR`이 서버와 같은지 봅니다(`--data-dir`로 준 폴더면 '--data-dir로 준 데이터 폴더로 …').
  - '…agent-endpoint.json이(가) 가리키는 서버(pid n)가 끝났습니다 — …' → 서버가 끝나며 파일이 남았습니다. 서버를 다시 띄우면 새 주소로 다시 씁니다(`wook`은 그 포트로 키를 보내지 않았습니다).
  - '…agent-endpoint.json에 서버 pid가 없습니다 — …' / '…에 서버 확인값(proof)이 없거나 꼴이 틀립니다 — …' → 지금 판의 서버가 쓴 파일이 아닙니다. 서버를 다시 시작하면 새로 씁니다(키를 보내지 않았습니다).
  - '그 주소(…)에서 듣는 쪽이 agent-endpoint.json을 쓴 욱채 서버임을 증명하지 못했습니다 (<까닭>) — 키를 보내지 않았습니다. …' → 그 포트를 다른 프로그램이 씁니다(끝난 서버가 남긴 파일일 수 있습니다). 까닭이 `HTTP 429`여도 같습니다 — 이 서버는 hello에 429로 답하지 않습니다. 키는 가지 않았습니다. 서버가 떠 있는지 운영자에게 확인합니다. 명령이 도는 사이 서버가 바뀌었으면(정상 종료 뒤 다른 프로그램이 포트를 차지함) 이 글이 그때 나옵니다 — 그 새 연결에는 키를 쓰지 않았습니다. `WOOK_AGENT_URL`을 쓰면 '…WOOK_AGENT_PROOF를 아는 욱채 서버임을 증명하지 못했습니다 …' — 두 값을 새 `agent-endpoint.json`의 값으로 바꿉니다.
  - '서버가 끝났습니다 (…agent-endpoint.json 없음) — 기다리기를 멈췄습니다. 키를 보내지 않았습니다 — …' / '서버가 다시 시작했거나 바뀌었습니다 (…의 runId·proof가 바뀜) — 기다리기를 멈췄습니다. …' → `work next --wait`가 기다리는 사이 서버가 끝나거나 다시 시작했습니다. 서버가 다시 뜨면 `wook seat claim`부터 합니다.
  - '욱채 서버의 에이전트 API(…)에 닿지 못했습니다 (ECONNREFUSED) — …' → 서버가 끝났거나 다시 시작해 포트가 바뀌었습니다. '(n초 안에 답이 끝나지 않음)'이면 그 시간 안에 답이 끝나지 않았습니다.
  - '그 주소에서 답한 쪽이 욱채 에이전트 API가 아닙니다 (HTTP n) — 키를 그 프로그램에 보냈을 수 있습니다: 운영자에게 이 에이전트를 폐기(wook-server agent revoke)하고 새로 등록(agent add)해 달라고 하세요. …' → 키를 실은 요청에 다른 프로그램이 답했습니다(서버 확인을 하지 않는 `WOOK_AGENT_URL`만 쓴 때 등). 키가 그 프로그램에 갔을 수 있으니 폐기하고 새로 받습니다. '(답이 8MB를 넘음)'도 같습니다.
- 명령 뒤 표준 오류에 `(heartbeat) <코드>: <글>` 줄이 더 있으면, 기다리는 동안 보낸 heartbeat가 거부된 것입니다(대개 `lease_expired`·`seat_changed`·`stopped`). 명령의 결과와 끝 코드는 그 앞 줄과 표준 출력의 것입니다. 다음 요청 전에 그 코드대로 합니다.
- 도구가 거부해도(HTTP 200 `ok:false`) 임대·턴은 그대로입니다. 401·409와 헷갈리지 마세요.
- 서버가 다시 시작하면 임대도 토큰도 없어집니다 — `lease_expired`('모르는 임대입니다')를 받으면 `claim`부터 다시 합니다. 돌던 턴은 서버가 다시 시작할 때 끝내고 다시 넣습니다.
