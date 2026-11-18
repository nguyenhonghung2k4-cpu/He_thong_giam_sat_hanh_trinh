$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 reads UTF-8 scripts correctly when this file has a
# UTF-8 BOM. Keep the console explicitly on UTF-8 as well so Vietnamese prompts
# render correctly in both classic CMD and Windows Terminal.
$consoleUtf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $consoleUtf8
[Console]::OutputEncoding = $consoleUtf8
$OutputEncoding = $consoleUtf8
$projectRoot = Split-Path -Parent $PSScriptRoot
$firmwareConfigPath = Join-Path $projectRoot "Arduino\ESP32S3_Telematics\config.h"
$dashboardConfigPath = Join-Path $projectRoot "WebDashboard_Online\config.local.json"

function Get-Define([string]$content, [string]$name, [string]$fallback) {
  $pattern = '(?m)^[ \t]*#[ \t]*define[ \t]+' + [regex]::Escape($name) + '[ \t]+"((?:\\.|[^"\\\r\n])*)"'
  $match = [regex]::Match($content, $pattern)
  if ($match.Success) { return Unescape-Cpp $match.Groups[1].Value }
  return $fallback
}

function Unescape-Cpp([string]$value) {
  # Decode the escapes emitted by Escape-Cpp, without treating dollars as
  # replacement syntax or interpreting literal backslashes a second time.
  return [regex]::Replace($value, '\\(.)', [Text.RegularExpressions.MatchEvaluator]{
    param($escapeMatch)
    switch -CaseSensitive ($escapeMatch.Groups[1].Value) {
      '\' { return '\' }
      '"' { return '"' }
      "'" { return "'" }
      '?' { return '?' }
      'a' { return [string][char]7 }
      'b' { return [string][char]8 }
      'f' { return [string][char]12 }
      'n' { return "`n" }
      'r' { return "`r" }
      't' { return "`t" }
      'v' { return [string][char]11 }
      default { throw 'Unsupported C++ string escape in config.h; use literal characters or standard escaped quotes/backslashes before configuring.' }
    }
  })
}

