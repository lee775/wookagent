# 욱채 X11 곁 도우미 (S10c, 리드 결정 S10-7.1·S10-7.4~7.6) — X11 화면 도우미(x11Helper.mjs)가 `python3 -I -B -s`로 띄운다.
# 셋을 맡는다: 멈춤 단축키(Ctrl+Alt+Shift+F12)를 루트 창에 잡기(python3-xlib), 실제 화면의 조작 중 표시(주황 테두리 창 — 캡처 동안 걷는다),
# 포커스가 암호 칸인지(AT-SPI, gi + Atspi — 세션 버스와 접근성 버스가 있을 때. 없으면 AT-SPI만 빼고 단축키·표시는 그대로 — S10c2 FSD-5).
# 표준 입력·출력은 JSON 한 줄씩이다. 첫 줄: {"ev":"hello","xlib":…,"xlibWhy":null|"import"|"connect","grab":…,"atspi":…}. 요청 {"id":n,"op":…} → 답 {"id":n,"ok":…}.
# 알림 {"ev":"hotkey","at":ms}. 표준 입력이 닫히면 잡은 키를 놓고 표시를 지우고 끝난다.
# 사람의 키 입력은 읽지 않는다: 잡은 것은 멈춤 단축키 하나뿐이고(그 키를 누를 때만 X 서버가 알린다), 다른 키 사건은 받지 않는다. 파일을 쓰지 않는다.
import json
import os
import socket
import struct
import sys


def identity(n):
    """화면의 주인 확인 (리드 결정 S10-13 SC-1) — `python3 -I -B -s x11Sidecar.py --identity <n>`. 추상 이름 @/tmp/.X11-unix/X<n>과 소켓 파일
    /tmp/.X11-unix/X<n>에 연결만 하고(아무것도 보내지 않는다 — 쿠키를 보내지 않는다) 듣는 쪽의 SO_PEERCRED(pid·uid)를 본다. 둘이 같은 프로세스이고 이 사용자의
    것이면 ok. libxcb(X 도구)는 추상 이름을 먼저 쓰므로 그 이름의 주인이 화면의 주인이다"""

    def peer(addr):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(2.0)
        try:
            s.connect(addr)
            pid, uid, _gid = struct.unpack("3i", s.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))
            return {"pid": pid, "uid": uid}
        except OSError:
            return None
        finally:
            s.close()

    path = "/tmp/.X11-unix/X%d" % n
    a = peer("\0" + path)
    p = peer(path)
    if p is None and a is None:
        return {"ok": False, "detail": "nodisplay"}
    if a is None:
        # -nolisten local로 띄운 X 서버 — 다른 프로세스가 그 이름을 가로챌 수 있다
        return {"ok": False, "detail": "noabstract"}
    if p is None or a["pid"] != p["pid"] or a["pid"] <= 0:
        return {"ok": False, "detail": "foreign"}
    if a["uid"] != os.getuid() or p["uid"] != os.getuid():
        return {"ok": False, "detail": "otheruser"}
    return {"ok": True, "pid": a["pid"]}


if len(sys.argv) == 2 and sys.argv[1] == "--atspi-probe":
    # AT-SPI를 이 프로세스에서 먼저 띄워 본다 (S10c2, 리드 결정 S10-17 FSD-5). 접근성 버스에 붙지 못하면 Atspi.init()은 C 수준에서 프로세스를 끝낸다(g_error →
    # SIGTRAP — try로 잡을 수 없다). 세션 버스가 없을 때도, 주소가 있지만 죽은 버스일 때도 그렇다 [Xvfb에서 본 것]. 그래서 곁 도우미 자신은 이 시험이 끝까지 간 뒤에만
    # AT-SPI를 띄운다 — 멈춤 단축키와 조작 중 표시가 함께 죽지 않게. 이 프로세스는 코어 덤프를 남기지 않는다 (WSL은 덤프를 Windows의 임시 폴더에 쓴다)
    try:
        import ctypes

        ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE, 0
    except Exception:
        pass
    try:
        import gi

        gi.require_version("Atspi", "2.0")
        from gi.repository import Atspi as _Probe

        sys.exit(0 if _Probe.init() in (0, 1) else 3)
    except Exception:
        sys.exit(3)

if len(sys.argv) == 3 and sys.argv[1] == "--identity":
    try:
        num = int(sys.argv[2])
        if num < 0 or num > 65535:
            raise ValueError
        res = identity(num)
    except Exception:
        res = {"ok": False, "detail": "unverified"}
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()
    sys.exit(0)

