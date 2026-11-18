param([Parameter(Mandatory=$true)][string]$ZigPath)
$ErrorActionPreference='Stop'
$testBuild=Join-Path ([IO.Path]::GetTempPath()) ('direct-realtime-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testBuild | Out-Null
$exe=Join-Path $testBuild 'direct_realtime_policy_test.exe'
& $ZigPath c++ -std=c++17 -Wall -Wextra -Werror (Join-Path $PSScriptRoot 'direct_realtime_policy_test.cpp') -o $exe
if($LASTEXITCODE -ne 0){throw 'Realtime policy build failed'}
& $exe
if($LASTEXITCODE -ne 0){throw 'Realtime policy test failed'}
Write-Output 'PASS host-only realtime slot/gates/freshness and adaptive potentiometer filter. No physical audio/SD latency measurement.'
