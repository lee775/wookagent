// settingsPolicy.ts의 보기 전용 사본. followups.test.ts가 서버 원본과 비교합니다.
export const EXECUTION_LIMITS = {
  maxConcurrent: { label: '전체 CLI 실행 상한', unit: '개', min: 2, max: 32, integer: true },
  turnTimeoutMin: { label: '턴 시간 상한', unit: '분', min: 5, max: 1440, integer: false },
  commandMaxMin: { label: '실행 명령 시간 상한', unit: '분', min: 1, max: 1440, integer: false },
  noOutputMin: { label: '응답 없음 기준', unit: '분', min: 1, max: 1440, integer: false },
  healthCheckMin: { label: '응답 확인 대기', unit: '분', min: 1, max: 60, integer: false },
  spinNoProgressMin: { label: '진척 없음 기준', unit: '분', min: 5, max: 1440, integer: false },
  claudeMaxTurns: { label: 'Claude 최대 반복 수', unit: '번', min: 10, max: 10000, integer: true, nullable: true },
  crashRetryMax: { label: '비정상 종료 재시도', unit: '번', min: 0, max: 10, integer: true },
  spinSameErrorCount: { label: '같은 오류 반복 기준', unit: '번', min: 2, max: 100, integer: true },
  spinNoProgressResumes: { label: '진척 없는 자동 재개', unit: '번', min: 0, max: 20, integer: true },
} as const;
export const BACKUP_KEEP_LIMIT = { min: 1, max: 365 } as const;
