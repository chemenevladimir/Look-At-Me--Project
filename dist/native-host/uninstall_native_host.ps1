$ErrorActionPreference = 'Stop'
$hostName = 'com.look_at_me.security'
$registryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName"

if (Test-Path -LiteralPath $registryPath) {
    Remove-Item -LiteralPath $registryPath -Recurse -Force
    Write-Host "Unregistered $hostName"
} else {
    Write-Host "$hostName is not registered for the current user"
}
