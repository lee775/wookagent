# 욱채 v3.1 화면과 움직임 증거

1440×900 화면은 `s01-login.png`부터 `s09-busy-reduced-motion.png`까지 순서대로 연다. `s04-studio-busy-1100.png`와 `s04-studio-busy-1920.png`는 같은 사무실의 다른 너비다.

움직임은 [40프레임 순환](cycle-sheet.png), [2.5초 시작 버스트](burst-2500-sheet.png), [11초 시작 버스트](burst-11000-sheet.png), [검수 전달·복귀·방문](review-sheet.png)에서 먼저 살펴본다. 각 시트의 원본 프레임은 루트의 `frame-000.png`–`frame-039.png`와 `burst-2500/`, `burst-11000/`, `review/` 폴더에 있다.

측정과 자동 확인:

- [CPU](cpu.json): 12명 업무 중 12.006초, mainThreadBusy 0.056, 레이아웃 15.6회/초.
- [색 검사](palette-gate.txt): s01–s08 모두 통과. 크림·세이지 유사 픽셀 최대 1.75%, 짙은 녹색 최대 0.06%, 사무실 목재·황갈색 0.22%.
- [원본 색 분석](lens-ai-palette.txt): s01–s08의 violet 0.00%.
- [이름표와 글자](browser-check.json): 1100·1440·1920 업무 장면 및 1440 휴식·이벤트·긴급 정지에서 겹침 0건, 최소 글자 11px.

캡처는 이 저장소의 새 Vite 서버 `http://127.0.0.1:5200/`에서 만들었다. `plan-v31.json`, `plan-burst-2500.json`, `plan-burst-11000.json`, `plan-review.json`에 사용한 장면과 간격이 남아 있다.
