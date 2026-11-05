"""Temporarily reintroduce each renderer regression, then restore the source."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'src/renderer/src/lib/taskSignals.ts'
TEST = 'src/renderer/src/lib/taskSignals.test.ts'
CASES = [
    ('1 typed rejudge refId', 'finds the rejudge hold', "reason.refId === 'rejudge'", 'false'),
    ('2 check left files', 'names the exact consequence', "reason.note.includes('검사 뒤 커밋되지 않은 파일'))\n    ?", "reason.note.includes('검사 뒤 없는 파일'))\n    ?"),
    ('3 emergency uncertainty', 'distinguishes unconfirmed shutdowns', 'if (unknown && unknown === summary.failures.length)', 'if (false && unknown === summary.failures.length)'),
    ('4 typed member scope', 'offers the member release path', "pausedReasons.some(reason => reason.scope === 'member')", 'false'),
    ('4 typed project scope', 'offers the member release path', "pausedReasons.some(reason => reason.scope === 'project')", 'false'),
    ('5 typed unverifiable conflict', 'keeps the unverifiable files', 'return task.conflictUnverifiable ?? [];', 'return [];'),
    ('6 typed changed criterion', 'marks exact changed criteria', 'return task.changedCriteria ?? [];', 'return [];'),
    ('6 typed checkRuns', 'marks exact changed criteria', 'return detail.checkRuns ?? [];', 'return [];'),
    ('6 unknown remaining', 'marks exact changed criteria', 'run.remaining === -1', 'false'),
    ('6 left files', 'marks exact changed criteria', 'run.leftFiles.length > 0', 'false'),
    ('7 redelivery', 'treats a redelivered pending message', "message.text.startsWith('(다시 전달 —') ? '다시 전달 대기'", "message.text.startsWith('(다시 전달 —') ? '전달 못 함'"),
    ('8 notice groups', 'preserves each sync notice group', "body.split(' / ') : [body]", '[body] : [body]'),
]

original = SOURCE.read_bytes()
text = original.decode('utf-8')
lines = ['# Renderer mutation checks', '', 'Each run used `--no-fsModuleCache` and restored the source immediately afterward.', '']
try:
    for name, test_name, old, new in CASES:
        if text.count(old) != 1:
            raise RuntimeError(f'{name}: mutation target count {text.count(old)}')
        SOURCE.write_text(text.replace(old, new), encoding='utf-8', newline='\n')
        try:
            result = subprocess.run([
                'npx.cmd', 'vitest', 'run', '--config', 'src/renderer/tools/vitest.config.ts',
                TEST, '-t', test_name, '--no-fsModuleCache',
            ], cwd=ROOT, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=90)
            combined = result.stdout + result.stderr
            failed_as_expected = result.returncode != 0 and 'AssertionError' in combined
            old_label = ' '.join(old.split())
            new_label = ' '.join(new.split())
            lines.append(f'- {name}: {"FAIL as expected" if failed_as_expected else "UNEXPECTED RESULT"} (exit {result.returncode}). Reintroduced: `{old_label}` → `{new_label}`.')
            if not failed_as_expected:
                lines.append(f'  - Output: `{combined[-600:]}`')
        finally:
            SOURCE.write_bytes(original)
finally:
    SOURCE.write_bytes(original)

output = Path(__file__).with_name('mutations.md')
output.write_text('\n'.join(lines) + '\n', encoding='utf-8', newline='\n')
print(output)
print('\n'.join(lines[4:]))
if 'UNEXPECTED RESULT' in '\n'.join(lines):
    raise SystemExit(1)
