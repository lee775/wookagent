# 팀원 AI 건의서

팀원 상세에서 **AI 건의**를 누르면 대표가 메인 에이전트에게 보내는 건의서가 열린다. 대표는 모델, 노력치 또는 둘 다 제안하고 까닭을 덧붙일 수 있다. 접수하면 해당 프로젝트의 업무 대화가 열린다. 대표가 보낸 글과 메인 에이전트의 판단을 한 곳에서 이어 읽을 수 있다. [기존 업무 대화](../agent-chat/README.md)

## 화면에서 결정한 점

- 팀원의 AI 정보 바로 아래, 기존 대화 버튼 옆에 메모 아이콘과 **AI 건의**를 두었다. 서버가 이 팀원의 선택지를 내려줄 때만 보인다. 이전 서버에서 필드가 빠진 경우도 같은 방식으로 처리한다.
- 종이 한 장 안에서 발신인과 수신인, 대상 팀원, 현재 AI, 건의 내용을 차례로 읽는다. 아래쪽 점선은 대표가 적는 내용과 메인 에이전트가 판단할 내용을 구분한다. 팀원 교체가 필요한 경우에는 보내기 버튼 위에서 퇴직, 새 팀원 채용, 남은 일의 인수인계를 설명한다.
- 모델 목록은 Claude와 Codex로 묶었다. **모델별 설명**을 펼치면 선택하기 전에 모든 모델의 용도를 비교할 수 있다. 선택한 모델의 설명은 목록 아래에도 남는다. 노력치 세 단계에는 선택한 AI 종류에서 실제로 사용할 값을 표시한다.
- 두 선택의 시작값은 **건의 없음**이다. 실제 모델이나 노력치 값이 달라져야 보낼 수 있다. 다음 작업에 쓸 AI가 이미 정해졌으면 현재 값 아래에 예정 값을 표시하고 그 값과 비교한다. 두 종류에 같은 모델 ID가 있으면 서버가 식별할 수 있는 쪽인 현재 비교 대상의 AI 종류를 표시한다.
- 휴대폰에서는 한 열로 읽고, 화면보다 긴 건의서는 안에서 스크롤한다. 브라우저의 기본 모달 대화상자가 포커스를 관리한다. Tab으로 항목을 이동하고 방향키로 노력치를 선택한다. Esc나 닫기 버튼을 쓰면 상세의 **AI 건의**로 포커스가 돌아간다.

## 전송과 답변

`command.send`의 `target`은 팀원의 프로젝트 ID다. `text`에는 대표가 작성한 까닭을 담으며 빈 문자열도 허용한다. `aiSuggestion`에는 `memberId`와 대표가 선택한 `model`, `effortTier`만 담는다. 예를 들어 노력치만 건의하면 다음과 같이 보낸다.

```json
{
  "target": "P-8001",
  "text": "검색 조건이 겹치는 경우를 더 꼼꼼히 검토해 주세요.",
  "aiSuggestion": { "memberId": "M-8002", "effortTier": "high" }
}
```

전송 중에는 입력과 중복 전송을 막고 **보내는 중…**을 표시한다. 서버가 거절하면 그 메시지를 건의서 안에서 읽을 수 있다. 모델, 노력치, 까닭이 그대로 남아 수정하거나 다시 보낼 수 있다. 열어 둔 건의서는 당시의 모델 목록을 보존한다. 팀원 상세를 다시 열면 최신 목록을 조회한다.

접수 응답을 받으면 **건의를 보냈습니다** 토스트를 띄우고 `openConversation(projectId)`로 업무 대화를 연다. 기존 대화 초안은 유지한다. 답이 도착하면 같은 대화에 판단과 까닭이 이어지고 기존 **메인 에이전트의 답** 알림이 뜬다. 접수 이후의 기록은 프로젝트 대화에서 확인한다.

## 브라우저 테스트 선택자

| 역할 | 접근 가능한 이름 또는 내용 | 선택자 |
| --- | --- | --- |
| button | AI 건의 | `.ai-suggestion-entry` |
| dialog | 팀원 AI 건의서 | `.ai-suggestion-sheet` |
| region | 현재 AI | `.suggestion-current` |
| combobox | 건의할 모델 | `#suggestion-model` |
| 펼침 버튼 | 모델별 설명 | `.suggestion-catalog summary` |
| radiogroup | 건의할 노력치 | `.suggestion-effort` |
| radio | 건의 없음, 높게, 보통, 낮게 | `.suggestion-effort input` |
| textbox | 건의하는 까닭 | `#suggestion-reason` |
| button | 건의 보내기 | `.suggestion-send` |
| button | 건의서 닫기 | `.suggestion-head button` |
| 안내 문단 | 팀원 교체 안내 | `.suggestion-fixed` |
| alert | 서버의 거절 문구 | `.suggestion-error` |
| 토스트 | 건의를 보냈습니다 | `.toast` |
| dialog | 메인 에이전트 대화창 | `.agent-chat` |
| 대화 메시지 | 대표가 보낸 건의와 메인 에이전트의 답 | `.conversation .bubble-owner`, `.conversation .bubble-main_agent` |

