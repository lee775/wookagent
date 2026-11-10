// 욱채 화면 도우미 (WookDesktopHelper.exe) — SERVER_DESIGN 8.3.2, 리드 결정 S6-4·S6-5·S6-8·S6-9·S6-11.
//
// 서버(src/main/desktop/desktopHelper.ts)가 직접 띄우는 오래 떠 있는 프로세스. 표준 입력으로 ASCII 한 줄 명령을 받고 표준 출력으로 UTF-8 한 줄을
// 답한다. 프로토콜은 src/main/desktop/types.ts 머리말 (3판).
//
// - 컴파일: .NET Framework 4.x csc.exe (C# 5 — 문자열 보간·?.·nameof·식 본문 멤버·out var·튜플 없음). 참조: csc.rsp 기본(System.Drawing,
//   System.Windows.Forms) + WPF\UIAutomationClient.dll · UIAutomationTypes.dll (src/main/process/compiledTool.ts).
// - 스레드: 읽기(이 Main 스레드 — STOP·RELEASE를 도는 명령과 상관없이 바로 처리) · 실행(명령 하나씩) · 화면(STA — 조작 중 표시, 멈춤 단축키,
//   저수준 훅) · 쓰기(표준 출력 하나). 훅 콜백은 표준 출력에 쓰지 않는다(파이프가 막히면 입력이 멈추므로) — 시각만 적고, 쓰기 스레드가 250ms마다 알린다.
// - 쓰는 API: 캡처 CopyFromScreen(SourceCopy|CaptureBlt, 24bpp) + 바이큐빅 축소 + PNG · 입력 SendInput(가상 화면 절대 좌표, KEYEVENTF_UNICODE) ·
//   창 GetForegroundWindow / WindowFromPoint+GA_ROOT의 PID·클래스·제목·무결성, EnumWindows(가려진 창·자기 창 빼고) · 암호 칸 UIA IsPassword
//   (일꾼 스레드, 1.5초 상한, 모르면 막는 쪽) · GetAsyncKeyState · GetLastInputInfo · WTS · OpenInputDesktop · 모니터·DPI.
// - 쓰지 않는 것: 클립보드, SwitchDesktop, 자식 프로세스, 화면 폴더(WOOK_DESKTOP_SCREENS) 밖 쓰기.
// - 막는 창 (리드 결정 S6-8, S6-21 E3): 정책의 PID·제목(서버 자신, '욱채 서버 (pid N)', '욱채'로 시작하는 제목)과 도우미 자신에 더해, 서버의 조상 프로세스가 가진
//   모든 최상위 창. 서버를 띄운 창은 그 창을 연 셸(cmd·PowerShell)이나 터미널(Windows Terminal·mintty·VS Code·ConEmu …)의 것으로 보이므로 서버 PID만으로는
//   가려내지 못한다 — 시작할 때 Toolhelp로 이 도우미의 조상(서버 → 그 부모 → …)을 한 번 구해, 그 조상의 창이면 창 종류와 상관없이 막는다. Windows 셸
//   (explorer.exe — 바탕 화면·작업 표시줄·탐색기 창)은 조상이어도 막지 않는다. 조상을 구하지 못하면 콘솔 종류의 창(ConsoleWindowClass·PseudoConsoleWindow·
//   Windows Terminal)을 모두 막는다 (막는 쪽). 한계: 조상이 아닌 터미널이 붙은 창(기본 터미널 넘겨받기)·비활성 탭은 가려내지 못한다 (KNOWN_ISSUES).
// - 글자 입력 (리드 결정 S6-21 B1·B2, S6-23 K1·K2): TYPE의 글에 제어 문자(탭·줄바꿈 등)가 있으면 ERR BAD_TEXT — 탭·Enter는 포커스를 옮기므로 KEY로 따로
//   받는다. TYPE은 4자씩 보내고 둘째 묶음부터는 보내기 전에 포커스를 다시 읽는다 — 앱이 치는 중에 포커스를 암호 칸이나 모르는 곳으로 옮기면 멈춘다. 끝난 뒤의
//   포커스를 OK에 싣는다. KEY는 이동·기능 키(KeyMap.NonPrintable)가 아니고 메인이 수정 키를 쓰지 않았거나(Shift만은 글자) Win 없이 Ctrl+Alt를 함께 썼으면
//   (AltGr) 글자 키다 — 암호 칸·모르는 포커스에 보내지 않는다.
// - 무장·해제 (리드 결정 S6-21 F2): 무장(ARM)과 해제(RELEASE·STOP·멈춤 단축키)의 전환은 armLock 하나로 세운다. 무장은 화면 스레드가 훅을 건 같은 단계에서
//   정한다 — 그때 abortSeq가 ARM을 시작할 때와 다르면(그사이 해제가 지나갔다) 무장하지 않고 훅을 푼다. 늦게 도착한 해제는 그 뒤의 새 무장을 풀지 않는다.
// - 멈춤 단축키 (리드 결정 S6-21 D): 시작할 때와 ARM마다 등록해 본다. 등록하지 못한 동안에는 ARM이 hotkey=0으로 답하고 띠에 단축키 글을 쓰지 않는다.
// - DPI: SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)가 첫 호출이다. 좌표는 모두 실제 픽셀 (가상 화면 좌표, 음수 가능).
// - 사람 입력: 무장(ARM)부터 RELEASE·STOP까지만 저수준 훅을 건다. 콜백은 주입 표시(flags)와 시각만 읽는다(키 코드는 읽지 않는다).
//   자기 주입(LLMHF_INJECTED·LLKHF_INJECTED)은 뺀다. 사람 입력은 도는 TYPE·DRAG를 다음 단계에서 멈춘다.
// - 이 파일은 대표가 쓰는 개발 PC에서 실행하지 않는다 — 컴파일과 해시만 한다 (리드 결정 S6-15). 실제 동작은 9단계 실제 화면 시험이 본다.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace Wook.DesktopHelper
{
    internal static class Program
    {
        /// <summary>앱(src/main/desktop/desktopHelper.ts DESKTOP_PROTOCOL_VERSION)과 같아야 한다</summary>
        internal const int ProtocolVersion = 3;

        [MTAThread]
        private static int Main(string[] args)
        {
            // 첫 호출: 실제 픽셀 좌표 (이 뒤의 모든 창·모니터·캡처 좌표가 물리 픽셀)
            Native.InitDpi();
            if (args.Length == 1 && args[0] == "--probe") return Helper.Probe();
            if (args.Length != 0)
            {
                Console.Error.WriteLine("usage: WookDesktopHelper.exe [--probe]");
                return 2;
            }
            return Helper.Run();
        }
    }

    /// <summary>막는 대상 (ARM과 WOOK_DESKTOP_POLICY). 도우미 자신의 PID는 늘 막는다</summary>
    internal sealed class Policy
    {
        public readonly HashSet<uint> Pids = new HashSet<uint>();
        public readonly List<string> Titles = new List<string>();
        public readonly List<string> Prefixes = new List<string>();

        /// <summary>base64(UTF-8 줄: v1 · pid n · title t · prefix p). 깨졌으면 null</summary>
        public static Policy Parse(string b64)
        {
            Policy p = new Policy();
            if (string.IsNullOrEmpty(b64)) return p;
            string text;
            try { text = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(b64)); }
            catch (FormatException) { return null; }
            catch (ArgumentException) { return null; }
            foreach (string raw in text.Split('\n'))
            {
                string line = raw.TrimEnd('\r');
                int sp = line.IndexOf(' ');
                if (sp <= 0) continue;
                string k = line.Substring(0, sp);
                string v = line.Substring(sp + 1);
                if (k == "pid")
                {
                    uint pid;
                    if (uint.TryParse(v, NumberStyles.None, CultureInfo.InvariantCulture, out pid) && pid > 0) p.Pids.Add(pid);
                }
                else if (k == "title" && v.Length > 0) p.Titles.Add(v);
                else if (k == "prefix" && v.Length > 0) p.Prefixes.Add(v);
            }
            return p;
        }

        public bool Blocks(uint pid, string title)
        {
            if (pid == Helper.OwnPid || Pids.Contains(pid)) return true;
            if (title == null) return false;
            foreach (string t in Titles) if (string.Equals(t, title, StringComparison.Ordinal)) return true;
            foreach (string p in Prefixes) if (title.StartsWith(p, StringComparison.Ordinal)) return true;
            return false;
        }
    }

    internal sealed class Mon
    {
        public int X, Y, W, H, Dpi;
        public bool Primary;
    }

    internal sealed class WinFacts
    {
        public IntPtr Root;
        public uint Pid;
        public string Title = "";
        public string Class = "";
        public string App = "";
        public bool Blocked;
        public bool Elevated;
        public bool Minimized;
        public Native.RECT Rect;
    }

    internal sealed class UiaFocus
    {
        public string Control;
        public bool Password;
        public bool Done;
        public bool Abandoned;
    }

    internal static class Helper
    {
        internal static uint OwnPid;
        private static int ownIntegrity = -1;
        /// <summary>이 도우미의 조상 프로세스 PID (서버와 그 위 — Windows 셸 explorer.exe는 뺀다). 구하지 못했으면 null — 콘솔 종류의 창을 모두 막는다</summary>
        private static HashSet<uint> ancestorPids;
        private static string screensDir;
        private static Policy policy = new Policy();
        private static readonly object stateLock = new object();
        /// <summary>SendInput과 놓기를 한 줄로 세운다 — 놓은 뒤에는 옛 명령이 아무것도 보내지 못한다</summary>
        private static readonly object sendLock = new object();

        /// <summary>
        /// 무장·해제의 전환을 한 줄로 세운다 (리드 결정 S6-21 F2): TryArm(화면 스레드) · BeginDisarm(읽기 스레드의 RELEASE·STOP, 화면 스레드의 멈춤 단축키) ·
        /// ConfirmDisarm(화면 스레드). 이 잠금을 쥔 채 다른 스레드를 기다리지 않는다. 잠금 순서는 armLock → sendLock
        /// </summary>
        private static readonly object armLock = new object();
        /// <summary>무장할 때 쥔 abortSeq — 그보다 앞서 낸 해제가 화면 스레드에 늦게 도착해도 이 무장의 훅·표시를 풀지 않는다</summary>
        private static long armedSeq = -1;

        private static volatile bool stopped;
        private static volatile bool armed;
        private static long armSeed = -1;
        /// <summary>RELEASE·STOP·HOTKEY마다 1 늘어난다 — 명령은 시작할 때의 값을 쥐고, 다르면 멈춘다</summary>
        private static long abortSeq;
        private static string abortReason = "RELEASED";
        private static long humanSeq;
        private static long lastHumanMs;
        private static long lastEmittedHumanMs;
        private static int hungUia;
        private static int build;

        private static readonly HashSet<ushort> pressedKeys = new HashSet<ushort>();
        private static readonly HashSet<int> pressedButtons = new HashSet<int>();

        private static readonly BlockingCollection<string> commands = new BlockingCollection<string>();
        private static readonly BlockingCollection<string> output = new BlockingCollection<string>();
        private static StreamWriter stdout;
        private static System.Threading.Timer humanTimer;

        private static readonly Regex IdRe = new Regex("^[0-9]{1,9}$", RegexOptions.CultureInvariant);
        private static readonly Regex CaptureIdRe = new Regex("^SC-[0-9]{6,12}$", RegexOptions.CultureInvariant);
        private static readonly Regex LayoutRe = new Regex("^[0-9a-f]{8,64}$", RegexOptions.CultureInvariant);
        private static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
        /// <summary>자기 주입에 붙이는 표시 (dwExtraInfo) — 'WOOK'</summary>
        internal static readonly IntPtr InjectTag = new IntPtr(0x574F4F4B);

        // ───── 확인 (--probe): 창·훅·캡처 없이 읽기만 ─────

        internal static int Probe()
        {
            int session = Process.GetCurrentProcess().SessionId;
            bool interactive = Environment.UserInteractive;
            string lk = session == 0 || !interactive ? "no_desktop" : LockState();
            int b = Native.BuildNumber();
            bool admin = false;
            try { admin = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator); }
            catch (Exception) { admin = false; }
            int monitors = session == 0 || !interactive ? 0 : Monitors().Count;
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"__wookDesktop\":\"probe\",\"ok\":true,\"version\":").Append(Program.ProtocolVersion);
            sb.Append(",\"bits\":").Append(IntPtr.Size * 8);
            sb.Append(",\"session\":").Append(session);
            sb.Append(",\"interactive\":").Append(interactive ? "true" : "false");
            sb.Append(",\"lock\":").Append(lk == null ? "null" : Json.S(lk));
            sb.Append(",\"monitors\":").Append(monitors);
            sb.Append(",\"build\":").Append(b);
            sb.Append(",\"wda\":").Append(b >= 19041 ? "true" : "false");
            sb.Append(",\"elevated\":").Append(admin ? "true" : "false");
            sb.Append("}");
            Console.Out.WriteLine(sb.ToString());
            Console.Out.Flush();
            return 0;
        }

        // ───── 시작 ─────

        internal static int Run()
        {
            stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            stdout.NewLine = "\n";
            stdout.AutoFlush = false;
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
            {
                try { ReleaseAll(); } catch (Exception) { }
                try { Console.Error.WriteLine("화면 도우미 내부 오류: " + (e.ExceptionObject == null ? "?" : e.ExceptionObject.GetType().Name)); } catch (Exception) { }
                Environment.Exit(70);
            };

            OwnPid = (uint)Process.GetCurrentProcess().Id;
            int session = Process.GetCurrentProcess().SessionId;
            if (session == 0 || !Environment.UserInteractive)
            {
                RawLine("FAIL NO_DESKTOP " + (session == 0 ? "session0" : "noninteractive"));
                return 3;
            }
            screensDir = Environment.GetEnvironmentVariable("WOOK_DESKTOP_SCREENS");
            if (string.IsNullOrEmpty(screensDir) || !Directory.Exists(screensDir))
            {
                RawLine("FAIL INIT screens_dir");
                return 3;
            }
            Policy p = Policy.Parse(Environment.GetEnvironmentVariable("WOOK_DESKTOP_POLICY"));
            if (p == null)
            {
                RawLine("FAIL INIT policy");
                return 3;
            }
            policy = p;
            ancestorPids = AncestorPids();
            ownIntegrity = IntegrityRid(OwnPid);
            build = Native.BuildNumber();
            try { Native.DisableProcessWindowsGhosting(); } catch (EntryPointNotFoundException) { }

            if (!Ui.Start())
            {
                RawLine("FAIL INIT ui");
                return 3;
            }
            Thread writer = new Thread(WriterLoop);
            writer.IsBackground = true;
            writer.Name = "writer";
            writer.Start();
            Thread executor = new Thread(ExecutorLoop);
            executor.IsBackground = true;
            executor.Name = "executor";
            executor.Start();
            humanTimer = new System.Threading.Timer(EmitHuman, null, 250, 250);

            string lk = LockState();
            Line("READY " + Program.ProtocolVersion + " " + Monitors().Count + " locked=" + (lk != null ? "1" : "0") +
                 " wda=" + (build >= 19041 ? "1" : "0") + " build=" + build);

            StreamReader stdin = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line.Length == 0 || line.Length > 65536) continue;
                if (line == "STOP")
                {
                    DoStop();
                    continue;
                }
                int sp = line.IndexOf(' ');
                if (sp <= 0) continue;
                string id = line.Substring(0, sp);
                if (!IdRe.IsMatch(id)) continue;
                string rest = line.Substring(sp + 1);
                if (rest == "RELEASE")
                {
                    DoRelease(id);
                    continue;
                }
                if (stopped)
                {
                    Line(id + " ERR STOPPED");
                    continue;
                }
                commands.Add(line);
            }
            // 표준 입력이 닫혔다 (서버가 끝냄) — 키를 떼고 표시·훅을 끄고 끝난다
            Shutdown();
            return 0;
        }

        private static void Shutdown()
        {
            stopped = true;
            long seq = BeginDisarm("STOPPED");
            ReleaseAll();
            Ui.Disarm(500, seq);
            output.CompleteAdding();
            Thread.Sleep(50);
            try { stdout.Flush(); } catch (Exception) { }
            Environment.Exit(0);
        }

        // ───── 쓰기 ─────

        private static void RawLine(string text)
        {
            try
            {
                stdout.WriteLine(text);
                stdout.Flush();
            }
            catch (IOException) { }
        }

        internal static void Line(string text)
        {
            try { output.Add(text); }
            catch (InvalidOperationException) { }
        }

        private static void WriterLoop()
        {
            try
            {
                foreach (string text in output.GetConsumingEnumerable())
                {
                    stdout.WriteLine(text);
                    if (output.Count == 0) stdout.Flush();
                }
                stdout.Flush();
            }
            catch (IOException)
            {
                // 서버가 사라졌다 — 키를 떼고 끝난다
                try { ReleaseAll(); } catch (Exception) { }
                Environment.Exit(0);
            }
        }

        private static void EmitHuman(object state)
        {
            long at = Interlocked.Read(ref lastHumanMs);
            if (at > Interlocked.Read(ref lastEmittedHumanMs))
            {
                Interlocked.Exchange(ref lastEmittedHumanMs, at);
                Line("HUMAN " + at.ToString(CultureInfo.InvariantCulture));
            }
        }

        /// <summary>훅 콜백(화면 스레드)에서: 시각만 적는다</summary>
        internal static void NoteHuman()
        {
            Interlocked.Exchange(ref lastHumanMs, NowMs());
            Interlocked.Increment(ref humanSeq);
        }

        internal static long NowMs()
        {
            return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds;
        }

        // ───── 실행 ─────

        private static void ExecutorLoop()
        {
            foreach (string line in commands.GetConsumingEnumerable())
            {
                int sp = line.IndexOf(' ');
                string id = line.Substring(0, sp);
                string rest = line.Substring(sp + 1);
                string verb = rest;
                string args = "";
                int sp2 = rest.IndexOf(' ');
                if (sp2 > 0)
                {
                    verb = rest.Substring(0, sp2);
                    args = rest.Substring(sp2 + 1);
                }
                string reply;
                try
                {
                    if (stopped) reply = "ERR STOPPED";
                    else reply = Dispatch(verb, args);
                }
                catch (Exception e)
                {
                    // 사유에는 예외 종류만 (인자·글자를 되풀이하지 않는다)
                    reply = "ERR INTERNAL " + e.GetType().Name;
                }
                Line(id + " " + reply);
            }
        }

        private static string Dispatch(string verb, string args)
        {
            switch (verb)
            {
                case "SCREENS": return DoScreens();
                case "WINDOWS": return DoWindows();
                case "FOCUS": return DoFocus();
                case "ARM": return DoArm(args);
                case "CAPTURE": return DoCapture(args);
                case "MOVE": return DoMove(args);
                case "CLICK": return DoClick(args);
                case "DRAG": return DoDrag(args);
                case "SCROLL": return DoScroll(args);
                case "KEY": return DoKey(args);
                case "TYPE": return DoType(args);
                default: return "ERR BAD_ARGS verb";
            }
        }

        // ───── 정지 · 놓기 ─────

        /// <summary>도는 명령을 멈춘다: 쥔 값이 달라져 다음 단계·다음 SendInput을 보내지 못한다</summary>
        private static void Abort(string reason)
        {
            lock (sendLock)
            {
                abortReason = reason;
                Interlocked.Increment(ref abortSeq);
            }
        }

        /// <summary>
        /// 해제의 시작 (RELEASE·STOP·멈춤 단축키): 무장을 풀고 도는 명령을 멈춘다 — 한 잠금 안에서. 돌려주는 값은 이 해제의 abortSeq로, 화면 스레드의 훅·표시
        /// 끄기(Ui.Disarm·DisarmHere)에 넘긴다 — 그 뒤에 새로 무장한 것은 풀지 않게 (리드 결정 S6-21 F2)
        /// </summary>
        private static long BeginDisarm(string reason)
        {
            lock (armLock)
            {
                armed = false;
                Interlocked.Exchange(ref armSeed, -1);
                Abort(reason);
                return Interlocked.Read(ref abortSeq);
            }
        }

        /// <summary>
        /// 무장 (화면 스레드 — 훅을 건 바로 뒤, 같은 단계에서): ARM을 시작할 때 쥔 abortSeq가 그대로일 때만 무장한다. 그사이 RELEASE·STOP·멈춤 단축키가 지나갔으면
        /// false — 부르는 쪽이 훅을 풀고 ARM은 오류로 답한다 (훅 없이 무장한 채 남지 않는다)
        /// </summary>
        internal static bool TryArm(long before, long seed)
        {
            lock (armLock)
            {
                if (stopped || Interlocked.Read(ref abortSeq) != before) return false;
                Interlocked.Exchange(ref armSeed, seed);
                armedSeq = before;
                armed = true;
                return true;
            }
        }

        /// <summary>
        /// 훅·표시를 끄기 전에 (화면 스레드): 그 해제(seq)보다 뒤에 새로 무장했으면 false — 끄지 않는다. 아니면 무장을 풀고 true
        /// </summary>
        internal static bool ConfirmDisarm(long seq)
        {
            lock (armLock)
            {
                if (armed && armedSeq >= seq) return false;
                armed = false;
                return true;
            }
        }

        /// <summary>무장하지 못한 ARM의 뒷정리: 늦게 도는 무장 단계가 무장하지 못하게 쥔 값을 바꾼다. 돌려주는 값으로 훅·표시를 끈다</summary>
        private static long CancelArm()
        {
            lock (armLock)
            {
                armed = false;
                Interlocked.Exchange(ref armSeed, -1);
                return Interlocked.Increment(ref abortSeq);
            }
        }

        /// <summary>STOP: 놓기 + 대기 명령 버림(이 뒤로는 STOPPED) + 표시·훅 끄기. 되돌릴 수 없다</summary>
        private static void DoStop()
        {
            stopped = true;
            long seq = BeginDisarm("STOPPED");
            int n = ReleaseAll();
            Ui.Disarm(300, seq);
            Line("STOP OK " + n);
        }

        /// <summary>RELEASE: 도는 입력을 멈추고 키·버튼을 떼고 표시·훅을 끈다. 다시 ARM할 때까지 입력은 RELEASED</summary>
        private static void DoRelease(string id)
        {
            long seq = BeginDisarm("RELEASED");
            int n = ReleaseAll();
            Ui.Disarm(300, seq);
            Line(id + " OK " + n);
        }

        /// <summary>멈춤 단축키 (화면 스레드): 도는 입력을 멈추고 떼고 끈다. 무장하지 않았어도 알린다 (사람이 눌렀다)</summary>
        internal static void OnHotkey()
        {
            long at = NowMs();
            long seq = BeginDisarm("HUMAN_ACTIVE hotkey");
            ReleaseAll();
            Ui.DisarmHere(seq);
            Line("HOTKEY " + at.ToString(CultureInfo.InvariantCulture));
        }

        /// <summary>
        /// 이 도우미가 누른 키·버튼과, GetAsyncKeyState가 눌렸다고 하는 수정 키·마우스 버튼을 모두 뗀다 (한 번의 SendInput). 뗀 수
        /// </summary>
        internal static int ReleaseAll()
        {
            lock (sendLock)
            {
                List<Native.INPUT> ups = new List<Native.INPUT>();
                HashSet<ushort> keys = new HashSet<ushort>(pressedKeys);
                foreach (ushort vk in KeyMap.Modifiers)
                {
                    if ((Native.GetAsyncKeyState(vk) & 0x8000) != 0) keys.Add(vk);
                }
                foreach (ushort vk in keys) ups.Add(KeyMap.KeyInput(vk, true));
                HashSet<int> buttons = new HashSet<int>(pressedButtons);
                if ((Native.GetAsyncKeyState(0x01) & 0x8000) != 0) buttons.Add(0);
                if ((Native.GetAsyncKeyState(0x02) & 0x8000) != 0) buttons.Add(1);
                if ((Native.GetAsyncKeyState(0x04) & 0x8000) != 0) buttons.Add(2);
                foreach (int b in buttons) ups.Add(Mouse.Button(b, false));
                if (ups.Count > 0) Native.Send(ups.ToArray());
                pressedKeys.Clear();
                pressedButtons.Clear();
                return ups.Count;
            }
        }

        /// <summary>쥔 값이 그대로일 때만 보낸다 (놓기·정지 뒤에는 보내지 않는다). 보냈으면 true</summary>
        private static bool Inject(Native.INPUT[] inputs, long token)
        {
            lock (sendLock)
            {
                if (stopped || token != Interlocked.Read(ref abortSeq)) return false;
                if (Native.Send(inputs) != inputs.Length) throw new Win32Exception(Marshal.GetLastWin32Error());
                return true;
            }
        }

        /// <summary>떼기만 하는 것은 멈춘 뒤에도 보낸다 (DRAG는 늘 버튼을 떼고 끝난다)</summary>
        private static void InjectUp(Native.INPUT[] inputs)
        {
            lock (sendLock) { Native.Send(inputs); }
        }

        /// <summary>멈췄으면 그 까닭(ERR …)을, 아니면 null</summary>
        private static string Aborted(long token, long human)
        {
            if (stopped) return "ERR STOPPED";
            if (token != Interlocked.Read(ref abortSeq))
            {
                lock (sendLock) { return "ERR " + abortReason; }
            }
            if (human != Interlocked.Read(ref humanSeq)) return "ERR HUMAN_ACTIVE";
            return null;
        }

        // ───── 화면 · 창 · 포커스 ─────

        private static string DoScreens()
        {
            List<Mon> mons = Monitors();
            StringBuilder sb = new StringBuilder();
            sb.Append("OK {\"layout\":").Append(Json.S(LayoutHash(mons))).Append(",\"screens\":[");
            for (int i = 0; i < mons.Count; i++)
            {
                Mon m = mons[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"index\":").Append(i + 1).Append(",\"primary\":").Append(m.Primary ? "true" : "false")
                  .Append(",\"x\":").Append(m.X).Append(",\"y\":").Append(m.Y).Append(",\"width\":").Append(m.W)
                  .Append(",\"height\":").Append(m.H).Append(",\"dpi\":").Append(m.Dpi).Append('}');
            }
            sb.Append("]}");
            return sb.ToString();
        }

        private static string DoWindows()
        {
            string lk = LockState();
            if (lk != null) return "ERR LOCKED " + lk;
            List<IntPtr> handles = new List<IntPtr>();
            Native.EnumWindowsProc cb = delegate(IntPtr h, IntPtr l)
            {
                handles.Add(h);
                return true;
            };
            Native.EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            Policy pol;
            lock (stateLock) { pol = policy; }
            StringBuilder sb = new StringBuilder();
            sb.Append("OK {\"windows\":[");
            int shown = 0;
            int total = 0;
            foreach (IntPtr h in handles)
            {
                if (!Native.IsWindowVisible(h) || Native.IsCloaked(h)) continue;
                WinFacts f = Facts(h, pol);
                if (f == null || f.Pid == OwnPid || f.Title.Length == 0) continue;
                total++;
                if (shown >= 200) continue;
                if (shown > 0) sb.Append(',');
                shown++;
                sb.Append("{\"title\":").Append(Json.S(f.Title)).Append(",\"app\":").Append(Json.S(f.App))
                  .Append(",\"pid\":").Append(f.Pid).Append(",\"x\":").Append(f.Rect.Left).Append(",\"y\":").Append(f.Rect.Top)
                  .Append(",\"width\":").Append(f.Rect.Right - f.Rect.Left).Append(",\"height\":").Append(f.Rect.Bottom - f.Rect.Top)
                  .Append(",\"minimized\":").Append(f.Minimized ? "true" : "false")
                  .Append(",\"blocked\":").Append(f.Blocked ? "true" : "false")
                  .Append(",\"elevated\":").Append(f.Elevated ? "true" : "false").Append('}');
            }
            sb.Append("],\"total\":").Append(total).Append('}');
            return sb.ToString();
        }

        private static string DoFocus()
        {
            string lk = LockState();
            if (lk != null) return "ERR LOCKED " + lk;
            WinFacts f = ForegroundFacts();
            if (f == null) return "OK null";
            UiaFocus u = QueryFocus(1500);
            return "OK " + FocusJson(f, u);
        }

        private static string FocusJson(WinFacts f, UiaFocus u)
        {
            if (f == null) return "null";
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"app\":").Append(Json.S(f.App)).Append(",\"title\":").Append(Json.S(f.Title)).Append(",\"pid\":").Append(f.Pid);
            sb.Append(",\"control\":").Append(u != null && u.Done && u.Control != null ? Json.S(u.Control) : "null");
            sb.Append(",\"password\":").Append(u != null && u.Done ? (u.Password ? "true" : "false") : "null");
            sb.Append(",\"blocked\":").Append(f.Blocked ? "true" : "false").Append(",\"elevated\":").Append(f.Elevated ? "true" : "false").Append('}');
            return sb.ToString();
        }

        private static WinFacts ForegroundFacts()
        {
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero) return null;
            Policy pol;
            lock (stateLock) { pol = policy; }
            return Facts(Native.GetAncestor(fg, 2), pol);
        }

        /// <summary>그 점의 최상위 창. 조작 중 표시(도우미 자신의 창)가 잡히면 그 아래에서 점을 품은 첫 창</summary>
        private static WinFacts PointFacts(int x, int y)
        {
            Policy pol;
            lock (stateLock) { pol = policy; }
            Native.POINT pt;
            pt.X = x;
            pt.Y = y;
            IntPtr h = Native.WindowFromPoint(pt);
            if (h != IntPtr.Zero)
            {
                WinFacts f = Facts(Native.GetAncestor(h, 2), pol);
                if (f != null && f.Pid != OwnPid) return f;
            }
            IntPtr found = IntPtr.Zero;
            Native.EnumWindowsProc cb = delegate(IntPtr w, IntPtr l)
            {
                if (!Native.IsWindowVisible(w) || Native.IsCloaked(w)) return true;
                uint pid;
                Native.GetWindowThreadProcessId(w, out pid);
                if (pid == OwnPid) return true;
                Native.RECT r;
                if (!Native.GetWindowRect(w, out r)) return true;
                if (x >= r.Left && x < r.Right && y >= r.Top && y < r.Bottom)
                {
                    found = w;
                    return false;
                }
                return true;
            };
            Native.EnumWindows(cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            return found == IntPtr.Zero ? null : Facts(found, pol);
        }

        private static WinFacts Facts(IntPtr root, Policy pol)
        {
            if (root == IntPtr.Zero) return null;
            WinFacts f = new WinFacts();
            f.Root = root;
            Native.GetWindowThreadProcessId(root, out f.Pid);
            f.Title = Native.WindowText(root);
            f.Class = Native.ClassName(root);
            f.App = AppName(f.Pid);
            f.Minimized = Native.IsIconic(root);
            if (!Native.FrameBounds(root, out f.Rect)) Native.GetWindowRect(root, out f.Rect);
            f.Blocked = pol.Blocks(f.Pid, f.Title) || IsAncestorWindow(f);
            int rid = IntegrityRid(f.Pid);
            // 열지 못하면(보호된·높은 권한 프로세스) 높은 권한으로 본다 — 막는 쪽
            f.Elevated = rid < 0 || (ownIntegrity >= 0 && rid > ownIntegrity);
            return f;
        }

        /// <summary>
        /// 서버를 띄운 쪽의 창인지 (리드 결정 S6-8, S6-21 E3): 그 창의 프로세스가 이 도우미의 조상(서버 → 그 부모 → …, Windows 셸은 빼고)이면 창 종류와
        /// 상관없이 막는다 — 서버를 띄운 터미널(cmd·PowerShell·Windows Terminal·mintty·VS Code·ConEmu …)에 Ctrl+C를 보내거나 그 창을 닫으면 서버가 끝난다.
        /// 조상을 구하지 못했으면 콘솔 종류의 창은 모두 막는다 (막는 쪽)
        /// </summary>
        private static bool IsAncestorWindow(WinFacts f)
        {
            HashSet<uint> chain = ancestorPids;
            if (chain == null) return f.Class == "ConsoleWindowClass" || f.Class == "PseudoConsoleWindow" || f.Class == "CASCADIA_HOSTING_WINDOW_CLASS";
            return chain.Contains(f.Pid);
        }

        /// <summary>
        /// 이 도우미의 조상 프로세스 PID — 부모(서버)부터 위로 12단계까지. 부모가 자식보다 늦게 시작했으면 그 PID는 다시 쓰인 것이라 거기서 멈춘다.
        /// Windows 셸(explorer.exe)은 넣지 않는다 — 탐색기에서 서버를 띄웠다고 바탕 화면·작업 표시줄·탐색기 창을 모두 막지 않는다. 프로세스를 띄우지 않고
        /// Toolhelp 목록만 읽는다. 구하지 못하면 null
        /// </summary>
        private static HashSet<uint> AncestorPids()
        {
            try
            {
                Dictionary<uint, uint> parentOf = new Dictionary<uint, uint>();
                Dictionary<uint, string> exeOf = new Dictionary<uint, string>();
                IntPtr snap = Native.CreateToolhelp32Snapshot(0x00000002, 0);
                if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return null;
                try
                {
                    Native.PROCESSENTRY32W e = new Native.PROCESSENTRY32W();
                    e.dwSize = (uint)Marshal.SizeOf(typeof(Native.PROCESSENTRY32W));
                    if (!Native.Process32FirstW(snap, ref e)) return null;
                    do
                    {
                        parentOf[e.th32ProcessID] = e.th32ParentProcessID;
                        exeOf[e.th32ProcessID] = e.szExeFile ?? "";
                    }
                    while (Native.Process32NextW(snap, ref e));
                }
                finally { Native.CloseHandle(snap); }
                HashSet<uint> chain = new HashSet<uint>();
                HashSet<uint> walked = new HashSet<uint>();
                bool foundParent = false;
                uint cur = OwnPid;
                long curStart = ProcessStartTime(cur);
                for (int depth = 0; depth < 12; depth++)
                {
                    uint parent;
                    if (!parentOf.TryGetValue(cur, out parent) || parent == 0 || parent == cur || walked.Contains(parent)) break;
                    long parentStart = ProcessStartTime(parent);
                    if (parentStart > 0 && curStart > 0 && parentStart > curStart) break;
                    walked.Add(parent);
                    foundParent = true;
                    string exe;
                    bool shell = exeOf.TryGetValue(parent, out exe) && string.Equals(exe, "explorer.exe", StringComparison.OrdinalIgnoreCase);
                    if (!shell) chain.Add(parent);
                    cur = parent;
                    curStart = parentStart;
                }
                // 부모(서버)조차 찾지 못했으면 구하지 못한 것이다
                return foundParent ? chain : null;
            }
            catch (Exception) { return null; }
        }

        /// <summary>프로세스가 시작한 때 (FILETIME). 모르면 0</summary>
        private static long ProcessStartTime(uint pid)
        {
            IntPtr hp = Native.OpenProcess(0x1000, false, pid);
            if (hp == IntPtr.Zero) return 0;
            try
            {
                long created, exited, kernel, user;
                return Native.GetProcessTimes(hp, out created, out exited, out kernel, out user) ? created : 0;
            }
            finally { Native.CloseHandle(hp); }
        }

        private static string AppName(uint pid)
        {
            IntPtr hp = Native.OpenProcess(0x1000, false, pid);
            if (hp == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(1024);
                int size = sb.Capacity;
                if (!Native.QueryFullProcessImageNameW(hp, 0, sb, ref size)) return "";
                return Path.GetFileNameWithoutExtension(sb.ToString(0, size));
            }
            finally { Native.CloseHandle(hp); }
        }

        /// <summary>프로세스 무결성 수준 RID (중간 0x2000, 높음 0x3000). 모르면 -1</summary>
        private static int IntegrityRid(uint pid)
        {
            IntPtr hp = Native.OpenProcess(0x1000, false, pid);
            if (hp == IntPtr.Zero) return -1;
            try
            {
                IntPtr tok;
                if (!Native.OpenProcessToken(hp, 0x0008, out tok)) return -1;
                try
                {
                    int len;
                    Native.GetTokenInformation(tok, 25, IntPtr.Zero, 0, out len);
                    if (len <= 0) return -1;
                    IntPtr buf = Marshal.AllocHGlobal(len);
                    try
                    {
                        if (!Native.GetTokenInformation(tok, 25, buf, len, out len)) return -1;
                        IntPtr sid = Marshal.ReadIntPtr(buf);
                        int count = Marshal.ReadByte(Native.GetSidSubAuthorityCount(sid));
                        if (count <= 0) return -1;
                        return Marshal.ReadInt32(Native.GetSidSubAuthority(sid, (uint)(count - 1)));
                    }
                    finally { Marshal.FreeHGlobal(buf); }
                }
                finally { Native.CloseHandle(tok); }
            }
            finally { Native.CloseHandle(hp); }
        }

        /// <summary>
        /// 포커스된 요소의 컨트롤 종류와 IsPassword (UI Automation). 대상 앱이 멈춰 있으면 오래 걸릴 수 있어 일꾼 스레드에서 capMs까지만 기다린다.
        /// 넘거나 오류면 null (모름 — 글자 입력은 막는다). 멈춘 일꾼이 3개 넘게 쌓이면 바로 모름
        /// </summary>
        private static UiaFocus QueryFocus(int capMs)
        {
            if (Interlocked.CompareExchange(ref hungUia, 0, 0) >= 3) return null;
            UiaFocus res = new UiaFocus();
            object gate = new object();
            Thread t = new Thread(delegate()
            {
                try
                {
                    AutomationElement el = AutomationElement.FocusedElement;
                    if (el != null)
                    {
                        AutomationElement.AutomationElementInformation cur = el.Current;
                        bool pw = cur.IsPassword;
                        ControlType ct = cur.ControlType;
                        string name = ct == null ? null : ct.ProgrammaticName;
                        if (name != null && name.StartsWith("ControlType.", StringComparison.Ordinal)) name = name.Substring(12);
                        lock (gate)
                        {
                            res.Password = pw;
                            res.Control = name;
                            res.Done = true;
                        }
                    }
                }
                catch (Exception) { }
                finally
                {
                    lock (gate)
                    {
                        if (res.Abandoned) Interlocked.Decrement(ref hungUia);
                    }
                }
            });
            t.IsBackground = true;
            t.SetApartmentState(ApartmentState.MTA);
            t.Start();
            if (!t.Join(capMs))
            {
                lock (gate)
                {
                    if (!res.Done)
                    {
                        res.Abandoned = true;
                        Interlocked.Increment(ref hungUia);
                        return null;
                    }
                }
            }
            lock (gate) { return res.Done ? res : null; }
        }

        // ───── 잠김 ─────

        /// <summary>null = 쓸 수 있다. 아니면 disconnected · locked · secure_desktop (읽기만 — SwitchDesktop을 쓰지 않는다)</summary>
        internal static string LockState()
        {
            IntPtr buf;
            int bytes;
            if (Native.WTSQuerySessionInformationW(IntPtr.Zero, -1, 8, out buf, out bytes))
            {
                try
                {
                    if (bytes >= 4 && Marshal.ReadInt32(buf) == 4) return "disconnected";
                }
                finally { Native.WTSFreeMemory(buf); }
            }
            if (Native.WTSQuerySessionInformationW(IntPtr.Zero, -1, 25, out buf, out bytes))
            {
                try
                {
                    // WTSINFOEXW { DWORD Level; (8바이트 정렬) WTSINFOEX_LEVEL1_W { SessionId; SessionState; SessionFlags; ... } }
                    if (bytes >= 20 && Marshal.ReadInt32(buf, 0) == 1 && Marshal.ReadInt32(buf, 16) == 0) return "locked";
                }
                finally { Native.WTSFreeMemory(buf); }
            }
            IntPtr desk = Native.OpenInputDesktop(0, false, 0x0001);
            if (desk == IntPtr.Zero) return "secure_desktop";
            try
            {
                string name = Native.DesktopName(desk);
                if (!string.Equals(name, "Default", StringComparison.OrdinalIgnoreCase)) return "secure_desktop";
            }
            finally { Native.CloseDesktop(desk); }
            return null;
        }

        // ───── 모니터 ─────

        internal static List<Mon> Monitors()
        {
            List<Mon> list = new List<Mon>();
            Native.MonitorEnumProc cb = delegate(IntPtr hMon, IntPtr hdc, IntPtr rc, IntPtr data)
            {
                Native.MONITORINFO mi = new Native.MONITORINFO();
                mi.cbSize = Marshal.SizeOf(typeof(Native.MONITORINFO));
                if (Native.GetMonitorInfoW(hMon, ref mi))
                {
                    Mon m = new Mon();
                    m.X = mi.rcMonitor.Left;
                    m.Y = mi.rcMonitor.Top;
                    m.W = mi.rcMonitor.Right - mi.rcMonitor.Left;
                    m.H = mi.rcMonitor.Bottom - mi.rcMonitor.Top;
                    m.Primary = (mi.dwFlags & 1) != 0;
                    m.Dpi = 96;
                    try
                    {
                        uint dx, dy;
                        if (Native.GetDpiForMonitor(hMon, 0, out dx, out dy) == 0) m.Dpi = (int)dx;
                    }
                    catch (DllNotFoundException) { }
                    catch (EntryPointNotFoundException) { }
                    list.Add(m);
                }
                return true;
            };
            Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, cb, IntPtr.Zero);
            GC.KeepAlive(cb);
            list.Sort(delegate(Mon a, Mon b)
            {
                if (a.Primary != b.Primary) return a.Primary ? -1 : 1;
                if (a.X != b.X) return a.X.CompareTo(b.X);
                return a.Y.CompareTo(b.Y);
            });
            return list;
        }

        internal static string LayoutHash(List<Mon> mons)
        {
            StringBuilder sb = new StringBuilder();
            foreach (Mon m in mons)
            {
                sb.Append(m.Primary ? 'p' : 's').Append(',').Append(m.X).Append(',').Append(m.Y).Append(',').Append(m.W).Append(',')
                  .Append(m.H).Append(',').Append(m.Dpi).Append(';');
            }
            return Sha256Hex(Encoding.ASCII.GetBytes(sb.ToString())).Substring(0, 16);
        }

        private static Rectangle VirtualRect()
        {
            return new Rectangle(Native.GetSystemMetrics(76), Native.GetSystemMetrics(77), Native.GetSystemMetrics(78), Native.GetSystemMetrics(79));
        }

        private static string Sha256Hex(byte[] data)
        {
            using (SHA256 sha = SHA256.Create())
            {
                byte[] h = sha.ComputeHash(data);
                StringBuilder sb = new StringBuilder(h.Length * 2);
                foreach (byte b in h) sb.Append(b.ToString("x2", CultureInfo.InvariantCulture));
                return sb.ToString();
            }
        }

        // ───── 무장 ─────

        private static string DoArm(string args)
        {
            Policy p = Policy.Parse(args);
            if (p == null) return "ERR BAD_ARGS policy";
            // 사람 우선의 시작 값: 아무것도 주입하기 전의 마지막 입력 시각. 이미 무장했으면 처음 값 (그 사이 우리 주입이 섞인다)
            long seed = Interlocked.Read(ref armSeed);
            if (seed < 0 || !armed) seed = Native.LastInputEpochMs();
            lock (stateLock) { policy = p; }
            // 쥔 값: 이 ARM을 시작할 때의 abortSeq. 화면 스레드가 훅을 건 같은 단계에서(TryArm, armLock 안) 다시 본다 — 그사이 RELEASE·STOP·멈춤 단축키가
            // 지나갔으면 무장하지 않고 훅을 푼다. 무장했다면 훅·표시가 켜진 채다 (리드 결정 S6-21 F2)
            long before = Interlocked.Read(ref abortSeq);
            int result = Ui.Arm(700, before, seed);
            if (result == Ui.ArmOk)
            {
                return "OK seed=" + seed.ToString(CultureInfo.InvariantCulture) + " hotkey=" + (Ui.HotkeyRegistered ? "1" : "0");
            }
            // 무장하지 않았다 (훅을 걸지 못함 · 그사이 해제가 지나감 · 화면 스레드가 제때 답하지 않음): 늦게 도는 무장 단계가 무장하지 못하게 하고 훅·표시를 끈다
            long seq = CancelArm();
            Ui.Disarm(300, seq);
            if (stopped) return "ERR STOPPED";
            if (result == Ui.ArmAborted)
            {
                lock (sendLock) { return "ERR " + abortReason; }
            }
            return "ERR INTERNAL hooks";
        }

        // ───── 캡처 ─────

        private static string DoCapture(string args)
        {
            string[] a = args.Split(' ');
            if (a.Length != 3) return "ERR BAD_ARGS";
            int maxEdge;
            if (!int.TryParse(a[1], NumberStyles.None, CultureInfo.InvariantCulture, out maxEdge) || maxEdge < 1 || maxEdge > 16384) return "ERR BAD_ARGS maxEdge";
            string id = a[2];
            if (!CaptureIdRe.IsMatch(id)) return "ERR BAD_ARGS id";
            string lk = LockState();
            if (lk != null) return "ERR LOCKED " + lk;
            List<Mon> mons = Monitors();
            string layout = LayoutHash(mons);
            Rectangle r;
            if (a[0] == "all") r = VirtualRect();
            else
            {
                int idx;
                if (!int.TryParse(a[0], NumberStyles.None, CultureInfo.InvariantCulture, out idx) || idx < 1 || idx > mons.Count) return "ERR BAD_ARGS screen";
                Mon m = mons[idx - 1];
                r = new Rectangle(m.X, m.Y, m.W, m.H);
            }
            if (r.Width <= 0 || r.Height <= 0) return "ERR INTERNAL empty_screen";
            string final = Path.Combine(screensDir, id + ".png");
            string tmp = final + ".tmp";
            if (File.Exists(final) || File.Exists(tmp)) return "ERR BAD_ARGS id_exists";
            byte[] png;
            int w, h;
            using (Bitmap bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format24bppRgb))
            {
                try
                {
                    using (Graphics g = Graphics.FromImage(bmp))
                    {
                        g.CopyFromScreen(r.X, r.Y, 0, 0, r.Size, CopyPixelOperation.SourceCopy | CopyPixelOperation.CaptureBlt);
                    }
                }
                catch (Win32Exception)
                {
                    // 입력 데스크톱이 우리 것이 아니다 (잠김·보안 화면)
                    string again = LockState();
                    return "ERR LOCKED " + (again ?? "secure_desktop");
                }
                double scale = Math.Min(1.0, (double)maxEdge / Math.Max(r.Width, r.Height));
                w = Math.Max(1, (int)Math.Round(r.Width * scale));
                h = Math.Max(1, (int)Math.Round(r.Height * scale));
                if (w != r.Width || h != r.Height)
                {
                    using (Bitmap small = new Bitmap(w, h, PixelFormat.Format24bppRgb))
                    {
                        using (Graphics g2 = Graphics.FromImage(small))
                        using (ImageAttributes ia = new ImageAttributes())
                        {
                            g2.InterpolationMode = InterpolationMode.HighQualityBicubic;
                            g2.PixelOffsetMode = PixelOffsetMode.HighQuality;
                            g2.CompositingQuality = CompositingQuality.HighQuality;
                            g2.SmoothingMode = SmoothingMode.HighQuality;
                            ia.SetWrapMode(WrapMode.TileFlipXY);
                            g2.DrawImage(bmp, new Rectangle(0, 0, w, h), 0, 0, r.Width, r.Height, GraphicsUnit.Pixel, ia);
                        }
                        png = ToPng(small);
                    }
                }
                else png = ToPng(bmp);
            }
            string hash = Sha256Hex(png);
            try
            {
                File.WriteAllBytes(tmp, png);
                File.Move(tmp, final);
            }
            catch (Exception)
            {
                try { File.Delete(tmp); } catch (Exception) { }
                throw;
            }
            return "OK " + w + " " + h + " " + r.X + " " + r.Y + " " + r.Width + " " + r.Height + " " + layout + " " + hash;
        }

        private static byte[] ToPng(Bitmap bmp)
        {
            using (MemoryStream ms = new MemoryStream())
            {
                bmp.Save(ms, ImageFormat.Png);
                return ms.ToArray();
            }
        }

        // ───── 입력 ─────

        /// <summary>입력 명령의 공통 앞 검사. 통과하면 null과 쥔 값들</summary>
        private static string InputGate(string layout, out long token, out long human)
        {
            token = Interlocked.Read(ref abortSeq);
            human = Interlocked.Read(ref humanSeq);
            if (stopped) return "ERR STOPPED";
            if (!armed) return "ERR RELEASED";
            if (!LayoutRe.IsMatch(layout)) return "ERR BAD_ARGS layout";
            string lk = LockState();
            if (lk != null) return "ERR LOCKED " + lk;
            if (layout != LayoutHash(Monitors())) return "ERR LAYOUT_CHANGED";
            return null;
        }

        private static bool InScreen(int x, int y)
        {
            Rectangle v = VirtualRect();
            return x >= v.Left && x < v.Right && y >= v.Top && y < v.Bottom;
        }

        /// <summary>그 점의 창이 막는 창이거나 높은 권한이면 ERR</summary>
        private static string PointTarget(int x, int y, out WinFacts f)
        {
            f = PointFacts(x, y);
            if (f == null) return null;
            if (f.Blocked) return "ERR BLOCKED_TARGET window";
            if (f.Elevated) return "ERR ELEVATED_TARGET";
            return null;
        }

        private static bool ParseInts(string[] a, int from, int n, int[] into)
        {
            for (int i = 0; i < n; i++)
            {
                if (!int.TryParse(a[from + i], NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out into[i])) return false;
            }
            return true;
        }

        private static string DoMove(string args)
        {
            string[] a = args.Split(' ');
            if (a.Length != 3) return "ERR BAD_ARGS";
            int[] v = new int[2];
            if (!ParseInts(a, 0, 2, v)) return "ERR BAD_ARGS x/y";
            long token, human;
            string gate = InputGate(a[2], out token, out human);
            if (gate != null) return gate;
            if (!InScreen(v[0], v[1])) return "ERR BAD_ARGS outside";
            WinFacts f;
            string target = PointTarget(v[0], v[1], out f);
            if (target != null) return target;
            if (!Inject(new Native.INPUT[] { Mouse.MoveTo(v[0], v[1]) }, token)) return Aborted(token, human) ?? "ERR RELEASED";
            return "OK " + FocusJson(ForegroundFacts(), null);
        }

        private static string DoClick(string args)
        {
            string[] a = args.Split(' ');
            if (a.Length != 5) return "ERR BAD_ARGS";
            int[] v = new int[2];
            if (!ParseInts(a, 0, 2, v)) return "ERR BAD_ARGS x/y";
            int button = a[2] == "left" ? 0 : a[2] == "right" ? 1 : a[2] == "middle" ? 2 : -1;
            if (button < 0) return "ERR BAD_ARGS button";
            int count;
            if (!int.TryParse(a[3], NumberStyles.None, CultureInfo.InvariantCulture, out count) || count < 1 || count > 3) return "ERR BAD_ARGS count";
            long token, human;
            string gate = InputGate(a[4], out token, out human);
            if (gate != null) return gate;
            if (!InScreen(v[0], v[1])) return "ERR BAD_ARGS outside";
            WinFacts f;
            string target = PointTarget(v[0], v[1], out f);
            if (target != null) return target;
            // 이동 + (누름·뗌)×n 이 한 번의 SendInput 배열이다 — 중간에 끊겨 버튼이 눌린 채 남지 않는다
            List<Native.INPUT> list = new List<Native.INPUT>();
            list.Add(Mouse.MoveTo(v[0], v[1]));
            for (int i = 0; i < count; i++)
            {
                list.Add(Mouse.Button(button, true));
                list.Add(Mouse.Button(button, false));
            }
            if (!Inject(list.ToArray(), token)) return Aborted(token, human) ?? "ERR RELEASED";
            Thread.Sleep(30);
            return "OK " + FocusJson(ForegroundFacts(), null);
        }

        private static string DoDrag(string args)
        {
            string[] a = args.Split(' ');
            if (a.Length != 5) return "ERR BAD_ARGS";
            int[] v = new int[4];
            if (!ParseInts(a, 0, 4, v)) return "ERR BAD_ARGS x/y";
            long token, human;
            string gate = InputGate(a[4], out token, out human);
            if (gate != null) return gate;
            if (!InScreen(v[0], v[1]) || !InScreen(v[2], v[3])) return "ERR BAD_ARGS outside";
            WinFacts f;
            string target = PointTarget(v[0], v[1], out f);
            if (target != null) return target;
            target = PointTarget(v[2], v[3], out f);
            if (target != null) return target;
            const int steps = 12;
            if (!Inject(new Native.INPUT[] { Mouse.MoveTo(v[0], v[1]), Mouse.Button(0, true) }, token)) return Aborted(token, human) ?? "ERR RELEASED";
            lock (sendLock) { pressedButtons.Add(0); }
            int sent = 0;
            string stop = null;
            try
            {
                for (int i = 1; i <= steps; i++)
                {
                    Thread.Sleep(15);
                    stop = Aborted(token, human);
                    if (stop != null) break;
                    int x = v[0] + (int)Math.Round((v[2] - v[0]) * (double)i / steps);
                    int y = v[1] + (int)Math.Round((v[3] - v[1]) * (double)i / steps);
                    if (!Inject(new Native.INPUT[] { Mouse.MoveTo(x, y) }, token))
                    {
                        stop = Aborted(token, human) ?? "ERR RELEASED";
                        break;
                    }
                    sent = i;
                }
            }
            finally
            {
                // 늘 버튼을 떼고 끝난다 (멈췄어도)
                InjectUp(new Native.INPUT[] { Mouse.Button(0, false) });
                lock (sendLock) { pressedButtons.Remove(0); }
            }
            if (stop != null) return stop + " sent=" + sent;
            return "OK " + FocusJson(ForegroundFacts(), null);
        }

        private static string DoScroll(string args)
        {
            string[] a = args.Split(' ');
            if (a.Length != 4) return "ERR BAD_ARGS";
            int[] v = new int[3];
            if (!ParseInts(a, 0, 3, v)) return "ERR BAD_ARGS x/y";
            if (v[2] == 0 || v[2] < -20 || v[2] > 20) return "ERR BAD_ARGS amount";
            long token, human;
            string gate = InputGate(a[3], out token, out human);
            if (gate != null) return gate;
            if (!InScreen(v[0], v[1])) return "ERR BAD_ARGS outside";
            WinFacts f;
            string target = PointTarget(v[0], v[1], out f);
            if (target != null) return target;
            // 양수 = 아래로: 휠 값은 몸 쪽(음수)
            if (!Inject(new Native.INPUT[] { Mouse.MoveTo(v[0], v[1]), Mouse.Wheel(-v[2] * 120) }, token)) return Aborted(token, human) ?? "ERR RELEASED";
            return "OK " + FocusJson(ForegroundFacts(), null);
        }

        private static string DoKey(string args)
        {
            string[] a = args.Split(' ');
            if (a.Length != 2) return "ERR BAD_ARGS";
            KeyCombo combo = KeyMap.Parse(a[0]);
            if (combo == null) return "ERR BAD_ARGS combo";
            long token, human;
            string gate = InputGate(a[1], out token, out human);
            if (gate != null) return gate;
            // 사람의 멈춤 단축키·잠금·SAS는 보내지 않는다 (TS screenGuard가 먼저 막는다 — 여기는 한 번 더)
            if (combo.Denied) return "ERR BLOCKED_TARGET key";
            WinFacts f = ForegroundFacts();
            if (f != null)
            {
                if (f.Blocked) return "ERR BLOCKED_TARGET window";
                if (f.Elevated) return "ERR ELEVATED_TARGET";
                // 바탕 화면·작업 표시줄의 Alt+F4는 'Windows 종료' 창을 연다
                if (combo.IsAltF4 && (f.Class == "Progman" || f.Class == "WorkerW" || f.Class == "Shell_TrayWnd" || f.Class == "Shell_SecondaryTrayWnd")) return "ERR BLOCKED_TARGET shell";
            }
            UiaFocus u = null;
            if (combo.Printable)
            {
                if (f == null) return "ERR FOCUS_UNKNOWN";
                u = QueryFocus(1500);
                if (u == null) return "ERR FOCUS_UNKNOWN";
                if (u.Password) return "ERR PASSWORD_FIELD";
                string again = Aborted(token, human);
                if (again != null) return again;
            }
            // 수정 키 누름 → 키 누름·뗌 → 수정 키 뗌 (거꾸로)이 한 번의 SendInput 배열이다
            if (!Inject(combo.Inputs(), token)) return Aborted(token, human) ?? "ERR RELEASED";
            return "OK " + FocusJson(ForegroundFacts(), u);
        }

        private static string DoType(string args)
        {
            string[] a = args.Split(' ');
            if (a.Length != 2) return "ERR BAD_ARGS";
            string text;
            try { text = new UTF8Encoding(false, true).GetString(Convert.FromBase64String(a[0])); }
            catch (FormatException) { return "ERR BAD_ARGS text"; }
            catch (ArgumentException) { return "ERR BAD_ARGS text"; }
            if (text.Length == 0) return "ERR BAD_ARGS text";
            // 제어 문자(탭·줄바꿈 등)가 든 글은 치지 않는다 — 탭·Enter는 포커스를 옮기거나 양식을 보내, 그 뒤 글자가 암호 칸 검사를 받지 않은 칸에 들어간다.
            // 서버(TS)가 먼저 거른다 — 여기는 한 번 더 (리드 결정 S6-21 B1)
            if (KeyMap.HasControl(text)) return "ERR BAD_TEXT";
            long token, human;
            string gate = InputGate(a[1], out token, out human);
            if (gate != null) return gate;
            WinFacts f = ForegroundFacts();
            if (f == null) return "ERR FOCUS_UNKNOWN";
            if (f.Blocked) return "ERR BLOCKED_TARGET window";
            if (f.Elevated) return "ERR ELEVATED_TARGET";
            UiaFocus u = QueryFocus(1500);
            if (u == null) return "ERR FOCUS_UNKNOWN";
            if (u.Password) return "ERR PASSWORD_FIELD";
            string early = Aborted(token, human);
            if (early != null) return early + " sent=0";
            // 글자 → 누름·뗌 쌍들 (UTF-16 단위마다 한 쌍). sent는 보낸 UTF-16 단위 수이자 inputs에서 다음에 보낼 쌍의 자리다
            List<Native.INPUT> inputs = KeyMap.TextInputs(text);
            int sent = 0;
            // 글자 TypeUnitChars개씩(서로게이트 쌍은 한 글자 — 나누지 않는다) SendInput 한 번으로 보낸다 (리드 결정 S6-23 K2). 앱이 치는 중에 스스로 포커스를
            // 옮길 수 있다(칸을 다 채우면 다음 칸으로 넘어가는 양식 — 주민등록번호 뒷자리·OTP 칸). 그래서 둘째 묶음부터는 보내기 전에 최상위 창과 포커스를
            // 다시 읽는다: 다시 읽은 포커스가 암호 칸이거나 모르면(읽지 못함·TypeRecheckMs 넘음) ERR FOCUS_UNKNOWN sent=n으로 멈춘다. 처음 칸 그대로이든
            // 앱이 옮긴 다른 칸이든 판정은 같다 — 보통 칸이면 이어 친다. 그래서 요소가 같은지(런타임 ID)는 견주지 않는다.
            // UI Automation 이벤트(포커스 바뀜 알림)는 쓰지 않는다 — 처음 읽기와 같은 QueryFocus를 다시 부른다.
            // 한계: 앱은 포커스를 비동기로 옮긴다 — 보내는 중인 묶음(4자까지)과 앱이 아직 처리하지 않은 글자는 옮겨 간 칸에 들어갈 수 있다 (KNOWN_ISSUES).
            // 그 칸에 더 치지는 않는다. 끝난 뒤 포커스를 한 번 더 읽어 OK에 싣는다 — 서버는 그 포커스가 암호 칸이거나 모르면 secret_blocked로 끝낸다
            while (sent < text.Length)
            {
                int end = KeyMap.UnitEnd(text, sent, TypeUnitChars);
                if (sent > 0)
                {
                    // 앱이 앞 묶음을 처리할 틈 (포커스를 옮겼으면 다시 읽기가 볼 수 있게)
                    Thread.Sleep(5);
                    IntPtr fg = Native.GetForegroundWindow();
                    if (fg == IntPtr.Zero || Native.GetAncestor(fg, 2) != f.Root) return "ERR FOCUS_UNKNOWN sent=" + sent;
                    UiaFocus now = QueryFocus(TypeRecheckMs);
                    if (now == null || now.Password) return "ERR FOCUS_UNKNOWN sent=" + sent;
                    // 멈춤·사람 입력은 보내기 바로 전에 (포커스 읽기가 걸린 동안 왔을 수 있다)
                    string stop = Aborted(token, human);
                    if (stop != null) return stop + " sent=" + sent;
                }
                Native.INPUT[] chunk = new Native.INPUT[(end - sent) * 2];
                inputs.CopyTo(sent * 2, chunk, 0, chunk.Length);
                if (!Inject(chunk, token)) return (Aborted(token, human) ?? "ERR RELEASED") + " sent=" + sent;
                sent = end;
            }
            // 마지막 묶음을 앱이 처리할 틈을 두고 끝난 뒤의 포커스를 읽는다 (마지막 묶음이 포커스를 옮겼을 수 있다)
            Thread.Sleep(30);
            UiaFocus last = QueryFocus(1500);
            return "OK " + FocusJson(ForegroundFacts(), last);
        }

        /// <summary>TYPE이 SendInput 한 번에 보내는 글자 수 (코드 포인트 — 리드 결정 S6-23 K2)</summary>
        private const int TypeUnitChars = 4;

        /// <summary>
        /// TYPE이 둘째 묶음부터 포커스를 다시 읽을 때의 상한 (ms). 넘으면 모름으로 보고 멈춘다. 처음 읽기와 끝난 뒤 읽기는 1500ms다.
        /// 서버의 TYPE 시간 상한(desktopHelper.ts DESKTOP_TIMEOUTS — TYPE 5000 + 글자당 80ms)은 가장 늦은 경우(2,000자: 1.5초 + 499묶음 × (쉼 ≤16ms +
        /// 이 상한 + 보내기) + 1.5초 ≈ 137초)보다 길다 — guiDeniedTargets가 이 값들로 셈해 본다
        /// </summary>
        private const int TypeRecheckMs = 250;
    }

    internal sealed class KeyCombo
    {
        public readonly List<ushort> Mods = new List<ushort>();
        public ushort Vk;
        public bool Printable;
        public bool Denied;
        public bool IsAltF4;

        public Native.INPUT[] Inputs()
        {
            List<Native.INPUT> list = new List<Native.INPUT>();
            foreach (ushort m in Mods) list.Add(KeyMap.KeyInput(m, false));
            list.Add(KeyMap.KeyInput(Vk, false));
            list.Add(KeyMap.KeyInput(Vk, true));
            for (int i = Mods.Count - 1; i >= 0; i--) list.Add(KeyMap.KeyInput(Mods[i], true));
            return list.ToArray();
        }
    }

    internal static class KeyMap
    {
        internal static readonly ushort[] Modifiers = new ushort[] { 0x10, 0xA0, 0xA1, 0x11, 0xA2, 0xA3, 0x12, 0xA4, 0xA5, 0x5B, 0x5C };
        private static readonly Dictionary<string, ushort> Named = new Dictionary<string, ushort>(StringComparer.Ordinal);
        private static readonly HashSet<ushort> Extended = new HashSet<ushort>(new ushort[] { 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2C, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F, 0x90, 0xA3, 0xA5 });
        /// <summary>
        /// 글자를 찍지 않는 키 (이동·기능 키): Enter·Tab·Esc·Backspace·Delete·Insert·Home·End·PageUp·PageDown·화살표·PrintScreen·Menu·CapsLock과 F1~F24
        /// (정적 생성자가 더한다). 이 목록에 없는 키는 모두 글자 키다 — space·plus·minus와 모든 글자 하나 (리드 결정 S6-21 B2). 새 이름 키를 더하고 이 목록을
        /// 잊으면 글자 키로 다뤄져 암호 칸에서 막힌다 (막는 쪽). core/screenGuard.ts NON_PRINTABLE_KEYS와 같은 목록이다
        /// </summary>
        private static readonly HashSet<ushort> NonPrintable = new HashSet<ushort>(new ushort[] { 0x0D, 0x09, 0x1B, 0x08, 0x2E, 0x2D, 0x24, 0x23, 0x21, 0x22, 0x26, 0x28, 0x25, 0x27, 0x2C, 0x5D, 0x14 });

        static KeyMap()
        {
            Named["enter"] = 0x0D; Named["return"] = 0x0D; Named["tab"] = 0x09; Named["esc"] = 0x1B; Named["escape"] = 0x1B;
            Named["space"] = 0x20; Named["backspace"] = 0x08; Named["delete"] = 0x2E; Named["del"] = 0x2E; Named["insert"] = 0x2D;
            Named["ins"] = 0x2D; Named["home"] = 0x24; Named["end"] = 0x23; Named["pageup"] = 0x21; Named["pgup"] = 0x21;
            Named["pagedown"] = 0x22; Named["pgdn"] = 0x22; Named["up"] = 0x26; Named["down"] = 0x28; Named["left"] = 0x25;
            Named["right"] = 0x27; Named["printscreen"] = 0x2C; Named["prtsc"] = 0x2C; Named["menu"] = 0x5D; Named["apps"] = 0x5D;
            Named["capslock"] = 0x14; Named["plus"] = 0xBB; Named["minus"] = 0xBD;
            for (int i = 1; i <= 24; i++)
            {
                Named["f" + i.ToString(CultureInfo.InvariantCulture)] = (ushort)(0x70 + i - 1);
                NonPrintable.Add((ushort)(0x70 + i - 1));
            }
        }

        /// <summary>'ctrl+shift+s' · 'enter' · 'A' 꼴. 모르는 이름이면 null</summary>
        internal static KeyCombo Parse(string text)
        {
            if (string.IsNullOrEmpty(text) || text.Length > 60) return null;
            string[] parts = text.Split('+');
            KeyCombo c = new KeyCombo();
            bool ctrl = false, alt = false, shift = false, win = false;
            for (int i = 0; i < parts.Length; i++)
            {
                string raw = parts[i];
                if (raw.Length == 0) return null;
                string p = raw.ToLowerInvariant();
                bool last = i == parts.Length - 1;
                if (!last || raw.Length > 1)
                {
                    if (p == "ctrl" || p == "control") { if (last) return null; ctrl = true; continue; }
                    if (p == "alt") { if (last) return null; alt = true; continue; }
                    if (p == "shift") { if (last) return null; shift = true; continue; }
                    if (p == "win" || p == "meta" || p == "super") { if (last) return null; win = true; continue; }
                }
                if (!last) return null;
                // 글자 키인지는 메인이 준 조합으로 정한다 (리드 결정 S6-21 B2·S6-23 K1): 키가 이동·기능 키가 아니고, 메인이 수정 키를 쓰지 않았거나(Shift만은
                // 글자) Win 없이 Ctrl과 Alt를 함께 썼으면 글자 키다 — Windows에서 Ctrl+Alt는 AltGr이라 AltGr 자판에서 글자를 찍는다(독일어 Ctrl+Alt+Q = '@').
                // Ctrl만·Alt만 썼거나 Win이 든 조합은 단축키다. 이 줄은 마지막 낱말에서만 돈다 — 여기까지의 ctrl·alt·win은 모두 메인이 쓴 것이고, 아래에서
                // 자판 배열이 그 글자에 더하는 Ctrl+Alt(AltGr)는 이 판정에 들지 않는다 (AltGr로 찍는 글자도 글자 키다). 막는 조합(Denied)은 DoKey가 먼저 본다
                bool askedAltGr = ctrl && alt && !win;
                bool askedShortcut = (ctrl || alt || win) && !askedAltGr;
                ushort named;
                if (raw.Length > 1)
                {
                    if (!Named.TryGetValue(p, out named)) return null;
                    c.Vk = named;
                    c.Printable = !askedShortcut && !NonPrintable.Contains(named);
                }
                else
                {
                    char ch = raw[0];
                    if (ch < 0x21 || ch > 0x7E) return null;
                    short scan = Native.VkKeyScanW(ch);
                    if (scan == -1) return null;
                    c.Vk = (ushort)(scan & 0xFF);
                    int state = (scan >> 8) & 0xFF;
                    if ((state & 1) != 0) shift = true;
                    if ((state & 2) != 0) ctrl = true;
                    if ((state & 4) != 0) alt = true;
                    c.Printable = !askedShortcut;
                }
            }
            if (c.Vk == 0) return null;
            // 보내는 조합 자체가 Win 없는 Ctrl+Alt면 AltGr 글자다 (S6-23 K1 — 위 판정을 막는 쪽으로만 넓힌다): 메인이 Ctrl이나 Alt 하나만 줬는데 자판 배열이 그
            // 글자에 Ctrl+Alt를 더한 경우('alt+@' — 독일어 자판에서 AltGr+Q로 '@'를 찍는다)도 글자 키다
            if (ctrl && alt && !win && !NonPrintable.Contains(c.Vk)) c.Printable = true;
            if (ctrl) c.Mods.Add(0x11);
            if (alt) c.Mods.Add(0x12);
            if (shift) c.Mods.Add(0x10);
            if (win) c.Mods.Add(0x5B);
            c.IsAltF4 = alt && c.Vk == 0x73;
            c.Denied = (win && c.Vk == 0x4C) || (ctrl && alt && (c.Vk == 0x2E || (shift && c.Vk == 0x7B)));
            return c;
        }

        internal static Native.INPUT KeyInput(ushort vk, bool up)
        {
            Native.INPUT i = new Native.INPUT();
            i.type = 1;
            i.U.ki.wVk = vk;
            i.U.ki.wScan = (ushort)Native.MapVirtualKeyW(vk, 0);
            i.U.ki.dwFlags = (up ? 0x0002u : 0u) | (Extended.Contains(vk) ? 0x0001u : 0u);
            i.U.ki.dwExtraInfo = Helper.InjectTag;
            return i;
        }

        private static Native.INPUT UnicodeInput(char unit, bool up)
        {
            Native.INPUT i = new Native.INPUT();
            i.type = 1;
            i.U.ki.wVk = 0;
            i.U.ki.wScan = unit;
            i.U.ki.dwFlags = 0x0004u | (up ? 0x0002u : 0u);
            i.U.ki.dwExtraInfo = Helper.InjectTag;
            return i;
        }

        /// <summary>제어 문자(U+0000~U+001F, U+007F)가 들었는지 — 탭·줄바꿈 포함. 이런 글은 TYPE으로 받지 않는다 (ERR BAD_TEXT)</summary>
        internal static bool HasControl(string text)
        {
            foreach (char ch in text)
            {
                if (ch < 0x20 || ch == 0x7F) return true;
            }
            return false;
        }

        /// <summary>
        /// start(UTF-16 자리)부터 글자 chars개 뒤의 자리. 서로게이트 쌍은 한 글자로 세고 나누지 않는다 (TYPE의 묶음 끝 — 리드 결정 S6-23 K2).
        /// DoType의 글은 UTF-8을 엄격히 푼 것이라 짝 없는 서로게이트가 없다 — 있어도 한 단위로 센다
        /// </summary>
        internal static int UnitEnd(string text, int start, int chars)
        {
            int i = start;
            for (int c = 0; c < chars && i < text.Length; c++)
            {
                bool pair = char.IsHighSurrogate(text[i]) && i + 1 < text.Length && char.IsLowSurrogate(text[i + 1]);
                i += pair ? 2 : 1;
            }
            return i;
        }

        /// <summary>
        /// 글자 → 누름·뗌 쌍들. 모든 글자를 KEYEVENTF_UNICODE로 보낸다 (서로게이트 쌍은 두 단위). 탭·줄바꿈을 Tab·Enter 키로 바꾸지 않는다 — 그런 글은 DoType이
        /// 먼저 거부한다 (리드 결정 S6-21 B1)
        /// </summary>
        internal static List<Native.INPUT> TextInputs(string text)
        {
            List<Native.INPUT> list = new List<Native.INPUT>();
            foreach (char ch in text)
            {
                list.Add(UnicodeInput(ch, false));
                list.Add(UnicodeInput(ch, true));
            }
            return list;
        }
    }

    internal static class Mouse
    {
        internal static Native.INPUT MoveTo(int x, int y)
        {
            int vx = Native.GetSystemMetrics(76), vy = Native.GetSystemMetrics(77);
            int vw = Math.Max(2, Native.GetSystemMetrics(78)), vh = Math.Max(2, Native.GetSystemMetrics(79));
            Native.INPUT i = new Native.INPUT();
            i.type = 0;
            // 가상 화면 절대 좌표 0..65535 (내려앉는 픽셀은 9단계 실제 화면 시험이 본다)
            i.U.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
            i.U.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
            i.U.mi.dwFlags = 0x0001u | 0x8000u | 0x4000u;
            i.U.mi.dwExtraInfo = Helper.InjectTag;
            return i;
        }

        /// <summary>0 왼쪽 · 1 오른쪽 · 2 가운데</summary>
        internal static Native.INPUT Button(int button, bool down)
        {
            uint flag;
            if (button == 1) flag = down ? 0x0008u : 0x0010u;
            else if (button == 2) flag = down ? 0x0020u : 0x0040u;
            else flag = down ? 0x0002u : 0x0004u;
            Native.INPUT i = new Native.INPUT();
            i.type = 0;
            i.U.mi.dwFlags = flag;
            i.U.mi.dwExtraInfo = Helper.InjectTag;
            return i;
        }

        internal static Native.INPUT Wheel(int delta)
        {
            Native.INPUT i = new Native.INPUT();
            i.type = 0;
            i.U.mi.mouseData = unchecked((uint)delta);
            i.U.mi.dwFlags = 0x0800u;
            i.U.mi.dwExtraInfo = Helper.InjectTag;
            return i;
        }
    }

    /// <summary>화면 스레드 (STA): 조작 중 표시, 멈춤 단축키, 저수준 훅. 다른 스레드는 BeginInvoke로 맡긴다</summary>
    internal static class Ui
    {
        private static Thread thread;
        private static PumpForm pump;
        private static readonly List<OverlayForm> overlays = new List<OverlayForm>();
        private static string overlayLayout;
        private static IntPtr mouseHook = IntPtr.Zero;
        private static IntPtr keyHook = IntPtr.Zero;
        // 콜백 대리자는 GC가 거두지 않게 붙들어 둔다
        private static readonly Native.LowLevelProc mouseProc = MouseProc;
        private static readonly Native.LowLevelProc keyProc = KeyProc;
        internal static volatile bool HotkeyRegistered;

        internal static bool Start()
        {
            ManualResetEvent ready = new ManualResetEvent(false);
            thread = new Thread(delegate()
            {
                pump = new PumpForm();
                // 창 핸들을 이 스레드에서 만든다 (BeginInvoke와 WM_HOTKEY가 이 스레드로 온다). 단축키는 여기서 한 번, 그 뒤 ARM마다 다시 걸어 본다
                if (pump.Handle != IntPtr.Zero) EnsureHotkey();
                ready.Set();
                Application.Run(new ApplicationContext());
            });
            thread.IsBackground = true;
            thread.Name = "ui";
            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            return ready.WaitOne(5000) && pump != null;
        }

        private static bool OnUi(MethodInvoker a, int waitMs)
        {
            if (pump == null) return false;
            if (Thread.CurrentThread == thread)
            {
                a();
                return true;
            }
            ManualResetEvent done = new ManualResetEvent(false);
            bool ok = false;
            try
            {
                pump.BeginInvoke((MethodInvoker)delegate
                {
                    try
                    {
                        a();
                        ok = true;
                    }
                    catch (Exception) { ok = false; }
                    finally { done.Set(); }
                });
            }
            catch (InvalidOperationException) { return false; }
            return done.WaitOne(waitMs) && ok;
        }

        /// <summary>
        /// 멈춤 단축키 Ctrl+Alt+Shift+F12를 등록해 본다 (화면 스레드 — 메시지 창을 만든 스레드). 시작할 때와 ARM마다 부른다: 시작할 때 다른 프로그램(끝나지 않은
        /// 옛 도우미 포함)이 쥐고 있어 실패했어도, 그 프로그램이 끝난 뒤의 ARM에서 다시 걸린다 (리드 결정 S6-21 D). 이미 등록했으면 아무것도 하지 않는다
        /// </summary>
        private static void EnsureHotkey()
        {
            if (HotkeyRegistered || pump == null) return;
            // MOD_ALT 1 | MOD_CONTROL 2 | MOD_SHIFT 4 | MOD_NOREPEAT 0x4000, VK_F12
            HotkeyRegistered = Native.RegisterHotKey(pump.Handle, 1, 0x0001u | 0x0002u | 0x0004u | 0x4000u, 0x7Bu);
        }

        internal const int ArmOk = 0;
        /// <summary>훅을 걸지 못했다 (사람 우선을 지킬 수 없으므로 무장하지 않는다)</summary>
        internal const int ArmNoHooks = 1;
        /// <summary>그사이 RELEASE·STOP·멈춤 단축키가 지나갔다</summary>
        internal const int ArmAborted = 2;
        /// <summary>화면 스레드가 제때 답하지 않았다</summary>
        internal const int ArmNoUi = 3;

        /// <summary>
        /// 무장: 단축키를 다시 걸어 보고, 훅을 걸고, 같은 단계에서 무장을 정한 뒤(Helper.TryArm — before는 ARM을 시작할 때의 abortSeq) 표시를 띄운다.
        /// ArmOk가 아니면 무장하지 않은 것이다 — 부르는 쪽이 Disarm으로 훅·표시를 끈다
        /// </summary>
        internal static int Arm(int waitMs, long before, long seed)
        {
            int result = ArmNoUi;
            bool done = OnUi(delegate
            {
                EnsureHotkey();
                IntPtr mod = Native.GetModuleHandleW(null);
                if (mouseHook == IntPtr.Zero) mouseHook = Native.SetWindowsHookExW(14, mouseProc, mod, 0);
                if (keyHook == IntPtr.Zero) keyHook = Native.SetWindowsHookExW(13, keyProc, mod, 0);
                if (mouseHook == IntPtr.Zero || keyHook == IntPtr.Zero)
                {
                    result = ArmNoHooks;
                    return;
                }
                if (!Helper.TryArm(before, seed))
                {
                    result = ArmAborted;
                    return;
                }
                ShowOverlays();
                result = ArmOk;
            }, waitMs);
            return done ? result : ArmNoUi;
        }

        /// <summary>훅·표시를 끈다 (다른 스레드에서). seq: 이 해제의 abortSeq — 그 뒤에 새로 무장했으면 끄지 않는다</summary>
        internal static void Disarm(int waitMs, long seq)
        {
            OnUi(delegate { DisarmHere(seq); }, waitMs);
        }

        /// <summary>화면 스레드에서: 훅을 풀고 표시를 숨긴다. 그 해제(seq)보다 뒤에 새로 무장했으면 그대로 둔다 (Helper.ConfirmDisarm)</summary>
        internal static void DisarmHere(long seq)
        {
            if (!Helper.ConfirmDisarm(seq)) return;
            if (mouseHook != IntPtr.Zero) { Native.UnhookWindowsHookEx(mouseHook); mouseHook = IntPtr.Zero; }
            if (keyHook != IntPtr.Zero) { Native.UnhookWindowsHookEx(keyHook); keyHook = IntPtr.Zero; }
            foreach (OverlayForm f in overlays) f.Hide();
        }

        private static void ShowOverlays()
        {
            List<Mon> mons = Helper.Monitors();
            string layout = Helper.LayoutHash(mons);
            if (layout != overlayLayout)
            {
                foreach (OverlayForm old in overlays) old.Dispose();
                overlays.Clear();
                foreach (Mon m in mons) overlays.Add(new OverlayForm(new Rectangle(m.X, m.Y, m.W, m.H)));
                overlayLayout = layout;
            }
            foreach (OverlayForm f in overlays)
            {
                IntPtr h = f.Handle;
                // 캡처에는 찍히지 않게 (빌드 19041+). 옛 빌드는 사전 점검이 알리고 표시는 그대로 띄운다
                try { Native.SetWindowDisplayAffinity(h, 0x11); } catch (EntryPointNotFoundException) { }
                // 단축키를 걸지 못한 동안에는 띠에 '…F12로 멈춤'을 쓰지 않는다 — 누르면 멈춘다고 거짓으로 알리지 않는다 (리드 결정 S6-21 D)
                f.SetHotkey(HotkeyRegistered);
                if (!f.Visible) f.Show();
                Native.SetWindowPos(h, new IntPtr(-1), 0, 0, 0, 0, 0x0001u | 0x0002u | 0x0010u);
            }
        }

        private static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                // MSLLHOOKSTRUCT.flags (오프셋 12): LLMHF_INJECTED 1 | LLMHF_LOWER_IL_INJECTED 2 — 주입이 아니면 사람
                int flags = Marshal.ReadInt32(lParam, 12);
                if ((flags & 0x3) == 0) Helper.NoteHuman();
            }
            return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        private static IntPtr KeyProc(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                // KBDLLHOOKSTRUCT.flags (오프셋 8): LLKHF_INJECTED 0x10 | LLKHF_LOWER_IL_INJECTED 0x02. 키 코드는 읽지 않는다
                int flags = Marshal.ReadInt32(lParam, 8);
                if ((flags & 0x12) == 0) Helper.NoteHuman();
            }
            return Native.CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
        }

        /// <summary>보이지 않는 메시지 창: BeginInvoke와 WM_HOTKEY를 받는다</summary>
        private sealed class PumpForm : Form
        {
            protected override void SetVisibleCore(bool value)
            {
                base.SetVisibleCore(false);
            }

            protected override void WndProc(ref Message m)
            {
                if (m.Msg == 0x0312) Helper.OnHotkey();
                base.WndProc(ref m);
            }
        }
    }

    /// <summary>조작 중 표시: 모니터 테두리 4px + 위쪽 띠. 클릭이 지나가고, 활성화되지 않고, 맨 위에 뜬다</summary>
    internal sealed class OverlayForm : Form
    {
        private const string BandBase = "욱채 메인 에이전트가 화면을 조작 중";
        /// <summary>멈춤 단축키를 등록했을 때만 띠에 붙인다</summary>
        private const string BandHotkey = " · Ctrl+Alt+Shift+F12로 멈춤";
        private readonly Font font;
        private bool hotkey;

        /// <summary>멈춤 단축키를 걸었는지 — 바뀌면 띠를 다시 그린다 (화면 스레드)</summary>
        internal void SetHotkey(bool registered)
        {
            if (hotkey == registered) return;
            hotkey = registered;
            Invalidate();
        }

        public OverlayForm(Rectangle bounds)
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            Bounds = bounds;
            BackColor = Color.Magenta;
            TransparencyKey = Color.Magenta;
            TopMost = true;
            font = new Font("Malgun Gothic", 11f, FontStyle.Bold, GraphicsUnit.Point);
        }

        protected override bool ShowWithoutActivation
        {
            get { return true; }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                // WS_EX_LAYERED 0x80000 | WS_EX_TRANSPARENT 0x20 | WS_EX_TOOLWINDOW 0x80 | WS_EX_NOACTIVATE 0x8000000 | WS_EX_TOPMOST 0x8
                cp.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x8000000 | 0x8;
                return cp;
            }
        }

        protected override void WndProc(ref Message m)
        {
            // WM_NCHITTEST → HTTRANSPARENT: 포인터가 지나간다
            if (m.Msg == 0x0084)
            {
                m.Result = new IntPtr(-1);
                return;
            }
            // WM_MOUSEACTIVATE → MA_NOACTIVATE
            if (m.Msg == 0x0021)
            {
                m.Result = new IntPtr(3);
                return;
            }
            base.WndProc(ref m);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            Graphics g = e.Graphics;
            g.Clear(Color.Magenta);
            Color edge = Color.FromArgb(255, 230, 81, 0);
            using (SolidBrush b = new SolidBrush(edge))
            {
                int w = ClientSize.Width, h = ClientSize.Height;
                g.FillRectangle(b, 0, 0, w, 4);
                g.FillRectangle(b, 0, h - 4, w, 4);
                g.FillRectangle(b, 0, 0, 4, h);
                g.FillRectangle(b, w - 4, 0, 4, h);
                string label = hotkey ? BandBase + BandHotkey : BandBase;
                Size text = TextRenderer.MeasureText(g, label, font);
                Rectangle band = new Rectangle((w - text.Width) / 2 - 16, 4, text.Width + 32, text.Height + 10);
                g.FillRectangle(b, band);
                TextRenderer.DrawText(g, label, font, band, Color.White, TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
            }
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) font.Dispose();
            base.Dispose(disposing);
        }
    }

    internal static class Json
    {
        internal static string S(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder(s.Length + 2);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == 0x2028 || c == 0x2029) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct POINT { public int X; public int Y; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

        [StructLayout(LayoutKind.Explicit)]
        internal struct InputUnion
        {
            [FieldOffset(0)] public MOUSEINPUT mi;
            [FieldOffset(0)] public KEYBDINPUT ki;
            [FieldOffset(0)] public HARDWAREINPUT hi;
        }

        /// <summary>x64 40바이트 (합집합이 8에서 시작), x86 28바이트</summary>
        [StructLayout(LayoutKind.Sequential)]
        internal struct INPUT { public uint type; public InputUnion U; }

        [StructLayout(LayoutKind.Sequential)]
        internal struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct OSVERSIONINFOEXW
        {
            public int dwOSVersionInfoSize; public int dwMajorVersion; public int dwMinorVersion; public int dwBuildNumber; public int dwPlatformId;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szCSDVersion;
            public ushort wServicePackMajor; public ushort wServicePackMinor; public ushort wSuiteMask; public byte wProductType; public byte wReserved;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct PROCESSENTRY32W
        {
            public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
            public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
        }

        internal delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
        internal delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprcMonitor, IntPtr data);
        internal delegate IntPtr LowLevelProc(int nCode, IntPtr wParam, IntPtr lParam);

        [DllImport("user32.dll", SetLastError = true)] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
        [DllImport("shcore.dll")] internal static extern int SetProcessDpiAwareness(int value);
        [DllImport("shcore.dll")] internal static extern int GetDpiForMonitor(IntPtr hmonitor, int dpiType, out uint dpiX, out uint dpiY);
        [DllImport("user32.dll")] internal static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll")] internal static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFO info);
        [DllImport("user32.dll", SetLastError = true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern IntPtr WindowFromPoint(POINT pt);
        [DllImport("user32.dll")] internal static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
        [DllImport("user32.dll")] internal static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int max);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowTextLengthW(IntPtr hwnd);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hwnd, StringBuilder name, int max);
        [DllImport("user32.dll")] internal static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] internal static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
        [DllImport("user32.dll")] internal static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll")] internal static extern short GetAsyncKeyState(int vk);
        [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
        [DllImport("user32.dll", SetLastError = true)] private static extern bool GetUserObjectInformationW(IntPtr obj, int index, byte[] info, int length, out int needed);
        [DllImport("user32.dll")] internal static extern bool CloseDesktop(IntPtr desktop);
        [DllImport("user32.dll", SetLastError = true)] internal static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);
        [DllImport("user32.dll", SetLastError = true)] internal static extern IntPtr SetWindowsHookExW(int idHook, LowLevelProc proc, IntPtr hMod, uint threadId);
        [DllImport("user32.dll")] internal static extern bool UnhookWindowsHookEx(IntPtr hook);
        [DllImport("user32.dll")] internal static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] internal static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        [DllImport("user32.dll")] internal static extern void DisableProcessWindowsGhosting();
        [DllImport("user32.dll")] internal static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] internal static extern short VkKeyScanW(char ch);
        [DllImport("user32.dll")] internal static extern uint MapVirtualKeyW(uint code, uint mapType);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
        [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
        [DllImport("wtsapi32.dll", SetLastError = true)] internal static extern bool WTSQuerySessionInformationW(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
        [DllImport("wtsapi32.dll")] internal static extern void WTSFreeMemory(IntPtr memory);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] internal static extern IntPtr GetModuleHandleW(string name);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] internal static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
        [DllImport("kernel32.dll", SetLastError = true)] internal static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] internal static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] internal static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
        [DllImport("advapi32.dll")] internal static extern IntPtr GetSidSubAuthorityCount(IntPtr sid);
        [DllImport("advapi32.dll")] internal static extern IntPtr GetSidSubAuthority(IntPtr sid, uint index);
        [DllImport("ntdll.dll")] private static extern int RtlGetVersion(ref OSVERSIONINFOEXW info);

        /// <summary>실제 픽셀 좌표: PER_MONITOR_AWARE_V2 → (옛 Windows) 모니터별 → 시스템</summary>
        internal static void InitDpi()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; }
            catch (EntryPointNotFoundException) { }
            try { if (SetProcessDpiAwareness(2) == 0) return; }
            catch (DllNotFoundException) { }
            catch (EntryPointNotFoundException) { }
            try { SetProcessDPIAware(); }
            catch (EntryPointNotFoundException) { }
        }

        internal static uint Send(INPUT[] inputs)
        {
            if (inputs.Length == 0) return 0;
            return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        }

        internal static string WindowText(IntPtr hwnd)
        {
            int len = GetWindowTextLengthW(hwnd);
            if (len <= 0) return "";
            StringBuilder sb = new StringBuilder(Math.Min(len, 1024) + 1);
            GetWindowTextW(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        internal static string ClassName(IntPtr hwnd)
        {
            StringBuilder sb = new StringBuilder(256);
            GetClassNameW(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        internal static bool IsCloaked(IntPtr hwnd)
        {
            int cloaked;
            try { return DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0; }
            catch (DllNotFoundException) { return false; }
        }

        /// <summary>그림자 없는 보이는 테두리 (DWMWA_EXTENDED_FRAME_BOUNDS)</summary>
        internal static bool FrameBounds(IntPtr hwnd, out RECT rect)
        {
            try { return DwmGetWindowAttribute(hwnd, 9, out rect, Marshal.SizeOf(typeof(RECT))) == 0; }
            catch (DllNotFoundException)
            {
                rect = new RECT();
                return false;
            }
        }

        internal static string DesktopName(IntPtr desk)
        {
            byte[] buf = new byte[512];
            int needed;
            if (!GetUserObjectInformationW(desk, 2, buf, buf.Length, out needed)) return "";
            return Encoding.Unicode.GetString(buf, 0, Math.Max(0, Math.Min(needed, buf.Length))).TrimEnd('\0');
        }

        /// <summary>마지막 입력 시각 (epoch ms) — 지금 - (틱 - 마지막 입력 틱)</summary>
        internal static long LastInputEpochMs()
        {
            LASTINPUTINFO li = new LASTINPUTINFO();
            li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
            long now = Helper.NowMs();
            if (!GetLastInputInfo(ref li)) return now;
            uint idle = unchecked((uint)Environment.TickCount - li.dwTime);
            return now - idle;
        }

        internal static int BuildNumber()
        {
            OSVERSIONINFOEXW v = new OSVERSIONINFOEXW();
            v.dwOSVersionInfoSize = Marshal.SizeOf(typeof(OSVERSIONINFOEXW));
            try { return RtlGetVersion(ref v) == 0 ? v.dwBuildNumber : 0; }
            catch (EntryPointNotFoundException) { return 0; }
        }
    }
}
