param([Parameter(Mandatory=$true)][string]$ZigPath)
$ErrorActionPreference='Stop'
$out=Join-Path ([IO.Path]::GetTempPath()) ('road-event-tests-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $out | Out-Null
$exe=Join-Path $out 'road-event.exe'
& $ZigPath c++ -std=c++17 -Wall -Wextra -Werror (Join-Path $PSScriptRoot 'road_event_policy_test.cpp') -o $exe
if($LASTEXITCODE -ne 0){throw 'Road event policy compile failed'}
& $exe
if($LASTEXITCODE -ne 0){throw 'Road event policy tests failed'}
Write-Output 'PASS real event admission policy and engine coordinates on PC; not measured physical AI accuracy.'
