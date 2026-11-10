import { useEffect, useState } from 'react';
import { Monitor, Image as ImageIcon } from 'lucide-react';
import type { GuiActionView, ScreenCaptureView, ScreenImageView, ScreenRecentView, SeatView } from '../../../shared/views';
import { GUI_ACTION_LABEL, GUI_RESULT_LABEL } from '../../../shared/labels';
import { call } from '../api/store';
import { date, Section } from '../lib/ui';
import { screenPauseReason, screenTypedText, screenVision } from '../lib/screens';

export function CaptureImage({ capture }: { capture: ScreenCaptureView }) {
  const [image, setImage] = useState<ScreenImageView | null>(null);
  const [state, setState] = useState('캡처를 불러오는 중…');
  useEffect(() => {
    let active = true;
    if (!capture.kept) return;
    void call('screens.image', capture.id).then(value => {
      if (!active) return;
      setImage(value);
      setState(value ? '' : '캡처가 지워졌거나 파일을 확인할 수 없습니다.');
    }).catch(() => { if (active) setState('캡처를 불러오지 못했습니다.'); });
    return () => { active = false; };
  }, [capture.id, capture.kept]);
  return image ? <img className="screen-capture-image" src={image.dataUrl} width={image.width} height={image.height} alt={`${date(capture.at)} 서버 PC 캡처 ${capture.id}`} /> : <p role="status">{state}</p>;
}

export function ScreenActionRecord({ row, captures, open }: { row: GuiActionView; captures: ScreenCaptureView[]; open: (id: string) => void }) {
  return <li className="screen-action">
    <div className="screen-action-heading"><strong>{GUI_ACTION_LABEL[row.action]}</strong><span className={`screen-result result-${row.result}`}>{GUI_RESULT_LABEL[row.result]}</span></div>
    <p className="screen-record-meta"><time dateTime={row.at}>{date(row.at)}</time> · 세대 {row.generation} · {row.holderLabel} · {row.by === 'server' ? '서버' : '메인 에이전트'}</p>
    <dl className="screen-action-facts">
      {row.x !== null && row.y !== null && <div><dt>실제 좌표</dt><dd>({row.x}, {row.y}){row.x2 !== null && row.y2 !== null ? ` → (${row.x2}, ${row.y2})` : ''}</dd></div>}
      {row.button && <div><dt>마우스</dt><dd>{{ left: '왼쪽', right: '오른쪽', middle: '가운데' }[row.button]} 버튼{row.count !== null ? ` · ${row.count}회` : ''}</dd></div>}
      {row.amount !== null && <div><dt>스크롤</dt><dd>{row.amount}</dd></div>}
      {row.keys && <div><dt>키</dt><dd>{row.keys}</dd></div>}
      {row.action === 'type' && <div><dt>입력한 글</dt><dd className="screen-typed-text">{screenTypedText(row)}</dd></div>}
      {row.focus && <div><dt>입력 대상</dt><dd>{row.focus.app} · {row.focus.title}</dd></div>}
    </dl>
    {row.detail && <p className="screen-action-detail">{row.detail}</p>}
    <div className="screen-capture-links">{([['전', row.beforeCaptureId], ['후', row.afterCaptureId]] as const).map(([label, id]) => {
      if (!id) return null;
      const capture = captures.find(item => item.id === id);
      return capture?.kept ? <button key={label} onClick={() => open(id)} aria-label={`${row.id} ${label} 캡처 ${id} 보기`}>{label} 캡처 보기</button> : <span key={label}>{label} 캡처 {id} · {capture ? '보관 기간이 지났거나 파일을 확인할 수 없습니다.' : '현재 목록에 없습니다'}</span>;
    })}</div>
  </li>;
}

