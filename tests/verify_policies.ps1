$ErrorActionPreference = 'Stop'
$taskCompiler = Join-Path $env:LOCALAPPDATA 'Arduino15\packages\esp32\tools\esp-x32\2601\bin\xtensa-esp32s3-elf-g++.exe'
if (-not (Test-Path -LiteralPath $taskCompiler)) {
  throw 'Install Arduino-ESP32 3.3.12 (tested), or update taskCompiler to the installed ESP32-S3 g++ path.'
}
$taskTests = @(
  (Join-Path $PSScriptRoot 'storage_policy_static_test.cpp'),
  (Join-Path $PSScriptRoot 'audio_network_static_test.cpp')
)
& $taskCompiler -std=gnu++17 -Wall -Wextra -Werror -fsyntax-only @taskTests
if ($LASTEXITCODE -ne 0) { throw 'Policy checks failed.' }
Write-Output 'PASS: actual C++ constexpr checks for event ACK ownership, fair SD lanes, newest telemetry and 100% PCM/fade math.'
Write-Output 'These checks do not simulate SD power, I2S hardware, FreeRTOS timing or a real speaker.'