function Escape-Cpp([string]$value) {
  return $value.Replace('\', '\\').Replace('"', '\"').Replace([string][char]7, '\a').Replace([string][char]8, '\b').Replace([string][char]12, '\f').Replace("`n", '\n').Replace("`r", '\r').Replace("`t", '\t').Replace([string][char]11, '\v')
}

function Set-Define([string]$content, [string]$name, [string]$value) {
  $escaped = Escape-Cpp $value
  # A long macro name must still be separated from its quoted value.
  $line = "#define $name ".PadRight(24) + "`"$escaped`""
  $pattern = '(?m)^[ \t]*#[ \t]*define[ \t]+' + [regex]::Escape($name) + '\b[^\r\n]*'
  $defineRegex = [regex]::new($pattern)
  if ($defineRegex.IsMatch($content)) {
    $literalReplacement = [Text.RegularExpressions.MatchEvaluator]{ param($defineMatch) return $line }
    return $defineRegex.Replace($content, $literalReplacement, 1)
  }
  return $content + "`r`n" + $line + "`r`n"
}

function Test-ServerIPv4([string]$value) {
  # IPAddress.TryParse also accepts IPv6 and shortened/hexadecimal IPv4 forms.
  # Require the four decimal octets expected by the LAN URL shown to the user.
  if ($value -notmatch '^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$') { return $false }
  $parsedAddress = $null
  return [Net.IPAddress]::TryParse($value, [ref]$parsedAddress) -and $parsedAddress.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork
}

function Resolve-InputOrCurrent([string]$value, [string]$current, [switch]$WhitespaceIsBlank) {
  if ([string]::IsNullOrEmpty($value) -or ($WhitespaceIsBlank -and [string]::IsNullOrWhiteSpace($value))) { return $current }
  return $value
}

$firmware = [IO.File]::ReadAllText($firmwareConfigPath)
$dashboard = Get-Content -Raw -Encoding UTF8 $dashboardConfigPath | ConvertFrom-Json

$addresses = @()
foreach ($adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
  if ($adapter.OperationalStatus -ne [Net.NetworkInformation.OperationalStatus]::Up) { continue }
  foreach ($address in $adapter.GetIPProperties().UnicastAddresses) {
    if ($address.Address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { continue }
    $ip = $address.Address.ToString()
    if ($ip -eq "127.0.0.1" -or $ip.StartsWith("169.254.")) { continue }
    $virtual = $adapter.Name -match "VMware|Virtual|vEthernet|Loopback"
    $addresses += [pscustomobject]@{ Name = $adapter.Name; IP = $ip; Virtual = $virtual }
  }
}
$addresses = @($addresses | Sort-Object Virtual, Name, IP)
$preferred = ($addresses | Where-Object { -not $_.Virtual } | Select-Object -First 1).IP
if (-not $preferred) { $preferred = ($addresses | Select-Object -First 1).IP }
if (-not $preferred) { $preferred = "192.168.1.10" }

Write-Host "`nCác địa chỉ IPv4 phát hiện được:" -ForegroundColor Cyan
foreach ($item in $addresses) { Write-Host "  $($item.Name): $($item.IP)" }
$serverIp = Read-Host "IPv4 máy tính chạy dashboard [$preferred]"
$serverIp = Resolve-InputOrCurrent $serverIp $preferred -WhitespaceIsBlank
if (-not (Test-ServerIPv4 $serverIp)) { throw "IPv4 không hợp lệ: $serverIp" }

$currentSsid = Get-Define $firmware "WIFI_SSID" "YOUR_WIFI_SSID"
$ssid = Read-Host "Tên Wi-Fi/SSID [$currentSsid]"
$ssid = Resolve-InputOrCurrent $ssid $currentSsid -WhitespaceIsBlank
$securePassword = Read-Host "Mật khẩu Wi-Fi (Enter để giữ giá trị hiện tại)" -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
$password = Resolve-InputOrCurrent $password (Get-Define $firmware "WIFI_PASSWORD" "YOUR_WIFI_PASSWORD")

$currentDevice = Get-Define $firmware "DEVICE_ID" "blackbox-esp32s3-01"
$deviceId = Read-Host "Mã thiết bị [$currentDevice]"
$deviceId = Resolve-InputOrCurrent $deviceId $currentDevice -WhitespaceIsBlank

$serverUrl = "http://${serverIp}:$($dashboard.port)"
$firmware = Set-Define $firmware "WIFI_SSID" $ssid
$firmware = Set-Define $firmware "WIFI_PASSWORD" $password
$firmware = Set-Define $firmware "SERVER_URL" $serverUrl
$firmware = Set-Define $firmware "DEVICE_ID" $deviceId
$firmware = Set-Define $firmware "HTTP_API_KEY" ([string]$dashboard.ingestApiKey)
$firmware = Set-Define $firmware "SITES_BYPASS_TOKEN" ""
$firmware = [regex]::Replace($firmware, "(?m)^#define\s+TLS_ALLOW_INSECURE\b.*$", "#define TLS_ALLOW_INSECURE  0", 1)
[IO.File]::WriteAllText($firmwareConfigPath, $firmware, [Text.UTF8Encoding]::new($false))

# Auto Demo uses a separate simulated device ID. Mirror its two proximity
# warnings to the physical Gateway selected above so MAX98357A can speak too.
if ($dashboard.PSObject.Properties.Name -contains "demoSpeakerEnabled") { $dashboard.demoSpeakerEnabled = $true }
else { $dashboard | Add-Member -NotePropertyName demoSpeakerEnabled -NotePropertyValue $true }
if ($dashboard.PSObject.Properties.Name -contains "demoSpeakerDeviceId") { $dashboard.demoSpeakerDeviceId = $deviceId }
else { $dashboard | Add-Member -NotePropertyName demoSpeakerDeviceId -NotePropertyValue $deviceId }
if (-not ($dashboard.PSObject.Properties.Name -contains "demoSpeakerFreshMs")) {
  $dashboard | Add-Member -NotePropertyName demoSpeakerFreshMs -NotePropertyValue 10000
}
if (-not ($dashboard.PSObject.Properties.Name -contains "demoSpeakerCommandTtlMs")) {
  $dashboard | Add-Member -NotePropertyName demoSpeakerCommandTtlMs -NotePropertyValue 12000
}
$dashboardJson = $dashboard | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($dashboardConfigPath, $dashboardJson + "`r`n", [Text.UTF8Encoding]::new($false))

Write-Host "`nĐã cấu hình firmware thành công." -ForegroundColor Green
Write-Host "  Server   : $serverUrl"
Write-Host "  Device ID: $deviceId"
Write-Host "  API key  : đã đồng bộ với dashboard"
Write-Host "  Loa demo : bật cho Gateway $deviceId"
Write-Host "`nTiếp theo: chạy START_ONLINE.bat, rồi mở Arduino IDE và Upload firmware."
Write-Host "  Điện thoại có thể dùng mạng khác. Gateway vẫn phải tới được IP máy tính ở trên."
