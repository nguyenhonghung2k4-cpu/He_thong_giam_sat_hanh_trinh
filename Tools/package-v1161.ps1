param(
  [Parameter(Mandatory=$true)][string]$ProjectRoot,
  [Parameter(Mandatory=$true)][string]$ArchivePath,
  [Parameter(Mandatory=$true)][string]$DatabaseSnapshot
)
$ErrorActionPreference='Stop'
$releaseRoot=(Resolve-Path -LiteralPath $ProjectRoot).Path.TrimEnd('\')
$releaseName=Split-Path -Leaf $releaseRoot
if($releaseName -ne 'HeThongGiamSatHanhTrinh_V11_6_1_Mobile_Demo_Fix_Full_Project'){throw 'Unexpected release directory'}
if(Test-Path -LiteralPath $ArchivePath){throw 'Archive already exists; choose a new output name'}
if(-not(Test-Path -LiteralPath $DatabaseSnapshot -PathType Leaf)){throw 'A consistent SQLite backup is required'}
Add-Type -AssemblyName System.IO.Compression
$files=@(Get-ChildItem -LiteralPath $releaseRoot -File -Recurse -Force | Where-Object {
  $rel=$_.FullName.Substring($releaseRoot.Length+1).Replace('\','/')
  $rel -notmatch '(^|/)(\.git|\.runtime|\.online-runtime|node_modules)(/|$)' -and
  $rel -notmatch '\.(log|db-wal|db-shm)$'
})
$stream=[IO.File]::Open($ArchivePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite)
$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach($file in $files){
    $rel=$file.FullName.Substring($releaseRoot.Length+1).Replace('\','/')
    $source=if($rel -eq 'WebDashboard_Online/data/telematics.db'){$DatabaseSnapshot}else{$file.FullName}
    $entry=$zip.CreateEntry($releaseName+'/'+$rel,[IO.Compression.CompressionLevel]::Optimal)
    $inputFile=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
    $outputFile=$entry.Open()
    try{$inputFile.CopyTo($outputFile)}finally{$outputFile.Dispose();$inputFile.Dispose()}
  }
}finally{$zip.Dispose();$stream.Dispose()}
Write-Output ('Created local private release archive: '+$files.Count+' files')
Write-Output 'Contains private configuration and database. Do not publish or share this archive.'
