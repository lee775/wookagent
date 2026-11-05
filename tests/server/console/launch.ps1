# 시험 도우미 (tests/server/consoleSignals.test.ts, S2-17): 이 프로세스의 'Ctrl+C 무시' 표시를 지우고, 이 콘솔에서 node로 wrapper.mjs를 띄워 끝날 때까지 기다린다.
# 그 표시는 시험을 돌리는 도구의 프로세스 줄기(새 프로세스 그룹)에서 물려받을 수 있다 — 운영자가 연 터미널에는 없다. 자식(wrapper, 서버)은 지운 상태를 물려받는다
# UTF-8 BOM으로 저장한다 — Windows PowerShell 5.1이 BOM 없는 파일을 시스템 코드 페이지로 읽어 한국어 주석이 깨지지 않게
param([string]$Node, [string]$Wrapper, [string]$Config)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WookConsoleLaunch {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);
}
'@
[WookConsoleLaunch]::SetConsoleCtrlHandler([IntPtr]::Zero, $false) | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Node
$psi.Arguments = '"' + $Wrapper + '" "' + $Config + '"'
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $false
$p = [System.Diagnostics.Process]::Start($psi)
$p.WaitForExit()
