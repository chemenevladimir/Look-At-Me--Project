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
    $pythonCommand = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        $PythonPath = (& $pythonCommand.Source -3 -c 'import sys; print(sys.executable)').Trim()
    }
    else {
        $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
        if (-not $pythonCommand) {
            $pythonCommand = Get-Command python -ErrorAction SilentlyContinue
        }
        if ($pythonCommand) {
            $PythonPath = $pythonCommand.Source
        }
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
    & $resolvedPython -m pip install --disable-pip-version-check --upgrade --target $dependencyDir -r $installedRequirementsPath
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
