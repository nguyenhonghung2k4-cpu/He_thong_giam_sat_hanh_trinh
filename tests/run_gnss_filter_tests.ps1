param([string]$Compiler = '')
$ErrorActionPreference = 'Stop'

# Native host test only. The Arduino Xtensa compiler cannot produce a Windows
# executable; do not report a syntax-only check as execution of these tests.
if ([string]::IsNullOrWhiteSpace($Compiler)) {
  foreach ($taskName in @('g++', 'clang++', 'cl', 'zig')) {
    $taskFound = Get-Command $taskName -ErrorAction SilentlyContinue
    if ($null -ne $taskFound) { $Compiler = $taskFound.Source; break }
  }
}
if ([string]::IsNullOrWhiteSpace($Compiler)) {
  throw 'A native C++ compiler is required: g++, clang++, Zig, or cl in a Visual Studio Developer PowerShell. Pass -Compiler with its executable path. Arduino/Xtensa is not a host compiler.'
}
if ($Compiler -match 'xtensa|riscv|arm-none-eabi') {
  throw 'This is a cross compiler. Use a Windows native compiler to execute the deterministic tests.'
}

$taskSource = Join-Path $PSScriptRoot 'gnss_position_filter_test.cpp'
$taskBuild = Join-Path ([System.IO.Path]::GetTempPath()) ('telematics-gnss-test-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskBuild | Out-Null
$taskExecutable = Join-Path $taskBuild 'gnss_filter_test.exe'
$taskObject = Join-Path $taskBuild 'gnss_filter_test.obj'
$taskCompilerName = [System.IO.Path]::GetFileNameWithoutExtension($Compiler)

if ($taskCompilerName -eq 'cl') {
  & $Compiler /nologo /std:c++14 /EHsc /W4 /WX "/Fe:$taskExecutable" "/Fo:$taskObject" $taskSource
} elseif ($taskCompilerName -eq 'zig') {
  & $Compiler c++ -std=c++11 -Wall -Wextra -Werror $taskSource -o $taskExecutable
} else {
  & $Compiler -std=c++11 -Wall -Wextra -Werror $taskSource -o $taskExecutable
}
if ($LASTEXITCODE -ne 0) { throw "GNSS test compilation failed. Build files: $taskBuild" }
& $taskExecutable
if ($LASTEXITCODE -ne 0) { throw "GNSS test execution failed. Build files: $taskBuild" }
Write-Output 'This tests the actual filter C++ with synthetic fixes. It does not validate antenna placement, GNSS accuracy, hardware timing, or real-road alerts.'
Write-Output "Native test files: $taskBuild"
