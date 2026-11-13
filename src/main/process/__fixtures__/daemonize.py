# Linux 시험 (리드 결정 S10-13, 리뷰 프로브 zz-s10-linux-process-sweep에서; S10-16 FPS-1, 프로브 zz-s102-fixes-process-shell-sweep에서):
# 실행의 후손이 데몬처럼 떠난다 — fork, setsid, 부모는 곧바로 끝난다.
# 사용: python3 -I daemonize.py <그만 파일> <모드> <표시를 적을 파일>
#   dump    : 보통 데몬 (환경에 실행 표시가 그대로 — /proc/<pid>/environ으로 읽힌다)
#   nodump  : prctl(PR_SET_DUMPABLE, 0) — ssh-agent처럼. 같은 사용자도 /proc/<pid>/environ을 읽지 못한다 (EACCES)
#   clobber : setproctitle처럼 원래 환경 자리(/proc/self/stat의 env_start..env_end)에 프로세스 제목을 덮어쓴다 (nginx·PostgreSQL·Redis)
#   wrap-scrub · wrap-clobber · wrap-nodump : 떠난 프로세스는 표시를 그대로 가진 감싸개(setsid한 셸처럼)이고, 자식 하나를 띄워 기다린다. 자식은 표시를
#     보이지 않는다 — scrub = 빈 환경으로 /bin/sh를 다시 실행(env -i), clobber·nodump = 위와 같다. 감싸개의 부모(이 스크립트)는 곧바로 끝난다 (고아)
# 찍는 줄: {"leaver": 떠난 프로세스, "child": 감싸개의 자식 (wrap 모드가 아니면 0)}
# 떠난 프로세스와 그 자식은 그만 파일이 생기면(또는 30초 뒤) 스스로 끝난다 — 시험은 기록한 PID로 죽이지 않는다
import ctypes
import os
import sys
import time

quit_file, mode, tag_file = sys.argv[1], sys.argv[2], sys.argv[3]
wrap = mode.startswith('wrap-')
inner = mode[5:] if wrap else mode


def hide(how):
    if how == 'nodump':
        ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE = 4
    if how == 'clobber':
        st = open('/proc/self/stat', 'rb').read()
        fields = st[st.rindex(b')') + 2:].split()
        env_start, env_end = int(fields[47]), int(fields[48])
        title = b'myserver: master process'
        ctypes.memset(env_start, 0, env_end - env_start)
        ctypes.memmove(env_start, title, min(len(title), env_end - env_start - 1))
    if how == 'scrub':
        loop = 't=0; while [ ! -e "$1" ] && [ $t -lt 300 ]; do /bin/sleep 0.1; t=$((t+1)); done'
        os.execve('/bin/sh', ['sh', '-c', loop, 'sh', quit_file], {})


def stay():
    t0 = time.time()
    while not os.path.exists(quit_file) and time.time() - t0 < 30:
        time.sleep(0.1)
    os._exit(0)


r, w = os.pipe()
pid = os.fork()
if pid == 0:
    os.close(r)
    os.setsid()
    fd = os.open('/dev/null', os.O_RDWR)
    for i in (0, 1, 2):
        os.dup2(fd, i)
    with open(tag_file, 'w') as f:
        f.write(os.environ.get('WOOK_RUN_TAG', ''))
    if not wrap:
        os.close(w)
        hide(inner)
        stay()
    child = os.fork()
    if child == 0:
        os.close(w)
        hide(inner)
        stay()
    os.write(w, str(child).encode())
    os.close(w)
    os.waitpid(child, 0)
    os._exit(0)
os.close(w)
child = int(os.read(r, 32) or b'0') if wrap else 0
print('{"leaver":%d,"child":%d}' % (pid, child), flush=True)
os._exit(0)
