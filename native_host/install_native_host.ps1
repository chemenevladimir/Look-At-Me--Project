param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [string]$PythonPath = '',

    [string]$InstallRoot = '',

    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.look_at_me.security'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $nativeDir
$agentPath = Join-Path $projectRoot 'local_security_agent.py'
$evidenceStorePath = Join-Path $projectRoot 'local_evidence_store.py'
$requirementsPath = Join-Path $projectRoot 'requirements-agent.txt'
$packagedAgentPath = Join-Path $nativeDir 'local_security_agent.py'
$packagedEvidenceStorePath = Join-Path $nativeDir 'local_evidence_store.py'
$packagedRequirementsPath = Join-Path $nativeDir 'requirements-agent.txt'
$vendorPath = Join-Path $nativeDir 'vendor'

if (-not (Test-Path -LiteralPath $agentPath)) {
    $agentPath = $packagedAgentPath
    $evidenceStorePath = $packagedEvidenceStorePath
    $requirementsPath = $packagedRequirementsPath
}
if (-not (Test-Path -LiteralPath $agentPath)) {
    throw "Security agent was not found in the repository or packaged native-host directory."
}
if (-not (Test-Path -LiteralPath $evidenceStorePath)) {
    throw "Local evidence store was not found in the repository or packaged native-host directory."
}

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    $pythonCandidates = @()
    $pythonLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($pythonLauncher) {
        try { $pythonCandidates += (& $pythonLauncher.Source -3 -c 'import sys; print(sys.executable)').Trim() } catch { }
    }
    foreach ($commandName in @('python.exe', 'python')) {
        $pythonCommand = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($pythonCommand) { $pythonCandidates += $pythonCommand.Source }
    }
    $existingManifestRegistry = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
    if (Test-Path -LiteralPath $existingManifestRegistry) {
        try {
            $existingManifestPath = (Get-Item -LiteralPath $existingManifestRegistry).GetValue('')
            $existingManifest = Get-Content -LiteralPath $existingManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $existingLauncher = Get-Content -LiteralPath $existingManifest.path -ErrorAction Stop
            $pythonLine = $existingLauncher | Where-Object { $_ -match '^"([^"]+python\.exe)"' } | Select-Object -First 1
            if ($pythonLine -match '^"([^"]+python\.exe)"') { $pythonCandidates += $matches[1] }
        } catch { }
    }
    foreach ($registryRoot in @('HKCU:\Software\Python\PythonCore', 'HKLM:\Software\Python\PythonCore')) {
        if (-not (Test-Path -LiteralPath $registryRoot)) { continue }
        Get-ChildItem -LiteralPath $registryRoot -ErrorAction SilentlyContinue | ForEach-Object {
            $installPath = Join-Path $_.PSPath 'InstallPath'
            try {
                $executable = (Get-Item -LiteralPath $installPath).GetValue('ExecutablePath')
                if ($executable) { $pythonCandidates += $executable }
            } catch { }
        }
    }
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $pythonCandidates += Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python*\python.exe') -File -ErrorAction SilentlyContinue | ForEach-Object FullName
    }
    foreach ($candidate in @($pythonCandidates | Where-Object { $_ } | Select-Object -Unique)) {
        try {
            $resolvedCandidate = (Resolve-Path -LiteralPath $candidate -ErrorAction Stop).Path
            $versionOk = & $resolvedCandidate -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
            if ($LASTEXITCODE -eq 0) { $PythonPath = $resolvedCandidate; break }
        } catch { }
    }
}
if ([string]::IsNullOrWhiteSpace($PythonPath)) {
    throw 'Python was not found. Install Python 3.10+ or pass -PythonPath explicitly.'
}

$resolvedPython = (Resolve-Path -LiteralPath $PythonPath).Path
if ([string]::IsNullOrWhiteSpace($InstallRoot)) {
    if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        throw 'LOCALAPPDATA is unavailable. Pass -InstallRoot explicitly.'
    }
    $InstallRoot = Join-Path $env:LOCALAPPDATA 'LookAtMe\native-host'
}

$resolvedInstallRoot = [System.IO.Path]::GetFullPath($InstallRoot)
$dependencyDir = Join-Path $resolvedInstallRoot 'python-packages'
$installedAgentPath = Join-Path $resolvedInstallRoot 'local_security_agent.py'
$installedEvidenceStorePath = Join-Path $resolvedInstallRoot 'local_evidence_store.py'
$installedRequirementsPath = Join-Path $resolvedInstallRoot 'requirements-agent.txt'
New-Item -ItemType Directory -Path $resolvedInstallRoot -Force | Out-Null
Copy-Item -LiteralPath $agentPath -Destination $installedAgentPath -Force
Copy-Item -LiteralPath $evidenceStorePath -Destination $installedEvidenceStorePath -Force
Copy-Item -LiteralPath $requirementsPath -Destination $installedRequirementsPath -Force

if (-not $SkipDependencyInstall) {
    if (-not (Test-Path -LiteralPath $requirementsPath)) {
        throw "Agent requirements were not found: $requirementsPath"
    }
    New-Item -ItemType Directory -Path $dependencyDir -Force | Out-Null
    $bundledWheel = Get-ChildItem -LiteralPath $vendorPath -Filter 'keyboard-0.13.5-*.whl' -File -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bundledWheel) {
        Write-Host 'Installing the bundled keyboard dependency (no internet required).'
        & $resolvedPython -m pip install --disable-pip-version-check --no-index --upgrade --target $dependencyDir $bundledWheel.FullName
    }
    else {
        Write-Host 'Bundled dependency was not found; downloading from requirements-agent.txt.'
        & $resolvedPython -m pip install --disable-pip-version-check --upgrade --target $dependencyDir -r $installedRequirementsPath
    }
    if ($LASTEXITCODE -ne 0) {
        throw "Could not install local security-agent dependencies (pip exit code $LASTEXITCODE)."
    }
}

$launcherPath = Join-Path $resolvedInstallRoot 'look-at-me-security-host.cmd'
$launcher = "@echo off`r`nchcp 65001 > nul`r`nset `"PYTHONPATH=$dependencyDir;%PYTHONPATH%`"`r`n`"$resolvedPython`" `"$installedAgentPath`"`r`n"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($launcherPath, $launcher, $utf8NoBom)

$manifestPath = Join-Path $resolvedInstallRoot "$hostName.json"
$manifest = [ordered]@{
    name = $hostName
    description = 'Look At Me! local Windows security observer'
    path = $launcherPath
    type = 'stdio'
    allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"
New-Item -Path $registryPath -Force | Out-Null
Set-Item -Path $registryPath -Value $manifestPath

Write-Host "Registered $hostName for extension $ExtensionId"
Write-Host "Manifest: $manifestPath"
Write-Host "Installed host: $installedAgentPath"
Write-Host "Python: $resolvedPython"
if ($SkipDependencyInstall) {
    Write-Warning 'Dependency installation was skipped. The selected Python environment must already provide keyboard==0.13.5.'
}
else {
    Write-Host "Dependencies: $dependencyDir"
}
