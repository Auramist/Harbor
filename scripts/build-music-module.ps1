param([switch]$Release)
$ErrorActionPreference = 'Stop'
Set-Location (Resolve-Path (Join-Path $PSScriptRoot '..'))
$manifest = 'src-tauri/music-module/Cargo.toml'
$arguments = @('build', '--manifest-path', $manifest, '--locked')
$configuration = 'debug'
if ($Release) { $arguments += '--release'; $configuration = 'release' }
& cargo @arguments
if ($LASTEXITCODE -ne 0) { throw 'Music module build failed' }
$source = "src-tauri/music-module/target/$configuration/harbor-music-module.exe"
$destination = 'src-tauri/resources/music-module'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
Copy-Item -LiteralPath $source -Destination "$destination/harbor-music-module.exe" -Force
$version = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
@{ kind='harbor-music'; abi=1; version=$version } | ConvertTo-Json | Set-Content "$destination/music-module.json" -Encoding utf8
Write-Host "Music module staged for development at $destination"
Write-Host "Module is experimental and must not be included in production Shipyard until the full Music host is extracted."
