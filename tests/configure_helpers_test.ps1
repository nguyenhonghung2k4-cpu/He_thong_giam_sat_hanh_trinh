$ErrorActionPreference = 'Stop'

# Parse the real helper, but execute ONLY its function definitions. The script's
# prompts, network enumeration and reads/writes of real configuration never run.
$helperPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'Tools\configure-esp32.ps1'
$sourceBytes = [IO.File]::ReadAllBytes($helperPath)
if ($sourceBytes.Length -lt 3 -or $sourceBytes[0] -ne 0xEF -or $sourceBytes[1] -ne 0xBB -or $sourceBytes[2] -ne 0xBF) {
  throw 'Vietnamese configuration helper requires UTF-8 BOM for Windows PowerShell 5.1 -File.'
}
$tokens = $null
$parseErrors = $null
$helperAst = [Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw 'Configuration helper has PowerShell syntax errors.' }
$functionAsts = $helperAst.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst]
}, $false)
foreach ($functionAst in $functionAsts) { Invoke-Expression $functionAst.Extent.Text }

# Source encoding must keep each real Write-Host statement a command rather
# than accidentally swallowing it into the preceding Vietnamese string.
$hostCommands = @($helperAst.FindAll({
  param($node)
  $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Write-Host'
}, $true))
if ($hostCommands.Count -ne 9) { throw 'Expected nine independent Write-Host statements in the configuration helper.' }
$wrongStrings = @($helperAst.FindAll({
  param($node)
  ($node -is [Management.Automation.Language.StringConstantExpressionAst] -or $node -is [Management.Automation.Language.ExpandableStringExpressionAst]) -and
    $node.Extent.Text -match 'Write-Host\s+'
}, $true))
if ($wrongStrings.Count -ne 0) { throw 'A Write-Host command was swallowed into a string; check UTF-8 BOM and quotes.' }

$checks = 0
function Assert-Equal($actual, $expected, [string]$label) {
  if ($actual -cne $expected) { throw "FAIL: $label" }
  $script:checks += 1
}

$syntheticValues = @(
  '',
  'plain-value',
  'cash$&money',
  'cash$$money',
  'group$1-$`-$''-$_',
  'slash\path\',
  'a"quote',
  'combined\"quote$&$$',
  '  keep spaces  ',
  "line1`r`nline2`ttab",
  ('unicode-' + [char]0x1EC7 + [char]0x1ED9)
)
foreach ($value in $syntheticValues) {
  $source = "#define WIFI_PASSWORD `"old`"`r`n#define UNRELATED `"keep`"`r`n"
  $updated = Set-Define $source 'WIFI_PASSWORD' $value
  $decoded = Get-Define $updated 'WIFI_PASSWORD' 'fallback'
  Assert-Equal $decoded $value 'C++ string round-trip'
  Assert-Equal (Get-Define $updated 'UNRELATED' 'fallback') 'keep' 'Unrelated macro preserved'
  Assert-Equal ($updated.Contains("`r`n#define UNRELATED")) $true 'CRLF preserved'
  $accepted = Resolve-InputOrCurrent '' $decoded
  Assert-Equal $accepted $value 'Blank input retains existing value'
  Assert-Equal (Set-Define $updated 'WIFI_PASSWORD' $accepted) $updated 'Repeated configuration is stable'
}

Assert-Equal (Resolve-InputOrCurrent '   ' 'existing' -WhitespaceIsBlank) 'existing' 'Blank SSID/device input keeps default'
Assert-Equal (Resolve-InputOrCurrent '   ' 'existing') '   ' 'Password spaces are retained'
Assert-Equal (Resolve-InputOrCurrent 'new' 'existing') 'new' 'Explicit input replaces default'
Assert-Equal (Get-Define '#define OTHER "test"' 'MISSING' 'fallback') 'fallback' 'Missing macro fallback'
Assert-Equal (Get-Define '#define EMPTY ""' 'EMPTY' 'fallback') '' 'Existing empty string retained'
Assert-Equal (Get-Define '  # define SPACED "kept"' 'SPACED' 'fallback') 'kept' 'Indented macro read'
Assert-Equal (Get-Define (Set-Define '#define OTHER "keep"' 'ADDED' '$&\"') 'ADDED' 'fallback') '$&\"' 'Missing macro append'
Assert-Equal (Get-Define (Set-Define '#define WIFI_PASSWORD_EXTRA "keep"' 'WIFI_PASSWORD' 'new') 'WIFI_PASSWORD_EXTRA' 'fallback') 'keep' 'Macro boundary preserved'
Assert-Equal (Set-Define "#define DUP `"one`"`n#define DUP `"two`"" 'DUP' 'changed') ("#define DUP".PadRight(24) + "`"changed`"`n#define DUP `"two`"") 'Only first matching definition replaced'

foreach ($validIp in @('192.168.1.10', '10.0.0.1', '172.16.8.42', '127.0.0.1')) {
  Assert-Equal (Test-ServerIPv4 $validIp) $true 'Valid dotted IPv4 accepted'
}
foreach ($invalidIp in @('', '::1', '2001:db8::1', '::ffff:192.168.1.10', '192.168.1.256', '192.168.1', '127.1', '0x7f000001', 'not-an-ip', ' 192.168.1.10', '192.168.1.10:3000')) {
  Assert-Equal (Test-ServerIPv4 $invalidIp) $false 'Invalid or non-IPv4 input rejected'
}

foreach ($longName in @('SITES_BYPASS_TOKEN', 'A_VERY_LONG_CONFIGURATION_DEFINE_NAME')) {
  $longUpdated = Set-Define '#define OTHER "keep"' $longName ''
  Assert-Equal (Get-Define $longUpdated $longName 'fallback') '' 'Long macro empty value remains readable'
  Assert-Equal ($longUpdated.Contains("#define $longName " + '""')) $true 'Long macro has required whitespace'
  Assert-Equal (Set-Define $longUpdated $longName '') $longUpdated 'Long macro repeat stable'
}

Write-Output "PASS: $checks configuration-helper checks (synthetic strings and IPv4 inputs only)."
Write-Output 'No prompts, real configuration reads/writes, server starts or Arduino changes were performed.'
