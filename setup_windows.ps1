param(
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId = '',

    [string]$PythonPath = '',

    [switch]$SkipDependencyInstall
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ExtensionId)) {
    $candidateRoots = @(
        $PSScriptRoot,
        (Join-Path $PSScriptRoot 'dist')
    ) | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'manifest.json') } |
        ForEach-Object { [System.IO.Path]::GetFullPath($_).TrimEnd('\') }
    $chromeUserData = Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data'
    $discovered = @()
    if (Test-Path -LiteralPath $chromeUserData) {
        $preferenceFiles = Get-ChildItem -LiteralPath $chromeUserData -Directory -ErrorAction SilentlyContinue |
            ForEach-Object {
                @((Join-Path $_.FullName 'Secure Preferences'), (Join-Path $_.FullName 'Preferences'))
            } | Where-Object { Test-Path -LiteralPath $_ }
        foreach ($preferenceFile in $preferenceFiles) {
            try {
                $preferences = Get-Content -LiteralPath $preferenceFile -Raw -Encoding UTF8 | ConvertFrom-Json
                $settings = $preferences.extensions.settings
                if ($null -eq $settings) { continue }
                foreach ($entry in $settings.PSObject.Properties) {
                    $storedPath = [string]$entry.Value.path
                    if ([string]::IsNullOrWhiteSpace($storedPath)) { continue }
                    try { $resolvedStoredPath = [System.IO.Path]::GetFullPath($storedPath).TrimEnd('\') } catch { continue }
                    if ($candidateRoots -contains $resolvedStoredPath -and $entry.Name -match '^[a-p]{32}$') {
                        $discovered += $entry.Name
                    }
                }
            }
            catch {
                Write-Verbose "Could not inspect Chrome profile preferences: $preferenceFile"
            }
        }
    }
    $discovered = @($discovered | Select-Object -Unique)
    if ($discovered.Count -eq 1) {
        $ExtensionId = $discovered[0]
        Write-Host "Detected the loaded Look At Me! extension: $ExtensionId" -ForegroundColor Green
    }
    else {
        Write-Host 'Load the dist folder at chrome://extensions first.'
        Write-Host 'Automatic detection did not find exactly one matching unpacked extension.'
        $ExtensionId = (Read-Host 'Paste the 32-character Look At Me! extension ID').Trim()
    }
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
Write-Host "Violation screenshots: $(Join-Path $documents 'LookAtMe\screenshots')"
Write-Host "Violation database:   $(Join-Path $documents 'LookAtMe\database.db')"