export function SeatScreenControl({ seat }: { seat: SeatView }) {
  const [recent, setRecent] = useState<ScreenRecentView | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected) document.getElementById('screen-open-capture')?.scrollIntoView({ block: 'center' });
  }, [selected]);
  const operating = Boolean(seat.screen.operatingSince);
  useEffect(() => {
    let active = true, busy = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    setRecent(null); setSelected(null); setError('');
    const load = async () => {
      if (busy || !active) return;
      busy = true;
      try {
        const value = await call('screens.recent', { limit: 100 });
        if (active) { setRecent(value); setError(''); }
      } catch { if (active) setError('화면 기록을 불러오지 못했습니다.'); }
      finally { busy = false; }
    };
    const visibility = () => {
      clearInterval(timer);
      if (document.hidden) return;
      void load();
      if (operating) timer = setInterval(() => void load(), 5000);
    };
    visibility();
    document.addEventListener('visibilitychange', visibility);
    return () => { active = false; clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [seat.generation, operating]);
  const screen = seat.screen;
  const capture = recent?.captures.find(item => item.id === selected);
  return <div className="screen-control">
    <Section title="서버 PC 화면" action={<Monitor size={20} aria-hidden="true" />}>
      <div className={`screen-state ${screen.paused || screen.unavailable ? 'attention' : ''}`} role="status">
        <strong>{screen.unavailable ? '화면 도구를 쓸 수 없습니다' : screen.paused ? '화면 조작 멈춤' : screen.operatingSince ? '화면 조작 중' : '화면 도구 사용 가능'}</strong>
        {screen.unavailable && <p>{screen.unavailable.text}</p>}
        {screen.paused && <p>{screenPauseReason(screen.paused.by)}{screen.paused.by === 'human' ? '으로' : '로'} 멈췄습니다. {date(screen.paused.until)}까지 기다립니다.</p>}
        {screen.operatingSince && <p>서버 PC의 조작 표시 시작: {date(screen.operatingSince)}</p>}
        {!screen.unavailable && !screen.operatingSince && !screen.paused && <p>지금은 화면을 조작하고 있지 않습니다.</p>}
      </div>
      <p className="seat-vision">{screenVision(seat)}</p>
      <p className="muted">메인 에이전트가 서버 PC에서 한 일을 보여 줍니다. 요청은 아래 명령창에 적어 주세요.</p>
    </Section>
    <div className="screen-records-grid">
      <Section title="최근 캡처" action={<ImageIcon size={20} aria-hidden="true" />}>
        <p className="screen-record-help">캡처는 열 때 불러옵니다. 24시간 또는 최근 500장까지 보관합니다.</p>
        <ul className="screen-captures">{recent?.captures.map(item => <li key={item.id}>
          <strong>{item.screen === 'all' ? '모든 화면' : `화면 ${item.screen}`}</strong>
          <p className="screen-record-meta">{date(item.at)} · 세대 {item.generation} · {item.holderLabel}</p>
          <p>{item.width} × {item.height} · {item.cause === 'after_input' ? '입력 후 캡처' : '화면 확인'}{item.focus ? ` · ${item.focus}` : ''}</p>
          {item.kept ? <button aria-label={`캡처 ${item.id} 보기`} onClick={() => setSelected(item.id)}>캡처 보기</button> : <p className="screen-expired">보관 기간이 지났거나 파일을 확인할 수 없습니다.</p>}
        </li>)}</ul>
        {selected && <div id="screen-open-capture" className="screen-open-capture" aria-label="선택한 캡처">
          <div className="screen-action-heading"><strong>{selected}</strong><button onClick={() => setSelected(null)}>캡처 닫기</button></div>
          {capture?.kept ? <CaptureImage key={capture.id} capture={capture} /> : <p>보관 기간이 지났거나 파일을 확인할 수 없습니다.</p>}
        </div>}
        {recent?.captures.length === 0 && <p className="empty">아직 캡처가 없습니다.</p>}
      </Section>
      <Section title="화면 조작 기록">
        <p className="screen-record-help">최근 동작 최대 100건입니다. 좌표는 서버 PC의 실제 픽셀입니다.</p>
        <ol className="screen-actions">{recent?.actions.map(row => <ScreenActionRecord key={row.id} row={row} captures={recent.captures} open={setSelected} />)}</ol>
        {recent?.actions.length === 0 && <p className="empty">아직 화면 조작 기록이 없습니다.</p>}
      </Section>
    </div>
    {!recent && !error && <p role="status">화면 기록을 불러오는 중…</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
