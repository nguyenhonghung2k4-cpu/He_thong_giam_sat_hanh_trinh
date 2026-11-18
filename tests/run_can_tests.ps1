param([Parameter(Mandatory=$true)][string]$ZigPath)
$ErrorActionPreference = 'Stop'
$testRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$workDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ('telematics-can-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDirectory | Out-Null
$executable = Join-Path $workDirectory 'can_recovery_test.exe'
& $ZigPath c++ -std=c++11 -Wall -Wextra -Werror -I (Join-Path $testRoot 'can_mock') (Join-Path $testRoot 'can_recovery_test.cpp') -o $executable
if ($LASTEXITCODE -ne 0) { throw 'CAN host test compilation failed.' }
& $executable
if ($LASTEXITCODE -ne 0) { throw 'CAN host test failed.' }
Write-Host "CAN mock test executable: $executable"
