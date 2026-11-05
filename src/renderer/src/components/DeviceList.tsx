import { useEffect, useRef, useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import type { AuthState, DeviceSessionView } from '../../../shared/views';
import { call } from '../api/store';
import { date, Section } from '../lib/ui';

export function DeviceList({ auth, version, focusRequest = 0 }: { auth: AuthState; version: number; focusRequest?: number }) {
  const container = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<DeviceSessionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const server = auth.mode === 'server';
  useEffect(() => {
    if (focusRequest) { container.current?.scrollIntoView({ block: 'start' }); container.current?.focus({ preventScroll: true }); }
  }, [focusRequest]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    // Desktop also calls this owner method; its contracted result is an empty list.
    void call('auth.listDevices').then(value => { if (!cancelled) setDevices(server ? value : []); })
      .catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : '기기 목록을 불러오지 못했습니다.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [server, version, reload]);
  const revoke = async (device: DeviceSessionView) => {
    const question = device.current ? '이 기기의 연결을 끊을까요? 이 화면에서 로그아웃됩니다.' : `${device.deviceName}의 연결을 끊을까요? 다시 쓰려면 해당 기기에서 로그인해야 합니다.`;
    if (revoking || !window.confirm(question)) return;
    setRevoking(device.id); setError('');
    try {
      setDevices(await call('auth.revokeDevice', device.id));
      if (device.current) window.dispatchEvent(new Event('wook:unauthorized'));
    } catch (error) { setError(error instanceof Error ? error.message : '연결을 끊지 못했습니다. 잠시 뒤 다시 시도해 주세요.'); }
    finally { setRevoking(null); }
  };
  return <div id="logged-in-devices" ref={container} tabIndex={-1} aria-label="로그인한 기기"><Section title="로그인한 기기">
    {!server ? <p className="muted">이 PC에서 쓰는 데스크톱 앱입니다 — 기기별 로그인은 서버 접속에서 씁니다</p> : <>
      <p className="muted">내 서버에 연결된 기기입니다. 모르는 기기가 있으면 연결을 끊어 주세요.</p>
      {loading && !devices.length && <p role="status">기기를 불러오는 중…</p>}
      {!loading && !error && !devices.length && <p className="muted">로그인한 기기가 없습니다.</p>}
      <ul className="device-list">{devices.map(device => <li className="device-session" key={device.id}>
        <MonitorSmartphone size={22} className="device-session-icon" aria-hidden="true" />
        <div className="device-session-info"><div className="device-session-name"><strong>{device.deviceName}</strong>{device.current && <span className="current-device">이 기기</span>}</div>
          <p>Tailscale <span>{device.tailscaleLogin ?? '사용자 정보 없음'}</span></p>
          <dl><div><dt>마지막 사용</dt><dd>{date(device.lastUsedAt)}</dd></div><div><dt>만료</dt><dd>{date(device.expiresAt)}</dd></div></dl>
        </div>
        <button className="device-revoke" disabled={revoking !== null} aria-label={`${device.deviceName} 끊기`} onClick={() => void revoke(device)}>{revoking === device.id ? '끊는 중…' : '끊기'}</button>
      </li>)}</ul>
      {error && <div className="device-list-error" role="alert"><p>{error}</p><button onClick={() => setReload(value => value + 1)}>다시 불러오기</button></div>}
    </>}
  </Section></div>;
}
