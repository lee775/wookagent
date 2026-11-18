# 메인 에이전트와 업무 대화

2026-11-18. 하단 명령줄을 오른쪽 아래의 대화창으로 옮겼다. 사무실을 보면서 지시하고 답변을 읽을 수 있다. 이전 기록은 [command-bar](../command-bar/README.md)에 있다.

## 화면과 동작

런처는 짙은 녹색 바탕에 노트 아이콘을 넣은 작은 직사각형이다. 화면의 종이색, 녹색 메뉴, 얇은 테두리와 어울리도록 만들었다. 런처에는 "메인과 대화"와 읽지 않은 답변 수를 표시한다. 별도의 답변 미리보기는 추가하지 않았다. 기존 알림함과 답변 토스트는 유지한다.

작은 대화창은 최대 384px 너비와 590px 높이다. 오른쪽 아래에 열리고 배경을 어둡게 덮지 않는다. 데스크톱에서는 본문 오른쪽에 대화창 공간을 확보한다. 사무실의 이름과 목록을 대화창 뒤에 숨기지 않고, 남은 영역에서 계속 조작할 수 있다. 하단 명령줄에 쓰던 데스크톱 92px, 모바일 153px 행을 없앴다.

"대화 넓게 보기"는 최대 640px 너비와 화면 높이에 맞춘 긴 대화창을 연다. 이때도 본문 영역을 조정한다. "대화 작게 보기"로 돌아온다. 휴대폰은 작은 대화창부터 화면 대부분을 사용하므로 넓게 보기에서는 위아래 여백을 조금 더 줄인다.

상단에는 업무 대화 제목, 크기 조절과 닫기 버튼, 대화 대상이 있다. 대표의 메시지는 오른쪽의 옅은 녹색 종이, 에이전트의 메시지는 왼쪽의 종이색으로 구분한다. 시스템 메시지는 가는 세로선과 작은 글씨로 표시한다. 메시지는 줄바꿈을 보존하고 첨부 이름으로 내려받을 수 있다.

## 열림 상태와 읽음 처리

- 처음에는 닫혀 있다. 런처를 한 번 누르면 작은 대화창이 열리고 입력창으로 포커스가 간다.
- 닫기 버튼, 런처, Esc로 닫는다. 포커스는 런처로 돌아간다. 입력기 조합 중의 Esc는 대화창을 닫지 않는다.
- 화면을 이동해도 대화창, 작성 중인 내용과 첨부를 유지한다. 프로젝트 화면으로 이동하면 해당 프로젝트를 대화 대상으로 선택한다. 대상 선택에 따라 그 대상의 기록을 가져온다.
- 닫아도 업로드는 계속된다. 다시 열면 작은 대화창으로 시작한다. 새로고침 시 열림 상태를 복구하지 않는다. 알림의 대화 링크로 들어온 경우에는 기존 `subscribeConversation` 경로로 요청한 대화를 연다.
- 답변이 도착했다는 이유로 대화창을 자동으로 열지 않는다. 읽지 않은 답변 수는 모든 대상의 합계다.
- 현재 대상의 답변이 대화 영역 안에 보이고 페이지가 활성 상태일 때 읽음 처리한다. 다른 대상, 스크롤 영역 밖, 닫힌 대화창, 다른 탭, 차단 중인 대화창의 답변은 읽음 처리하지 않는다.
- 기록 위쪽을 읽는 중에는 새 답변이 와도 읽던 위치를 유지한다. 맨 아래로 돌아오면 새 메시지를 따라간다. 다른 대상을 선택하거나 다시 열 때는 최근 대화로 이동한다.
- `subscribeCommand`는 지정한 대상과 초안을 채우고 대화창을 연다. `subscribeConversation`은 작성 중인 글을 지우지 않고 요청한 대화를 연다. 어느 쪽도 명령을 자동 전송하지 않는다.

기록은 기존 `command.history`의 최근 60개를 사용한다. 알림과 답변의 연결은 기존 대상과 본문 비교를 유지한다. 계약에 알림이 가리키는 대화 메시지 ID가 없으므로 같은 대상에서 동일한 문장이 반복되면 정밀한 일대일 연결에는 한계가 있다.

## 겹침과 휴대폰