모델은 기본 HTML `select`이므로 `selectOption('gpt-6-sol')`처럼 서버의 모델 ID를 쓴다. 노력치는 기본 HTML 라디오 버튼이며 화면에 보이는 단계 이름으로 찾을 수 있다.

## 데모에서 두 가지 답 보기

개발 미리보기에서 `?officeState=busy&studio3d=0`을 열고 **서비스 개발 사무실**의 팀원 디렉터리로 들어간다.

| 팀원 | 건의 예시 | 데모의 판단 |
| --- | --- | --- |
| 시안 (`M-8002`, 기획자) | GPT-6 Sol, 노력치 높게 | 맡은 검색 화면 작업을 더 꼼꼼히 검토하도록 건의를 반영한다. 답변 뒤 팀원 상세에도 새 AI가 보인다. |
| 지우 (`M-8007`, UI 디자이너) | Opus | 보내기 전에 교체 안내가 보인다. 메인은 현재 AI로 마칠 수 있는 작업이며 인수인계에 시간이 든다는 이유로 기존 팀원을 유지한다. |

데모는 같은 입력을 다시 확인할 수 있도록 업무와 AI 확정 여부에 따라 정해진 답을 낸다. 접수 시에는 대표 글만 추가한다. 약 1초 뒤에 데모 메인이 결정을 내리고 답변과 알림을 보낸다. 운영 환경의 판단은 서버의 메인 에이전트가 맡는다.

## 검증과 캡처

웹 TypeScript 검사와 서버용 웹 빌드가 통과했다. 빌드 결과는 임시 폴더에 출력했다. 계약 검사에서 49개 메서드의 화면 호출과 데모 처리기를 확인했다. 렌더러 테스트 41개 파일, 553개 사례가 통과했다. 이 기능에 추가한 사례는 12개다. 변이 30개 모두 테스트 단언 실패로 검출했다. [변이별 결과](mutation-results.json)

두 너비에서 프로젝트 대화까지 키보드로 진행하고 최종 이미지 12장을 직접 확인했다. 거절 장면은 건의서를 연 뒤 데모의 운영 목록에서 선택한 모델을 제거해 재현했다. 같은 초안으로 재전송해 접수와 답변까지 확인했다.

| 장면 | 1440 × 960 | 390 × 844 |
| --- | --- | --- |
| 팀원 상세의 진입점 | [상세](captures/member-1440.jpg) | [상세](captures/member-390.jpg) |
| 모델과 노력치를 선택한 건의서 | [건의서](captures/picks-1440.jpg) | [건의서](captures/picks-390.jpg) |
| AI가 확정된 팀원 | [교체 안내](captures/fixed-1440.jpg) | [교체 안내](captures/fixed-390.jpg) |
| 서버 거절과 보존된 초안 | [거절](captures/refusal-1440.jpg) | [거절](captures/refusal-390.jpg) |
| 접수 직후의 토스트와 대표 글 | [접수](captures/sent-1440.jpg) | [접수](captures/sent-390.jpg) |
| 대표의 건의와 메인 에이전트의 답 | [대화](captures/conversation-1440.jpg) | [대화](captures/conversation-390.jpg) |

변이 도구는 임시 복사본에 결함을 하나씩 넣고 기능 테스트를 실행한다. 재실행할 때는 `AI_SUGGESTION_VITEST_WRAPPER`에 승인된 CPU 제한 실행기 경로를 지정한다. 캡처 도구는 5196번 포트에 데모를 열고 헤드리스 브라우저 한 개를 사용한 뒤 둘 다 종료한다.

```bash
bash "$AI_SUGGESTION_VITEST_WRAPPER" -- node src/renderer/tools/mutate-ai-suggestion.mjs
bash "$AI_SUGGESTION_VITEST_WRAPPER" -- node src/renderer/tools/capture-ai-suggestion.mjs
```

## 변경 파일

| 범위 | 파일 |
| --- | --- |
| 화면 연결 | `src/renderer/src/components/MemberPanel.tsx`, `src/renderer/src/App.tsx` |
| 새 건의서와 비교 로직 | `src/renderer/src/components/AiSuggestion.tsx`, `src/renderer/src/styles/ai-suggestion.css`, `src/renderer/src/lib/aiSuggestion.ts` |
| 데모 | 기존 `src/renderer/src/api/fake/index.ts`와 새 `src/renderer/src/api/fake/aiSuggestion.ts` |
| 새 테스트 | `src/renderer/src/components/ai-suggestion.test.ts`, `src/renderer/src/api/fake/ai-suggestion.test.ts` |
| 새 검증 도구 | `src/renderer/tools/mutate-ai-suggestion.mjs`, `src/renderer/tools/capture-ai-suggestion.mjs` |
| 기록 | 이 문서, `mutation-results.json`, `captures/`의 JPEG 12장 |
