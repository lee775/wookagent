/**
 * Linux 경로 규칙 (리드 결정 S10-6.6, pathGuard.ts linuxPathProblem): 프로젝트 폴더·작업 폴더 위치·host_exec cwd로 /proc·/sys·/dev(와 그 안)와 네트워크 파일
 * 시스템(nfs·cifs/smb·sshfs·ceph·glusterfs)을 받지 않는다. 9p(WSL의 /mnt/c)는 받는다. 적힌 경로와 실제 경로(심볼릭 링크를 푼 것) 둘 다 본다.
 * - 순수 판단(넣은 mountinfo·realpath)은 어느 OS에서나: 마운트 종류, 가장 긴 마운트 자리, 8진 이스케이프(빈칸이 든 마운트 자리), 링크로 가리킨 /proc·NFS
 * - 글: Windows는 예전 글 그대로(로컬 드라이브 폴더, C:\work, D:\wook-workspace), Linux는 Linux 예시
 * - Linux에서만: 실제 /proc·/sys·/dev, /proc을 가리키는 심볼릭 링크, 실제 mountinfo로 임시 폴더는 받는다, 9p 마운트가 있으면 그 아래도 받는다
 * 잡는 결함: Linux에서 아무 경로나 받음(예전), 링크로 우회, /procfoo 같은 이름을 /proc으로 봄, 바깥 마운트를 안쪽 마운트보다 먼저 봄, 9p를 막음
 */
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { linuxPathProblem, localFolderWords, mountOf, parseMountInfo, projectPathRefusal, readMounts, winPathProblem, type MountEntry } from './pathGuard';
import { mainWorkDirProblem, workspaceExample } from './mainWork';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** mountinfo 한 줄 (선택 칸 하나) */
const line = (id: number, mountPoint: string, fsType: string, source = 'src'): string => `${id} 1 0:${id} / ${mountPoint} rw,relatime shared:${id} - ${fsType} ${source} rw`;
const MOUNTS = parseMountInfo(
  [
    line(1, '/', 'ext4', '/dev/sdc'),
    line(2, '/proc', 'proc', 'proc'),
    line(3, '/sys', 'sysfs', 'sysfs'),
    line(4, '/dev', 'devtmpfs', 'none'),
    line(5, '/mnt/c', '9p', 'C:\\134'),
    line(6, '/srv/nfs', 'nfs4', 'host:/export'),
    line(7, '/srv/nfs/local', 'ext4', '/dev/sdd'),
    line(8, '/home/u/smb\\040share', 'cifs', '//host/share'),
    line(9, '/home/u/ssh', 'fuse.sshfs', 'u@host:'),
    line(10, '/data/ceph', 'ceph', 'mon:/'),
    line(11, '/data/gluster', 'fuse.glusterfs', 'host:/vol'),
    line(12, '/srv/proc-copy', 'proc', 'proc'),
  ].join('\n'),
);
const same = (p: string): string => p;

