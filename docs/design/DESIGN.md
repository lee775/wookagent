# 욱채 렌더러 v3.4 · Design B

## 화면

앱의 색상 토큰과 패널 색은 `src/renderer/src/styles/identity.css:1`에 있다. Pretendard Variable의 사용 글리프 부분 집합은 `src/renderer/src/styles/pretendard-used.css:1`에서 불러온다. 로그인은 저장된 Google 설정의 검증 상태에 따라 설정 재입력 경로를 연다(`src/renderer/src/App.tsx:70`). 화면에 표시하는 활동 문장의 내부 ID는 표시용 이름으로 바꾼다(`src/renderer/src/lib/displayText.ts:20`).

## 사무실

작업실은 1200×610 SVG이며, 바닥에 두 색의 카펫 무늬를 한 장면으로 깐다(`src/renderer/src/studio/Office.tsx:438`, `src/renderer/src/studio/Office.tsx:32`). 푸른 러그는 화면 오른쪽의 회의 공간 아래에 그린다(`src/renderer/src/studio/Office.tsx:34`). 보드의 단계 문장은 지시의 모든 열린 작업에서 아직 끝나지 않은 첫 단계를 찾는다(`src/renderer/src/studio/Office.tsx:20`). 보드 글씨를 사람보다 앞에 다시 그려 이동 중에도 읽을 수 있게 한다(`src/renderer/src/studio/Office.tsx:449`).

벽에는 현재 시각을 가리키는 시계, 메모 게시판과 바인더 선반을 둔다(`src/renderer/src/studio/Office.tsx:44`, `src/renderer/src/studio/Office.tsx:49`, `src/renderer/src/studio/Office.tsx:51`). 소파, 회의 탁자와 커피 기계는 벽 아래 바닥 위에 그린다(`src/renderer/src/studio/Office.tsx:52`, `src/renderer/src/studio/Office.tsx:54`, `src/renderer/src/studio/Office.tsx:56`). 책상에는 작은 소품과 관절 조명이 놓인다(`src/renderer/src/studio/Office.tsx:94`, `src/renderer/src/studio/Office.tsx:104`).

마주 보는 책상 두 줄 사이에는 짧은 천 스크린 여섯 조각과 다섯 내부 통로가 있다(`src/renderer/src/studio/Office.tsx:19`, `src/renderer/src/studio/Office.tsx:39`). 물을 주는 화분은 화면 왼쪽 아래에 있다(`src/renderer/src/studio/Office.tsx:62`). 책상과 의자는 사람의 발 위치에 맞춰 정렬하고, 소파 앞면도 깊이 정렬에 넣는다(`src/renderer/src/studio/Office.tsx:15`, `src/renderer/src/studio/Office.tsx:447`). 걷는 동안은 책상의 앞뒤 순서가 뒤집히지 않게 보행자 깊이 키를 고정한다(`src/renderer/src/studio/Office.tsx:18`, `src/renderer/src/studio/Office.tsx:233`).

## 사람과 동작

사람은 별도의 몸통·팔·다리·머리와 얼굴을 갖는 SVG 리그다(`src/renderer/src/studio/Person.tsx:26`, `src/renderer/src/studio/Person.tsx:38`, `src/renderer/src/studio/Person.tsx:40`). 작업 표정에는 중립 입을, 감정 자세에는 다른 입을 쓴다(`src/renderer/src/studio/Person.tsx:59`, `src/renderer/src/styles/identity.css:412`). 작업 중 팔과 머리의 흔들림은 서로 다른 주기로 계산한다(`src/renderer/src/studio/motion.ts:463`).

길찾기는 책상, 스크린, 화분, 소파와 다른 자리의 머리 공간을 피하려고 경로 후보를 걸러낸다(`src/renderer/src/studio/motion.ts:43`, `src/renderer/src/studio/motion.ts:233`). 보고를 전달하는 왕복은 소파와 회의 탁자 앞을 가로지르지 않고 가까운 책상줄 아래 통로를 쓴다(`src/renderer/src/studio/motion.ts:292`). 상태 이름표는 자세 이름 대신 작업 장소와 행동에서 만든다(`src/renderer/src/studio/motion.ts:17`). 다른 사람 몸과 먼저 놓인 이름표를 장애물로 쓰고, 마우스로 연 상세 카드는 위로 올린다(`src/renderer/src/studio/Office.tsx:387`, `src/renderer/src/styles/identity.css:214`). 검수 전달 때 서류는 두 사람 사이를 이동한다(`src/renderer/src/studio/Office.tsx:320`).

미리보기 주기는 64초이며 배정, 검수, 보고, 긴급 정지와 재출발을 포함한다(`src/renderer/src/api/fake/officeDemo.ts:10`). 300초 유휴 검사에는 같은 통로에서 두 보행자가 겹치는 사례가 남아 있다(`src/renderer/src/studio/motion.v33.test.ts:157`).