import queue  # noqa: E402
import select  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402

_out_lock = threading.Lock()


def out(obj):
    with _out_lock:
        try:
            sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
            sys.stdout.flush()
        except Exception:
            os._exit(0)


# python3-xlib가 없어 곁 도우미가 화면에 붙지 못한 까닭 — import(꾸러미 없음) · connect(화면에 붙지 못함). hello의 xlibWhy (FSD-5)
XLIB_WHY = None
try:
    from Xlib import X, XK, error as xerror
    from Xlib import display as xdisplay

    XLIB = True
except Exception:
    XLIB = False
    XLIB_WHY = "import"

ATSPI = False
Atspi = None
GLib = None
try:
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi as _Atspi, GLib as _GLib

    Atspi = _Atspi
    GLib = _GLib
    ATSPI = True
except Exception:
    ATSPI = False

ORANGE = 0xE65100
BORDER = 4


class XSide(threading.Thread):
    """X 연결 하나를 쥔 실 — 단축키 잡기·사건 읽기·표시 창. 다른 실의 일은 queue로 받아 이 실에서 한다(python-xlib은 연결 하나를 여러 실이 쓰지 못한다)"""

    def __init__(self):
        super().__init__(daemon=True)
        self.d = xdisplay.Display()
        self.root = self.d.screen().root
        self.jobs = queue.Queue()
        self.rfd, self.wfd = os.pipe()
        self.grabbed = False
        self.keycode = self.d.keysym_to_keycode(XK.string_to_keysym("F12"))
        self.windows = []
        self.shown = False
        self.alive = True

    # ── 단축키 ──
    def grab(self):
        if self.grabbed or not self.keycode:
            return self.grabbed
        base = X.ControlMask | X.Mod1Mask | X.ShiftMask
        ec = xerror.CatchError(xerror.BadAccess)
        # NumLock(Mod2)·CapsLock(Lock)이 켜져 있어도 잡히게 네 가지를 모두 잡는다
        for extra in (0, X.LockMask, X.Mod2Mask, X.LockMask | X.Mod2Mask):
            self.root.grab_key(self.keycode, base | extra, True, X.GrabModeAsync, X.GrabModeAsync, onerror=ec)
        self.d.sync()
        if ec.get_error():
            # 다른 프로그램이 같은 단축키를 쥐고 있다 — 잡은 것을 놓고 사실대로 말한다
            self.ungrab()
            self.grabbed = False
        else:
            self.grabbed = True
        return self.grabbed

    def ungrab(self):
        base = X.ControlMask | X.Mod1Mask | X.ShiftMask
        for extra in (0, X.LockMask, X.Mod2Mask, X.LockMask | X.Mod2Mask):
            try:
                self.root.ungrab_key(self.keycode, base | extra)
            except Exception:
                pass
        try:
            self.d.sync()
        except Exception:
            pass

    # ── 표시 ──
    def make_windows(self):
        if self.windows:
            return
        g = self.root.get_geometry()
        w, h = g.width, g.height
        cmap = self.d.screen().default_colormap
        pixel = cmap.alloc_color((ORANGE >> 16 & 0xFF) * 257, (ORANGE >> 8 & 0xFF) * 257, (ORANGE & 0xFF) * 257).pixel
        rects = [(0, 0, w, BORDER), (0, h - BORDER, w, BORDER), (0, 0, BORDER, h), (w - BORDER, 0, BORDER, h)]
        for (x, y, rw, rh) in rects:
            win = self.root.create_window(
                x, y, rw, rh, 0, self.d.screen().root_depth, X.InputOutput, X.CopyFromParent, background_pixel=pixel, override_redirect=True
            )
            win.set_wm_name("wook-indicator")
            try:
                win.change_property(self.d.intern_atom("_NET_WM_PID"), self.d.intern_atom("CARDINAL"), 32, [os.getpid()])
            except Exception:
                pass
            # 클릭이 표시를 지나 아래 창으로 가게 입력 모양을 비운다 (SHAPE 1.1 — 없으면 그대로)
            try:
                from Xlib.ext import shape

                win.shape_rectangles(shape.SO.Set, shape.SK.Input, X.Unsorted, 0, 0, [])
            except Exception:
                pass
            self.windows.append(win)

    def show(self):
        self.make_windows()
        for win in self.windows:
            win.map()
            win.raise_window()
        self.d.sync()
        self.shown = True

    def hide(self):
        for win in self.windows:
            win.unmap()
        self.d.sync()
        self.shown = False

    def destroy(self):
        for win in self.windows:
            try:
                win.destroy()
            except Exception:
                pass
        self.windows = []
        self.shown = False
        try:
            self.d.sync()
        except Exception:
            pass

    def screensaver_on(self):
        try:
            info = self.d.screensaver_query_info(self.root)
            return info.state == 1
        except Exception:
            return None

    # ── 다른 실의 일 ──
    def call(self, fn, timeout=1.5):
        box = {}
        done = threading.Event()

        def job():
            try:
                box["v"] = fn()
            except Exception as e:  # noqa: BLE001
                box["e"] = e
            done.set()

        self.jobs.put(job)
        os.write(self.wfd, b"x")
        if not done.wait(timeout):
            return None
        if "e" in box:
            return None
        return box.get("v")

    def run(self):
        fd = self.d.fileno()
        while self.alive:
            try:
                r, _, _ = select.select([fd, self.rfd], [], [], 0.5)
            except Exception:
                break
            if self.rfd in r:
                try:
                    os.read(self.rfd, 64)
                except Exception:
                    pass
            while True:
                try:
                    job = self.jobs.get_nowait()
                except queue.Empty:
                    break
                job()
            try:
                while self.d.pending_events():
                    e = self.d.next_event()
                    if e.type == X.KeyPress and e.detail == self.keycode and self.grabbed:
                        out({"ev": "hotkey", "at": int(time.time() * 1000)})
            except Exception:
                # X 연결이 끊겼다 — 끝난다 (도우미가 곁 도우미 없음으로 다룬다)
                os._exit(0)