describe('Linux 경로 규칙 — 순수 판단 (모든 OS)', () => {
  it('mountinfo를 읽는다 — 8진 이스케이프(\\040 빈칸)를 풀고 종류는 - 뒤 칸', () => {
    expect(MOUNTS.find((m) => m.fsType === 'cifs')).toEqual({ mountPoint: '/home/u/smb share', fsType: 'cifs' });
    expect(MOUNTS).toHaveLength(12);
  });

  it('/proc·/sys·/dev와 그 안은 가상 파일 시스템 — /procfoo 같은 이름은 아니다', () => {
    const o = { mounts: MOUNTS, real: same };
    expect(linuxPathProblem('/proc', o)).toBe('가상 파일 시스템(/proc)의 경로');
    expect(linuxPathProblem('/proc/self/cwd', o)).toBe('가상 파일 시스템(/proc)의 경로');
    expect(linuxPathProblem('/sys/kernel', o)).toBe('가상 파일 시스템(/sys)의 경로');
    expect(linuxPathProblem('/dev/shm/work', o)).toBe('가상 파일 시스템(/dev)의 경로');
    expect(linuxPathProblem('/procfoo/work', o)).toBeNull();
    expect(linuxPathProblem('/home/u/devtools', o)).toBeNull();
    // 다른 자리에 붙인 proc도 가상 파일 시스템이다 (마운트 종류로)
    expect(linuxPathProblem('/srv/proc-copy/1', o)).toBe('가상 파일 시스템(proc, /srv/proc-copy)의 경로');
  });

  it('네트워크 파일 시스템(nfs·cifs·sshfs·ceph·glusterfs)은 막고, 9p(WSL /mnt/c)·ext4는 받는다 — 가장 긴 마운트 자리가 정한다', () => {
    const o = { mounts: MOUNTS, real: same };
    expect(linuxPathProblem('/srv/nfs/proj', o)).toBe('네트워크 파일 시스템(nfs4, /srv/nfs)의 경로');
    expect(linuxPathProblem('/srv/nfs/local/proj', o)).toBeNull();
    expect(linuxPathProblem('/home/u/smb share/proj', o)).toBe('네트워크 파일 시스템(cifs, /home/u/smb share)의 경로');
    expect(linuxPathProblem('/home/u/ssh', o)).toBe('네트워크 파일 시스템(fuse.sshfs, /home/u/ssh)의 경로');
    expect(linuxPathProblem('/data/ceph/x', o)).toBe('네트워크 파일 시스템(ceph, /data/ceph)의 경로');
    expect(linuxPathProblem('/data/gluster/x', o)).toBe('네트워크 파일 시스템(fuse.glusterfs, /data/gluster)의 경로');
    expect(linuxPathProblem('/mnt/c/Users/u/work', o)).toBeNull();
    expect(linuxPathProblem('/home/u/work', o)).toBeNull();
    expect(linuxPathProblem('/srv/nfsother', o)).toBeNull();
    expect(mountOf('/srv/nfs/local/a', MOUNTS)).toEqual({ mountPoint: '/srv/nfs/local', fsType: 'ext4' });
  });

  it('적힌 경로가 아니라 실제 경로(링크를 푼 것)도 본다 — 링크로 /proc·NFS를 가리켜도 막는다. mountinfo를 읽지 못하면 마운트 검사는 건너뛴다', () => {
    expect(linuxPathProblem('/home/u/link', { mounts: MOUNTS, real: () => '/proc/1' })).toBe('가상 파일 시스템(/proc)의 경로');
    expect(linuxPathProblem('/home/u/link', { mounts: MOUNTS, real: () => '/srv/nfs/x' })).toBe('네트워크 파일 시스템(nfs4, /srv/nfs)의 경로');
    expect(linuxPathProblem('/srv/nfs/x', { mounts: null, real: same })).toBeNull();
  });

  it('적힌 경로가 이미 걸리면 실제 경로를 풀지 않는다 — 멈춘 NFS의 realpath가 서버를 붙잡지 않게 (S10-13 SH-4)', () => {
    const touched: string[] = [];
    const real = (p: string): string => (touched.push(p), p);
    expect(linuxPathProblem('/srv/nfs/proj', { mounts: MOUNTS, real })).toBe('네트워크 파일 시스템(nfs4, /srv/nfs)의 경로');
    expect(linuxPathProblem('/proc/1/cwd', { mounts: MOUNTS, real })).toBe('가상 파일 시스템(/proc)의 경로');
    expect(touched).toEqual([]);
    // 적힌 경로가 괜찮을 때만 링크를 푼다
    expect(linuxPathProblem('/home/u/link', { mounts: MOUNTS, real })).toBeNull();
    expect(touched).toEqual(['/home/u/link']);
  });

  it('글: Windows는 예전 그대로(로컬 드라이브 폴더·C:\\work·D:\\wook-workspace), Linux는 Linux 예시', () => {
    expect(localFolderWords('win32')).toMatchObject({ folder: '이 PC의 로컬 드라이브 폴더', example: 'C:\\work', projectExample: 'C:\\work\\my-app' });
    expect(projectPathRefusal('X:', '네트워크 경로(\\\\h\\…)', 'win32')).toBe(
      '프로젝트 폴더는 이 PC의 로컬 드라이브 폴더(예: C:\\work\\my-app)만 등록할 수 있습니다. 네트워크 경로(\\\\h\\…)는 쓸 수 없습니다 — 네트워크 경로(\\\\서버\\공유)·장치 경로(\\\\?\\…)·이름이 점(.)이나 공백으로 끝나는 폴더는 등록하지 않습니다: X:',
    );
    expect(projectPathRefusal('/proc/1', '가상 파일 시스템(/proc)의 경로', 'linux')).toBe(
      '프로젝트 폴더는 이 PC의 로컬 폴더(예: /home/<사용자>/work/my-app)만 등록할 수 있습니다. 가상 파일 시스템(/proc)의 경로는 쓸 수 없습니다 — /proc·/sys·/dev와 그 안, 네트워크 파일 시스템(NFS·SMB/CIFS·SSHFS·Ceph·GlusterFS)의 폴더는 등록하지 않습니다: /proc/1',
    );
    expect([workspaceExample('win32'), workspaceExample('linux')]).toEqual(['D:\\wook-workspace', '/srv/wook-workspace']);
  });
});

