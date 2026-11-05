/**
 * host_exec 거부 목록 (SERVER_DESIGN 8.2, 리드 결정 S5-17·S5-32, 지도 host-exec §5) — 서버 PC를 멈추게 할 수 있는 명령, 서버 운영자 명령, 서버 데이터 폴더를
 * 가리키는 명령은 거부하고, 비슷해 보이는 명령(따옴표 안의 같은 글자 포함)은 막지 않는다. 순수 함수라 플랫폼과 상관없이 같은 표로 본다
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toolSpec } from '../main/mcp/catalog';
import { HOST_COMMAND_GUARD_LIMITS, hostCommandDenied, hostCommandRefusal, type HostCommandRule } from './hostCommandGuard';

const ctx = { serverPid: 4242, serverImage: 'node.exe', dataDir: 'D:\\wook-data', shell: 'cmd' as const };
const ruleOf = (cmd: string) => hostCommandDenied(cmd, ctx)?.rule ?? null;

const DENIED: [string, HostCommandRule][] = [
  // 디스크 포맷
  ['format c:', '디스크 포맷'],
  ['FORMAT D: /Q /Y', '디스크 포맷'],
  ['format.com e:\\ /fs:ntfs', '디스크 포맷'],
  ['C:\\Windows\\System32\\format.com d: /q', '디스크 포맷'],
  ['powershell -NoProfile -Command "Format-Volume -DriveLetter D"', '디스크 포맷'],
  ['pwsh -c Clear-Disk -Number 1 -RemoveData', '디스크 포맷'],
  ['Initialize-Disk 2', '디스크 포맷'],
  ['Remove-Partition -DiskNumber 1 -PartitionNumber 2', '디스크 포맷'],
  ['Reset-PhysicalDisk -FriendlyName x', '디스크 포맷'],
  ['mkfs.ext4 /dev/sdb1', '디스크 포맷'],
  ['sudo mkfs -t xfs /dev/nvme0n1', '디스크 포맷'],
  ['mke2fs /dev/sdc', '디스크 포맷'],
  ['wipefs -a /dev/sdb', '디스크 포맷'],
  ['mkswap /dev/sdb2', '디스크 포맷'],
  ['sgdisk --zap-all /dev/sda', '디스크 포맷'],
  ['shred -n 1 /dev/sda', '디스크 포맷'],
  // diskpart
  ['diskpart', 'diskpart'],
  ['diskpart /s wipe.txt', 'diskpart'],
  ['echo select disk 0 | diskpart', 'diskpart'],
  ['cmd /c "diskpart /s x.txt"', 'diskpart'],
  ['start /wait diskpart', 'diskpart'],
  ['C:\\Windows\\System32\\diskpart.exe', 'diskpart'],
  // 디스크로 dd
  ['dd if=image.iso of=\\\\.\\PhysicalDrive1 bs=4M', '디스크로 dd'],
  ['dd if=x of=\\\\.\\e:', '디스크로 dd'],
  ['dd if=/dev/zero of=/dev/sda bs=1M', '디스크로 dd'],
  ['sudo dd if=boot.img of=/dev/mmcblk0', '디스크로 dd'],
  ['dd if=a of=/dev/mapper/root', '디스크로 dd'],
  // 루트 삭제
  ['rd /s /q C:\\', '루트 삭제'],
  ['rmdir /S /Q c:/', '루트 삭제'],
  ['rd /s/q \\', '루트 삭제'],
  ['del /s /q C:\\*', '루트 삭제'],
  ['erase /s /f /q d:\\*.*', '루트 삭제'],
  ['Remove-Item -Recurse -Force C:\\', '루트 삭제'],
  ['ri -r c:\\*', '루트 삭제'],
  ['rm -rf /', '루트 삭제'],
  ['rm -fr /*', '루트 삭제'],
  ['rm --recursive --force /', '루트 삭제'],
  ['rm -r --no-preserve-root /x', '루트 삭제'],
  ['sudo rm -Rf /', '루트 삭제'],
  ['bash -c "rm -rf /"', '루트 삭제'],
  // 서버 PC 종료·재시작
  ['shutdown /s /t 0', '서버 PC 종료·재시작'],
  ['shutdown -r now', '서버 PC 종료·재시작'],
  ['shutdown', '서버 PC 종료·재시작'],
  ['shutdown -h now', '서버 PC 종료·재시작'],
  ['Stop-Computer -Force', '서버 PC 종료·재시작'],
  ['Restart-Computer', '서버 PC 종료·재시작'],
  ['logoff', '서버 PC 종료·재시작'],
  ['reboot', '서버 PC 종료·재시작'],
  ['poweroff', '서버 PC 종료·재시작'],
  ['halt -p', '서버 PC 종료·재시작'],
  ['init 0', '서버 PC 종료·재시작'],
  ['telinit 6', '서버 PC 종료·재시작'],
  ['systemctl reboot', '서버 PC 종료·재시작'],
  ['sudo systemctl poweroff', '서버 PC 종료·재시작'],
  ['npm run build && shutdown /r', '서버 PC 종료·재시작'],
  ['echo a; shutdown -P +1', '서버 PC 종료·재시작'],
  ['sh^utdown /s', '서버 PC 종료·재시작'],
  // 서버 종료 (이 프로세스)
  ['taskkill /F /PID 4242', '서버 종료'],
  ['taskkill /im node.exe /f', '서버 종료'],
  ['taskkill /IM node* /T', '서버 종료'],
  ['Stop-Process -Id 4242 -Force', '서버 종료'],
  ['Stop-Process -Name node', '서버 종료'],
  ['kill -9 4242', '서버 종료'],
  ['pkill node', '서버 종료'],
  ['killall node', '서버 종료'],
  // 감싸는 명령 env·wsl과 줄바꿈 나누기 (리뷰 tests-integrity, 프로브 zz-s5ti-guard-gaps)
  ['env FOO=1 reboot', '서버 PC 종료·재시작'],
  ['env -i PATH=/usr/bin shutdown -h now', '서버 PC 종료·재시작'],
  ['wsl shutdown -h now', '서버 PC 종료·재시작'],
  ['wsl -d Ubuntu -- mkfs.ext4 /dev/sdb1', '디스크 포맷'],
  ['echo start\nshutdown /s /t 0', '서버 PC 종료·재시작'],
  ['git status\r\ndiskpart', 'diskpart'],
  // 흔한 cmd·PowerShell 꼴 (리드 결정 S5-32, 프로브 zz-xs5-exec): @ 앞말, 괄호, Start-Process(saps), 공백 든 경로의 셸, taskkill /fi
  ['@shutdown /s /t 0', '서버 PC 종료·재시작'],
  ['(shutdown /r /t 0)', '서버 PC 종료·재시작'],
  ['echo a & (shutdown /r)', '서버 PC 종료·재시작'],
  ["Start-Process shutdown -ArgumentList '/s /t 0'", '서버 PC 종료·재시작'],
  ['saps -FilePath C:\\Windows\\System32\\shutdown.exe -ArgumentList "/r","/t","0"', '서버 PC 종료·재시작'],
  ["Start-Process cmd -ArgumentList '/c diskpart'", 'diskpart'],
  ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -c Stop-Computer -Force', '서버 PC 종료·재시작'],
  ['"C:\\Windows\\System32\\shutdown.exe" /s', '서버 PC 종료·재시작'],
  ['cmd /c "echo a & shutdown /s"', '서버 PC 종료·재시작'],
  ['cmd /c "C:\\Program Files\\Tools\\diskpart.exe"', 'diskpart'],
  ['(taskkill /pid 4242)', '서버 종료'],
  ['powershell "Stop-Computer -Force"', '서버 PC 종료·재시작'],
  ['start "" cmd /c shutdown /r', '서버 PC 종료·재시작'],
  ['taskkill /F /FI "IMAGENAME eq node.exe"', '서버 종료'],
  ['taskkill /fi "pid eq 4242"', '서버 종료'],
  // 이름·PID 배열, Get-Process | Stop-Process 파이프라인, wmic, taskkill 사용자·세션 (리드 결정 S5-39, 프로브 zz-xs5f1-guard)
  ['powershell -NoProfile -Command "Stop-Process -Name node, python -Force"', '서버 종료'],
  ['powershell -c "Stop-Process -Name node,python"', '서버 종료'],
  ['powershell -c "Stop-Process -Id 4242,1 -Force"', '서버 종료'],
  ['powershell -NoProfile -Command "Get-Process node | Stop-Process -Force"', '서버 종료'],
  ['powershell -c "Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force"', '서버 종료'],
  ['wmic process where name="node.exe" delete', '서버 종료'],
  ['wmic process where "name=\'node.exe\'" call terminate', '서버 종료'],
  ['taskkill /f /fi "username eq pc_09"', '서버 종료'],
  ['taskkill /fi "session eq 2" /f', '서버 종료'],
  // cmd if·for 몸과 PowerShell 스크립트 블록 { }·& { } 안의 종료 명령 (리드 결정 S5-39, 프로브 zz-xs5f1-guard)
  ['if errorlevel 1 shutdown /r /t 0', '서버 PC 종료·재시작'],
  ['if exist C:\\deploy\\done.flag (shutdown /r /t 0)', '서버 PC 종료·재시작'],
  ['if 1==1 shutdown /s /t 0', '서버 PC 종료·재시작'],
  ['for /l %i in (1,1,1) do shutdown /r /t 0', '서버 PC 종료·재시작'],
  ['powershell -NoProfile -Command "& { Restart-Computer -Force }"', '서버 PC 종료·재시작'],
  ['powershell -c "if ($true) { Stop-Computer -Force }"', '서버 PC 종료·재시작'],
  ['pwsh -c "{ Stop-Computer }.Invoke()"', '서버 PC 종료·재시작'],
  // 한 줄에 스크립트 블록 둘 — 둘째 블록의 종료 명령은 { } 경계로 나눠야 잡힌다 (리드 결정 S5-39)
  ['powershell -c "{ echo hi }{ shutdown /s }"', '서버 PC 종료·재시작'],
  // powershell.exe 옵션 줄임말(앞부분)과 값 옵션 뒤의 -Command (리드 결정 S5-39)
  ['powershell -NoProfile -Exec Bypass -Command "Stop-Computer -Force"', '서버 PC 종료·재시작'],
  ['powershell -NoP -NonI -Exec Bypass -Command "Restart-Computer -Force"', '서버 PC 종료·재시작'],
  ['powershell -ExecutionPolicy Bypass -Command "Restart-Computer -Force"', '서버 PC 종료·재시작'],
  ['powershell -Win Hidden -Command "Stop-Computer"', '서버 PC 종료·재시작'],
  ['powershell -Window Hidden -c "Stop-Computer"', '서버 PC 종료·재시작'],
  ['powershell -c "start -FilePath shutdown.exe -ArgumentList \'/r\',\'/t\',\'0\'"', '서버 PC 종료·재시작'],
  // Start-Process 값 옵션·-Opt:값, 세 겹 감싸기 (리드 결정 S5-39, 프로브 zz-s5f1ti-guard-gaps2)
  ['Start-Process -WindowStyle Hidden shutdown -ArgumentList "/s /t 0"', '서버 PC 종료·재시작'],
  ['saps -Verb RunAs diskpart', 'diskpart'],
  ['Start-Process -FilePath:shutdown -ArgumentList:"/s"', '서버 PC 종료·재시작'],
  ['cmd /c cmd /c cmd /c shutdown /s /t 0', '서버 PC 종료·재시작'],
  // PowerShell 값 옵션의 정해진 별칭 — 이름의 앞부분이 아닌 -ep·-wd·-of·-if도, 앞부분인 -ex·-w·-v도 값을 하나 받는다 (리드 결정 S5-46, 프로브 zz-s5f2ti-guard-ep)
  ['powershell -ep bypass -c "Restart-Computer -Force"', '서버 PC 종료·재시작'],
  ['powershell -NoProfile -ep Bypass -Command "Stop-Process -Name node -Force"', '서버 종료'],
  ['pwsh -wd D:/work -c "Stop-Computer"', '서버 PC 종료·재시작'],
  ['powershell -of text -c "Restart-Computer"', '서버 PC 종료·재시작'],
  ['powershell -if text -c "Restart-Computer"', '서버 PC 종료·재시작'],
  ['powershell -ex bypass -c "Restart-Computer"', '서버 PC 종료·재시작'],
  ['powershell -w hidden -c "Stop-Computer"', '서버 PC 종료·재시작'],
  ['powershell -v 2 -c "Stop-Computer"', '서버 PC 종료·재시작'],
  ['powershell -InputFormat Text -OutputFormat Text -PSConsoleFile c.psc1 -c "Stop-Computer"', '서버 PC 종료·재시작'],
  ['pwsh -WorkingDirectory D:/x -SettingsFile s.json -ConfigurationName c -c "Restart-Computer"', '서버 PC 종료·재시작'],
  // cmd if의 여러 낱말 조건 — 비교 낱말, 앞뒤를 띄운 ==, 빈 글 "", defined, /i, else 뒤 몸 (리드 결정 S5-46, 프로브 zz-s5f2ti-guard-forms)
  ['if %errorlevel% equ 0 (shutdown /r /t 0)', '서버 PC 종료·재시작'],
  ['if %ERRORLEVEL% NEQ 0 (shutdown /s /t 0)', '서버 PC 종료·재시작'],
  ['if %n% lss 3 shutdown /s', '서버 PC 종료·재시작'],
  ['if %n% leq 3 shutdown /s', '서버 PC 종료·재시작'],
  ['if %n% gtr 3 shutdown /s', '서버 PC 종료·재시작'],
  ['if %n% geq 3 shutdown /s', '서버 PC 종료·재시작'],
  ['if "%1" == "go" (shutdown /r /t 0)', '서버 PC 종료·재시작'],
  ['if "%1" == "" shutdown /s', '서버 PC 종료·재시작'],
  ['if "%1"== "" shutdown /s', '서버 PC 종료·재시작'],
  ['if "%1"=="" shutdown /s', '서버 PC 종료·재시작'],
  ['if a ==b shutdown /s', '서버 PC 종료·재시작'],
  ['if defined DEPLOY_DONE (shutdown /r /t 0)', '서버 PC 종료·재시작'],
  ['if not defined KEEP shutdown /s', '서버 PC 종료·재시작'],
  ['if cmdextversion 2 shutdown /s', '서버 PC 종료·재시작'],
  ['if exist "" shutdown /s', '서버 PC 종료·재시작'],
  ['if /i "%1" equ "GO" shutdown /s /t 0', '서버 PC 종료·재시작'],
  ['if %errorlevel% equ 0 (taskkill /im node.exe /f)', '서버 종료'],
  ['if exist build (echo built) else (shutdown /s)', '서버 PC 종료·재시작'],
  ['if exist build ( shutdown /s )', '서버 PC 종료·재시작'],
  // S5-39 갈래 가운데 표에 없던 것 (리드 결정 S5-46, 프로브 zz-s5f2ti-guard-kills)
  ['wmic process where processid=4242 call terminate', '서버 종료'],
  ['powershell -c "Get-Process -Id 4242 | Stop-Process -Force"', '서버 종료'],
  ['if not exist C:\\deploy\\keep.flag shutdown /r /t 0', '서버 PC 종료·재시작'],
  ['if /i "%1"=="go" shutdown /s /t 0', '서버 PC 종료·재시작'],
  ['powershell -c "Stop-Process -Name python, node -Force"', '서버 종료'],
  ['powershell -ExecutionPolicy:Bypass -Command "Stop-Computer -Force"', '서버 PC 종료·재시작'],
  ["Start-Process -FilePath 'shutdown' -ArgumentList '/s'", '서버 PC 종료·재시작'],
  ['start /b "" cmd /c "echo hi & shutdown /s"', '서버 PC 종료·재시작'],
  // 따옴표만 있는 빈 낱말("")은 실행 파일로 보지 않는다 — 그다음 낱말이 실행 파일이다 (리드 결정 S5-46의 빈 글 낱말)
  ['Start-Process "" shutdown -ArgumentList "/s"', '서버 PC 종료·재시작'],
  // 안쪽 프로그램을 집는 자리의 앞 빈 따옴표 낱말("")을 건너뛴다 — cmd /c·powershell -c·call이 그다음을 프로그램으로 본다 (리드 결정 S5-52, 프로브 zz-s5f3ti-guard-empty)
  ['cmd /c "" shutdown /s /t 0', '서버 PC 종료·재시작'],
  ['cmd /d /c "" taskkill /im node.exe /f', '서버 종료'],
  ['cmd.exe /c "" wmic process where processid=4242 call terminate', '서버 종료'],
  ['powershell -c "" Stop-Computer -Force', '서버 PC 종료·재시작'],
  ['powershell -NoProfile -Command "" Restart-Computer -Force', '서버 PC 종료·재시작'],
  ['powershell -c "" "Restart-Computer"', '서버 PC 종료·재시작'],
  ['call "" shutdown /s', '서버 PC 종료·재시작'],
  // 빈 따옴표 낱말이 둘 이상이어도 모두 건너뛴다 (scanCommand의 한 개 떼기만으로는 모자람 — 리드 결정 S5-52)
  ['call "" "" shutdown /s', '서버 PC 종료·재시작'],
  ['"" "" shutdown /s', '서버 PC 종료·재시작'],
  // cmd start는 첫 따옴표 낱말을 창 제목으로 건너뛴다 — 빈 제목도, 이름이 든 제목도 (리드 결정 S5-52, 프로브 zz-s5f3ti-guard-empty·zz-s5f3ti-guard-kills, S5F6 KNOWN_ISSUES)
  ['start "Dev Server" cmd /c shutdown /s', '서버 PC 종료·재시작'],
  ['start "" /b cmd /c shutdown /s /t 0', '서버 PC 종료·재시작'],
  ['start "" /min /wait cmd /c taskkill /im node.exe /f', '서버 종료'],
  // 제목만 건너뛴다 — 제목 뒤 따옴표로 쓴 명령(공백 든 경로 등)은 명령으로 본다 (리드 결정 S5-52)
  ['start "setup" "diskpart"', 'diskpart'],
  // if 조건의 /i와 not을 함께, %x%== 1 꼴의 오른쪽 값 (리드 결정 S5-52, 프로브 zz-s5f3ti-guard-kills, S5F6 KNOWN_ISSUES)
  ['if /i not "%DEPLOY%"=="skip" shutdown /r /t 0', '서버 PC 종료·재시작'],
  ['if /i not %errorlevel% equ 0 (shutdown /s /t 0)', '서버 PC 종료·재시작'],
  ['if %x%== 1 shutdown /s', '서버 PC 종료·재시작'],
  ['if %x% == 1 shutdown /s', '서버 PC 종료·재시작'],
  ['if %x% ==1 shutdown /s', '서버 PC 종료·재시작'],
  // 따옴표로 쓴 비교 — 끝이 ==이고 그 뒤에 따옴표 부분이 없으면 오른쪽 값은 다음 낱말, ==""는 연산자와 오른쪽 값 (리드 결정 S5-58, 프로브 zz-xs5f4-guard3)
  ['if "%a%"== "1" shutdown /s', '서버 PC 종료·재시작'],
  ['if "%a%" =="" shutdown /s', '서버 PC 종료·재시작'],
  ['if %a% =="" shutdown /s', '서버 PC 종료·재시작'],
  ['if /i "%a%"== "yes" shutdown /r', '서버 PC 종료·재시작'],
  ['if not "%a%" =="" shutdown /s', '서버 PC 종료·재시작'],
  ['if "%a%"== "" shutdown /s /t 0', '서버 PC 종료·재시작'],
  ['if "%a%" =="x" shutdown /s', '서버 PC 종료·재시작'],
  ['if "%a%"=="" shutdown /s', '서버 PC 종료·재시작'],
  ['if "%a%" == "" shutdown /s', '서버 PC 종료·재시작'],
  // 서버 운영자 명령 — 어느 하위 명령이든 (리드 결정 S5-32)
  ['wook-server shutdown --data-dir D:\\wook-data', '서버 운영자 명령'],
  ['wook-server status', '서버 운영자 명령'],
  ['wook-server', '서버 운영자 명령'],
  ['C:\\tools\\wook-server.cmd stop', '서버 운영자 명령'],
  ['node out\\server\\index.mjs shutdown --data-dir D:\\wook-data', '서버 운영자 명령'],
  ['node C:\\WOOK\\wookagent\\out\\server\\index.mjs shutdown', '서버 운영자 명령'],
  ['node ./out/server/index.mjs config show', '서버 운영자 명령'],
  ['"C:\\Program Files\\nodejs\\node.exe" --max-old-space-size=4096 out/server/index.mjs secret set google-client-secret', '서버 운영자 명령'],
  ['node -r ./hook.cjs out/server/index.mjs seat assign launched:codex', '서버 운영자 명령'],
  ['npm run start:server -- stop', '서버 운영자 명령'],
  ['npm run-script start:server', '서버 운영자 명령'],
  ['pnpm start:server', '서버 운영자 명령'],
  ['cmd /c "wook-server config reload"', '서버 운영자 명령'],
  ["Start-Process node -ArgumentList 'out\\server\\index.mjs','shutdown'", '서버 운영자 명령'],
  // 서버 데이터 폴더 — 경로(대소문자·빗금 방향 무시)와 관리 파일 이름 (리드 결정 S5-32)
  ['type D:\\wook-data\\admin.token', '서버 데이터 폴더'],
  ['dir d:/WOOK-DATA', '서버 데이터 폴더'],
  ['Get-Content "D:\\wook-data\\logs\\server.log" -Tail 50', '서버 데이터 폴더'],
  ['copy D:\\\\wook-data\\\\wook.db C:\\tmp\\', '서버 데이터 폴더'],
  ['git -C D:\\wook-data\\ status', '서버 데이터 폴더'],
  ['cd /d D:\\wook-data && dir', '서버 데이터 폴더'],
  ['type admin.token', '서버 데이터 폴더'],
  ['cat ../admin.endpoint', '서버 데이터 폴더'],
  ['more "setup-code.txt"', '서버 데이터 폴더'],
];

const ALLOWED: string[] = [
  'git log --format=%H -n 5',
  'git log --pretty=format:%h',
  'npx prettier --format src',
  'npm run format',
  'echo format c:',
  'echo shutdown',
  'git commit -m "fix diskpart docs"',
  'dd if=/dev/zero of=./disk.img bs=1M count=1',
  'dd if=/dev/urandom of=/dev/null count=1',
  'rm -rf ./build',
  'rm -rf /tmp/wook-x',
  'rd /s /q build',
  'rmdir /s /q C:\\work\\old',
  'del /s /q C:\\work\\*.log',
  'Remove-Item -Recurse -Force .\\dist',
  'rm -f /',
  'shutdown /a',
  'shutdown -c',
  'shutdown /?',
  'taskkill /PID 1234 /F',
  'taskkill /im notepad.exe',
  'Stop-Process -Id 1234',
  'kill 1234',
  'pkill -f my-dev-server',
  'winget install --id Git.Git --accept-source-agreements --accept-package-agreements',
  'npm install -g pnpm',
  'node -e "console.log(1)"',
  'systemctl status nginx',
  'init',
  // 큰따옴표 안의 && | ; 뒤 낱말 (리드 결정 S5-32, 프로브 zz-xs5-exec) — cmd에서도 큰따옴표는 따옴표다
  'git commit -m "docs: note; reboot procedure"',
  'git log --grep="fix | halt handling"',
  'echo "build && shutdown notes"',
  // 안쪽이 sh인 감싸기는 작은따옴표도 따옴표로 읽는다 (리드 결정 S5-39)
  'bash -c "echo \'reboot later\'"',
  // 운영자 명령과 비슷해 보이는 것
  'npm run build:server',
  'node out/server/other.mjs',
  'node scripts/check-size.mjs out/server/index.mjs',
  'git log -- out/server/index.mjs',
  'echo wook-server',
  'npx vitest run tests/server',
  // 데이터 폴더·관리 파일과 비슷해 보이는 것
  'dir D:\\wook-data2',
  'dir D:\\wook-data-backup',
  'type myadmin.token',
  'echo admin.tokens',
  'git log --grep=setup-code',
  // 첫 낱말이 아닌 자리의 diskpart — 가림 1회차가 가린 kill s5d:hg-diskpart-anywhere를 되살린다 (리드 결정 S5-39, 프로브 zz-s5f1ti-guard-lookalike)
  'where diskpart',
  'Get-Help diskpart',
  'echo diskpart is not run here',
  'choco info diskpart',
  // taskkill /fi "pid eq …"가 서버 PID가 아니면 통과 (프로브 zz-s5f1ti-guard-gaps2)
  'taskkill /fi "pid eq 7" /f',
  // 안쪽이 PowerShell인 명령 줄의 작은따옴표는 따옴표다 — 비슷해 보여도 통과 (리드 결정 S5-39·S5-46, 프로브 zz-s5f2ti-guard-kills)
  'powershell -c "git commit -m \'fix; reboot docs\'"',
  'pwsh -NoProfile -Command "Write-Host \'build && shutdown notes\'"',
  // 서버 PID가 아닌 wmic, 끝내지 않는 wmic, 파이프라인이 끊긴 Get-Process, 다른 프로그램으로 좁힌 taskkill 사용자 (프로브 zz-s5f2ti-guard-kills)
  'wmic process where processid=7 call terminate',
  'wmic process where name="node.exe" get processid,commandline',
  'powershell -c "Get-Process node; Stop-Process -Id 1234"',
  'powershell -c "Get-Process node && Stop-Process -Name notepad"',
  'taskkill /fi "username eq pc_09" /im notepad.exe /f',
  // cmd if 조건의 낱말은 명령이 아니다 — 몸만 본다 (리드 결정 S5-46)
  'if "%1" == "shutdown" echo bye',
  'if %errorlevel% equ 0 echo shutdown done',
  'if defined SHUTDOWN echo ok',
  'if "%1"=="" echo usage: deploy [shutdown]',
  'if exist build (echo built) else (echo none)',
  // 빈 따옴표 낱말을 건너뛴 뒤가 위험하지 않으면 통과 (리드 결정 S5-52, 프로브 zz-s5f3ti-guard-empty)
  'cmd /c "" echo ok',
  'cmd /c "" npm run build',
  // 따옴표로 쓴 비교의 오른쪽 값은 명령이 아니다 (리드 결정 S5-58, 프로브 zz-xs5f4-guard3)
  'if "%ACTION%"== "shutdown" echo planned',
  'if "%ACTION%" =="shutdown" echo planned',
  'if "%1"=="shutdown" echo bye',
];

describe('host_exec 거부 목록 (hostCommandGuard)', () => {
  it.each(DENIED)('거부: %s → %s', (cmd, rule) => {
    expect(ruleOf(cmd)).toBe(rule);
  });

  it.each(ALLOWED.map((c) => [c]))('통과: %s', (cmd) => {
    expect(hostCommandDenied(cmd, ctx)).toBeNull();
  });

  it('서버 PID·실행 파일 이름은 넘긴 값으로 본다 — 다른 PID·이름이면 막지 않고, 이름을 모르면 이름으로는 막지 않는다', () => {
    expect(hostCommandDenied('taskkill /PID 4242 /F', { serverPid: 7, serverImage: 'node.exe', dataDir: null, shell: 'cmd' })).toBeNull();
    expect(hostCommandDenied('taskkill /im node.exe', { serverPid: 7, serverImage: 'wookagent.exe', dataDir: null, shell: 'cmd' })).toBeNull();
    expect(hostCommandDenied('taskkill /im wookagent.exe', { serverPid: 7, serverImage: 'C:\\Program Files\\wookagent\\wookagent.exe', dataDir: null, shell: 'cmd' })?.rule).toBe('서버 종료');
    expect(hostCommandDenied('pkill node', { serverPid: 7, serverImage: null, dataDir: null, shell: 'cmd' })).toBeNull();
    // 서버 실행 파일이 node가 아니어도(데스크톱의 앱 실행 파일) 그 이름으로 서버 진입점을 띄우면 운영자 명령이다
    expect(hostCommandDenied('wookagent.exe out\\server\\index.mjs status', { serverPid: 7, serverImage: 'C:\\Program Files\\wookagent\\wookagent.exe', dataDir: null, shell: 'cmd' })?.rule).toBe('서버 운영자 명령');
    expect(hostCommandDenied('python out/server/index.mjs', ctx)).toBeNull();
  });

  it('데이터 폴더는 넘긴 값으로 본다 — 다른 폴더면 막지 않고, 모르면 관리 파일 이름만 본다', () => {
    expect(hostCommandDenied('type D:\\wook-data\\wook.db', { ...ctx, dataDir: 'E:\\other' })).toBeNull();
    expect(hostCommandDenied('type D:\\wook-data\\wook.db', { ...ctx, dataDir: null })).toBeNull();
    expect(hostCommandDenied('type D:\\wook-data\\admin.token', { ...ctx, dataDir: null })?.rule).toBe('서버 데이터 폴더');
    // POSIX 데이터 폴더와 끝 빗금
    expect(hostCommandDenied('ls -la /home/me/.wookagent/logs', { ...ctx, dataDir: '/home/me/.wookagent/' })?.rule).toBe('서버 데이터 폴더');
    expect(hostCommandDenied('ls -la /home/me/.wookagent-old', { ...ctx, dataDir: '/home/me/.wookagent/' })).toBeNull();
  });

  it('짝 없는 따옴표는 글자로 본다 — 그 뒤의 & | ; 를 숨기지 않는다', () => {
    expect(ruleOf("echo it's & shutdown /s")).toBe('서버 PC 종료·재시작');
    expect(ruleOf('echo "unclosed ; reboot')).toBe('서버 PC 종료·재시작');
  });

  it('cmd에서는 작은따옴표가 따옴표가 아니다 — 그 안의 & | ; 가 명령을 나눈다. posix·안쪽 셸에서는 따옴표다 (리드 결정 S5-39)', () => {
    // cmd(host_exec의 셸): 작은따옴표 안의 shutdown이 실제로 돈다 — 막는다(지나친 거부, 결정이 받아들임)
    expect(ruleOf("git commit -m 'fix; reboot docs'")).toBe('서버 PC 종료·재시작');
    expect(ruleOf("echo 'a & shutdown /s'")).toBe('서버 PC 종료·재시작');
    // 거부 글이 큰따옴표를 쓰라고 일러 준다
    const d = hostCommandDenied("git commit -m 'fix; reboot docs'", ctx)!;
    expect(hostCommandRefusal(d, 'cmd')).toContain('메시지·인자에는 큰따옴표를 쓰세요');
    // posix 셸에서는 작은따옴표가 따옴표라 나누지 않는다
    expect(hostCommandDenied("git commit -m 'fix; reboot docs'", { ...ctx, shell: 'posix' })).toBeNull();
    // 큰따옴표로 감싼 안쪽이 sh면 그 안의 작은따옴표는 따옴표로 읽혀 나누지 않는다
    expect(ruleOf('bash -c "git commit -m \'fix; reboot\'"')).toBeNull();
    // 작은따옴표와 상관없는 거부에는 큰따옴표를 쓰라는 말을 붙이지 않는다 (리드 결정 S5-46, 프로브 zz-s5f2ti-guard-kills)
    expect(hostCommandRefusal(hostCommandDenied('shutdown /s /t 0', ctx)!, 'cmd')).not.toContain('큰따옴표');
    expect(hostCommandRefusal(d, 'posix')).not.toContain('큰따옴표');
  });

  it('운영자 명령·데이터 폴더의 거부 글은 그 까닭과 걸린 조각, 갈 길을 말한다', () => {
    const op = hostCommandDenied('wook-server status', ctx)!;
    expect(hostCommandRefusal(op)).toBe(
      '서버 운영자 명령(wook-server)이라 실행하지 않았습니다 ("wook-server status") — 운영자 명령은 서버 PC의 운영자가 쓰는 것이라, 메인 에이전트는 상태 보기를 포함해 어떤 운영자 명령도 돌리지 않습니다. 운영자가 할 일이 있으면 ask_owner로 대표에게 알리세요',
    );
    const data = hostCommandDenied('type admin.token', ctx)!;
    expect(hostCommandRefusal(data)).toBe(
      '앱 데이터 폴더나 그 안의 관리 파일(admin.token·admin.endpoint·setup-code.txt)을 가리키는 명령이라 실행하지 않았습니다 ("type admin.token") — 데이터 폴더는 host_exec로 읽거나 바꾸지 않습니다. 앱의 기록은 search_activity·get_overview로 보세요',
    );
  });

  it('스크립트 파일·인코딩한 명령은 보지 못한다 (한계 — 거부하지 않는다)', () => {
    expect(hostCommandDenied('powershell -EncodedCommand ZgBvAHIAbQBhAHQA', ctx)).toBeNull();
    expect(hostCommandDenied('bash ./wipe.sh', ctx)).toBeNull();
    // 환경 변수로 쓴 데이터 폴더 경로도 보지 못한다 (한계 문장의 '변수·별칭')
    expect(hostCommandDenied('dir %APPDATA%\\wookagent', { ...ctx, dataDir: 'C:\\Users\\me\\AppData\\Roaming\\wookagent' })).toBeNull();
  });

  it('걸린 조각은 80자까지이고 거부 글은 규칙과 그 조각, 하지 않는 일 목록을 말한다', () => {
    const d = hostCommandDenied(`echo ${'x'.repeat(200)} & format c: /q /fs:ntfs /v:${'y'.repeat(100)}`, ctx)!;
    expect(d.rule).toBe('디스크 포맷');
    expect(d.matched.length).toBeLessThanOrEqual(80);
    expect(d.matched.startsWith('format c: /q')).toBe(true);
    expect(hostCommandRefusal({ rule: '디스크 포맷', matched: 'format c:' })).toBe(
      '서버 PC를 멈추게 할 수 있는 명령이라 실행하지 않았습니다 (디스크 포맷: "format c:") — 디스크 포맷·diskpart·mkfs·디스크로 dd·루트 삭제·서버 PC 종료·재시작·서버 종료는 host_exec로 하지 않습니다',
    );
  });

  it('한계 문장은 글자만 본다·실수를 막는다(일부러 피하는 쪽은 아니다)·CLI 자체 셸은 거치지 않는다를 말한다 — 도구 설명과 SERVER_DESIGN 8.2에 그대로 있다', () => {
    for (const s of ['명령 글자만 봅니다', '실수를 막는 장치이지 일부러 피하려는 쪽을 막는 장치가 아닙니다', 'CLI 자체의 셸로 돌리는 명령은 이 검사를 거치지 않습니다']) {
      expect(HOST_COMMAND_GUARD_LIMITS).toContain(s);
    }
    // 두 새 규칙도 글자만 본다는 것, cmd 작은따옴표, 그리고 S5-39가 더한 남은 구멍들
    expect(HOST_COMMAND_GUARD_LIMITS).toContain('서버 운영자 명령과 서버 데이터 폴더도 그 이름이나 경로가 명령에 그대로 적혀 있을 때만 알아봅니다');
    expect(HOST_COMMAND_GUARD_LIMITS).toContain('cmd.exe에서는 작은따옴표가 따옴표가 아니라 그 안의 글도 명령으로 봅니다');
    for (const s of ['파일에 쓴 뒤 실행하는 스크립트', '변수·별칭·함수', 'cd로 옮긴 뒤 상대 경로로 가리키는 서버·데이터 폴더', '-EncodedCommand', '다른 언어의 한 줄 실행', '그 밖의 셸 문법']) {
      expect(HOST_COMMAND_GUARD_LIMITS).toContain(s);
    }
    expect(toolSpec('host_exec')!.description).toContain(HOST_COMMAND_GUARD_LIMITS);
    // 도구 설명은 두 새 규칙을 이름으로 말한다
    for (const s of ['서버 운영자 명령(wook-server', '앱 데이터 폴더나 그 안의 관리 파일(admin.token·admin.endpoint·setup-code.txt)']) expect(toolSpec('host_exec')!.description).toContain(s);
    const design = readFileSync(join(process.cwd(), 'docs', 'SERVER_DESIGN.md'), 'utf8');
    const s82 = design.slice(design.indexOf('### 8.2 셸과 설치'), design.indexOf('### 8.3 화면 조작'));
    expect(s82).toContain(HOST_COMMAND_GUARD_LIMITS);
  });
});
