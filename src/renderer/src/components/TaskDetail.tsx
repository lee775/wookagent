import { useEffect, useState } from 'react';
import type { AppSnapshot, CheckRunView, TaskDetail as TaskDetailView, DirectiveDetail as DirectiveDetailView, TaskView } from '../../../shared/views';
import { AUTO_CHECK_LABEL, DIRECTIVE_STATE_LABEL, OUTPUT_MODE_LABEL, PRIORITY_LABEL, TASK_STATE_LABEL, TASK_TYPE_LABEL } from '../../../shared/labels';
import { call } from '../api/store';
import { date, Diff, LabelValue, Modal, Progress, Section } from '../lib/ui';
import { resolveDisplayText, taskEventText, taskStateText } from '../lib/displayText';
import { openCommand } from '../lib/commands';
import { changedCriteriaOf, checkRunDetails, checkRunsOf, holdReasonHint, unverifiableConflictFiles } from '../lib/taskSignals';

export function TaskRevertLinks({ task, snapshot, openTask }: { task: Pick<TaskView, 'revertOfTaskId' | 'revertedByTaskId'>; snapshot: Pick<AppSnapshot, 'tasks'>; openTask: (id: string) => void }) {
  const originalId = task.revertOfTaskId;
  const revertId = task.revertedByTaskId;
  if (!originalId && !revertId) return null;
  return <Section title="되돌리기 연결">
    {originalId && <button className="list-link" onClick={() => openTask(originalId)}>되돌린 작업: {snapshot.tasks.find(item => item.id === originalId)?.title ?? '작업'} →</button>}
    {revertId && <button className="list-link" onClick={() => openTask(revertId)}>되돌리기 작업: {snapshot.tasks.find(item => item.id === revertId)?.title ?? '작업'} →</button>}
  </Section>;
}

function CheckRunHistory({ runs }: { runs: CheckRunView[] }) {
  if (runs.length === 0) return null;
  return <Section title="실행 기록">{runs.map(run => <div className="review-entry" key={run.requestId}>
    <strong>자동 검사 · {run.command}</strong>
    <p>{run.ownerConfirmedAt ? `재개 때 결과 확인 · ${date(run.ownerConfirmedAt)}` : `검사 ${run.state === 'unknown' ? '종료 상태 미확인' : run.state === 'succeeded' ? '통과' : run.state === 'failed' ? '실패' : '실행 중'}`}</p>
    {checkRunDetails(run).map(line => <p key={line} className="warning">{line}</p>)}
  </div>)}</Section>;
}
export function TaskDetail({ id, snapshot, close, openDirective, openTask }: { id: string; snapshot: AppSnapshot; close: () => void; openDirective: (id: string) => void; openTask: (id: string) => void; openReviewer?: (id: string) => void }) {
  const [detail, setDetail] = useState<TaskDetailView | null>(null);
  useEffect(() => { let active = true; void call('tasks.get', id).then(value => { if (active) setDetail(value); }).catch(() => undefined); return () => { active = false; }; }, [id, snapshot.version]);
  if (!detail) return <Modal title="작업 상세" onClose={close}>불러오는 중…</Modal>;
  const t = detail.task;
  const name = (memberId: string | null) => memberId === 'M-MAIN' ? '메인 에이전트' : snapshot.members.find(m => m.id === memberId)?.name ?? '미정';
  const changedCriteria = changedCriteriaOf(t);
  const unverifiable = unverifiableConflictFiles(t);
  const checkRuns = checkRunsOf(detail);
  return <Modal title={t.title} onClose={close} wide><div className="detail-intro"><span className={`task-state task-${t.state}`}>{TASK_STATE_LABEL[t.state]}</span><span>{TASK_TYPE_LABEL[t.type]} · {PRIORITY_LABEL[t.priority]}</span><button className="text-button" onClick={() => openDirective(t.directiveId)}>상위 지시 {snapshot.directives.find(d => d.id === t.directiveId)?.title ?? '지시'} · {t.round}회차 →</button></div><p className="lead">{t.goal}</p><button className="command-shortcut" onClick={() => { close(); openCommand(t.projectId, `${t.id} "${t.title}"에 대해: `); }}>메인 에이전트에게 말하기</button>{t.reviewerId === 'M-MAIN' && t.state === 'in_review' && <p className="hint">메인 에이전트 검수 중</p>}<div className="detail-grid"><LabelValue label="담당">{name(t.assigneeId)}</LabelValue><LabelValue label="검수자">{name(t.reviewerId)}</LabelValue><LabelValue label="선행 작업">{t.prerequisiteIds.map(taskId => snapshot.tasks.find(task => task.id === taskId)?.title ?? '작업').join(', ') || '없음'}</LabelValue><LabelValue label="산출물 방식">{OUTPUT_MODE_LABEL[t.outputMode]}</LabelValue><LabelValue label="작업 공간"><span title={t.worktreePath ?? undefined}>{t.worktreePath ? '생성됨' : '없음'}</span></LabelValue><LabelValue label="브랜치"><span title={t.branch ?? undefined}>{t.branch ? '연결됨' : '없음'}</span></LabelValue><LabelValue label="검수 차수 · 반려">{t.review.round}차 · 이번 회차 {t.review.rejectsInRound}회 / 전체 {t.review.rejectsTotal}회</LabelValue><LabelValue label="자동 검사">{AUTO_CHECK_LABEL[t.review.autoCheck]} · {t.review.autoCheckDetail}</LabelValue><LabelValue label="병합">{t.merge ? `${t.merge.mergeCommitSha} · ${date(t.merge.mergedAt)}` : '아직 병합되지 않음'}</LabelValue><LabelValue label="수정 예정 영역">{t.plannedAreas.join(', ') || '없음'}</LabelValue></div><Section title="진행 단계"><Progress value={t.progress} /><div className="step-list">{t.steps.map(step => <div key={step.idx} className={`step ${step.done ? 'done' : ''} ${!step.done && step.idx === t.progress.done + 1 ? 'current' : ''}`}><span>{step.done ? '✓' : step.idx}</span><strong>{step.title}</strong><small>{step.done ? '완료' : !step.done && step.idx === t.progress.done + 1 ? '현재 단계' : '대기'}</small></div>)}</div></Section><Section title="완료 조건"><ul>{t.acceptanceCriteria.map(x => <li key={x}>{x}{changedCriteria.includes(x) && <span className="criteria-mark">최근 바뀐 조건</span>}</li>)}</ul></Section>
    <TaskRevertLinks task={t} snapshot={snapshot} openTask={openTask} />
    {t.hold && <Section title="보류 사유"><p>재개 시 돌아갈 상태: {t.hold.returnState ? TASK_STATE_LABEL[t.hold.returnState] : '미정'}</p>{t.hold.reasons.map((reason, index) => <div className="hold-reason" key={index}><strong>{reason.label}</strong><p className="hold-hint">{holdReasonHint(reason, checkRuns)}</p><details className="hold-history"><summary>보류 당시 기록 · {date(reason.since)}</summary><p>{reason.note}</p></details></div>)}</Section>}
    {t.conflictFiles.length > 0 && <Section title="열린 병합 충돌"><p>충돌 파일: {t.conflictFiles.join(', ')}</p>{unverifiable.length > 0 && <p className="warning">내용을 확인할 수 없는 파일: {unverifiable.join(', ')}</p>}</Section>}<CheckRunHistory runs={checkRuns} /><Section title="검수 이력">{detail.reviews.map(review => <div className="review-entry" key={review.id}><strong>{review.reviewRound}차 · {review.reviewerName} · {review.verdict === 'pass' ? '통과' : '반려'}</strong><p>{review.reason}</p>{review.criteria.map((c, i) => <p key={i}>{c.pass ? '✓' : '✕'} {c.criterion}{c.note && ` · ${c.note}`}</p>)}</div>)}</Section><Section title="상태 전이">{detail.transitions.map((transition, index) => <p className="transition" key={index}>{date(transition.at)} · {taskStateText(transition.from)} → {taskStateText(transition.to)} · {taskEventText(transition.event)} · {resolveDisplayText(transition.reason, snapshot)} ({resolveDisplayText(transition.actor, snapshot)})</p>)}</Section><Section title="변경 내용"><Diff value={detail.diff} /></Section>{detail.artifact && <Section title="보관된 산출물"><p>확정 버전 {detail.artifact.version} · {date(detail.artifact.finalizedAt)}</p><p>보관 위치: {detail.artifact.dir}</p><ul>{detail.artifact.files.map(file => <li key={file}>{file}</li>)}</ul></Section>}

  </Modal>;
}

