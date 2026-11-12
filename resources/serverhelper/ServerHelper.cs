// 욱채 서버 도우미 (WookServerHelper.exe) — SERVER_DESIGN 3.2, 리드 결정 S9-5·S9-7.
//
// 서버(src/server/adminPipe.ts·src/server/power.ts)가 직접 띄우는 오래 떠 있는 프로세스. 두 가지 일 가운데 하나를 한다 (한 프로세스에 하나).
// - pipe --name \\.\pipe\wook-admin-…: 관리 채널의 이름 있는 파이프를 이 도우미가 만들고 바이트를 표준 입출력으로 서버에 넘긴다. Node(libuv)는
//   원격 클라이언트를 거부하는 표시(PIPE_REJECT_REMOTE_CLIENTS)와 파이프의 DACL을 정하지 못한다 — 그래서 SMB(\\<PC>\pipe\…)로 온 연결은 이
//   도우미가 증명 전에 거부하고, 지금 사용자 말고는 아무도 파이프를 열지 못한다 (SDDL D:P(A;;GA;;;<사용자 SID>)).
//   표준 출력: READY 1 pipe | FAIL INUSE | FAIL INIT <까닭>, 그 뒤 OPEN <id> · DATA <id> <base64> · END <id>
//   표준 입력: DATA <id> <base64> · END <id>(쓸 것을 다 쓴 뒤 연결을 닫는다 — 클라이언트는 남은 바이트를 읽는다) · KILL <id>(바로 닫는다) · CLOSE
//   연결은 16개까지(인스턴스 16개), 버퍼 64KiB. 서버가 표준 입력을 닫거나 CLOSE를 보내면 모든 연결을 닫고 끝난다.
// - power: 절전 방지. READY 1 power, 그 뒤 AWAKE → OK awake (SetThreadExecutionState ES_CONTINUOUS|ES_SYSTEM_REQUIRED — 화면 표시 플래그는
//   쓰지 않는다), RELAX → OK idle (ES_CONTINUOUS), PING → OK <idle|awake>. 표준 입력이 끝나거나 QUIT이면 풀고 0으로 끝난다. 스레드 하나 —
//   실행 상태는 스레드마다라 같은 스레드가 읽고 정한다.
// - --probe: {"__wookServer":"probe","ok":true,"version":1,"bits":N} 한 줄 (compiledTool.ts의 확인 형식).
//
// - 컴파일: .NET Framework 4.x csc.exe (C# 5 — 문자열 보간·?.·nameof·식 본문 멤버·out var·튜플 없음). 참조: csc.rsp 기본(System.Core의 System.IO.Pipes).
// - 쓰지 않는 것: 자식 프로세스, 파일 쓰기, 레지스트리, 화면 표시 플래그(ES_DISPLAY_REQUIRED). 받은 바이트를 기록하지 않는다.
// - 콘솔 신호(Ctrl+C·Ctrl+Break)는 무시한다 — 서버와 같은 콘솔에서 떠도 신호로 먼저 죽지 않고, 서버가 표준 입력을 닫을 때 끝난다.
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace Wook.ServerHelper
{
    internal static class Program
    {
        /// <summary>앱(src/server/serverHelper.ts SERVER_HELPER_PROTOCOL)과 같아야 한다</summary>
        internal const int ProtocolVersion = 1;

        [MTAThread]
        private static int Main(string[] args)
        {
            Native.IgnoreConsoleSignals();
            AppDomain.CurrentDomain.UnhandledException += delegate(object s, UnhandledExceptionEventArgs e)
            {
                try { Console.Error.WriteLine("server helper internal error: " + (e.ExceptionObject == null ? "?" : e.ExceptionObject.GetType().Name)); } catch (Exception) { }
                Environment.Exit(70);
            };
            if (args.Length == 1 && args[0] == "--probe") return Probe();
            if (args.Length == 1 && args[0] == "power") return Power.Run();
            if (args.Length == 3 && args[0] == "pipe" && args[1] == "--name") return Pipe.Run(args[2]);
            Console.Error.WriteLine("usage: WookServerHelper.exe --probe | power | pipe --name \\\\.\\pipe\\wook-admin-<name>");
            return 2;
        }

        private static int Probe()
        {
            Out.Line("{\"__wookServer\":\"probe\",\"ok\":true,\"version\":" + ProtocolVersion.ToString(CultureInfo.InvariantCulture) +
                     ",\"bits\":" + (IntPtr.Size * 8).ToString(CultureInfo.InvariantCulture) + "}");
            return 0;
        }
    }

    /// <summary>표준 출력 한 줄씩 (ASCII, \n). 여러 스레드가 쓰므로 잠근다. 서버가 사라져 쓰지 못하면 버린다 — 표준 입력이 끝나 곧 끝난다</summary>
    internal static class Out
    {
        private static readonly object gate = new object();
        private static StreamWriter writer;

        internal static void Line(string text)
        {
            lock (gate)
            {
                try
                {
                    if (writer == null)
                    {
                        writer = new StreamWriter(Console.OpenStandardOutput(), new ASCIIEncoding(), 65536);
                        writer.NewLine = "\n";
                        writer.AutoFlush = true;
                    }
                    writer.WriteLine(text);
                }
                catch (Exception)
                {
                    // 서버가 사라졌다
                }
            }
        }

        internal static StreamReader OpenInput()
        {
            return new StreamReader(Console.OpenStandardInput(), new ASCIIEncoding(), false, 65536);
        }
    }

    // ───────────────────────── 절전 방지 (power) ─────────────────────────

    internal static class Power
    {
        private const uint ES_CONTINUOUS = 0x80000000;
        private const uint ES_SYSTEM_REQUIRED = 0x00000001;

        internal static int Run()
        {
            string state = "idle";
            Out.Line("READY " + Program.ProtocolVersion.ToString(CultureInfo.InvariantCulture) + " power");
            StreamReader stdin = Out.OpenInput();
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line == "AWAKE")
                {
                    if (Native.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) != 0)
                    {
                        state = "awake";
                        Out.Line("OK awake");
                    }
                    else Out.Line("ERR awake");
                }
                else if (line == "RELAX")
                {
                    if (Native.SetThreadExecutionState(ES_CONTINUOUS) != 0)
                    {
                        state = "idle";
                        Out.Line("OK idle");
                    }
                    else Out.Line("ERR idle");
                }
                else if (line == "PING") Out.Line("OK " + state);
                else if (line == "QUIT") break;
                else Out.Line("ERR unknown");
            }
            // 끝나기 전에 푼다 (스레드가 끝나도 풀리지만 순서를 분명히)
            Native.SetThreadExecutionState(ES_CONTINUOUS);
            return 0;
        }
    }

    // ───────────────────────── 관리 채널 파이프 (pipe) ─────────────────────────

    internal sealed class Conn
    {
        internal readonly int Id;
        internal readonly NamedPipeServerStream Stream;
        /// <summary>쓸 것 — null은 '다 쓰면 닫기'(END)</summary>
        internal readonly BlockingCollection<byte[]> Writes = new BlockingCollection<byte[]>();
        internal volatile bool Killed;
        private int finished;

        internal Conn(int id, NamedPipeServerStream stream)
        {
            Id = id;
            Stream = stream;
        }

        /// <summary>한 번만: 닫고 칸을 돌려주고, 서버가 KILL로 닫은 것이 아니면 END를 알린다</summary>
        internal void Finish()
        {
            if (Interlocked.Exchange(ref finished, 1) != 0) return;
            try { Stream.Dispose(); } catch (Exception) { }
            // 쓰기 스레드도 끝나게 (클라이언트가 먼저 끊었을 때)
            try { Writes.CompleteAdding(); } catch (InvalidOperationException) { }
            Pipe.Release(this);
            if (!Killed && !Pipe.Closing) Out.Line("END " + Id.ToString(CultureInfo.InvariantCulture));
        }
    }

    internal static class Pipe
    {
        internal const int MaxConnections = 16;
        private const int BufferBytes = 65536;
        private const uint PIPE_ACCESS_DUPLEX = 0x00000003;
        private const uint FILE_FLAG_OVERLAPPED = 0x40000000;
        private const uint FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000;
        private const uint PIPE_TYPE_BYTE = 0x00000000;
        private const uint PIPE_READMODE_BYTE = 0x00000000;
        private const uint PIPE_WAIT = 0x00000000;
        private const uint PIPE_REJECT_REMOTE_CLIENTS = 0x00000008;
        private const int ERROR_ACCESS_DENIED = 5;
        private const int ERROR_PIPE_BUSY = 231;

        private static readonly Regex NameRe = new Regex("^\\\\\\\\\\.\\\\pipe\\\\wook-admin-[A-Za-z0-9._-]{1,200}$", RegexOptions.CultureInvariant);
        private static readonly Regex IdRe = new Regex("^[0-9]{1,9}$", RegexOptions.CultureInvariant);
        private static readonly object gate = new object();
        private static readonly Dictionary<int, Conn> conns = new Dictionary<int, Conn>();
        /// <summary>파이프 인스턴스 칸 — 듣는 것과 연결된 것을 합쳐 16개 (인스턴스를 만들기 전에 잡고, 닫을 때 돌려준다)</summary>
        private static readonly Semaphore slots = new Semaphore(MaxConnections, MaxConnections);
        private static string pipeName;
        private static Native.SECURITY_ATTRIBUTES security;
        private static NamedPipeServerStream listening;
        private static int nextId;
        private static volatile bool closing;

        internal static bool Closing { get { return closing; } }

        internal static int Run(string name)
        {
            if (!NameRe.IsMatch(name))
            {
                Out.Line("FAIL INIT bad_name");
                return 3;
            }
            pipeName = name;
            string sid;
            try { sid = WindowsIdentity.GetCurrent().User.Value; }
            catch (Exception)
            {
                Out.Line("FAIL INIT sid");
                return 3;
            }
            // 지금 사용자에게만 모두 — 상속하지 않는다(P). 다른 계정·Everyone·Anonymous는 열지도 인스턴스를 만들지도 못한다
            IntPtr sd;
            uint sdSize;
            if (!Native.ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;" + sid + ")", 1, out sd, out sdSize))
            {
                Out.Line("FAIL INIT sddl_" + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture));
                return 3;
            }
            security = new Native.SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES));
            security.lpSecurityDescriptor = sd;
            security.bInheritHandle = 0;

            slots.WaitOne();
            int err;
            SafePipeHandle first = Create(true, out err);
            if (first == null)
            {
                slots.Release();
                // 첫 인스턴스로 만들지 못함 = 그 이름을 이미 누가 쓴다 (FILE_FLAG_FIRST_PIPE_INSTANCE는 ACCESS_DENIED, 인스턴스가 다 찼으면 PIPE_BUSY)
                if (err == ERROR_ACCESS_DENIED || err == ERROR_PIPE_BUSY) Out.Line("FAIL INUSE");
                else Out.Line("FAIL INIT create_" + err.ToString(CultureInfo.InvariantCulture));
                return 4;
            }
            Thread accept = new Thread(delegate() { AcceptLoop(first); });
            accept.IsBackground = true;
            accept.Name = "accept";
            Out.Line("READY " + Program.ProtocolVersion.ToString(CultureInfo.InvariantCulture) + " pipe");
            accept.Start();

            StreamReader stdin = Out.OpenInput();
            string line;
            while ((line = stdin.ReadLine()) != null)
            {
                if (line == "CLOSE") break;
                Command(line);
            }
            Shutdown();
            return 0;
        }

        private static SafePipeHandle Create(bool first, out int err)
        {
            uint open = PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0);
            uint mode = PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS;
            SafePipeHandle h = Native.CreateNamedPipeW(pipeName, open, mode, MaxConnections, BufferBytes, BufferBytes, 0, ref security);
            err = Marshal.GetLastWin32Error();
            if (h == null || h.IsInvalid)
            {
                if (h != null) h.Dispose();
                return null;
            }
            err = 0;
            return h;
        }

        /// <summary>듣는 인스턴스 하나에서 연결을 받고, 다음 인스턴스를 만든다 (칸이 없으면 하나가 닫힐 때까지 기다린다)</summary>
        private static void AcceptLoop(SafePipeHandle handle)
        {
            SafePipeHandle h = handle;
            while (!closing)
            {
                NamedPipeServerStream s;
                try { s = new NamedPipeServerStream(PipeDirection.InOut, true, false, h); }
                catch (Exception)
                {
                    h.Dispose();
                    slots.Release();
                    return;
                }
                lock (gate) listening = s;
                bool connected = false;
                try
                {
                    s.WaitForConnection();
                    connected = true;
                }
                catch (Exception)
                {
                    // 닫는 중이거나, 클라이언트가 붙자마자 끊었다 — 이 인스턴스는 버리고 새로 만든다
                }
                lock (gate) listening = null;
                if (!connected || closing)
                {
                    try { s.Dispose(); } catch (Exception) { }
                    slots.Release();
                    if (closing) return;
                }
                else
                {
                    Conn c;
                    lock (gate)
                    {
                        nextId++;
                        c = new Conn(nextId, s);
                        conns[c.Id] = c;
                    }
                    Out.Line("OPEN " + c.Id.ToString(CultureInfo.InvariantCulture));
                    Thread reader = new Thread(delegate() { ReadLoop(c); });
                    reader.IsBackground = true;
                    reader.Start();
                    Thread writer = new Thread(delegate() { WriteLoop(c); });
                    writer.IsBackground = true;
                    writer.Start();
                }
                // 다음 인스턴스 — 칸이 날 때까지 (닫는 중이면 그만)
                while (!slots.WaitOne(200))
                {
                    if (closing) return;
                }
                if (closing)
                {
                    slots.Release();
                    return;
                }
                int err;
                h = null;
                while (h == null)
                {
                    h = Create(false, out err);
                    if (h != null) break;
                    if (closing)
                    {
                        slots.Release();
                        return;
                    }
                    Thread.Sleep(100);
                }
            }
        }

        private static void ReadLoop(Conn c)
        {
            byte[] buf = new byte[BufferBytes];
            for (;;)
            {
                int n;
                try { n = c.Stream.Read(buf, 0, buf.Length); }
                catch (Exception) { n = 0; }
                if (n <= 0 || c.Killed) break;
                Out.Line("DATA " + c.Id.ToString(CultureInfo.InvariantCulture) + " " + Convert.ToBase64String(buf, 0, n));
            }
            c.Finish();
        }

        private static void WriteLoop(Conn c)
        {
            try
            {
                foreach (byte[] chunk in c.Writes.GetConsumingEnumerable())
                {
                    if (chunk == null || c.Killed) break;
                    c.Stream.Write(chunk, 0, chunk.Length);
                }
            }
            catch (Exception)
            {
                // 클라이언트가 끊었거나 KILL로 닫았다
            }
            // END(또는 쓰기 실패) — 핸들을 닫는다. 이미 쓴 바이트는 파이프에 남아 클라이언트가 읽고, 그다음 끊김을 본다
            c.Finish();
        }

        private static void Command(string line)
        {
            int sp = line.IndexOf(' ');
            if (sp <= 0) return;
            string verb = line.Substring(0, sp);
            string rest = line.Substring(sp + 1);
            string idText = rest;
            string payload = null;
            int sp2 = rest.IndexOf(' ');
            if (sp2 > 0)
            {
                idText = rest.Substring(0, sp2);
                payload = rest.Substring(sp2 + 1);
            }
            if (!IdRe.IsMatch(idText)) return;
            int id = int.Parse(idText, NumberStyles.None, CultureInfo.InvariantCulture);
            Conn c;
            lock (gate)
            {
                if (!conns.TryGetValue(id, out c)) return;
            }
            if (verb == "DATA" && payload != null)
            {
                byte[] bytes;
                try { bytes = Convert.FromBase64String(payload); }
                catch (FormatException) { return; }
                try { c.Writes.Add(bytes); } catch (InvalidOperationException) { }
            }
            else if (verb == "END" && payload == null)
            {
                try
                {
                    c.Writes.Add(null);
                    c.Writes.CompleteAdding();
                }
                catch (InvalidOperationException) { }
            }
            else if (verb == "KILL" && payload == null)
            {
                c.Killed = true;
                try { c.Writes.CompleteAdding(); } catch (InvalidOperationException) { }
                c.Finish();
            }
        }

        internal static void Release(Conn c)
        {
            lock (gate) conns.Remove(c.Id);
            slots.Release();
        }

        private static void Shutdown()
        {
            closing = true;
            List<Conn> all;
            lock (gate)
            {
                all = new List<Conn>(conns.Values);
                if (listening != null)
                {
                    try { listening.Dispose(); } catch (Exception) { }
                }
            }
            foreach (Conn c in all)
            {
                c.Killed = true;
                try { c.Writes.CompleteAdding(); } catch (InvalidOperationException) { }
                c.Finish();
            }
        }
    }

    internal static class Native
    {
        [StructLayout(LayoutKind.Sequential)]
        internal struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern SafePipeHandle CreateNamedPipeW(string lpName, uint dwOpenMode, uint dwPipeMode, uint nMaxInstances, uint nOutBufferSize, uint nInBufferSize, uint nDefaultTimeOut, ref SECURITY_ATTRIBUTES lpSecurityAttributes);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string StringSecurityDescriptor, uint StringSDRevision, out IntPtr SecurityDescriptor, out uint SecurityDescriptorSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        internal static extern uint SetThreadExecutionState(uint esFlags);

        internal delegate bool ConsoleCtrlHandler(uint ctrlType);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);

        /// <summary>처리기를 GC가 거두지 않게 붙들어 둔다</summary>
        private static ConsoleCtrlHandler ctrlHandler;

        /// <summary>Ctrl+C(0)·Ctrl+Break(1)는 무시한다 — 창 닫기·로그오프·종료는 기본 처리(끝남)로 둔다</summary>
        internal static void IgnoreConsoleSignals()
        {
            ctrlHandler = delegate(uint ctrlType) { return ctrlType == 0 || ctrlType == 1; };
            try { SetConsoleCtrlHandler(ctrlHandler, true); } catch (Exception) { }
        }
    }
}
