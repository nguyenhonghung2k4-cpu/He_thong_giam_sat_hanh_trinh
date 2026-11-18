param(
  [Parameter(Mandatory = $true)][string]$ModelSourceDir,
  [Parameter(Mandatory = $true)][string]$ZigPath
)
$ErrorActionPreference = 'Stop'
$sampleLib = (Resolve-Path -LiteralPath $ModelSourceDir).Path
$sampleCompiler = (Resolve-Path -LiteralPath $ZigPath).Path
$sampleSdk = Join-Path $sampleLib 'edge-impulse-sdk'
$sampleBuild = Join-Path $PSScriptRoot '.host-demo-inference'
New-Item -ItemType Directory -Path $sampleBuild -Force | Out-Null
$env:ZIG_GLOBAL_CACHE_DIR = Join-Path $sampleBuild 'zig-global-cache'
$env:ZIG_LOCAL_CACHE_DIR = Join-Path $sampleBuild 'zig-local-cache'
$sampleManifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../WebDashboard_Online/demo_samples/manifest.json') -Raw | ConvertFrom-Json
$sampleMetadata = Get-FileHash -LiteralPath (Join-Path $sampleLib 'model-parameters/model_metadata.h') -Algorithm SHA256
if ($sampleMetadata.Hash.ToLowerInvariant() -ne $sampleManifest.model.metadata_sha256) {
  throw 'Model metadata is not the bundled deployment; do not compare different models.'
}
$sampleSources = @(
  (Join-Path $PSScriptRoot 'demo_samples_host_probe.cpp'),
  "$sampleLib/tflite-model/tflite_learn_1081808_4_compiled.cpp",
  "$sampleSdk/dsp/kissfft/kiss_fft.cpp",
  "$sampleSdk/dsp/kissfft/kiss_fftr.cpp",
  "$sampleSdk/dsp/dct/fast-dct-fft.cpp",
  "$sampleSdk/dsp/memory.cpp",
  "$sampleSdk/tensorflow/lite/micro/kernels/fully_connected.cpp",
  "$sampleSdk/tensorflow/lite/micro/kernels/fully_connected_common.cpp",
  "$sampleSdk/tensorflow/lite/micro/kernels/softmax.cpp",
  "$sampleSdk/tensorflow/lite/micro/kernels/softmax_common.cpp",
  "$sampleSdk/tensorflow/lite/micro/kernels/kernel_util_micro.cpp",
  "$sampleSdk/tensorflow/lite/micro/kernels/micro_tensor_utils.cpp",
  "$sampleSdk/tensorflow/lite/kernels/kernel_util_lite.cpp",
  "$sampleSdk/tensorflow/lite/kernels/internal/quantization_util.cpp",
  "$sampleSdk/tensorflow/lite/core/api/common.cpp",
  "$sampleSdk/tensorflow/lite/core/api/tensor_utils.cpp",
  "$sampleSdk/tensorflow/lite/core/api/flatbuffer_conversions.cpp",
  "$sampleSdk/tensorflow/lite/core/api/error_reporter.cpp",
  "$sampleSdk/tensorflow/lite/kernels/internal/portable_tensor_utils.cpp",
  "$sampleSdk/tensorflow/lite/kernels/internal/tensor_utils.cpp",
  "$sampleSdk/tensorflow/lite/kernels/internal/reference_portable_tensor_utils.cpp"
)
$sampleSources += Get-ChildItem -LiteralPath "$sampleSdk/tensorflow/lite/micro" -Filter '*.cpp' |
  Where-Object { $_.Name -notmatch '^(all_ops|fake_|mock_|test_|micro_interpreter|op_resolver_bridge)' } |
  Select-Object -ExpandProperty FullName
$sampleSources += Get-ChildItem -LiteralPath "$sampleSdk/tensorflow/lite/micro/memory_planner" -Filter '*.cpp' |
  Select-Object -ExpandProperty FullName
$sampleExecutable = Join-Path $sampleBuild 'demo_samples_host_probe.exe'
& $sampleCompiler c++ -O2 -std=c++17 `
  -DEI_CLASSIFIER_TFLITE_ENABLE_CMSIS_NN=0 -DEI_CLASSIFIER_ENABLE_DETECTION_POSTPROCESS_OP=0 `
  -I $sampleLib -I "$sampleSdk" -I "$sampleSdk/third_party/flatbuffers/include" `
  -I "$sampleSdk/third_party/gemmlowp" -I "$sampleSdk/third_party/ruy" `
  @sampleSources -o $sampleExecutable
if ($LASTEXITCODE -ne 0) { throw 'Host classifier compilation failed.' }
& node (Join-Path $PSScriptRoot 'demo_samples_host_test.mjs') $sampleExecutable
exit $LASTEXITCODE