| 요소 | 동작 |
| --- | --- |
| 상단 긴급 정지와 알림함 | 대화창 위쪽에 남는다. 대화창이 버튼을 덮지 않는다. 알림 메뉴는 기존 레이어를 사용한다. |
| 팀원 상세, 데스크톱 | 대화창과 런처를 상세창 왼쪽으로 이동한다. 상세 닫기는 오른쪽 위에 남는다. |
| 팀원 상세, 휴대폰 | 상세창을 위에 둔다. 뒤의 대화창과 런처는 `inert`로 처리하고 답변을 읽음 처리하지 않는다. 상세창을 닫으면 이전 대화창이 돌아온다. 상세창의 "메인 에이전트에게 말하기"도 기존처럼 초안을 연다. |
| 모달과 빠른 이동 | 모달이 우선한다. 대화창은 `inert`이고 파일 드롭을 거절한다. 파일의 브라우저 기본 탐색도 막는다. Esc는 모달에 남겨 두고, 모달을 닫은 뒤 대화를 이어 간다. |
| 토스트 | 대화창보다 위에 둔다. 데스크톱에서는 본문 왼쪽 아래, 휴대폰에서는 상단 버튼과 상세 닫기 아래에 표시한다. |
| 파일 드래그 안내 | 닫힌 상태에서도 표시한다. 데스크톱에서는 런처 위, 휴대폰에서는 상단 버튼 아래에 놓는다. 클릭을 가로채지 않는다. |

390px에서는 대화창 너비가 화면 너비에서 16px을 뺀 값이다. 상단 조작부와 닫기 버튼을 남긴다. `VisualViewport`의 높이와 이동량에 맞춰 대화창과 런처를 배치하므로 키보드가 올라오면 입력부도 올라간다. 입력 글씨는 16px이다. 첨부 목록은 독립적으로 스크롤한다. 모션 감소 설정에서는 대화창 애니메이션과 전환을 끈다.

대화창은 비모달 `dialog`다. 바깥 화면을 계속 사용할 수 있도록 키보드 포커스를 가두지 않는다. 새 메시지는 `log`의 `aria-live="polite"`로 알린다.

## 첨부와 전송

기존 `UploadQueue`, `fileDrop.ts`, `useCommandDrop.ts`를 재사용한다. 웹은 업로드 ID, 데스크톱 드롭과 이미지 붙여넣기는 데이터 URL을 보낸다. 데스크톱 파일 선택은 기존 `system.pickFiles` 경로를 유지한다.

파일은 창 어디에 놓아도 현재 대상에 첨부한다. 대화창이 닫혀 있으면 열고 첨부 칩과 안내를 보여 준다. 폴더는 말로 거절하고 함께 놓은 파일은 받는다. 파일당 50 MB 제한을 유지한다. 텍스트와 링크 드래그는 브라우저에 그대로 맡긴다. 드래그 취소, 창 이탈, Esc, 포커스 이탈, 숨겨진 페이지에서도 안내가 남지 않는다.

웹 칩에는 진행률, 준비됨, 오류와 재시도가 있다. 업로드 대기, 진행, 오류 또는 데스크톱 파일 읽기 중에는 전송을 막는다. 전송 중에는 "보내는 중…"을 표시한다. Enter로 보내고 Shift+Enter로 줄을 바꾼다. 조합 중인 Enter와 키 코드 229는 전송하지 않는다.

데스크톱 파일 선택 결과에는 파일 크기가 없다. 이 경로의 50 MB 확인은 기존 파일 선택 구현에 맡긴다. 선택 결과를 받은 렌더러에서도 다시 검사하려면 계약에 크기 정보가 필요하다. 공유 계약과 실제 파일 선택 구현은 수정하지 않았다.

## 리드 브라우저 테스트의 진입점

입력창은 이제 닫힌 상태의 접근성 트리에 없다. 입력 전에 런처를 열어야 한다. 이름은 **"메인 에이전트 대화"**이며 열려 있을 때도 같다. `aria-expanded`로 상태를 확인할 수 있다.

```js
const launcher = page.getByRole('button', { name: '메인 에이전트 대화', exact: true });
if (await launcher.getAttribute('aria-expanded') === 'false') await launcher.click();
await page.getByRole('textbox', { name: '명령 입력' }).fill('작업을 정리해 줘');
```