describe.runIf(process.platform === 'linux')('Linux 경로 규칙 — 실제 경로 (Linux)', () => {
  it('실제 /proc·/sys·/dev는 막고, 임시 폴더는 받는다 — winPathProblem(부르는 쪽 하나)이 Linux 규칙을 쓴다', () => {
    expect(winPathProblem('/proc/self')).toBe('가상 파일 시스템(/proc)의 경로');
    expect(winPathProblem('/sys/kernel')).toBe('가상 파일 시스템(/sys)의 경로');
    expect(winPathProblem('/dev/shm')).toBe('가상 파일 시스템(/dev)의 경로');
    const d = mkdtempSync(join(tmpdir(), 'wook-test-linuxpath-'));
    dirs.push(d);
    expect(winPathProblem(d)).toBeNull();
    expect(winPathProblem(join(d, '아직 없는 폴더', 'x'))).toBeNull();
  });

  it('/proc을 가리키는 심볼릭 링크도, 그 아래 아직 없는 경로도 막는다', () => {
    const d = mkdtempSync(join(tmpdir(), 'wook-test-linuxpath-'));
    dirs.push(d);
    symlinkSync('/proc/self', join(d, 'p'));
    expect(winPathProblem(join(d, 'p'))).toBe('가상 파일 시스템(/proc)의 경로');
    expect(winPathProblem(join(d, 'p', 'none', 'deeper'))).toBe('가상 파일 시스템(/proc)의 경로');
  });

  it('이 PC의 실제 mountinfo: 9p 마운트(WSL의 /mnt/c)가 있으면 그 아래는 받는다 — 네트워크 마운트가 있으면 그 아래는 막는다 (읽기만)', () => {
    const mounts = readMounts();
    expect(mounts).not.toBeNull();
    const ninep = mounts!.find((m: MountEntry) => m.fsType === '9p' && m.mountPoint.startsWith('/mnt/'));
    if (ninep) expect(linuxPathProblem(`${ninep.mountPoint}/x`, { real: same })).toBeNull();
    const net = mounts!.find((m: MountEntry) => ['nfs', 'nfs4', 'cifs', 'smb3', 'fuse.sshfs'].includes(m.fsType));
    if (net) expect(linuxPathProblem(`${net.mountPoint}/x`, { real: same })).toMatch(/^네트워크 파일 시스템/);
    console.log(`[mountinfo] 9p: ${ninep?.mountPoint ?? '없음'}, 네트워크: ${net ? `${net.fsType} ${net.mountPoint}` : '없음'}`);
  });

  it('작업 폴더 위치의 글은 Linux 예시를 쓴다', () => {
    const data = mkdtempSync(join(tmpdir(), 'wook-test-linuxpath-data-'));
    dirs.push(data);
    expect(mainWorkDirProblem('/proc/1/main', data)).toBe('메인 에이전트 작업 폴더는 이 PC의 로컬 폴더여야 합니다 — 가상 파일 시스템(/proc)의 경로는 쓸 수 없습니다: /proc/1/main');
    expect(mainWorkDirProblem('rel', data)).toBe('메인 에이전트 작업 폴더가 절대 경로가 아닙니다: rel — 예: /srv/wook-workspace');
  });
});
