import type { JournalEntryView, JournalFilter, JournalPage, SeatHandoverView, SeatHistoryEntry, SeatHolderView, SeatView } from '../../../../shared/views';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const claude: SeatHolderView = { kind: 'launched', label: 'Claude CLI', ai: { kind: 'claude', model: 'opus', effortTier: 'high', effortOverride: null } };
const codex: SeatHolderView = { kind: 'launched', label: 'Codex CLI', ai: { kind: 'codex', model: 'gpt-6-sol', effortTier: 'high', effortOverride: null } };
const projectName = '동네 산책 기록장';

export function createFakeSeat(query: URLSearchParams) {
  const scenario = query.get('fakeSeat');
  const seat: SeatView = { generation: 3, state: 'active', holder: claude, since: ago(90), unresponsiveSince: null, unresponsiveReason: null, pendingHolder: null, vision: 'unknown' };
  if (scenario === 'unresponsive') {
    seat.unresponsiveSince = ago(4);
    seat.unresponsiveReason = '사용량 한도로 메인 턴이 3번 연달아 끝났습니다.';
  }
  if (scenario === 'switching') { seat.state = 'switching'; seat.pendingHolder = codex; }
  if (scenario === 'vacant') { seat.state = 'vacant'; seat.holder = null; seat.since = null; }
  const history: SeatHistoryEntry[] = [
    { generation: 3, holder: claude, startedAt: ago(90), endedAt: null, endReason: null, changedBy: 'operator', hasHandover: true },
    { generation: 2, holder: codex, startedAt: ago(1440), endedAt: ago(90), endReason: '운영자가 서버 PC에서 Claude CLI에 복구 배정했습니다.', changedBy: 'main', hasHandover: true },
    { generation: 1, holder: claude, startedAt: ago(14400), endedAt: ago(1440), endReason: '사용량 한도로 메인이 Codex CLI에 넘겼습니다.', changedBy: 'server', hasHandover: false },
  ];
  function handover(generation = seat.generation): SeatHandoverView | null {
    const row = history.find(row => row.generation === generation);
    if (!row?.hasHandover) return null;
    const packet: SeatHandoverView = { generation, holder: row.holder, previous: history.find(row => row.generation === generation - 1)?.holder ?? null,
      createdAt: row.startedAt, chars: 0, sections: [
        { key: 'seat', title: '자리 정보', unverified: false, lines: [`세대 ${generation}의 보유자는 ${row.holder.label}입니다.`, generation === 3 ? '운영자가 서버 PC에서 복구 배정했습니다.' : '이전 메인이 사용량 한도로 자리를 넘겼습니다.'], omitted: 0 },
        { key: 'facts', title: '확인된 사실', unverified: false, lines: ['동네 산책 기록장 작업 2건이 진행 중입니다.', '대표가 확인할 보고서가 1건 있습니다.', '질문 답변을 기다리는 동안 다른 작업은 계속 진행합니다.'], omitted: 7 },
        { key: 'memos', title: '이전 메인 에이전트의 메모', unverified: true, lines: ['모바일 탐색 항목을 먼저 확인하겠다고 약속했습니다.', '대표 답변을 받으면 첫 화면의 문구를 다시 정리하려고 했습니다.'], omitted: 2 },
        { key: 'memory', title: '기억 문서 위치', unverified: false, lines: ['memory/general.md', 'memory/P-0001.md'], omitted: 0 },
      ] };
    packet.chars = JSON.stringify(packet.sections).length;
    return structuredClone(packet);
  }
  const journal: JournalEntryView[] = [
    { id: 'J-command', at: ago(3), generation: 3, holderLabel: 'Claude CLI', author: 'server', kind: 'command', projectId: 'P-0001', projectName, text: '모바일에서도 탐색 항목을 편하게 쓸 수 있게 정리해 달라는 명령을 받았습니다.', refs: [{ kind: 'project', id: 'P-0001', label: projectName }] },
    { id: 'J-action', at: ago(5), generation: 3, holderLabel: 'Claude CLI', author: 'server', kind: 'action', projectId: 'P-0001', projectName, text: '메인이 탐색 항목 개선 지시를 등록했습니다.', refs: [{ kind: 'directive', id: 'D-0001', label: '탐색 항목 개선 지시' }, { kind: 'task', id: 'T-0001', label: '진행 중인 작업' }, { kind: 'member', id: 'M-0001', label: '담당 팀원' }] },
    { id: 'J-report', at: ago(8), generation: 3, holderLabel: 'Claude CLI', author: 'server', kind: 'report', projectId: 'P-0001', projectName, text: '모바일 화면 점검 보고서를 제출했습니다.', refs: [{ kind: 'report', id: 'R-0001', label: '화면 점검 보고' }] },
    { id: 'J-seat', at: ago(90), generation: 3, holderLabel: 'Claude CLI', author: 'server', kind: 'seat', projectId: null, projectName: null, text: '운영자가 메인 자리를 Claude CLI에 배정했습니다.', refs: [] },
    { id: 'J-stop', at: ago(120), generation: 2, holderLabel: 'Codex CLI', author: 'server', kind: 'stop', projectId: null, projectName: null, text: '대표가 긴급 정지를 요청해 진행 중인 턴을 멈췄습니다.', refs: [] },
    { id: 'J-decision', at: ago(130), generation: 2, holderLabel: 'Codex CLI', author: 'agent', kind: 'decision', projectId: 'P-0001', projectName, text: '작은 화면에서 자주 쓰는 탐색 항목부터 정리하기로 했습니다.', refs: [] },
    { id: 'J-open', at: ago(140), generation: 2, holderLabel: 'Codex CLI', author: 'agent', kind: 'promise', projectId: 'P-0001', projectName, text: '대표 답변을 받으면 탐색 항목 이름을 다시 확인하겠습니다.', refs: [{ kind: 'question', id: 'Q-0001', label: '탐색 항목 이름에 관한 질문' }], promise: { state: 'open', stale: false, needsCheck: false, closedAt: null, resolution: null } },
    { id: 'J-check', at: ago(160), generation: 2, holderLabel: 'Codex CLI', author: 'agent', kind: 'promise', projectId: 'P-0001', projectName, text: '닫힌 지시에 남은 확인 항목이 있는지 살펴보겠습니다.', refs: [{ kind: 'directive', id: 'D-removed', label: '(지워짐)' }], promise: { state: 'open', stale: false, needsCheck: true, closedAt: null, resolution: null } },
    { id: 'J-closed', at: ago(180), generation: 2, holderLabel: 'Codex CLI', author: 'agent', kind: 'promise', projectId: 'P-0001', projectName, text: '첫 화면의 버튼 크기를 점검하겠습니다.', refs: [], promise: { state: 'closed', stale: false, needsCheck: false, closedAt: ago(100), resolution: '휴대폰에서 버튼을 눌러 보고 결과를 보고서에 남겼습니다.' } },
    { id: 'J-note', at: ago(200), generation: 2, holderLabel: 'Codex CLI', author: 'agent', kind: 'note', projectId: null, projectName: null, text: '다음 메인은 모바일 탐색 항목의 점검 결과부터 읽어 주세요.', refs: [] },
    { id: 'J-rollup', at: ago(220), generation: 2, holderLabel: 'Codex CLI', author: 'server', kind: 'rollup', projectId: null, projectName: null, text: '지난달 서버 기록 34건을 묶었습니다. 버튼 크기 점검 약속을 마쳤습니다.', refs: [] },
    { id: 'J-stale', at: ago(8 * 1440), generation: 1, holderLabel: 'Claude CLI', author: 'agent', kind: 'promise', projectId: 'P-0001', projectName, text: '오래된 도움말 링크도 확인하겠습니다.', refs: [], promise: { state: 'open', stale: true, needsCheck: false, closedAt: null, resolution: null } },
    ...Array.from({ length: 42 }, (_, i): JournalEntryView => ({ id: `J-older-${i}`, at: ago(15 * 1440 + i), generation: 1, holderLabel: 'Claude CLI', author: 'server', kind: 'action', projectId: 'P-0001', projectName, text: `모바일 화면 점검 항목 ${i + 1}을 작업 기록에 반영했습니다.`, refs: [] })),
  ];
  function list(filter: JournalFilter = {}): JournalPage {
    const rows = journal.filter(row => (filter.projectId === undefined || row.projectId === filter.projectId) &&
      (!filter.kinds?.length || filter.kinds.includes(row.kind)) && (!filter.author || row.author === filter.author) &&
      (filter.generation === undefined || row.generation === filter.generation) && (!filter.openPromisesOnly || row.promise?.state === 'open'));
    const cursor = filter.cursor ? rows.findIndex(row => row.id === filter.cursor) + 1 : 0;
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    const entries = rows.slice(cursor, cursor + limit);
    return structuredClone({ entries, nextCursor: cursor + limit < rows.length ? entries.at(-1)?.id ?? null : null });
  }
  return { seat, history, handover, list };
}
