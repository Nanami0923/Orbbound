param([string]$SdkPath = $env:ANDROID_HOME)
$ErrorActionPreference = 'Stop'
Import-Module "$PSHOME/Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1"
Set-Location (Split-Path $PSScriptRoot -Parent)
function Check-Exit { if ($LASTEXITCODE -ne 0) { throw "Build command failed: $LASTEXITCODE" } }
if (!$env:JAVA_HOME) { throw 'Set JAVA_HOME to JDK 21 or newer.' }
if (!$SdkPath -and (Test-Path android/local.properties)) {
    $SdkPath = ((Get-Content android/local.properties | Where-Object { $_ -match '^sdk.dir=' }) -replace '^sdk.dir=', '')
}
if (!(Test-Path "$SdkPath/build-tools/36.0.0/apksigner.bat")) { throw 'Set ANDROID_HOME to an SDK containing build-tools 36.0.0 and platform android-36.' }
$env:ANDROID_HOME = $SdkPath
$env:PATH = "$env:JAVA_HOME/bin;$env:PATH"
$androidVersion = Get-Content android/version.json -Raw | ConvertFrom-Json
$version = [string]$androidVersion.version
if ($version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Android version must use major.minor.patch in android/version.json.' }
$versionParts = $version.Split('.') | ForEach-Object { [long]$_ }
$expectedCode = $versionParts[0] * 10000 + $versionParts[1] * 100 + $versionParts[2]
if ($expectedCode -gt 2100000000) { throw 'Android versionCode exceeds the supported limit.' }
& npm.cmd run sync:android
Check-Exit
& ./android/gradlew.bat -p android assembleRelease
Check-Exit

$apkOutputDir = Join-Path (Get-Location) 'android/app/build/outputs/apk/release'
$metadataPath = Join-Path $apkOutputDir 'output-metadata.json'
if (!(Test-Path -LiteralPath $metadataPath)) { throw 'Gradle release output-metadata.json is missing.' }
$metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$elements = @($metadata.elements)
if ($metadata.artifactType.type -ne 'APK' -or $metadata.variantName -ne 'release' -or $metadata.applicationId -ne 'com.orbbound.game' -or $elements.Count -ne 1) {
    throw 'Gradle Android release metadata does not describe the expected single release APK.'
}
$element = $elements[0]
if ([string]$element.versionName -ne $version -or [long]$element.versionCode -ne $expectedCode -or $element.outputFile -ne 'app-release-unsigned.apk') {
    throw 'Gradle Android release metadata version does not match android/version.json.'
}
$unsignedApk = Join-Path $apkOutputDir $element.outputFile
if (!(Test-Path -LiteralPath $unsignedApk)) { throw 'Gradle release APK named in output-metadata.json is missing.' }

# Keep the release identity outside the repository and reuse it for every update.
$signingDir = Join-Path $env:LOCALAPPDATA 'Orbbound/signing'
New-Item -ItemType Directory -Force $signingDir | Out-Null
$keyPath = Join-Path $signingDir 'release.jks'
$passwordPath = Join-Path $signingDir 'password.dpapi'
if (!(Test-Path $keyPath)) {
    if (Test-Path $passwordPath) { throw 'Signing password exists but key is missing; restore the key before releasing.' }
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    $env:ORBBOUND_SIGNING_PASSWORD = [Convert]::ToBase64String($bytes)
    ConvertTo-SecureString $env:ORBBOUND_SIGNING_PASSWORD -AsPlainText -Force | ConvertFrom-SecureString | Set-Content $passwordPath
    & "$env:JAVA_HOME/bin/keytool.exe" -genkeypair -keystore $keyPath -storetype JKS -alias orbbound -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Orbbound' -storepass:env ORBBOUND_SIGNING_PASSWORD -keypass:env ORBBOUND_SIGNING_PASSWORD
    Check-Exit
} else {
    $secure = Get-Content $passwordPath | ConvertTo-SecureString
    $env:ORBBOUND_SIGNING_PASSWORD = [Net.NetworkCredential]::new('', $secure).Password
}
try {
    $outputDir = Join-Path (Get-Location) "最终交付/Android/Orbbound-$version"
    New-Item -ItemType Directory -Force $outputDir | Out-Null
    $apk = Join-Path $outputDir "Orbbound-$version-Android.apk"
    & "$SdkPath/build-tools/36.0.0/zipalign.exe" -f -p 4 $unsignedApk "$outputDir/aligned.apk"
    Check-Exit
    & "$SdkPath/build-tools/36.0.0/apksigner.bat" sign --ks $keyPath --ks-key-alias orbbound --ks-pass env:ORBBOUND_SIGNING_PASSWORD --key-pass env:ORBBOUND_SIGNING_PASSWORD --out $apk "$outputDir/aligned.apk"
    Check-Exit
    & "$SdkPath/build-tools/36.0.0/apksigner.bat" verify --verbose --print-certs $apk
    Check-Exit
    Remove-Item -LiteralPath "$outputDir/aligned.apk"
    $sha256 = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($apk)
    try { $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLower() }
    finally { $stream.Dispose(); $sha256.Dispose() }
    "$hash  $(Split-Path $apk -Leaf)" | Set-Content "$apk.sha256" -Encoding ascii
    Write-Output "APK: $apk"
} finally {
    Remove-Item Env:ORBBOUND_SIGNING_PASSWORD -ErrorAction SilentlyContinue
}
