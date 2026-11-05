# 욱채 화면 연결 확인

1440 × 900 브라우저 프리뷰를 기준으로 확인했다. 프로젝트 등록 폼은 기존 `screens/Home.tsx`가 오류 원문을 보여주는 것을 확인했고 수정하지 않았다. 3D 스튜디오 화면과 자산도 수정하지 않았다.

수정 파일: `src/renderer/src/App.tsx`, `components/TaskDetail.tsx`, `components/MemberPanel.tsx`, `styles/app.css`, `lib/taskSignals.ts`, `lib/taskSignals.test.ts`, `api/fake/index.ts`, `api/fake/data.ts`, 그리고 이 폴더의 사진·검증 기록·촬영 스크립트다. 후속 연결에서는 실제 뷰 타입의 선택 필드와 가짜 브리지의 모양을 일치시켰다.

## 항목별 결과

| 항목 | 화면 동작 | 확인 사진 |
| --- | --- | --- |
| 1 다시 판정 보류 | `refId: 'rejudge'`로 판별한다. 이전 기록을 위해 보류 문구 판별도 남겼다. 보류 사유 옆에 **검수자에게 메시지 보내기**와 **재개**를 둔다. 전송 뒤 `members.sendMessage`의 전달처 설명은 입력칸 아래에 한 번만 보여주고 토스트에는 싣지 않는다. | [보류](task-T-0008.png), [메시지 결과](rejudge-message.png) |
| 2 검사 종료 확인 보류 | 백엔드 보류 문구를 그대로 보여주고, 파일이 남은 경우 재개 결과를 짧게 적는다. `checkRuns`의 종료 확인 불가와 남은 파일도 실행 기록에 표시한다. | [보류와 실행 기록](task-T-0009-hold.png), [검사 기록](task-T-0009.png) |
| 3 긴급 정지 결과 | `remaining` 값에 따라 제목과 행별 표시를 바꾼다. 같은 팀원의 실패 두 건도 별도 행으로 보여준다. 긴 이름이 줄바꿈된다. | [혼합 결과](emergency-mixed.png) |
| 4 취소 지시의 병합 후 보류 | 보류 문구에 적힌 해제 경로를 보여준다. `scope`가 팀원 또는 프로젝트면 정지 목록과 맞춰 **팀원 재개** 또는 **프로젝트 재개**를 제공한다. 이전 기록에는 문구와 정지 목록을 이용한다. | [팀원 정지 사례](task-T-0010.png) |
| 5 열린 충돌 | 열린 충돌 파일과 `conflictUnverifiable`의 내용 확인이 어려운 파일을 각각 표시한다. | [충돌 파일](task-T-0011.png) |
| 6 작업 상세 | `changedCriteria`의 원문 옆에 **최근 바뀐 조건**을 표시한다. `checkRuns`를 오래된 순서로 보여주고, `ownerConfirmedAt`이 있는 실행에 대표 확인 표시를 붙인다. `remaining: -1`과 `leftFiles`도 각각 표시한다. | [변경 조건](task-T-0004.png), [검사 기록](task-T-0009.png) |
| 7 메시지 | `(다시 전달 — …)`로 시작하고 아직 전달 시각이 없는 메시지는 **다시 전달 대기**로 표시한다. | [메시지 기록](member-redelivery.png) |
| 8 프로젝트와 알림 | 프로젝트 등록 거부문은 원문 그대로 줄바꿈한다. 폴더 동기화 알림은 세 파일 묶음을 나눠 표시한다. 긴 활동 문구도 영역 안에서 줄바꿈한다. | [겹침](project-overlap.png), [등록 중](project-registering.png), [폴더 읽기 실패](project-unreadable.png), [알림](notice-groups.png), [활동](activity-wrap.png) |
| 9 앱 프레임 | 상단은 꿀빛 오크, 좌측은 짙은 세이지, 본문은 따뜻한 종이색으로 맞췄다. 주요 본문·사이드바·경고 글자의 측정 대비는 각각 6.29:1, 7.10:1, 5.43:1 이상이다. | [변경 전](frame-before.png), [변경 후](frame-after.png) |

## 검증

- `npx tsc --noEmit -p tsconfig.web.json`: 오류 0개.
- `node src/renderer/tools/check-contract.mjs`: 화면 호출과 가짜 브리지 누락 없음.
- `npx vitest run --config src/renderer/tools/vitest.config.ts`: 22개 파일, 131개 테스트 통과. 새 테스트 8개는 `lib/taskSignals.test.ts`에 있다.
- `npx vitest run tests/acceptance/flow.test.ts`: 21개 통과. `MemberPanel`의 훅은 `useState`, `useEffect`만 사용한다.
- [변이 결과](mutations.md): 이전 오류와 typed 필드 접근을 끊는 변이 12개가 모두 해당 테스트에서 실패했다. 메시지 안내 토스트를 되살린 브라우저 변이도 문구가 두 번 나타나며 실패했다. `check-rejudge-note.py`로 1440×900 화면을 재촬영하고 문구가 한 번만 있는지 검사했다.
- 사진은 포트 5196의 전용 Vite 서버에서 `capture.py`로 찍고 원본 크기로 열어 확인했다. 후속 연결 뒤 작업 상세 다섯 화면을 다시 촬영했다. 브라우저 프로필은 `tempfile.mkdtemp`로 OS 임시 폴더에 만든 뒤 촬영 종료 시 정리한다. 포트 5196 서버도 종료했다.

## 연결 상태와 남은 일

실제 뷰 계약이 보류 `refId`와 `scope`, `TaskView.conflictUnverifiable`과 `changedCriteria`, `TaskDetail.checkRuns`를 선택 필드로 전달한다. 화면과 가짜 브리지는 모두 이 필드를 읽는다. 이전 데이터에 값이 없을 때는 빈 목록으로 표시하거나, 보류 문구와 정지 목록으로 판별한다. 이 연결에서 남은 항목은 없다.
