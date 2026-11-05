# Run while dev:web serves port 5199. All profiles and images stay in docs/design.
$design = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\docs\design'))
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$base = 'http://127.0.0.1:5199/'
$captures = @(
  @{ Name = 'v3-login'; Query = '' },
  @{ Name = 'v3-home'; Query = '?officeDemo=busy&capture=home' },
  @{ Name = 'v3-studio-idle'; Query = '?officeDemo=idle' },
  @{ Name = 'v3-studio-busy'; Query = '?officeDemo=busy' },
  @{ Name = 'v3-studio-events'; Query = '?officeDemo=events' },
  @{ Name = 'v3-member'; Query = '?officeDemo=busy&capture=member' },
  @{ Name = 'v3-documents'; Query = '?officeDemo=busy&capture=documents' },
  @{ Name = 'v3-settings'; Query = '?officeDemo=busy&capture=settings' }
)
foreach ($capture in $captures) {
  $profile = [System.IO.Path]::GetFullPath((Join-Path $design ('.capture-' + $capture.Name)))
  $file = Join-Path $design ($capture.Name + '.png')
  if (-not $profile.StartsWith($design + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Profile escaped design directory' }
  & $edge '--headless' '--disable-gpu' '--no-sandbox' '--no-first-run' '--hide-scrollbars' "--user-data-dir=$profile" '--window-size=1440,900' '--force-device-scale-factor=1' '--virtual-time-budget=5000' "--screenshot=$file" ($base + $capture.Query) 2>$null | Out-Null
  if (-not (Test-Path -LiteralPath $file)) { throw "Capture failed: $file" }
  Write-Output "$($capture.Name): $((Get-Item -LiteralPath $file).Length) bytes"
}
