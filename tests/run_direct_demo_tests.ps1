param([Parameter(Mandatory=$true)][string]$ZigPath)
$ErrorActionPreference='Stop'
$out=Join-Path ([IO.Path]::GetTempPath()) ('direct-demo-tests-'+[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $out | Out-Null
$engine=Join-Path $out 'engine.exe'
$mailbox=Join-Path $out 'mailbox.exe'
& $ZigPath c++ -std=c++17 -Wall -Wextra -Werror (Join-Path $PSScriptRoot 'direct_demo_engine_test.cpp') -o $engine
if($LASTEXITCODE -ne 0){throw 'Engine compile failed'}
& $engine
if($LASTEXITCODE -ne 0){throw 'Engine tests failed'}
& $ZigPath c++ -std=c++17 -Wall -Wextra -Werror -I (Join-Path $PSScriptRoot 'direct_demo_mock') (Join-Path $PSScriptRoot 'direct_demo_mailbox_test.cpp') (Join-Path $PSScriptRoot '..\Arduino\ESP32S3_Telematics\direct_demo.cpp') -o $mailbox
if($LASTEXITCODE -ne 0){throw 'Mailbox compile failed'}
& $mailbox
if($LASTEXITCODE -ne 0){throw 'Mailbox tests failed'}
Write-Output 'PASS actual engine, parser and mailbox on PC. Not physical CAN/SD/AI/voice validation.'
