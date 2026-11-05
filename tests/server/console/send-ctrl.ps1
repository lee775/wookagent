# 시험 도우미 (tests/server/consoleSignals.test.ts, S2-17): TargetPid의 콘솔에 붙어 콘솔 제어 이벤트를 Count번 낸다 (Event 0 = Ctrl+C, 1 = Ctrl+Break).
# 먼저 자기 콘솔에서 떨어진다 — 시험을 돌리는 쪽 콘솔에는 아무것도 가지 않는다. 자기에게 온 이벤트는 처리기로 삼켜 이 도우미는 끝나지 않는다
# (Ctrl+C만 무시하는 SetConsoleCtrlHandler(NULL)로는 Ctrl+Break에 이 도우미가 먼저 죽는다). 결과는 ResultFile에 한 줄로.
# UTF-8 BOM으로 저장한다 — Windows PowerShell 5.1이 BOM 없는 파일을 시스템 코드 페이지로 읽어 한국어 주석이 깨지지 않게
param([int]$TargetPid, [int]$Event = 0, [int]$Count = 1, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class WookConsoleCtrl {
  public delegate bool Handler(uint ctrlType);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetConsoleCtrlHandler(Handler handler, bool add);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GenerateConsoleCtrlEvent(uint ctrlEvent, uint processGroupId);
  static readonly Handler Swallow = delegate (uint ctrlType) { return true; };
  public static string Send(uint pid, uint ctrlEvent, int count) {
    FreeConsole();
    if (!AttachConsole(pid)) return "attach-failed " + Marshal.GetLastWin32Error();
    SetConsoleCtrlHandler(Swallow, true);
    int sent = 0;
    for (int i = 0; i < count; i++) if (GenerateConsoleCtrlEvent(ctrlEvent, 0)) sent++;
    Thread.Sleep(300);
    FreeConsole();
    return "sent " + sent;
  }
}
'@
$r = [WookConsoleCtrl]::Send([uint32]$TargetPid, [uint32]$Event, $Count)
Set-Content -LiteralPath $ResultFile -Value $r -Encoding UTF8
