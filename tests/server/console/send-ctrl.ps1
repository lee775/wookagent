# 시험 도우미 (tests/server/consoleSignals.test.ts, S2-17): TargetPid의 콘솔에 붙어 콘솔 제어 이벤트를 Count번 낸다 (Event 0 = Ctrl+C, 1 = Ctrl+Break).
# 먼저 자기 콘솔에서 떨어진다 — 시험을 돌리는 쪽 콘솔에는 아무것도 가지 않는다. 자기에게 온 이벤트는 처리기로 삼켜 이 도우미는 끝나지 않는다
# (Ctrl+C만 무시하는 SetConsoleCtrlHandler(NULL)로는 Ctrl+Break에 이 도우미가 먼저 죽는다). 결과는 ResultFile에 한 줄로.
# UTF-8 BOM으로 저장한다 — Windows PowerShell 5.1이 BOM 없는 파일을 시스템 코드 페이지로 읽어 한국어 주석이 깨지지 않게
# S6F1b (리드 결정 S6-21 J5): WaitFile과 WaitTextB64(UTF-8 글의 base64)를 주면, 둘째 이벤트부터는 앞 이벤트를 받았다는 줄이 그 파일에 생긴 뒤에 낸다 —
# 붙은 채로 기다려 곧바로 낸다(새 도우미를 띄우면 그사이 서버가 끝난다). 앞 이벤트를 Node가 아직 받지 않았을 때 내면 둘이 하나로 합쳐진다. 기다림이 WaitMs를
# 넘으면 더 내지 않고 결과 앞에 'wait-timeout'을 붙인다
# S6F2b (리드 결정 S6-23 T3): 둘째 이벤트부터는 낸 직후 대상 프로세스가 아직 살아 있는지 본다 — 이미 끝났으면(그 이벤트는 대상에 가지 않았다 — 바쁜 PC에서
# 이 도우미가 늦게 돌면 서버가 그사이 종료를 마친다) 그 수를 결과 끝에 'late n'으로 붙인다. 시험은 늦지 않은 이벤트만 받았다고 본다
param([int]$TargetPid, [int]$Event = 0, [int]$Count = 1, [string]$ResultFile, [string]$WaitFile = '', [string]$WaitTextB64 = '', [int]$WaitMs = 15000)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class WookConsoleCtrl {
  public delegate bool Handler(uint ctrlType);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  static readonly Handler Swallow = delegate (uint ctrlType) { return true; };
  public static string Send(uint pid, uint ctrlEvent, int count, string waitFile, string waitText, int waitMs) {
    FreeConsole();
    if (!AttachConsole(pid)) return "attach-failed " + Marshal.GetLastWin32Error();
    SetConsoleCtrlHandler(Swallow, true);
    // 대상의 핸들 (SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION) — 핸들을 쥐고 보므로 PID가 다시 쓰여도 그 프로세스를 본다
    IntPtr target = OpenProcess(0x00100000u | 0x1000u, false, pid);
    int sent = 0;
    int late = 0;
    string note = "";
    try {
      for (int i = 0; i < count; i++) {
        if (i > 0 && waitFile.Length > 0 && waitText.Length > 0 && !Seen(waitFile, waitText, i, waitMs)) { note = "wait-timeout "; break; }
        if (GenerateConsoleCtrlEvent(ctrlEvent, 0)) {
          sent++;
          if (i > 0 && !Alive(target)) late++;
        }
      }
      Thread.Sleep(300);
    } finally {
      if (target != IntPtr.Zero) CloseHandle(target);
    }
    FreeConsole();
    return note + "sent " + sent + (late > 0 ? " late " + late : "");
  }
  // 대상이 아직 끝나지 않았는지 (WAIT_TIMEOUT). 핸들을 얻지 못했으면(이미 끝났다) false
  static bool Alive(IntPtr handle) {
    return handle != IntPtr.Zero && WaitForSingleObject(handle, 0) == 0x102u;
  }
  // 파일(UTF-8)에 text가 n번 이상 나올 때까지 — 서버가 쓰는 중인 파일이라 같이 열고, 처음 2초는 쉬지 않고 본다 (서버는 첫 신호 뒤 수십 ms 안에 끝난다)
  static bool Seen(string path, string text, int n, int waitMs) {
    Stopwatch sw = Stopwatch.StartNew();
    while (sw.ElapsedMilliseconds < waitMs) {
      try {
        using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
          byte[] buf = new byte[fs.Length];
          int off = 0;
          while (off < buf.Length) { int r = fs.Read(buf, off, buf.Length - off); if (r <= 0) break; off += r; }
          string s = Encoding.UTF8.GetString(buf, 0, off);
          int c = 0;
          for (int at = s.IndexOf(text, StringComparison.Ordinal); at >= 0; at = s.IndexOf(text, at + text.Length, StringComparison.Ordinal)) c++;
          if (c >= n) return true;
        }
      } catch (IOException) { }
      if (sw.ElapsedMilliseconds < 2000) Thread.Yield(); else Thread.Sleep(5);
    }
    return false;
  }
}
'@
$waitText = if ($WaitTextB64) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($WaitTextB64)) } else { '' }
$r = [WookConsoleCtrl]::Send([uint32]$TargetPid, [uint32]$Event, $Count, $WaitFile, $waitText, $WaitMs)
Set-Content -LiteralPath $ResultFile -Value $r -Encoding UTF8
