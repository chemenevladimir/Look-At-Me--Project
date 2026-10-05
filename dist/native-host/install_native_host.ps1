param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,

    [string]$PythonPath = '',

    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.look_at_me.security'
$nativeDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $nativeDir
$agentPath = Join-Path $projectRoot 'local_security_agent.py'
$requirementsPath = Join-Path $projectRoot 'requirements-agent.txt'
$packagedAgentPath = Join-Path $nativeDir 'local_security_agent.py'
$packagedRequirementsPath = Join-Path $nativeDir 'requirements-agent.txt'
$generatedDir = Join-Path $nativeDir 'generated'
$dependencyDir = Join-Path $generatedDir 'python-packages'

if (-not (Test-Path -LiteralPath $agentPath)) {
    $agentPath = $packagedAgentPath
    $requirementsPath = $packagedRequirementsPath
}
if (-not (Test-Path -LiteralPath $agentPath)) {
    throw "Security agent was not found in the repository or packaged native-host directory."
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
New-Item -ItemType Directory -Path $generatedDir -Force | Out-Null

if (-not $SkipDependencyInstall) {
    if (-not (Test-Path -LiteralPath $requirementsPath)) {
        throw "Agent requirements were not found: $requirementsPath"
    }
    New-Item -ItemType Directory -Path $dependencyDir -Force | Out-Null
    & $resolvedPython -m pip install --disable-pip-version-check --upgrade --target $dependencyDir -r $requirementsPath
    if ($LASTEXITCODE -ne 0) {
        throw "Could not install local security-agent dependencies (pip exit code $LASTEXITCODE)."
    }
}

$launcherPath = Join-Path $generatedDir 'look-at-me-security-host.cmd'
$launcher = "@echo off`r`nchcp 65001 > nul`r`nset `"PYTHONPATH=$dependencyDir;%PYTHONPATH%`"`r`n`"$resolvedPython`" `"$agentPath`"`r`n"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText($launcherPath, $launcher, $utf8NoBom)

$manifestPath = Join-Path $generatedDir "$hostName.json"
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
Write-Host "Python: $resolvedPython"
if ($SkipDependencyInstall) {
    Write-Warning 'Dependency installation was skipped. The selected Python environment must already provide keyboard==0.13.5.'
}
else {
    Write-Host "Dependencies: $dependencyDir"
}
