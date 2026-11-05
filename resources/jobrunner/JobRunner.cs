// 욱채 Job Object 러너 (ARCHITECTURE.md 13장 / 기획서 CTL-03·CTL-07·CTL-11, 15.5 하위 프로세스 종료)
//
// 사용법: WookJobRunner.exe [--stdin-file <파일>] [--verbatim-args] -- <실행 파일> <인자...>
//         WookJobRunner.exe --probe            (설치 확인: 작업 개체 생성·구조체 크기 점검, 프로토콜 버전 보고)
//
// --verbatim-args: 자식 명령줄을 만들 때 인자를 다시 인용하지 않고 공백으로만 잇는다. cmd.exe /d /s /c "<명령>" 전용
//                  (cmd는 역슬래시 이스케이프를 모르므로 일반 인용(\")이면 명령 속 큰따옴표가 깨진다 — 프로토콜 2)
//
// - Job Object(KILL_ON_JOB_CLOSE)를 만들고 자식을 CREATE_SUSPENDED로 띄워 job에 넣은 뒤 재개한다.
// - 자식 stdout·stderr를 그대로(바이트 단위) 자기 stdout·stderr로 중계한다.
//   제어 줄은 항상 줄 경계에서 stdout에 쓴다:
//     {"__wookRunner":"started","pid":N}
//     {"__wookRunner":"exit","code":C,"leftover":L,"remaining":R}
//     {"__wookRunner":"terminated","remaining":R}
// - stdin은 제어 채널: KILL 줄 또는 EOF(앱 종료) → job 전체 종료, 남은 프로세스 0까지 최대 2초 대기 → terminated.
//   (앱 쪽 종료 확인 제한 2.8초보다 짧게 끝나야 앱이 러너를 강제 종료하지 않고 남은 수를 그대로 받는다, CTL-03)
// - 러너가 강제 종료돼도 job 핸들이 닫히며 커널이 job 안 프로세스를 모두 종료한다.
//
// OS 기본 .NET Framework csc.exe(C# 5)로 컴파일한다:
// 문자열 보간·nameof·?.·식 본문 멤버·out var·자동 속성 초기화를 쓰지 않는다.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

