param([Parameter(Mandatory=$true)][string]$ZigPath)
$ErrorActionPreference = 'Stop'
$compiler = (Resolve-Path -LiteralPath $ZigPath).Path
$testDirectory = Join-Path ([IO.Path]::GetTempPath()) ('telematics-audio-startup-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testDirectory | Out-Null
$env:ZIG_GLOBAL_CACHE_DIR = Join-Path $testDirectory 'zig-global'
$env:ZIG_LOCAL_CACHE_DIR = Join-Path $testDirectory 'zig-local'
$executable = Join-Path $testDirectory 'audio_startup_sequence_test.exe'
& $compiler c++ -std=c++11 -Wall -Wextra -Werror (Join-Path $PSScriptRoot 'audio_startup_sequence_test.cpp') -o $executable
if ($LASTEXITCODE -ne 0) { throw 'Audio startup test compilation failed' }
& $executable
if ($LASTEXITCODE -ne 0) { throw 'Audio startup test failed' }
Write-Output "Test files retained in $testDirectory (not needed for Arduino upload)."
