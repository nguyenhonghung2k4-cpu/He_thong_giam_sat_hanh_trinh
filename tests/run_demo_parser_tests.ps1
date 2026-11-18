param([string]$Compiler = '')
$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($Compiler)) {
  foreach ($taskName in @('g++', 'clang++', 'cl', 'zig')) {
    $taskFound = Get-Command $taskName -ErrorAction SilentlyContinue
    if ($null -ne $taskFound) { $Compiler = $taskFound.Source; break }
  }
}
if ([string]::IsNullOrWhiteSpace($Compiler)) {
  throw 'A Windows native C++ compiler is required. Pass -Compiler with g++, clang++, Zig, or cl. This is optional PC testing, not firmware upload.'
}
if ($Compiler -match 'xtensa|riscv|arm-none-eabi') {
  throw 'This is a cross compiler; it cannot execute Windows parser tests.'
}
$taskSource = Join-Path $PSScriptRoot 'demo_json_reader_test.cpp'
$taskBuild = Join-Path ([System.IO.Path]::GetTempPath()) ('telematics-demo-parser-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskBuild | Out-Null
$taskExecutable = Join-Path $taskBuild 'demo_json_reader_test.exe'
$taskObject = Join-Path $taskBuild 'demo_json_reader_test.obj'
$taskCompilerName = [System.IO.Path]::GetFileNameWithoutExtension($Compiler)
if ($taskCompilerName -eq 'cl') {
  & $Compiler /nologo /std:c++14 /EHsc /W4 /WX "/Fe:$taskExecutable" "/Fo:$taskObject" $taskSource
} elseif ($taskCompilerName -eq 'zig') {
  $env:ZIG_GLOBAL_CACHE_DIR = Join-Path $taskBuild 'zig-global-cache'
  $env:ZIG_LOCAL_CACHE_DIR = Join-Path $taskBuild 'zig-local-cache'
  & $Compiler c++ -std=c++11 -Wall -Wextra -Werror $taskSource -o $taskExecutable
} else {
  & $Compiler -std=c++11 -Wall -Wextra -Werror $taskSource -o $taskExecutable
}
if ($LASTEXITCODE -ne 0) { throw "Parser test compilation failed. Build files: $taskBuild" }
& $taskExecutable
if ($LASTEXITCODE -ne 0) { throw "Parser test execution failed. Build files: $taskBuild" }
Write-Output 'This tests the actual bounded C++ JSON reader on PC; it does not test Wi-Fi, ADXL timing, SD power, or a physical ESP32-S3.'
Write-Output "Native test files: $taskBuild"