| 이름 또는 선택자 | 상태 |
| --- | --- |
| textbox "명령 입력" | 유지. 입력창은 DOM에 하나이며 패널 안에 있다. |
| button "보내기" | 유지. 전송 중 이름은 "보내는 중…"이다. |
| button "파일 첨부" | 유지. |
| file input "첨부할 파일 선택" | 유지. 숨겨진 파일 입력이다. |
| combobox "명령 대상" | 유지. |
| `.upload-chip`, "첨부 준비됨" | 유지. |
| button "<파일 이름> 첨부 제거" | 웹에서 유지. 데스크톱도 같은 이름으로 통일했다. 이전 데스크톱의 일반 이름 "첨부 제거"는 제거했다. |
| button "<파일 이름> 다시 올리기" | 유지. |
| `.upload-chip [role=alert]` | 유지. |
| `.conversation .bubble`, `.conversation .bubble-owner` | 유지. 메시지 첨부 링크는 파일 이름을 포함한다. |
| `.command-drop-hint` | 유지. `.command-bar` 안에 있지 않다. `.command-bar` 자체가 사라졌다. 창 가운데에서 드롭하는 테스트는 그대로 바깥 드롭이다. |
| `.command-file-over` | 유지. 이제 페이지의 드래그 안내에 붙는다. |
| `.toast`, "명령을 보냈습니다" | 유지. |
| button "메인 에이전트에게 말하기" | 다른 화면에서 유지. |
| button "메인 에이전트 대화" | 새 런처. `aria-controls="main-agent-chat"`. |
| dialog "메인 에이전트 대화창" | 새 비모달 패널. `.agent-chat`. |
| button "대화 닫기" | 새 닫기 버튼. |
| button "대화 넓게 보기", "대화 작게 보기" | 새 크기 조절 버튼. |
| `.agent-chat-compact`, `.agent-chat-expanded` | 새 크기 상태. 닫히면 `.agent-chat-closed`와 `hidden`을 사용한다. |
| button "대화 기록 펼치기", "대화 기록 접기", `.command-expanded` | 제거했다. 위로 기록을 펼치는 동작은 없다. |

`tests/`는 수정하지 않았다. `CommandBar.tsx`의 파일 이름과 export는 기존 렌더러 테스트와 App 연결을 위해 유지했다.

## 검증 기록

| 검사 | 결과 |
| --- | --- |
| `npx tsc --noEmit -p tsconfig.web.json` | 종료 0. 빌드 정보 파일은 시스템 임시 폴더로 지정했다. |
| `node src/renderer/tools/check-contract.mjs` | 종료 0. 계약 49개, 누락과 금지 호출 없음. |
| 렌더러 Vitest | 39개 파일, 541개 테스트 통과. 기존 드롭, followups, permission-ui, web-stage8 검증을 유지하고 새 진입점을 반영했다. |
| `npm run build:web` | 통과. 실제 서버용 remote 빌드 검사를 포함한다. |
| [채팅 변이](mutation-results.json) | 29/29 검출. |
| [기존 파일 드롭 변이](../command-bar/mutation-results.json) | 34/34 검출. |
| [헤드리스 브라우저 점검](capture-results.json) | 1440px와 390px 통과. 페이지 오류 없음. |

컴포넌트 검증에는 열기, 닫기, 확장, 포커스, 한 입력창, 화면 이동, 새로고침, 외부 초안, 닫힌 상태의 드롭, 대상별 읽음, 보이지 않는 답변, 모달 차단, 읽던 스크롤 위치, 한국어 Enter, 전송 중 상태, 데스크톱 파일 선택과 이미지 붙여넣기, 키보드 뷰포트 변경을 포함한다. CSS 검증은 이전 하단 행 제거, 휴대폰 너비, 사무실 여백과 모션 감소 규칙을 확인한다.

브라우저에서는 실제 텍스트 선택 드래그, 대화 영역과 입력창 위의 파일 드롭, 취소와 창 이탈, 모달 차단, 키보드 파일 선택, 이미지 붙여넣기, 업로드 오류 재시도, Enter 전송, 첨부 메타데이터와 링크도 확인했다. 캡처는 직접 보며 사무실 이름, 대화 가독성, 첨부 오류 문구, 상단 버튼과 상세 닫기의 겹침을 점검했다.

검증 도구는 모두 승인된 CPU 제한 실행기를 통해 한 번에 하나씩 실행했다. 재실행 시 `COMMAND_DROP_VITEST_WRAPPER`에 실행기 경로를 지정한다. `CHAT_TSC_INFO`는 시스템 임시 폴더 안의 빌드 정보 파일 경로다.

