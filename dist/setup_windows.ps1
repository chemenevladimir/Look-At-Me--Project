param(
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId = '',

    [string]$PythonPath = '',

    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
    Write-Host '1. Open chrome://extensions'
    Write-Host '2. Enable Developer mode and load the dist folder as an unpacked extension'
    Write-Host '3. Copy the 32-character Look At Me! extension ID'
    $ExtensionId = (Read-Host 'Paste the Look At Me! extension ID').Trim()
    if ($ExtensionId -notmatch '^[a-p]{32}$') {
        throw 'Chrome extension ID must contain exactly 32 letters from a to p.'
    }
}

$candidates = @(
    (Join-Path $PSScriptRoot 'native_host\install_native_host.ps1'),
    (Join-Path $PSScriptRoot 'dist\native-host\install_native_host.ps1'),
    (Join-Path $PSScriptRoot 'native-host\install_native_host.ps1')
)
$installer = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $installer) {
    throw 'Native Messaging installer was not found. Download the complete repository or run pnpm build.'
}

$arguments = @{ ExtensionId = $ExtensionId }
if (-not [string]::IsNullOrWhiteSpace($PythonPath)) {
    $arguments.PythonPath = $PythonPath
}
if ($SkipDependencyInstall) {
    $arguments.SkipDependencyInstall = $true
}

& $installer @arguments
if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "Native Messaging setup failed with exit code $LASTEXITCODE."
}

$documents = [Environment]::GetFolderPath('MyDocuments')
Write-Host ''
Write-Host 'Look At Me! local screenshot storage is ready.' -ForegroundColor Green
Write-Host "Reload the extension at chrome://extensions and start proctoring on an ordinary website."
Write-Host "Violation screenshots: $(Join-Path $documents 'LookAtMeViolations\screenshots')"
Write-Host "Violation database:   $(Join-Path $documents 'LookAtMeViolations\violations.db')"