export function DirectiveDetail({ id, snapshot, close, openTask, openReport }: { id: string; snapshot: AppSnapshot; close: () => void; openTask: (id: string) => void; openReport: (id: string) => void }) {
  const [detail, setDetail] = useState<DirectiveDetailView | null>(null);
  useEffect(() => { void call('directives.get', id).then(setDetail).catch(() => undefined); }, [id, snapshot.version]);
  if (!detail) return <Modal title="지시 상세" onClose={close}>불러오는 중…</Modal>;
  const d = detail.directive;
  return <Modal title={d.title} onClose={close} wide><div className="detail-intro"><span className="state-chip">{DIRECTIVE_STATE_LABEL[d.state]}</span><span>{d.round}회차 · {date(d.createdAt)}</span></div><p className="lead">{d.text}</p><Progress value={d.progress} /><Section title="회차별 요청">{detail.rounds.map(round => <div className="round-entry" key={round.round}><div><strong>{round.round}회차</strong><small>{date(round.requestedAt)}</small></div><p>{round.text}</p>{round.anchored.map((a, index) => <blockquote key={index}>“{a.quote}” → {a.comment}</blockquote>)}{round.reportId && <button className="text-button" onClick={() => openReport(round.reportId!)}>보고서 열기 →</button>}</div>)}</Section><Section title="작업"><div className="task-row-list">{detail.tasks.map(task => <button className="task-row" key={task.id} onClick={() => openTask(task.id)}><span className={`task-state task-${task.state}`}>{TASK_STATE_LABEL[task.state]}</span><strong>{task.title}</strong><small>{task.round}회차</small></button>)}</div></Section><Section title="보고서">{detail.reports.map(report => <button className="list-link" key={report.id} onClick={() => openReport(report.id)}>{report.title} · {report.round}회차 →</button>)}</Section><button onClick={() => { close(); openCommand(d.projectId, `${d.title}에 대해: `); }}>메인 에이전트에게 말하기</button></Modal>;
}