# ───────── AT-SPI ─────────

_last_focused = {"acc": None}


def _on_focus(event):
    try:
        if event.detail1 == 1:
            _last_focused["acc"] = event.source
    except Exception:
        pass


def _gtk4(acc):
    try:
        app = acc.get_application()
        return (app.get_toolkit_name() or "").lower() == "gtk" and (app.get_toolkit_version() or "").startswith("4.")
    except Exception:
        return False


def _role_of(acc):
    """암호 칸이면 True, 아니면 False, 가를 수 없으면 None.
    GTK 4(4.14에서 본 것 — zenity --password)는 암호 칸을 'password text'가 아니라 보통 'text'로 내놓아 보통 한 줄 칸과 다르지 않다: GTK 4의 여러 줄이 아닌
    글 칸은 모른다(None)로 둔다 — 그런 칸에는 치지 않는다 (운영자 설정 typeWithoutA11y가 아니면)"""
    role = acc.get_role()
    name = acc.get_role_name()
    if role == Atspi.Role.PASSWORD_TEXT:
        return {"control": name, "password": True}
    if role in (Atspi.Role.TEXT, Atspi.Role.ENTRY) and _gtk4(acc):
        try:
            multi = acc.get_state_set().contains(Atspi.StateType.MULTI_LINE)
        except Exception:
            multi = False
        if not multi:
            return {"control": name, "password": None}
    return {"control": name, "password": False}


def _focused_in(acc):
    try:
        return acc.get_state_set().contains(Atspi.StateType.FOCUSED)
    except Exception:
        return False


def a11y_focus(pid, cap_ms):
    """그 PID의 앱에서 포커스가 든 요소의 역할. 모르면 password None"""
    deadline = time.monotonic() + max(0.05, cap_ms / 1000.0)
    acc = _last_focused["acc"]
    try:
        if acc is not None and acc.get_process_id() == pid and _focused_in(acc):
            return _role_of(acc)
    except Exception:
        pass
    try:
        desktop = Atspi.get_desktop(0)
        for i in range(desktop.get_child_count()):
            if time.monotonic() > deadline:
                return {"control": None, "password": None}
            app = desktop.get_child_at_index(i)
            if app is None:
                continue
            try:
                if app.get_process_id() != pid:
                    continue
            except Exception:
                continue
            todo = [app]
            seen = 0
            while todo and seen < 4000 and time.monotonic() < deadline:
                node = todo.pop(0)
                seen += 1
                if node is not app and _focused_in(node):
                    return _role_of(node)
                try:
                    n = node.get_child_count()
                except Exception:
                    n = 0
                for j in range(min(n, 500)):
                    try:
                        c = node.get_child_at_index(j)
                    except Exception:
                        c = None
                    if c is not None:
                        todo.append(c)
            return {"control": None, "password": None}
    except Exception:
        pass
    return {"control": None, "password": None}


# ───────── 요청 ─────────

