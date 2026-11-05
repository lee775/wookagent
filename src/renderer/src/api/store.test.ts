import { afterEach, describe, expect, it, vi } from 'vitest';
import { call } from './store';

afterEach(() => vi.unstubAllGlobals());

describe('IPC 인증 오류', () => {
  it('어느 호출에서든 unauthorized가 오면 로그인 전환 이벤트를 보낸다', async () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal('window', {
      wook: { invoke: async () => Promise.reject({ code: 'unauthorized', message: '로그인이 필요합니다.' }) },
      dispatchEvent,
    });

    await expect(call('system.info')).rejects.toMatchObject({ code: 'unauthorized' });
    expect(dispatchEvent).toHaveBeenCalledOnce();
    expect(dispatchEvent.mock.calls[0][0]).toMatchObject({ type: 'wook:unauthorized' });
  });
});
