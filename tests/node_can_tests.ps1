param([Parameter(Mandatory=$true)][string]$ZigPath)
$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('node-can-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDirectory | Out-Null
foreach ($testName in @('node_can_policy_test', 'node_can_integration_test')) {
  $executable = Join-Path $workDirectory ($testName + '.exe')
  & $ZigPath c++ -std=c++11 -Wall -Wextra -Werror -I (Join-Path $testRoot 'node_can_mock') (Join-Path $testRoot ($testName + '.cpp')) -o $executable
  if ($LASTEXITCODE -ne 0) { throw "$testName compilation failed." }
  & $executable
  if ($LASTEXITCODE -ne 0) { throw "$testName failed." }
}
Write-Host "NODE host test executables: $workDirectory"