xs = None


def handle(req):
    op = req.get("op")
    rid = req.get("id")
    if op == "arm":
        grab = xs.call(xs.grab) if xs else False
        indicator = False
        if req.get("indicator") and xs:
            indicator = xs.call(lambda: (xs.show(), True)[1]) is True
        out({"id": rid, "ok": True, "grab": bool(grab), "indicator": bool(indicator)})
    elif op == "disarm":
        if xs:
            xs.call(xs.destroy)
        out({"id": rid, "ok": True})
    elif op == "hide":
        if xs and xs.shown:
            xs.call(xs.hide)
            # 걷힌 자리를 아래 창이 다시 그릴 틈 (합성기가 없는 화면)
            time.sleep(0.08)
        out({"id": rid, "ok": True})
    elif op == "show":
        if xs and xs.windows:
            xs.call(xs.show)
        out({"id": rid, "ok": True})
    elif op == "lock":
        locked = xs.call(xs.screensaver_on) if xs else None
        out({"id": rid, "ok": True, "locked": locked})
    elif op == "focus":
        if not ATSPI:
            out({"id": rid, "ok": True, "control": None, "password": None})
            return
        pid = req.get("pid")
        cap = req.get("capMs", 1500)
        r = a11y_focus(pid, cap) if isinstance(pid, int) else {"control": None, "password": None}
        out({"id": rid, "ok": True, "control": r["control"], "password": r["password"]})
    else:
        out({"id": rid, "ok": False})


def finish():
    if xs:
        try:
            xs.call(lambda: (xs.ungrab(), xs.destroy()), timeout=1.0)
        except Exception:
            pass
    os._exit(0)


def _atspi_usable():
    """AT-SPI를 이 프로세스에서 띄워도 되는지 (FSD-5) — 세션 버스나 접근성 버스의 주소가 있고, 자식 프로세스에서 Atspi.init()이 끝까지 갔을 때만. 주소가 없으면
    자식도 띄우지 않는다(그때 Atspi.init()은 늘 프로세스를 끝낸다 [Xvfb])"""
    if not (os.environ.get("DBUS_SESSION_BUS_ADDRESS") or os.environ.get("AT_SPI_BUS_ADDRESS")):
        return False
    import subprocess

    try:
        r = subprocess.run(
            [sys.executable, "-I", "-B", "-s", os.path.abspath(__file__), "--atspi-probe"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=4,
        )
        return r.returncode == 0
    except Exception:
        return False


def main():
    global xs, ATSPI, XLIB_WHY
    grab = False
    if XLIB:
        try:
            xs = XSide()
            xs.start()
            grab = xs.call(xs.grab, timeout=2.0) is True
        except Exception:
            xs = None
            XLIB_WHY = "connect"
    # 단축키와 표시(Xlib)는 위에서 이미 쥐었다 — AT-SPI가 쓸 수 없어도 그 둘은 산다 (FSD-5)
    if ATSPI and not _atspi_usable():
        ATSPI = False
    if ATSPI:
        try:
            Atspi.init()
            Atspi.set_timeout(800, 15000)
            listener = Atspi.EventListener.new(_on_focus)
            listener.register("object:state-changed:focused")
            main.listener = listener
        except Exception:
            ATSPI = False
    out({"ev": "hello", "xlib": xs is not None, "xlibWhy": None if xs is not None else (XLIB_WHY or "connect"), "grab": grab, "atspi": ATSPI})
    buf = b""
    if ATSPI and GLib is not None:
        loop = GLib.MainLoop()

        def on_stdin(_fd, cond):
            nonlocal buf
            if cond & (GLib.IO_HUP | GLib.IO_ERR):
                data = b""
            else:
                try:
                    data = os.read(0, 65536)
                except Exception:
                    data = b""
            if not data:
                loop.quit()
                return False
            buf += data
            while b"\n" in buf:
                raw, buf = buf.split(b"\n", 1)
                try:
                    handle(json.loads(raw.decode("utf-8")))
                except Exception:
                    pass
            return True

        GLib.io_add_watch(0, GLib.IO_IN | GLib.IO_HUP | GLib.IO_ERR, on_stdin)
        loop.run()
        finish()
    while True:
        data = os.read(0, 65536)
        if not data:
            break
        buf += data
        while b"\n" in buf:
            raw, buf = buf.split(b"\n", 1)
            try:
                handle(json.loads(raw.decode("utf-8")))
            except Exception:
                pass
    finish()


if __name__ == "__main__":
    main()
