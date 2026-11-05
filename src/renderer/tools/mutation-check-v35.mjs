// Run against the lead's dev server. Each owned source file is restored in finally.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const vitest = file => ['node_modules/vitest/vitest.mjs', 'run', '--config', 'src/renderer/tools/vitest.config.ts', file];
const browser = file => [file];
const mutations = [
  { item: '14', bug: 'Remove the MemberPanel stop guard', file: 'src/renderer/src/components/MemberPanel.tsx',
    from: 'snapshot.stop?.pausedMembers?.find', to: 'snapshot.stop.pausedMembers.find',
    checks: [[vitest('src/renderer/src/components/stop-guard.test.ts'), 'mounts the member panel']] },
  { item: '16', bug: 'Reuse MemberPanel across member ids', file: 'src/renderer/src/App.tsx',
    from: '<MemberPanel key={memberId} id={memberId}', to: '<MemberPanel id={memberId}',
    checks: [[browser('src/renderer/tools/verify-member-message.mjs'), 'draft carried to another member']] },
  { item: '17', bug: 'Stop recognizing backend ids in the display filter', file: 'src/renderer/src/lib/displayText.ts',
    from: 'value.replace(/\\b([TDRPM]-\\d{4})\\b/gi', to: 'value.replace(/NO_BACKEND_ID/g',
    checks: [[vitest('src/renderer/src/lib/displayText.test.ts'), 'backend text on owner screens'],
      [browser('src/renderer/tools/verify-raw-text.mjs'), 'machine text']] },
  { item: '17', bug: 'Keep backend particle placeholders after ID substitution', file: 'src/renderer/src/lib/displayText.ts',
    from: "if (match === '이(가)') return particle(word, '이', '가');", to: "if (match === '이(가)') return match;",
    checks: [[vitest('src/renderer/src/lib/displayText.test.ts'), 'backend text on owner screens']] },
  { item: '17', bug: 'Leave English task state codes on screen', file: 'src/renderer/src/lib/displayText.ts',
    from: "in_progress: '진행 중'", to: "in_progress: 'in_progress'",
    checks: [[vitest('src/renderer/src/lib/displayText.test.ts'), 'backend text on owner screens']] },
  { item: '17', bug: 'Keep repeated report titles in one activity line', file: 'src/renderer/src/lib/displayText.ts',
    from: 'if (second >= 0) result =', to: 'if (false && second >= 0) result =',
    checks: [[vitest('src/renderer/src/lib/displayText.test.ts'), 'backend text on owner screens']] },
  { item: '17', bug: 'Keep the merge label in English', file: 'src/renderer/src/lib/displayText.ts',
    from: ".replace(/\\bmerge\\s*:/gi, '병합:')", to: ".replace(/\\bmerge\\s*:/gi, 'merge:')",
    checks: [[vitest('src/renderer/src/lib/displayText.test.ts'), 'backend text on owner screens']] },
  { item: '18', bug: 'Bind client ID input to refreshed server settings', file: 'src/renderer/src/screens/Settings.tsx',
    from: 'value={clientIdDraft ?? s.account.googleClientId}', to: 'value={s.account.googleClientId}',
    checks: [[browser('src/renderer/tools/verify-settings-draft.mjs'), 'client ID draft']] },
  { item: '18', bug: 'Bind sensitive paths to refreshed server settings', file: 'src/renderer/src/screens/Settings.tsx',
    from: "value={sensitiveDrafts[i] ?? area.paths.join('\\n')}", to: "value={area.paths.join('\\n')}",
    checks: [[browser('src/renderer/tools/verify-settings-draft.mjs'), 'sensitive path']] },
  { item: '13', bug: 'Restore the old order screen path in report data', file: 'src/renderer/src/api/fake/data.ts',
    from: 'src/ui/WalkLog.tsx', to: 'src/ui/OrderScreen.tsx',
    checks: [[vitest('src/renderer/src/api/fake/copy.v35.test.ts'), 'reference ordering vocabulary']] },
  { item: '13', bug: 'Restore the old order screen path in the task diff', file: 'src/renderer/src/api/fake/index.ts',
    from: "path: 'src/ui/WalkLog.tsx'", to: "path: 'src/ui/OrderScreen.tsx'",
    checks: [[browser('src/renderer/tools/capture-task-diff.mjs'), 'OrderScreen']] },
  { item: '17', bug: 'Make the fake send note too clean to exercise the backend format', file: 'src/renderer/src/api/fake/index.ts',
    from: "inReview ? `${item.currentTask?.id ?? 'T-0004'}이${'(가)'} 검수 중이라 메시지만 저장했습니다. 반려되거나 작업으로 돌아오면 전달됩니다.`",
    to: "inReview ? '검수 중이라 메시지만 저장했습니다.'",
    checks: [[vitest('src/renderer/src/api/fake/real-formats.test.ts'), 'keeps raw formats']] },
  { item: '20', bug: 'Repeat a role description in the directory', file: 'src/renderer/src/api/fake/data.ts',
    from: "producer: '요청을 작업으로 나누고 결과를 모아 대표에게 보고합니다.'",
    to: "producer: '사용 흐름과 완료 조건을 정리해 작업 범위를 분명히 합니다.'",
    checks: [[vitest('src/renderer/src/api/fake/copy.v35.test.ts'), 'keeps names, role descriptions']] },
  { item: '17', bug: 'Treat any mention of a review target as a stale version', file: 'src/renderer/src/components/TaskDetail.tsx',
    from: 'return /새 버전이 제출됨|검수 대상이 지금 검수 대상과 다릅니다/.test(message);',
    to: 'return /새 버전|검수 대상/.test(message);',
    checks: [[vitest('src/renderer/src/components/backend-view.test.ts'), 'refreshes the review form only']] },
  { item: '20', bug: 'Hide task titles in revert links', file: 'src/renderer/src/components/TaskDetail.tsx',
    from: "snapshot.tasks.find(item => item.id === originalId)?.title ?? '작업'",
    to: "'작업'", checks: [[vitest('src/renderer/src/components/backend-view.test.ts'), 'renders both directions']] },
  { item: '20', bug: 'Render comparison chunks as raw preformatted text', file: 'src/renderer/src/screens/Documents.tsx',
    from: '<Markdown source={part.value} />', to: '<pre>{part.value}</pre>',
    checks: [[browser('src/renderer/tools/verify-text-visuals.mjs'), 'comparison']] },
  { item: '20', bug: 'Use the fallback monospace font for code again', file: 'src/renderer/src/styles/app.css',
    from: "font-family: 'Pretendard Variable', Pretendard, 'Segoe UI', sans-serif;",
    to: 'font-family: monospace;',
    checks: [[browser('src/renderer/tools/verify-text-visuals.mjs'), 'Gulim']] },
  { item: '20', bug: 'Repeat the round in document tree labels', file: 'src/renderer/src/screens/Documents.tsx',
    from: '{treeReportTitle(report.title, report.round)}</button>', to: '{report.title}</button>',
    checks: [[browser('src/renderer/tools/verify-text-visuals.mjs'), 'duplicate round']] },
  { item: '20', bug: 'Leave an empty table in member history', file: 'src/renderer/src/components/MemberPanel.tsx',
    from: '{detail.history.length ? <div className="table-scroll">', to: '{true ? <div className="table-scroll">',
    checks: [[browser('src/renderer/tools/verify-member-message.mjs'), 'empty history table']] },
  { item: '20', bug: 'Keep the member effort mapping from panel mount', file: 'src/renderer/src/components/MemberPanel.tsx',
    from: '}, [snapshot.version]);', to: '}, []);',
    checks: [[browser('src/renderer/tools/verify-effort-live.mjs'), 'Timeout']] },
  { item: '20', bug: 'Enable empty client ID save', file: 'src/renderer/src/screens/Settings.tsx',
    from: 'disabled={!(clientIdDraft ?? s.account.googleClientId).trim()}', to: 'disabled={false}',
    checks: [[browser('src/renderer/tools/verify-auth.mjs'), 'false !== true']] },
  { item: '20', bug: 'Drop the login pending disable', file: 'src/renderer/src/App.tsx',
    from: 'disabled={loggingIn || !state?.googleConfigured', to: 'disabled={!state?.googleConfigured',
    checks: [[browser('src/renderer/tools/verify-auth.mjs'), 'false !== true']] },
  { item: '20', bug: 'Hide changed-settings guidance until form opens', file: 'src/renderer/src/App.tsx',
    from: 'state?.ownerRegistered && setupAvailable && state.googleConfigured && state.googleSecretSet && !setupOpen && <p className="login-guidance">',
    to: 'false && <p className="login-guidance">',
    checks: [[browser('src/renderer/tools/verify-auth.mjs'), 'login-guidance']] },
  { item: '20', bug: 'Move the login error toast over the form again', file: 'src/renderer/src/styles/app.css',
    from: '.login-toasts { right: auto; left: 22px; bottom: 22px; }',
    to: '.login-toasts { right: 22px; left: auto; bottom: 110px; }',
    checks: [[browser('src/renderer/tools/verify-auth.mjs'), 'error toast covers']] },
  { item: '20', bug: 'Do not refresh the main agent resolved effort hint', file: 'src/renderer/src/screens/Settings.tsx',
    from: '선택한 노력치: {EFFORT_TIER_LABEL[tier]} · 실제 값', to: '선택한 노력치: {EFFORT_TIER_LABEL[tier]} · 단계 값',
    checks: [[browser('src/renderer/tools/verify-effort-live.mjs'), 'Timeout']] },
  { item: '20', bug: 'Remove the system-paused demo member', file: 'src/renderer/src/api/fake/data.ts',
    from: "pausedMembers: [{ memberId: 'M-0020', since: ago(25), mode: 'immediate', by: 'system', reason: '작업 프로세스 종료를 확인하지 못해 일시정지했습니다.' }]",
    to: 'pausedMembers: []',
    checks: [[vitest('src/renderer/src/components/stop-guard.test.ts'), 'shows why a demo member']] },
  { item: '20', bug: 'Keep anchored comments after cancel on the same report', file: 'src/renderer/src/screens/Documents.tsx',
    from: "setChangesOpen(false); setQuote(''); setQuoteComment(''); setAnchored([]); setComment(''); };",
    to: "setChangesOpen(false); setQuote(''); setQuoteComment(''); setComment(''); };",
    checks: [[browser('src/renderer/tools/verify-browser.mjs'), 'Cancel did not reset review comments']] },
];

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
for (const mutation of mutations) {
  assert.ok(mutation.file.startsWith('src/renderer/'));
  const original = readFileSync(mutation.file, 'utf8');
  assert.ok(original.includes(mutation.from), `${mutation.file}: mutation anchor missing`);
  try {
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to), 'utf8');
    await pause(350);
    const checks = [];
    for (const [args, expected] of mutation.checks) {
      const run = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 3_000_000 });
      const output = `${run.stdout ?? ''}\n${run.stderr ?? ''}`;
      checks.push({ test: args.join(' '), caught: run.status !== 0 && output.includes(expected), exitCode: run.status,
        evidence: output.split(/\r?\n/).find(line => line.includes(expected))?.trim() ?? String(run.error ?? '').slice(0, 200) });
    }
    results.push({ item: mutation.item, reintroducedBug: mutation.bug, checks });
    console.log(`${mutation.item} ${mutation.bug}: ${checks.every(check => check.caught) ? 'caught' : 'MISSED'}`);
  } finally {
    writeFileSync(mutation.file, original, 'utf8');
    await pause(200);
  }
}
writeFileSync('docs/design/v35-functions/mutation-check.json', JSON.stringify(results, null, 2) + '\n', 'utf8');
assert.ok(results.every(result => result.checks.every(check => check.caught)), 'one or more mutations escaped the intended check');
