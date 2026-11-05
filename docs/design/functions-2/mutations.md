# Renderer mutation checks

Each run used `--no-fsModuleCache` and restored the source immediately afterward.

- 1 typed rejudge refId: FAIL as expected (exit 1). Reintroduced: `reason.refId === 'rejudge'` → `false`.
- 2 check left files: FAIL as expected (exit 1). Reintroduced: `reason.note.includes('검사 뒤 커밋되지 않은 파일')) ?` → `reason.note.includes('검사 뒤 없는 파일')) ?`.
- 3 emergency uncertainty: FAIL as expected (exit 1). Reintroduced: `if (unknown && unknown === summary.failures.length)` → `if (false && unknown === summary.failures.length)`.
- 4 typed member scope: FAIL as expected (exit 1). Reintroduced: `pausedReasons.some(reason => reason.scope === 'member')` → `false`.
- 4 typed project scope: FAIL as expected (exit 1). Reintroduced: `pausedReasons.some(reason => reason.scope === 'project')` → `false`.
- 5 typed unverifiable conflict: FAIL as expected (exit 1). Reintroduced: `return task.conflictUnverifiable ?? [];` → `return [];`.
- 6 typed changed criterion: FAIL as expected (exit 1). Reintroduced: `return task.changedCriteria ?? [];` → `return [];`.
- 6 typed checkRuns: FAIL as expected (exit 1). Reintroduced: `return detail.checkRuns ?? [];` → `return [];`.
- 6 unknown remaining: FAIL as expected (exit 1). Reintroduced: `run.remaining === -1` → `false`.
- 6 left files: FAIL as expected (exit 1). Reintroduced: `run.leftFiles.length > 0` → `false`.
- 7 redelivery: FAIL as expected (exit 1). Reintroduced: `message.text.startsWith('(다시 전달 —') ? '다시 전달 대기'` → `message.text.startsWith('(다시 전달 —') ? '전달 못 함'`.
- 8 notice groups: FAIL as expected (exit 1). Reintroduced: `body.split(' / ') : [body]` → `[body] : [body]`.

## Direct-message routing note (browser mutation)

At 1440×900, `python docs/design/functions-2/check-rejudge-note.py` passed with the routing phrase once in the page. Reintroducing `toast('직접 메시지를 보냈습니다', result?.note ?? '', 'info');` after `setSendNote(...)` in `MemberPanel.tsx` made the same check fail: `Expected one routing note, found 2` (exit 1). The source was restored; the check passed again and recaptured `rejudge-message.png`. The old toast visibly covered part of the message list; the restored capture leaves the composer and list clear.
