# 욱채 서버 — Linux 묶음

이 폴더는 욱채 서버(화면 없는 Node 서버)를 미리 빌드한 묶음입니다. 대표가 휴대폰이나 다른 PC의 브라우저에서 Tailscale로 들어와 쓰는 서버를 이 PC에 둡니다.

- 기준 시스템: Ubuntu 24.04 (x86_64·arm64). 컨테이너와 WSL은 서버 자리로 쓰지 않습니다.
- 필요한 것: Node.js 24 이상(Ubuntu의 `nodejs` 꾸러미는 18판이라 안 됩니다 — `docs/SERVER_SETUP.md`의 L1단계), `git`. 서버를 돌릴 보통의 로그인 사용자(root 아님).
- 빌드는 하지 않습니다. 이 묶음이 `docs/SERVER_SETUP.md`의 L2단계(저장소와 빌드)를 대신합니다.

## 시작

묶음 파일 두 개가 있는 폴더에서:

```sh
sha256sum -c wook-server-<판>-linux-<커밋 7자>.tar.gz.sha256
tar -xzf wook-server-<판>-linux-<커밋 7자>.tar.gz -C ~
cd ~/wookagent
scripts/wook-server --help
```

- 첫 줄은 `…tar.gz: OK`여야 합니다. `FAILED`면 풀지 않습니다.
- 마지막 줄은 Node 24 이상이 PATH에 있어야 돕니다.
- 그다음은 [docs/ai/INSTALL.md](docs/ai/INSTALL.md)(단계별 차례), 또는 [docs/SERVER_SETUP.md](docs/SERVER_SETUP.md)의 Linux 편(L2를 건너뜀)을 따릅니다.

## AI 도우미에게 맡길 때

- Claude Code나 Codex CLI 같은 AI를 이 폴더에서 띄우고 [AGENTS.md](AGENTS.md)부터 읽게 합니다. Claude Code는 `CLAUDE.md`를 거쳐 AGENTS.md를 저절로 읽습니다.
- AI는 서버를 돌릴 그 사용자로 띄웁니다(root나 `sudo -u`로 띄우지 않습니다).
- 사람이 할 일이 남습니다: `sudo` 암호가 드는 줄, CLI·Tailscale·구글 로그인, 비밀 값 넣기, 대표의 휴대폰 로그인, 다시 시작. AI는 그 자리에서 멈추고 칠 줄을 보여 줍니다.

## 알아 둘 것

- 서버의 자료는 데이터 폴더(문서에서는 `~/wook-data`)에 따로 둡니다. 새 묶음으로 바꿀 때는 이 앱 폴더만 바꾸고 데이터 폴더는 그대로 둡니다 — 방법은 [docs/ai/OPERATE.md](docs/ai/OPERATE.md)의 '새 묶음으로 바꾸기'.
- `BUILD-INFO.json`에 이 묶음의 판·커밋·빌드 시각·필요한 Node가 있습니다.
