import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

// Lead ruling S7-13: mutations must never touch the shared working tree.
if (!resolve('.').startsWith(resolve(tmpdir()) + sep)) throw new Error('Run in a lane scratch copy under the system temp folder.');
const suite = 'src/renderer/src/components/stage7-agents.test.ts';
const agents = 'components/ExternalAgents.tsx';
const mutants = [
  { file: 'lib/agents.ts', test: 'S7-chip', before: '`${holder.label} · 외부 에이전트`', after: "'Claude CLI'", bug: '외부 보유자를 Claude CLI로 오표시' },
  { file: 'screens/Seat.tsx', test: 'S7-seat', before: '{holderLabel(seat.holder)}</strong>', after: "{'Codex CLI'}</strong>", bug: '자리 화면에서 외부 보유자를 Codex CLI로 오표시' },
  { file: 'screens/Seat.tsx', test: 'S7-seat', before: "seat.holder?.kind === 'external' ? '명령은 계속 보낼 수 있습니다.", after: "false ? '명령은 계속 보낼 수 있습니다.", bug: '외부 접근 철회 후 복귀하면 처리한다고 약속함' },
  { file: 'components/SeatStatus.tsx', test: 'S7-seat', before: "seat.holder?.kind === 'external' ? '명령은 계속 보낼 수 있습니다.", after: "false ? '명령은 계속 보낼 수 있습니다.", bug: '응답 없음 안내에서 철회된 보유자의 복귀를 약속함' },
  { file: 'components/MemberPanel.tsx', test: 'S7-main-panel', before: 'member.isMain ? <MainSeatSummary', after: 'false ? <MainSeatSummary', bug: '메인 패널에 지난 CLI 모델과 노력치 노출' },
  { file: 'components/MemberPanel.tsx', test: 'S7-records', before: '{RUNNER_KIND_LABEL[session.aiKind]}', after: "{session.aiKind === 'external' ? 'Claude CLI' : RUNNER_KIND_LABEL[session.aiKind]}", bug: '외부 세션을 Claude CLI로 표시' },
  { file: 'components/MemberPanel.tsx', test: 'S7-records', before: "if (turn.runner === 'external') return RUNNER_KIND_LABEL.external;", after: "if (turn.runner === 'external') return 'Codex CLI';", bug: '외부 턴을 Codex CLI로 표시' },
  { file: 'components/MemberPanel.tsx', test: 'S7-records', before: "turn.runner !== 'external' && <span", after: 'true && <span', bug: '외부 턴에 CLI 바이패스 세부 정보 노출' },
  { file: 'lib/agents.ts', test: 'S7-connection', before: 'agent.connected && ', after: '', bug: '끊긴 에이전트를 연결됨으로 표시' },
  { file: 'lib/agents.ts', test: 'S7-connection', before: 'agent.revokedAt === null && ', after: '', bug: '접근 철회보다 오래된 연결 값을 우선함' },
  { file: 'lib/agents.ts', test: 'S7-connection', before: "seat.state !== 'stopped'", after: 'true', bug: '긴급 정지 뒤에도 외부 연결 유지로 표시' },
  { file: agents, test: 'S7-connection', before: "!connected && <span>마지막 접속: {agent.lastSeenAt ? date(agent.lastSeenAt) : '접속 기록 없음'}</span>", after: "!connected && <span>마지막 접속: 알 수 없음</span>", bug: '연결 해제 후 마지막 접속 시각 누락' },
  { file: 'lib/agents.ts', test: 'S7-connection', before: '외부 프로그램의 종료 여부는 확인할 수 없습니다.', after: '외부 프로그램의 종료를 확인했습니다.', bug: '접근 철회를 외부 프로그램 종료 확인으로 오표시' },
  { file: agents, test: 'S7-list', before: '<div className="agent-heading">', after: '<button>에이전트 등록</button><div className="agent-heading">', bug: '읽기 목록에 에이전트 등록 컨트롤 추가' },
  { file: agents, test: 'S7-list', before: '<div className="agent-heading">', after: '<button>접근 철회</button><div className="agent-heading">', bug: '읽기 목록에 접근 철회 컨트롤 추가' },
  { file: agents, test: 'S7-list', before: '<div className="agent-heading">', after: '<button>자리 배정</button><div className="agent-heading">', bug: '읽기 목록에 자리 배정 컨트롤 추가' },
  { file: agents, test: 'S7-list', before: '<div className="agent-heading">', after: '<button>키 복사</button><div className="agent-heading">', bug: '읽기 목록에 키 복사 컨트롤 추가' },
  { file: agents, test: 'S7-empty', before: '등록된 외부 에이전트가 없습니다.', after: '메인 자리가 비어 있습니다.', bug: '등록 없음과 메인 자리 비어 있음을 혼동' },
  { file: agents, test: 'S7-empty', before: '<p role="status">외부 에이전트를 불러오는 중…</p>', after: '<p>등록된 외부 에이전트가 없습니다.</p>', bug: '조회 중을 미등록으로 오표시' },
  { file: agents, test: 'S7-refresh', before: 'setAgents(null); setError(\'외부 에이전트 정보를 불러오지 못했습니다.\');', after: '', bug: '조회 실패 후 이전 연결 정보를 남김' },
  { file: agents, test: 'S7-refresh', before: 'clearInterval(timer);', after: '', bug: '자리 화면 종료 후 조회 타이머 유지' },
  { file: 'api/fake/index.ts', test: 'S7-fake', before: "'fakeScreen', 'fakeAgents',", after: "'fakeScreen',", bug: 'fakeAgents 개발 매개변수 무시' },
  { file: 'api/fake/index.ts', test: 'S7-fake', before: "'screens.image', 'agents.list'].includes(method)", after: "'screens.image'].includes(method)", bug: '로그인 전 에이전트 목록 노출' },
  { file: agents, suite: 'src/renderer/src/components/stage4-seat.test.ts', test: 'S4-no-swap', before: "call('agents.list')", after: "call('settings.update', {})", bug: '에이전트 조회 영역에서 운영 설정 쓰기 호출' },
];
const wrapper = 'C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/vt.sh';
const output = resolve('docs/design/permission-ui/stage7-agents'); mkdirSync(output, { recursive: true });
const report = resolve(output, 'mutation-results.json');
const retry = process.argv.includes('--retry-failed');
const results = retry && existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')).results.filter(row => row.killed) : [];
for (const mutant of mutants) {
  if (results.some(row => row.bug === mutant.bug)) continue;
  const file = resolve('src/renderer/src', mutant.file), original = readFileSync(file), source = original.toString('utf8');
  if (source.split(mutant.before).length !== 2) throw new Error(`Expected unique anchor: ${mutant.bug}`);
  try {
    writeFileSync(file, source.replace(mutant.before, mutant.after));
    const run = spawnSync('bash', [wrapper, 'run', '--config', 'src/renderer/tools/vitest.config.ts', '--configLoader', 'runner', '--no-cache', mutant.suite ?? suite, '-t', mutant.test], { encoding: 'utf8', timeout: 1080000, windowsHide: true, env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1' } });
    const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.replace(/\x1b\[[0-9;]*m/g, '');
    const killed = run.status === 1 && /AssertionError/.test(text) && /Tests\s+.*failed/.test(text);
    results.push({ file: mutant.file, test: mutant.test, bug: mutant.bug, exitCode: run.status, killed, evidence: text.split('\n').filter(line => /FAIL|AssertionError|Tests\s+|Test Files\s+/.test(line)) });
    console.log(`${killed ? 'KILLED' : 'SURVIVED / ERROR'}: ${mutant.bug}`);
  } finally {
    writeFileSync(file, original);
    if (!readFileSync(file).equals(original)) throw new Error(`Restoration failed: ${file}`);
  }
  writeFileSync(report, JSON.stringify({ scratchOnly: true, sourceRestored: true, results }, null, 2) + '\n');
}
if (results.length !== mutants.length || results.some(row => !row.killed)) process.exitCode = 1;