[assembly: System.Reflection.AssemblyTitle("WookJobRunner")]
[assembly: System.Reflection.AssemblyProduct("Wook")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace Wook.JobRunner
{
    internal static class NativeMethods
    {
        public const uint CREATE_SUSPENDED = 0x00000004;
        public const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
        public const int STARTF_USESTDHANDLES = 0x00000100;
        public const uint HANDLE_FLAG_INHERIT = 0x00000001;
        public const uint INFINITE = 0xFFFFFFFF;
        public const uint WAIT_OBJECT_0 = 0x00000000;
        public const uint RESUME_FAILED = 0xFFFFFFFF;
        public const int ERROR_MORE_DATA = 234;

        public const int JobObjectBasicAccountingInformation = 1;
        public const int JobObjectBasicProcessIdList = 3;
        public const int JobObjectExtendedLimitInformation = 9;
        public const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
        public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

        public static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = new IntPtr(0x00020002);

        public const uint CTRL_C_EVENT = 0;
        public const uint CTRL_BREAK_EVENT = 1;

        [StructLayout(LayoutKind.Sequential)]
        public struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            public int bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct STARTUPINFO
        {
            public int cb;
            public IntPtr lpReserved;
            public IntPtr lpDesktop;
            public IntPtr lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct STARTUPINFOEX
        {
            public STARTUPINFO StartupInfo;
            public IntPtr lpAttributeList;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        // SIZE_T·ULONG_PTR는 UIntPtr로 둬서 x86·x64 모두 실제 구조체 배치와 같게 한다
        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
        {
            public long TotalUserTime;
            public long TotalKernelTime;
            public long ThisPeriodTotalUserTime;
            public long ThisPeriodTotalKernelTime;
            public uint TotalPageFaultCount;
            public uint TotalProcesses;
            public uint ActiveProcesses;
            public uint TotalTerminatedProcesses;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        public delegate bool ConsoleCtrlHandler(uint ctrlType);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfo);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool QueryInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfo, out uint lpReturnLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe, ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool CloseHandle(IntPtr hObject);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        public static extern bool CreateProcessW(
            string lpApplicationName,
            StringBuilder lpCommandLine,
            IntPtr lpProcessAttributes,
            IntPtr lpThreadAttributes,
            bool bInheritHandles,
            uint dwCreationFlags,
            IntPtr lpEnvironment,
            string lpCurrentDirectory,
            ref STARTUPINFOEX lpStartupInfo,
            out PROCESS_INFORMATION lpProcessInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint ResumeThread(IntPtr hThread);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern uint WaitForMultipleObjects(uint nCount, IntPtr[] lpHandles, bool bWaitAll, uint dwMilliseconds);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

        [DllImport("kernel32.dll", SetLastError = true)]
        public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);

        [DllImport("kernel32.dll")]
        public static extern IntPtr GetCommandLineW();

        [DllImport("shell32.dll", SetLastError = true)]
        public static extern IntPtr CommandLineToArgvW(IntPtr lpCmdLine, out int pNumArgs);

        [DllImport("kernel32.dll")]
        public static extern IntPtr LocalFree(IntPtr hMem);
    }

    /// <summary>시작 단계 실패 (자식을 띄우기 전·직후)</summary>
    internal sealed class StartException : Exception
    {
        public StartException(string message) : base(message) { }
    }

    internal sealed class UsageException : Exception
    {
        public UsageException(string message) : base(message) { }
    }

    /// <summary>러너 자신의 stdout·stderr. 중계 바이트와 러너 줄이 섞이지 않게 한 잠금으로 쓴다</summary>
    internal sealed class Output
    {
        private readonly Stream stream;
        private readonly object gate = new object();
        private bool atLineStart = true;
        private bool closed;

        public Output(Stream stream)
        {
            this.stream = stream;
        }

        public void Relay(byte[] buffer, int count)
        {
            if (count <= 0) return;
            lock (gate)
            {
                if (closed) return;
                stream.Write(buffer, 0, count);
                stream.Flush();
                atLineStart = buffer[count - 1] == (byte)'\n';
            }
        }

        public void WriteLine(string text)
        {
            Write(text, false);
        }

        /// <summary>마지막 줄을 쓰고 닫는다. 이후 늦게 온 중계 바이트는 버린다 (제어 줄 뒤에 출력이 오지 않게)</summary>
        public void WriteLastLine(string text)
        {
            Write(text, true);
        }

        public void Close()
        {
            lock (gate)
            {
                closed = true;
            }
        }

        private void Write(string text, bool last)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text + "\n");
            lock (gate)
            {
                if (closed) return;
                if (!atLineStart) stream.WriteByte((byte)'\n');
                stream.Write(bytes, 0, bytes.Length);
                stream.Flush();
                atLineStart = true;
                if (last) closed = true;
            }
        }
    }

    /// <summary>자식 출력 파이프 → 러너 출력. 모든 쓰기 끝(자식·후손)이 닫히면 끝난다</summary>
    internal sealed class Relay
    {
        private readonly IntPtr handle;
        private readonly Output target;
        private readonly Thread thread;

        public Relay(IntPtr handle, Output target, string name)
        {
            this.handle = handle;
            this.target = target;
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.Name = "relay-" + name;
        }

        public void Start()
        {
            thread.Start();
        }

        public bool Join(int milliseconds)
        {
            return thread.Join(milliseconds < 0 ? 0 : milliseconds);
        }

        private void Run()
        {
            byte[] buffer = new byte[65536];
            try
            {
                using (FileStream source = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read, 1, false))
                {
                    while (true)
                    {
                        // 파이프가 끊기면(ERROR_BROKEN_PIPE) FileStream은 0을 돌려준다
                        int n = source.Read(buffer, 0, buffer.Length);
                        if (n <= 0) return;
                        target.Relay(buffer, n);
                    }
                }
            }
            catch (Exception e)
            {
                Program.Diagnostic("출력 중계 오류 (" + thread.Name + "): " + e.Message);
            }
        }
    }

    internal sealed class PipePair
    {
        public IntPtr ChildEnd;
        public IntPtr ParentEnd;

        /// <param name="childWrites">true면 자식이 쓰는 파이프(stdout·stderr), false면 자식이 읽는 파이프(stdin)</param>
        public static PipePair Create(bool childWrites, uint size)
        {
            NativeMethods.SECURITY_ATTRIBUTES sa = new NativeMethods.SECURITY_ATTRIBUTES();
            sa.nLength = Marshal.SizeOf(typeof(NativeMethods.SECURITY_ATTRIBUTES));
            sa.bInheritHandle = 1;
            IntPtr read;
            IntPtr write;
            if (!NativeMethods.CreatePipe(out read, out write, ref sa, size))
            {
                throw Program.Win32Failure("파이프를 만들지 못했습니다");
            }
            PipePair pair = new PipePair();
            pair.ChildEnd = childWrites ? write : read;
            pair.ParentEnd = childWrites ? read : write;
            // 러너 쪽 끝이 자식에게 새면 EOF가 전달되지 않는다
            if (!NativeMethods.SetHandleInformation(pair.ParentEnd, NativeMethods.HANDLE_FLAG_INHERIT, 0))
            {
                throw Program.Win32Failure("파이프 상속 설정을 바꾸지 못했습니다");
            }
            return pair;
        }

        public void CloseChildEnd()
        {
            if (ChildEnd != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(ChildEnd);
                ChildEnd = IntPtr.Zero;
            }
        }

        public IntPtr TakeParentEnd()
        {
            IntPtr h = ParentEnd;
            ParentEnd = IntPtr.Zero;
            return h;
        }

        public void CloseParentEnd()
        {
            if (ParentEnd != IntPtr.Zero)
            {
                NativeMethods.CloseHandle(ParentEnd);
                ParentEnd = IntPtr.Zero;
            }
        }
    }

    /// <summary>MSVCRT·CommandLineToArgvW 규칙으로 자식 명령줄을 만든다 (verbatim이면 인자는 그대로 잇기만 한다)</summary>
    internal static class CommandLine
    {
        public static string Build(string exe, string[] args, bool verbatim)
        {
            StringBuilder sb = new StringBuilder();
            // argv[0]은 따옴표만 해석되므로(역슬래시 규칙 없음) 감싸기만 한다. 경로에는 따옴표가 올 수 없다
            sb.Append('"').Append(exe).Append('"');
            for (int i = 0; i < args.Length; i++)
            {
                sb.Append(' ');
                if (verbatim) sb.Append(args[i]);
                else AppendArgument(sb, args[i]);
            }
            return sb.ToString();
        }

        public static void AppendArgument(StringBuilder sb, string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                sb.Append(arg);
                return;
            }
            sb.Append('"');
            int i = 0;
            while (i < arg.Length)
            {
                int backslashes = 0;
                while (i < arg.Length && arg[i] == '\\')
                {
                    backslashes++;
                    i++;
                }
                if (i == arg.Length)
                {
                    // 닫는 따옴표 앞 역슬래시는 두 배로
                    sb.Append('\\', backslashes * 2);
                    break;
                }
                if (arg[i] == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(arg[i]);
                }
                i++;
            }
            sb.Append('"');
        }
    }

    internal sealed class Options
    {
        public string StdinFile;
        public bool Probe;
        public bool VerbatimArgs;
        public string Exe;
        public string[] Args;

        public const string Usage = "사용법: WookJobRunner.exe [--stdin-file <파일>] [--verbatim-args] -- <실행 파일> <인자...>";

        public static Options Parse(string[] argv)
        {
            Options o = new Options();
            int i = 0;
            bool separator = false;
            while (i < argv.Length)
            {
                string a = argv[i];
                if (a == "--")
                {
                    separator = true;
                    i++;
                    break;
                }
                if (a == "--stdin-file")
                {
                    if (i + 1 >= argv.Length) throw new UsageException("--stdin-file 뒤에 파일 경로가 없습니다. " + Usage);
                    if (o.StdinFile != null) throw new UsageException("--stdin-file을 두 번 줬습니다. " + Usage);
                    o.StdinFile = argv[i + 1];
                    i += 2;
                    continue;
                }
                if (a == "--probe")
                {
                    o.Probe = true;
                    i++;
                    continue;
                }
                if (a == "--verbatim-args")
                {
                    o.VerbatimArgs = true;
                    i++;
                    continue;
                }
                throw new UsageException("알 수 없는 옵션입니다: " + a + ". " + Usage);
            }
            if (o.Probe)
            {
                if (separator || o.StdinFile != null || o.VerbatimArgs) throw new UsageException("--probe는 단독으로만 씁니다");
                return o;
            }
            if (!separator || i >= argv.Length) throw new UsageException("실행할 파일이 없습니다. " + Usage);
            o.Exe = argv[i];
            if (o.Exe.Length == 0) throw new UsageException("실행 파일 경로가 비어 있습니다. " + Usage);
            o.Args = new string[argv.Length - i - 1];
            Array.Copy(argv, i + 1, o.Args, 0, o.Args.Length);
            return o;
        }
    }

    internal static class Program
    {
        /// <summary>앱(compileRunner.ts RUNNER_PROTOCOL_VERSION)과 같아야 한다. 2 = --verbatim-args</summary>
        private const int ProtocolVersion = 2;
        private const int ExitUsage = 2;
        private const int ExitProbeFailed = 3;
        private const int ExitTerminated = 1;
        private const int ExitStartFailed = 127;
        private const uint KilledExitCode = 1;
        /// <summary>
        /// job 종료 후 남은 프로세스가 0이 될 때까지 기다리는 최대 시간 (ARCHITECTURE 13장).
        /// KillWaitMs + KillDrainMs는 앱 쪽 종료 확인 제한(turns.ts 2.8초)보다 짧아야 한다 — 늦으면 앱이 러너째 강제 종료해 남은 수를 잃는다 (CTL-03)
        /// </summary>
        private const int KillWaitMs = 2000;
        /// <summary>정상 종료 뒤 남은 출력을 다 옮길 때까지 기다리는 최대 시간</summary>
        private const int ExitDrainMs = 2000;
        private const int KillDrainMs = 300;
        private const uint StdoutPipeSize = 65536;
        private const uint StdinPipeSize = 65536;

        private static Output stdoutOut;
        private static Output stderrOut;
        private static readonly ManualResetEvent killRequested = new ManualResetEvent(false);
        private static readonly ManualResetEvent finished = new ManualResetEvent(false);
        private static NativeMethods.ConsoleCtrlHandler ctrlHandler; // GC가 수거하지 않게 붙잡아 둔다
        private static IntPtr job = IntPtr.Zero;
        private static volatile bool childStarted;
        private static int finalWritten;

        [MTAThread]
        private static int Main()
        {
            stdoutOut = new Output(Console.OpenStandardOutput());
            stderrOut = new Output(Console.OpenStandardError());
            try
            {
                Options opt = Options.Parse(GetArguments());
                if (opt.Probe) return Probe();
                return Run(opt);
            }
            catch (UsageException e)
            {
                FailStart(e.Message);
                return ExitUsage;
            }
            catch (Exception e)
            {
                // 예상하지 못한 오류여도 job을 정리하고 마지막 제어 줄을 반드시 쓴다 (앱이 무한 대기하지 않게)
                Diagnostic("내부 오류: " + e);
                if (job != IntPtr.Zero)
                {
                    NativeMethods.TerminateJobObject(job, KilledExitCode);
                    WaitJobEmpty(KillWaitMs);
                }
                if (childStarted) WriteFinal(TerminatedJson(ActiveProcesses()));
                else WriteFinal(ExitJson(-1, 0, 0));
                return ExitStartFailed;
            }
        }

        private static int Run(Options opt)
        {
            // 같은 콘솔의 Ctrl+C·Ctrl+Break(예: 하위 도구의 GenerateConsoleCtrlEvent)로 러너가 먼저 죽으면 트리가 통째로 끊긴다.
            // NULL 처리기가 아닌 처리기는 자식에게 상속되지 않으므로 자식의 Ctrl+C 동작은 그대로다.
            ctrlHandler = OnConsoleCtrl;
            if (!NativeMethods.SetConsoleCtrlHandler(ctrlHandler, true))
            {
                Diagnostic("콘솔 제어 처리기를 등록하지 못했습니다 (오류 " + Marshal.GetLastWin32Error() + ")");
            }

            // 제어 채널을 먼저 연다: 시작 도중 온 KILL·EOF도 놓치지 않는다
            Thread control = new Thread(ControlLoop);
            control.IsBackground = true;
            control.Name = "control";
            control.Start();

            byte[] input = null;
            if (opt.StdinFile != null)
            {
                try
                {
                    input = File.ReadAllBytes(opt.StdinFile);
                }
                catch (Exception e)
                {
                    FailStart("표준 입력 파일을 읽지 못했습니다: " + opt.StdinFile + " (" + e.Message + ")");
                    return ExitStartFailed;
                }
            }

            PipePair inPipe = null;
            PipePair outPipe = null;
            PipePair errPipe = null;
            NativeMethods.PROCESS_INFORMATION pi = new NativeMethods.PROCESS_INFORMATION();
            bool created = false;
            try
            {
                job = CreateKillOnCloseJob();
                inPipe = PipePair.Create(false, StdinPipeSize);
                outPipe = PipePair.Create(true, StdoutPipeSize);
                errPipe = PipePair.Create(true, StdoutPipeSize);
                if (killRequested.WaitOne(0))
                {
                    WriteFinal(TerminatedJson(0));
                    return ExitTerminated;
                }
                pi = CreateSuspended(opt, inPipe.ChildEnd, outPipe.ChildEnd, errPipe.ChildEnd);
                created = true;
                if (!NativeMethods.AssignProcessToJobObject(job, pi.hProcess))
                {
                    throw Win32Failure("자식 프로세스를 작업 개체에 넣지 못했습니다");
                }
            }
            catch (StartException e)
            {
                if (created)
                {
                    NativeMethods.TerminateProcess(pi.hProcess, KilledExitCode);
                    NativeMethods.CloseHandle(pi.hThread);
                    NativeMethods.CloseHandle(pi.hProcess);
                }
                FailStart(e.Message);
                return ExitStartFailed;
            }
            finally
            {
                // 자식 쪽 끝은 자식이 물려받았으므로 러너는 닫는다 (그래야 자식·후손이 끝날 때 EOF가 온다)
                if (inPipe != null) inPipe.CloseChildEnd();
                if (outPipe != null) outPipe.CloseChildEnd();
                if (errPipe != null) errPipe.CloseChildEnd();
                if (!created)
                {
                    if (inPipe != null) inPipe.CloseParentEnd();
                    if (outPipe != null) outPipe.CloseParentEnd();
                    if (errPipe != null) errPipe.CloseParentEnd();
                }
            }

            Relay outRelay = new Relay(outPipe.TakeParentEnd(), stdoutOut, "stdout");
            Relay errRelay = new Relay(errPipe.TakeParentEnd(), stderrOut, "stderr");
            outRelay.Start();
            errRelay.Start();
            StartStdinFeeder(inPipe.TakeParentEnd(), input);

            // 자식이 아직 멈춰 있으므로 started 줄이 자식 출력보다 항상 앞선다
            stdoutOut.WriteLine(StartedJson(pi.dwProcessId));
            childStarted = true;

            if (killRequested.WaitOne(0))
            {
                NativeMethods.CloseHandle(pi.hThread);
                return FinishKill(outRelay, errRelay);
            }
            if (NativeMethods.ResumeThread(pi.hThread) == NativeMethods.RESUME_FAILED)
            {
                int err = Marshal.GetLastWin32Error();
                Diagnostic("자식 프로세스를 재개하지 못했습니다: " + Win32Message(err));
                NativeMethods.CloseHandle(pi.hThread);
                TerminateJob();
                WaitJobEmpty(KillWaitMs);
                DrainRelays(outRelay, errRelay, KillDrainMs);
                WriteFinal(ExitJson(-1, 0, ActiveProcesses()));
                return ExitStartFailed;
            }
            NativeMethods.CloseHandle(pi.hThread);

            IntPtr[] handles = new IntPtr[] { pi.hProcess, killRequested.SafeWaitHandle.DangerousGetHandle() };
            // 둘 다 신호 상태면 낮은 번호(자식 종료)가 먼저 — 정상 종료 정보를 우선한다
            uint which = NativeMethods.WaitForMultipleObjects(2, handles, false, NativeMethods.INFINITE);
            if (which == NativeMethods.WAIT_OBJECT_0)
            {
                return FinishExit(pi.hProcess, pi.dwProcessId, outRelay, errRelay);
            }
            if (which == NativeMethods.WAIT_OBJECT_0 + 1)
            {
                return FinishKill(outRelay, errRelay);
            }
            throw Win32Failure("자식 프로세스 대기에 실패했습니다");
        }

        private static int FinishExit(IntPtr hProcess, int childPid, Relay outRelay, Relay errRelay)
        {
            uint rawCode;
            long code;
            if (NativeMethods.GetExitCodeProcess(hProcess, out rawCode))
            {
                code = rawCode;
            }
            else
            {
                Diagnostic("자식 종료 코드를 읽지 못했습니다: " + Win32Message(Marshal.GetLastWin32Error()));
                code = -1;
            }
            // 자식은 끝났는데 job에 남은 후손(개발 서버 등)은 정리 대상이다
            int leftover = CountJobProcessesExcept(childPid);
            int active = ActiveProcesses();
            if (leftover != 0 || active != 0)
            {
                TerminateJob();
                WaitJobEmpty(KillWaitMs);
            }
            // 후손이 파이프를 물고 있었다면 위에서 정리된 뒤에야 EOF가 온다
            DrainRelays(outRelay, errRelay, ExitDrainMs);
            int remaining = ActiveProcesses();
            WriteFinal(ExitJson(code, leftover, remaining));
            return unchecked((int)code);
        }

        private static int FinishKill(Relay outRelay, Relay errRelay)
        {
            TerminateJob();
            WaitJobEmpty(KillWaitMs);
            DrainRelays(outRelay, errRelay, KillDrainMs);
            WriteFinal(TerminatedJson(ActiveProcesses()));
            return ExitTerminated;
        }

        private static void TerminateJob()
        {
            if (!NativeMethods.TerminateJobObject(job, KilledExitCode))
            {
                Diagnostic("작업 개체를 종료하지 못했습니다: " + Win32Message(Marshal.GetLastWin32Error()));
            }
        }

        private static bool WaitJobEmpty(int milliseconds)
        {
            Stopwatch sw = Stopwatch.StartNew();
            while (true)
            {
                int active = ActiveProcesses();
                if (active == 0) return true;
                if (active < 0 || sw.ElapsedMilliseconds >= milliseconds) return false;
                Thread.Sleep(10);
            }
        }

        private static void DrainRelays(Relay a, Relay b, int milliseconds)
        {
            Stopwatch sw = Stopwatch.StartNew();
            a.Join(milliseconds);
            b.Join(milliseconds - (int)sw.ElapsedMilliseconds);
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            IntPtr h = NativeMethods.CreateJobObjectW(IntPtr.Zero, null);
            if (h == IntPtr.Zero) throw Win32Failure("작업 개체(Job Object)를 만들지 못했습니다");
            NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            // DIE_ON_UNHANDLED_EXCEPTION: 후손이 죽을 때 오류 보고 창이 떠서 멈춘 채 남지 않게 한다
            info.BasicLimitInformation.LimitFlags =
                NativeMethods.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | NativeMethods.JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
            int size = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(info, buf, false);
                if (!NativeMethods.SetInformationJobObject(h, NativeMethods.JobObjectExtendedLimitInformation, buf, (uint)size))
                {
                    int err = Marshal.GetLastWin32Error();
                    NativeMethods.CloseHandle(h);
                    throw new StartException("작업 개체 제한을 설정하지 못했습니다: " + Win32Message(err));
                }
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
            return h;
        }

        private static NativeMethods.PROCESS_INFORMATION CreateSuspended(Options opt, IntPtr hIn, IntPtr hOut, IntPtr hErr)
        {
            IntPtr attrList = IntPtr.Zero;
            IntPtr handleArray = IntPtr.Zero;
            bool attrInitialized = false;
            try
            {
                // 자식에게 세 파이프 끝만 물려준다 (러너 자신의 stdio 핸들이 새지 않게)
                IntPtr size = IntPtr.Zero;
                NativeMethods.InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
                if (size == IntPtr.Zero) throw Win32Failure("프로세스 속성 목록 크기를 구하지 못했습니다");
                attrList = Marshal.AllocHGlobal(size);
                if (!NativeMethods.InitializeProcThreadAttributeList(attrList, 1, 0, ref size))
                {
                    throw Win32Failure("프로세스 속성 목록을 만들지 못했습니다");
                }
                attrInitialized = true;
                handleArray = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleArray, 0, hIn);
                Marshal.WriteIntPtr(handleArray, IntPtr.Size, hOut);
                Marshal.WriteIntPtr(handleArray, IntPtr.Size * 2, hErr);
                if (!NativeMethods.UpdateProcThreadAttribute(attrList, 0, NativeMethods.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                        handleArray, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
                {
                    throw Win32Failure("상속할 핸들 목록을 설정하지 못했습니다");
                }

                NativeMethods.STARTUPINFOEX si = new NativeMethods.STARTUPINFOEX();
                si.StartupInfo.cb = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFOEX));
                si.StartupInfo.dwFlags = NativeMethods.STARTF_USESTDHANDLES;
                si.StartupInfo.hStdInput = hIn;
                si.StartupInfo.hStdOutput = hOut;
                si.StartupInfo.hStdError = hErr;
                si.lpAttributeList = attrList;

                string commandLine = CommandLine.Build(opt.Exe, opt.Args, opt.VerbatimArgs);
                StringBuilder cmd = new StringBuilder(commandLine, commandLine.Length + 1);
                // 절대 경로면 검색 없이 그 파일을 실행한다 (현재 폴더·러너 폴더에서 같은 이름을 찾지 않게)
                string application = IsRooted(opt.Exe) ? opt.Exe : null;
                NativeMethods.PROCESS_INFORMATION pi;
                if (!NativeMethods.CreateProcessW(application, cmd, IntPtr.Zero, IntPtr.Zero, true,
                        NativeMethods.CREATE_SUSPENDED | NativeMethods.EXTENDED_STARTUPINFO_PRESENT,
                        IntPtr.Zero, null, ref si, out pi))
                {
                    throw Win32Failure("실행하지 못했습니다: " + opt.Exe);
                }
                return pi;
            }
            finally
            {
                if (attrInitialized) NativeMethods.DeleteProcThreadAttributeList(attrList);
                if (attrList != IntPtr.Zero) Marshal.FreeHGlobal(attrList);
                if (handleArray != IntPtr.Zero) Marshal.FreeHGlobal(handleArray);
            }
        }

        private static bool IsRooted(string path)
        {
            try
            {
                return Path.IsPathRooted(path);
            }
            catch (ArgumentException)
            {
                // 경로에 쓸 수 없는 문자가 있으면 CreateProcess가 직접 판단하게 둔다
                return false;
            }
        }

        private static void StartStdinFeeder(IntPtr handle, byte[] data)
        {
            if (data == null || data.Length == 0)
            {
                NativeMethods.CloseHandle(handle);
                return;
            }
            Thread t = new Thread(() =>
            {
                try
                {
                    using (FileStream s = new FileStream(new SafeFileHandle(handle, true), FileAccess.Write, 1, false))
                    {
                        s.Write(data, 0, data.Length);
                    }
                }
                catch (IOException)
                {
                    // 자식이 표준 입력을 다 읽기 전에 닫거나 끝난 경우: 자식의 선택이므로 오류로 알리지 않는다
                }
                catch (Exception e)
                {
                    Diagnostic("표준 입력 전달 오류: " + e.Message);
                }
            });
            t.IsBackground = true;
            t.Name = "stdin";
            t.Start();
        }

        private static void ControlLoop()
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                byte[] buffer = new byte[512];
                StringBuilder line = new StringBuilder();
                while (true)
                {
                    int n = input.Read(buffer, 0, buffer.Length);
                    if (n <= 0) break;
                    for (int i = 0; i < n; i++)
                    {
                        char c = (char)buffer[i];
                        if (c == '\n')
                        {
                            if (line.ToString().Trim() == "KILL")
                            {
                                killRequested.Set();
                                return;
                            }
                            line.Length = 0;
                        }
                        else if (line.Length < 256)
                        {
                            line.Append(c);
                        }
                    }
                }
            }
            catch (Exception e)
            {
                Diagnostic("제어 채널을 읽지 못했습니다: " + e.Message);
            }
            // EOF·읽기 실패 = 앱이 사라졌다 → 트리를 남기지 않는다
            killRequested.Set();
        }

        private static bool OnConsoleCtrl(uint ctrlType)
        {
            if (ctrlType == NativeMethods.CTRL_C_EVENT || ctrlType == NativeMethods.CTRL_BREAK_EVENT) return true;
            // 닫기·로그오프·종료: 처리기가 끝나면 OS가 러너를 끝내므로 그 전에 정리와 마지막 줄을 마친다
            killRequested.Set();
            finished.WaitOne(KillWaitMs + KillDrainMs + 500);
            return true;
        }

        private static int Probe()
        {
            bool is64 = IntPtr.Size == 8;
            int extSize = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            int siSize = Marshal.SizeOf(typeof(NativeMethods.STARTUPINFOEX));
            int accSize = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            if (extSize != (is64 ? 144 : 112) || siSize != (is64 ? 112 : 72) || accSize != 48)
            {
                stdoutOut.WriteLine("{\"__wookRunner\":\"probe\",\"ok\":false,\"error\":" + JsonString(
                    "구조체 크기가 맞지 않습니다 (ext=" + extSize + ", si=" + siSize + ", acc=" + accSize + ")") + "}");
                return ExitProbeFailed;
            }
            try
            {
                job = CreateKillOnCloseJob();
                int active = ActiveProcesses();
                NativeMethods.CloseHandle(job);
                job = IntPtr.Zero;
                if (active != 0)
                {
                    stdoutOut.WriteLine("{\"__wookRunner\":\"probe\",\"ok\":false,\"error\":" + JsonString(
                        "작업 개체 상태를 읽지 못했습니다 (active=" + active + ")") + "}");
                    return ExitProbeFailed;
                }
            }
            catch (StartException e)
            {
                stdoutOut.WriteLine("{\"__wookRunner\":\"probe\",\"ok\":false,\"error\":" + JsonString(e.Message) + "}");
                return ExitProbeFailed;
            }
            stdoutOut.WriteLine("{\"__wookRunner\":\"probe\",\"ok\":true,\"version\":" + ProtocolVersion.ToString(CultureInfo.InvariantCulture)
                + ",\"bits\":" + (IntPtr.Size * 8).ToString(CultureInfo.InvariantCulture) + "}");
            return 0;
        }

        private static int ActiveProcesses()
        {
            if (job == IntPtr.Zero) return 0;
            int size = Marshal.SizeOf(typeof(NativeMethods.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            IntPtr buf = Marshal.AllocHGlobal(size);
            try
            {
                uint returned;
                if (!NativeMethods.QueryInformationJobObject(job, NativeMethods.JobObjectBasicAccountingInformation, buf, (uint)size, out returned))
                {
                    Diagnostic("작업 개체 상태를 읽지 못했습니다: " + Win32Message(Marshal.GetLastWin32Error()));
                    return -1;
                }
                NativeMethods.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info = (NativeMethods.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)
                    Marshal.PtrToStructure(buf, typeof(NativeMethods.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
                return (int)info.ActiveProcesses;
            }
            finally
            {
                Marshal.FreeHGlobal(buf);
            }
        }

        /// <summary>job 안 프로세스 중 자식을 뺀 수. 알 수 없으면 -1</summary>
        private static int CountJobProcessesExcept(int excludePid)
        {
            int capacity = 64;
            for (int attempt = 0; attempt < 6; attempt++)
            {
                int size = 8 + IntPtr.Size * capacity;
                IntPtr buf = Marshal.AllocHGlobal(size);
                try
                {
                    uint returned;
                    if (NativeMethods.QueryInformationJobObject(job, NativeMethods.JobObjectBasicProcessIdList, buf, (uint)size, out returned))
                    {
                        int assigned = Marshal.ReadInt32(buf, 0);
                        int listed = Marshal.ReadInt32(buf, 4);
                        if (listed < assigned)
                        {
                            capacity = assigned + 16;
                            continue;
                        }
                        int count = 0;
                        for (int i = 0; i < listed; i++)
                        {
                            long id = Marshal.ReadIntPtr(buf, 8 + i * IntPtr.Size).ToInt64();
                            if (id != excludePid) count++;
                        }
                        return count;
                    }
                    int err = Marshal.GetLastWin32Error();
                    if (err == NativeMethods.ERROR_MORE_DATA)
                    {
                        capacity = Math.Max(capacity * 2, Marshal.ReadInt32(buf, 0) + 16);
                        continue;
                    }
                    Diagnostic("작업 개체의 프로세스 목록을 읽지 못했습니다: " + Win32Message(err));
                    return -1;
                }
                finally
                {
                    Marshal.FreeHGlobal(buf);
                }
            }
            Diagnostic("작업 개체의 프로세스 목록이 계속 바뀌어 셀 수 없습니다");
            return -1;
        }

        private static string[] GetArguments()
        {
            int argc;
            IntPtr argv = NativeMethods.CommandLineToArgvW(NativeMethods.GetCommandLineW(), out argc);
            if (argv == IntPtr.Zero)
            {
                throw new UsageException("명령줄을 해석하지 못했습니다: " + Win32Message(Marshal.GetLastWin32Error()));
            }
            try
            {
                string[] result = new string[Math.Max(0, argc - 1)];
                for (int i = 1; i < argc; i++)
                {
                    result[i - 1] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
                }
                return result;
            }
            finally
            {
                NativeMethods.LocalFree(argv);
            }
        }

        private static void FailStart(string message)
        {
            Diagnostic(message);
            WriteFinal(ExitJson(-1, 0, ActiveProcesses()));
        }

        private static void WriteFinal(string json)
        {
            if (Interlocked.Exchange(ref finalWritten, 1) != 0) return;
            try
            {
                stdoutOut.WriteLastLine(json);
            }
            finally
            {
                finished.Set();
            }
        }

        /// <summary>러너 자신의 진단 줄 (stderr, 줄 경계에서)</summary>
        internal static void Diagnostic(string message)
        {
            try
            {
                stderrOut.WriteLine("[WookJobRunner] " + message);
            }
            catch (Exception)
            {
                // stderr마저 쓸 수 없으면 알릴 곳이 없다 (앱 쪽은 제어 줄과 종료 코드로 판단)
            }
        }

        internal static StartException Win32Failure(string what)
        {
            return new StartException(what + ": " + Win32Message(Marshal.GetLastWin32Error()));
        }

        private static string Win32Message(int error)
        {
            return new Win32Exception(error).Message + " (오류 " + error.ToString(CultureInfo.InvariantCulture) + ")";
        }

        private static string StartedJson(int pid)
        {
            return "{\"__wookRunner\":\"started\",\"pid\":" + pid.ToString(CultureInfo.InvariantCulture) + "}";
        }

        private static string ExitJson(long code, int leftover, int remaining)
        {
            return "{\"__wookRunner\":\"exit\",\"code\":" + code.ToString(CultureInfo.InvariantCulture)
                + ",\"leftover\":" + leftover.ToString(CultureInfo.InvariantCulture)
                + ",\"remaining\":" + remaining.ToString(CultureInfo.InvariantCulture) + "}";
        }

        private static string TerminatedJson(int remaining)
        {
            return "{\"__wookRunner\":\"terminated\",\"remaining\":" + remaining.ToString(CultureInfo.InvariantCulture) + "}";
        }

        private static string JsonString(string s)
        {
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in s)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }
    }
}