```bash
bash "$COMMAND_DROP_VITEST_WRAPPER" -- npx tsc --noEmit -p tsconfig.web.json --tsBuildInfoFile "$CHAT_TSC_INFO"
node src/renderer/tools/check-contract.mjs
bash "$COMMAND_DROP_VITEST_WRAPPER" run --config src/renderer/tools/vitest.config.ts
bash "$COMMAND_DROP_VITEST_WRAPPER" -- npm run build:web
bash "$COMMAND_DROP_VITEST_WRAPPER" -- node src/renderer/tools/mutate-agent-chat.mjs
bash "$COMMAND_DROP_VITEST_WRAPPER" -- node src/renderer/tools/mutate-command-drop.mjs
bash "$COMMAND_DROP_VITEST_WRAPPER" -- node src/renderer/tools/capture-agent-chat.mjs
```

`capture-command-drop.mjs`도 새 캡처 도구를 실행한다. 이전 브라우저 검증을 새 도구에 옮겼다. 캡처 도구는 5196의 개발 미리보기와 헤드리스 브라우저 하나만 사용한다. 브라우저 프로필과 Vite 캐시는 시스템 임시 폴더에 만들고 종료 시 삭제한다. 개발 서버도 종료한다.

실제 서버와 데스크톱 앱은 실행하지 않았다. 데스크톱은 브리지 모형을 통한 컴포넌트 테스트로 확인했다. 휴대폰의 실제 소프트 키보드 대신 `VisualViewport` 변경을 모형으로 확인했다. 공유 계약, 서버, 데스크톱 프로세스와 패키지 설정은 변경하지 않았다.

## 캡처

PNG는 기존 `.gitignore`의 `docs/design/**/*.png` 규칙에 따라 Git에서 제외한다. 아래 링크는 이 작업 폴더에 저장한 로컬 캡처다.

| 상태 | 1440px | 390px |
| --- | --- | --- |
| 닫힘과 읽지 않은 답변 | [보기](captures/closed-unread-1440.png) | [보기](captures/closed-unread-390.png) |
| 회사 사무실과 작은 대화창 | [보기](captures/compact-home-1440.png) | [보기](captures/compact-home-390.png) |
| 부서 사무실과 작은 대화창 | [보기](captures/compact-department-1440.png) | [보기](captures/compact-department-390.png) |
| 넓게 보기 | [보기](captures/expanded-1440.png) | [보기](captures/expanded-390.png) |
| 닫힌 상태에서 파일 드래그 | [보기](captures/file-drag-closed-1440.png) | [보기](captures/file-drag-closed-390.png) |
| 준비된 첨부와 오류 첨부 | [보기](captures/chips-ready-error-1440.png) | [보기](captures/chips-ready-error-390.png) |
| 팀원 상세와 함께 열림 | [보기](captures/with-member-1440.png) | [보기](captures/with-member-390.png) |
| 긴급 정지 | [보기](captures/emergency-1440.png) | [보기](captures/emergency-390.png) |
| 모션 감소 | [보기](captures/reduced-motion-1440.png) | [보기](captures/reduced-motion-390.png) |
| 키보드 높이 모형, 420px 뷰포트 | 해당 없음 | [보기](captures/keyboard-viewport-390.png) |

개발 브리지의 기본 대화에는 여러 차례의 대화, 내려받을 수 있는 메모 첨부와 읽지 않은 답변을 넣었다. `officeState=busy` 미리보기에서도 부서 대화를 읽을 수 있다. 모형 데이터는 remote 빌드에 들어가지 않는다.

## 파일 변경

추가한 구현 파일은 `src/renderer/src/lib/useChatSurface.ts`와 `src/renderer/src/styles/agent-chat.css`다. 검증 도구로 `src/renderer/tools/capture-agent-chat.mjs`, `src/renderer/tools/mutate-agent-chat.mjs`를 추가했다. 이 폴더에 README, 캡처 점검 JSON, 변이 결과 JSON, PNG 19장을 남겼다. 삭제한 파일은 없다.

기존 `CommandBar.tsx`, 드롭 스타일, 본문 레이아웃 스타일, 개발 브리지와 렌더러 테스트를 수정했다. 이전 명령줄 캡처 도구는 새 도구의 진입점으로 바꿨고, 기존 드롭 변이 도구는 닫힌 대화창을 여는 동작을 검사한다.
