import { readFileSync, writeFileSync } from 'node:fs';
const file = 'src/renderer/src/components/TaskDetail.tsx';
let source = readFileSync(file, 'utf8');
const edits = [
  [
    '<Section title="변경 내용"><Diff value={detail.diff} /></Section>',
    '<Section title="변경 내용"><Diff value={detail.diff} /></Section>{detail.artifact && <Section title="보관된 산출물"><p>확정 버전 {detail.artifact.version} · {date(detail.artifact.finalizedAt)}</p><p>보관 위치: {detail.artifact.dir}</p><ul>{detail.artifact.files.map(file => <li key={file}>{file}</li>)}</ul></Section>}',
  ],
  [
    '<Section title="대표 검수"><div className="criterion-form">',
    '<Section title="대표 검수">{detail.reviewNotes && <div className="review-notes"><strong>따로 확인할 파일</strong>{detail.reviewNotes.uncheckedConflictFiles.length > 0 && <p>충돌 해결 뒤 내용 확인이 필요한 파일: {detail.reviewNotes.uncheckedConflictFiles.join(", ")}</p>}{detail.reviewNotes.deliverables && <p>전환 전 산출물: {detail.reviewNotes.deliverables.dir} · {detail.reviewNotes.deliverables.files.join(", ")}</p>}</div>}<div className="criterion-form">',
  ],
  [
    '{reviewError && <p role="alert" className="warning">{reviewError}</p>}<button className="primary-button"',
    '{passHasFailedRow && <p className="warning">미통과 항목이 있습니다. 통과로 등록하려면 모든 항목을 통과로 바꿔 주세요.</p>}{reviewError && <p role="alert" className="warning">{reviewError}</p>}<button className="primary-button"',
  ],
];
for (const [from, to] of edits) {
  if (source.includes(to)) continue;
  if (source.split(from).length !== 2) throw new Error(`Review notes anchor missing or repeated: ${from}`);
  source = source.replace(from, to);
}
writeFileSync(file, source);
