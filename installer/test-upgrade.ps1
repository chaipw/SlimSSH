param(
  [string]$Makensis = 'C:\Program Files (x86)\NSIS\makensis.exe',
  [string]$AppBinary,
  [string]$TestRoot = (Join-Path $env:TEMP ('SlimSSH installer tests ' + [guid]::NewGuid()))
)

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
$TestRoot = (Resolve-Path -LiteralPath $TestRoot).Path
$installerScript = Join-Path $PSScriptRoot 'slimssh.nsi'

function Build-Installer([string]$script, [string[]]$definitions) {
  & $Makensis /V2 @definitions $script
  if ($LASTEXITCODE -ne 0) { throw "NSIS compilation failed: $script" }
}

function Assert-Equal($actual, $expected, [string]$message) {
  if ($actual -ne $expected) { throw "$message (expected $expected, received $actual)" }
}

$fixtureScript = Join-Path $TestRoot 'fixture.nsi'
@'
Unicode true
Name "SlimSSH version fixture"
OutFile "${TEST_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
VIProductVersion "${TEST_VERSION}"
VIAddVersionKey "ProductName" "SlimSSH"
VIAddVersionKey "FileDescription" "SlimSSH installer test fixture"
VIAddVersionKey "FileVersion" "${TEST_VERSION}"
VIAddVersionKey "LegalCopyright" "SlimSSH test fixture"
Section
  Sleep 30000
SectionEnd
'@ | Set-Content -LiteralPath $fixtureScript -Encoding utf8

$fixtures = @{}
foreach ($version in @('0.1.1.0', '0.1.2.0', '0.1.10.0')) {
  $output = Join-Path $TestRoot "fixture-$version.exe"
  Build-Installer $fixtureScript @("/DTEST_VERSION=$version", "/DTEST_OUTPUT=$output")
  $fixtures[$version] = $output
}

$payload = if ($AppBinary) { (Resolve-Path -LiteralPath $AppBinary).Path } else { $fixtures['0.1.2.0'] }
$setup = Join-Path $TestRoot 'SlimSSH-Setup-test.exe'
$failureSetup = Join-Path $TestRoot 'setup-copy-failure.exe'
# Compile the production version-check/upgrade code, but isolate admin access,
# shortcuts and registry writes. Only files inside each test directory change.
$definitions = @('/DSLIMSSH_INSTALLER_TEST', "/DAPP_BINARY=$payload")
Build-Installer $installerScript ($definitions + "/DINSTALLER_OUTPUT=$setup")
Build-Installer $installerScript ($definitions + @('/DSLIMSSH_TEST_FAIL_COPY', "/DINSTALLER_OUTPUT=$failureSetup"))

$results = @()
foreach ($case in @('fresh', 'older', 'same', 'newer', 'unknown', 'locked', 'rollback', 'existing-backup')) {
  $directory = Join-Path $TestRoot $case
  New-Item -ItemType Directory -Path $directory | Out-Null
  $target = Join-Path $directory 'SlimSSH.exe'
  $backup = $target + '.upgrade-backup'
  $sentinel = Join-Path $directory 'keep user files.txt'
  Set-Content -LiteralPath $sentinel -Value 'must survive installation' -Encoding utf8
  $before = $null
  if ($case -ne 'fresh') {
    $version = switch ($case) { 'same' {'0.1.2.0'} 'newer' {'0.1.10.0'} default {'0.1.1.0'} }
    Copy-Item -LiteralPath $fixtures[$version] -Destination $target
    if ($case -eq 'unknown') { Set-Content -LiteralPath $target -Value 'not a versioned executable' }
    $before = (Get-FileHash -LiteralPath $target).Hash
  }
  if ($case -eq 'existing-backup') { Set-Content -LiteralPath $backup -Value 'keep recovery backup' }
  $runningFixture = $null
  try {
    if ($case -eq 'locked') {
      $runningFixture = Start-Process -FilePath $target -ArgumentList '/S' -WindowStyle Hidden -PassThru
      Start-Sleep -Milliseconds 500
      if ($runningFixture.HasExited) { throw 'Version fixture exited before lock test' }
    }
    $package = if ($case -eq 'rollback') { $failureSetup } else { $setup }
    $process = Start-Process -FilePath $package -ArgumentList "/S /D=$directory" -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(30000)) {
      $process.Kill()
      throw "Installer timed out for $case"
    }
    $process.Refresh()
    $exit = $process.ExitCode
    $expected = switch ($case) { 'fresh' {0} 'older' {0} 'same' {1638} 'newer' {1638} 'unknown' {13} default {5} }
    Assert-Equal $exit $expected "$case exit code"
    if ($case -in @('fresh', 'older')) {
      Assert-Equal (Get-FileHash -LiteralPath $target).Hash (Get-FileHash -LiteralPath $payload).Hash "$case payload"
      Assert-Equal (Test-Path -LiteralPath (Join-Path $directory 'uninstall.exe')) $true "$case uninstaller"
    } else {
      Assert-Equal (Get-FileHash -LiteralPath $target).Hash $before "$case preserves original executable"
      Assert-Equal (Test-Path -LiteralPath (Join-Path $directory 'uninstall.exe')) $false "$case does not write uninstaller"
    }
    Assert-Equal (Get-Content -LiteralPath $sentinel -Raw).Trim() 'must survive installation' "$case preserves user files"
    Assert-Equal (Test-Path -LiteralPath $backup) ($case -eq 'existing-backup') "$case backup handling"
    if ($case -eq 'existing-backup') {
      Assert-Equal (Get-Content -LiteralPath $backup -Raw).Trim() 'keep recovery backup' 'Existing backup is preserved'
    }
    $results += [pscustomobject]@{ Case = $case; ExitCode = $exit; Result = 'Passed' }
  } finally {
    if ($runningFixture -and -not $runningFixture.HasExited) {
      $runningFixture.Kill()
      $runningFixture.WaitForExit()
    }
  }
}
$results | Format-Table -AutoSize
Write-Output "Test artifacts: $TestRoot"
