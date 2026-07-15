$ErrorActionPreference = 'Continue'

$artifactRoot = Join-Path $PWD 'artifacts/windows-cloak'
New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null

function Write-SanitizedText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [AllowEmptyString()][string]$Text
  )

  $sensitiveLinePattern = '(?i)(authorization|proxy-authorization|set-cookie|cookie|cdp(?:\s+endpoint)?|devtools|page[ _-]?content|document\.|innerhtml|outerhtml|snapshot|<html|<body|\b(?:html|body|content)\b\s*"?\s*:)'
  $liveUrlPattern = '(?i)\b[a-z][a-z0-9+.-]*://[^\s"''<>]+'
  $sanitized = foreach ($line in ($Text -split "`r?`n")) {
    if ($line -match $sensitiveLinePattern) {
      '[REDACTED sensitive diagnostic line]'
      continue
    }
    $line -replace $liveUrlPattern, '[REDACTED_URL]'
  }

  $sanitized | Set-Content -LiteralPath $Path -Encoding utf8
}

function Write-SanitizedJson {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyCollection()]$Value
  )

  Write-SanitizedText -Path $Path -Text (ConvertTo-Json -InputObject $Value -Depth 20)
}

$runnerMetadata = [ordered]@{
  collectedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
  nodeVersion = (& node --version 2>&1 | Out-String).Trim()
  npmVersion = (& npm --version 2>&1 | Out-String).Trim()
  runner = [ordered]@{
    os = $env:RUNNER_OS
    architecture = $env:RUNNER_ARCH
    imageOs = $env:ImageOS
    imageVersion = $env:ImageVersion
    machineName = $env:COMPUTERNAME
  }
  github = [ordered]@{
    runId = $env:GITHUB_RUN_ID
    runAttempt = $env:GITHUB_RUN_ATTEMPT
    sha = $env:GITHUB_SHA
  }
}

try {
  $windows = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $runnerMetadata['windows'] = [ordered]@{
    caption = $windows.Caption
    version = $windows.Version
    buildNumber = $windows.BuildNumber
  }
} catch {
  $runnerMetadata['windows'] = @{ error = 'Windows metadata unavailable' }
}
Write-SanitizedJson -Path (Join-Path $artifactRoot 'runner-metadata.json') -Value $runnerMetadata

$headers = @{ 'X-Webcmd' = '1' }
try {
  $daemonStatus = Invoke-RestMethod -Uri 'http://127.0.0.1:9777/status' -Headers $headers -TimeoutSec 5
  Write-SanitizedJson -Path (Join-Path $artifactRoot 'daemon-status.json') -Value $daemonStatus
} catch {
  Write-SanitizedText -Path (Join-Path $artifactRoot 'daemon-status.txt') -Text 'Daemon status unavailable.'
}

try {
  $daemonLogs = Invoke-RestMethod -Uri 'http://127.0.0.1:9777/logs' -Headers $headers -TimeoutSec 5
  Write-SanitizedJson -Path (Join-Path $artifactRoot 'daemon-logs.json') -Value $daemonLogs
} catch {
  Write-SanitizedText -Path (Join-Path $artifactRoot 'daemon-logs.txt') -Text 'Daemon logs unavailable.'
}

$processMetadata = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -match '(?i)^(node|chrome|chromium|cloak)' } |
  ForEach-Object {
    [ordered]@{
      name = $_.ProcessName
      id = $_.Id
      startedAtUtc = if ($_.StartTime) { $_.StartTime.ToUniversalTime().ToString('o') } else { $null }
      workingSetBytes = $_.WorkingSet64
      cpuSeconds = $_.CPU
    }
  }
Write-SanitizedJson -Path (Join-Path $artifactRoot 'process-metadata.json') -Value @($processMetadata)

$cloakRoot = if ($env:USERPROFILE) { Join-Path $env:USERPROFILE '.webcmd/cloak' } else { $null }
$cloakLogMetadata = @()
if ($cloakRoot -and (Test-Path -LiteralPath $cloakRoot)) {
  $cloakLogMetadata = Get-ChildItem -LiteralPath $cloakRoot -Recurse -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Extension -eq '.log' -or $_.Name -match '(?i)(debug|log)' } |
    ForEach-Object {
      [ordered]@{
        relativePath = [System.IO.Path]::GetRelativePath($cloakRoot, $_.FullName)
        bytes = $_.Length
        lastWriteUtc = $_.LastWriteTimeUtc.ToString('o')
      }
    }
}
Write-SanitizedJson -Path (Join-Path $artifactRoot 'cloak-log-metadata.json') -Value @($cloakLogMetadata)

Write-Host "Sanitized diagnostics written to $artifactRoot"
