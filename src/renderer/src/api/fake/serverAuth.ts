import type { AppSnapshot, DeviceLoginPoll, DeviceLoginStart, DeviceSessionView, NotificationView } from '../../../../shared/views';

// In-memory server simulation. No setup codes or device sessions go into localStorage.
export function createServerAuth({ snapshot, query, changed, notify }: {
  snapshot: Pick<AppSnapshot, 'auth'>; query: URLSearchParams; changed: () => void; notify: (notice: NotificationView) => void;
}) {
  let email = 'owner@example.com';
  let sequence = 0;
  let devices: DeviceSessionView[] = [];
  const logins = new Map<string, { start: DeviceLoginStart; deviceName: string; startedAt: number; polls: number; result?: DeviceLoginPoll }>();
  const iso = (offset = 0) => new Date(Date.now() + offset).toISOString();
  const serverOnly = () => { if (snapshot.auth.mode !== 'server') throw new Error('데스크톱 앱은 브라우저 로그인을 씁니다'); };
  const ownerOnly = () => { if (!snapshot.auth.loggedIn) throw Object.assign(new Error('로그인이 필요합니다.'), { code: 'unauthorized' }); };
  const logout = () => {
    devices = devices.filter(device => !device.current);
    snapshot.auth = { ...snapshot.auth, loggedIn: false, owner: null };
    changed();
    return structuredClone(snapshot.auth);
  };
  if (query.get('fakeMode') === 'server') {
    snapshot.auth = { ...snapshot.auth, mode: 'server', setupRequired: query.get('fakeSetup') === '1', loggedIn: false, owner: null,
      googleConfigured: true, googleSecretSet: true, ownerRegistered: query.get('fakeSetup') !== '1', googleSetupOpen: false, devLoginAllowed: false };
    devices.push({ id: 'fake-other-phone', deviceName: '휴대폰 (Android)', tailscaleLogin: 'owner@example.com',
      createdAt: iso(-86400000), lastUsedAt: iso(-3600000), expiresAt: iso(13 * 86400000), current: false });
    notify({ id: 'N-DEVICE-LOGIN', key: 'device-login:fake-other-phone', title: '새 기기 로그인',
      body: `휴대폰 (Android)이 로그인했습니다.\nTailscale 사용자: owner@example.com\n로그인 시각: ${new Date().toLocaleString('ko-KR')}`,
      createdAt: iso(), read: false, level: 'normal', link: null });
  } else snapshot.auth.mode = 'desktop';
  return {
    start(deviceName = '웹 브라우저'): DeviceLoginStart {
      serverOnly();
      if (snapshot.auth.setupRequired) throw new Error('서버 설정이 끝나지 않았습니다');
      // Retain completed attempts so repeat polls return the same result.
      const loginId = `fake-login-${++sequence}`;
      const start: DeviceLoginStart = { loginId, userCode: sequence % 2 ? 'WQKF-RHTM' : 'BCDX-FGHJ', verificationUrl: 'https://www.google.com/device',
        expiresAt: iso(query.get('fakeLogin') === 'expired' ? 6000 : 600000), intervalSec: 2 };
      logins.set(loginId, { start, deviceName, startedAt: Date.now(), polls: 0 });
      return structuredClone(start);
    },
    poll(loginId: string): DeviceLoginPoll {
      serverOnly();
      const login = logins.get(loginId);
      if (!login) return { status: 'error', message: '시작한 로그인을 찾을 수 없습니다. 다시 시작해 주세요.' };
      if (login.result) return structuredClone(login.result);
      if (Date.now() >= Date.parse(login.start.expiresAt)) return login.result = { status: 'expired', message: '로그인 코드가 만료되었습니다. 다시 시작해 주세요.' };
      const scenario = query.get('fakeLogin');
      login.polls++;
      if (scenario === 'slow' && login.polls === 2) return { status: 'pending', intervalSec: 7 };
      const elapsed = Date.now() - login.startedAt;
      if (scenario === 'pending' || elapsed < 6000) return { status: 'pending' };
      if (scenario === 'denied') return login.result = { status: 'denied', message: '등록된 대표 계정이 아니어서 로그인을 거절했습니다. 대표 Google 계정으로 다시 로그인해 주세요.' };
      if (scenario === 'error') return login.result = { status: 'error', message: 'Google 로그인에 연결하지 못했습니다. 잠시 뒤 다시 시작해 주세요.' };
      if (elapsed < 12000) return { status: 'pending' };
      snapshot.auth = { ...snapshot.auth, loggedIn: true, ownerRegistered: true, owner: { email, name: '대표' } };
      devices = devices.filter(device => !device.current);
      devices.unshift({ id: `fake-current-${sequence}`, deviceName: login.deviceName, tailscaleLogin: email,
        createdAt: iso(), lastUsedAt: iso(), expiresAt: iso(14 * 86400000), current: true });
      changed();
      login.result = { status: 'ok', auth: structuredClone(snapshot.auth) };
      return structuredClone(login.result);
    },
    setup(code: string, ownerEmail: string) {
      serverOnly();
      if (!snapshot.auth.setupRequired) throw new Error('대표 이메일이 이미 등록되어 있습니다.');
      if (code !== 'BCDX2345') throw new Error('설정 코드가 맞지 않습니다. 서버 PC에서 코드를 확인해 주세요.');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new Error('이메일 주소를 확인해 주세요.');
      email = ownerEmail.toLowerCase();
      snapshot.auth = { ...snapshot.auth, setupRequired: false, ownerRegistered: true };
      changed();
      return structuredClone(snapshot.auth);
    },
    list() {
      if (snapshot.auth.mode !== 'server') return [];
      ownerOnly();
      return structuredClone(devices);
    },
    revoke(id: string) {
      serverOnly(); ownerOnly();
      const device = devices.find(device => device.id === id);
      if (!device) throw new Error('기기를 찾을 수 없습니다.');
      devices = devices.filter(device => device.id !== id);
      if (device.current) logout();
      else changed();
      return structuredClone(devices);
    },
    logout,
  };
}
