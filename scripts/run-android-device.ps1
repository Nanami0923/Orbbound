[CmdletBinding()]
param(
    [string]$Serial,
    [switch]$NoLogStream,
    [switch]$BuildOnly,
    [switch]$LogsOnly
)

$ErrorActionPreference = 'Stop'

function Add-UniquePath {
    param(
        [System.Collections.Generic.List[string]]$List,
        [string]$Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return
    }

    try {
        $normalized = [System.IO.Path]::GetFullPath($Path.Trim().Trim('"'))
    } catch {
        $normalized = $Path.Trim().Trim('"')
    }

    if (-not $List.Contains($normalized)) {
        $List.Add($normalized)
    }
}

function Normalize-SdkPath {
    param([string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }

    $normalized = $Path.Trim().Trim('"')
    $normalized = $normalized -replace '\\:', ':'
    $normalized = $normalized.Replace('\\', '\')
    $normalized = $normalized -replace '/', '\'
    return [Environment]::ExpandEnvironmentVariables($normalized)
}

function Get-JavaMajorVersion {
    param([string]$JavaPath)

    $previousErrorAction = $ErrorActionPreference
    try {
        # java.exe writes -version to stderr on Windows; do not let that
        # normal behavior become a terminating error under Stop semantics.
        $ErrorActionPreference = 'Continue'
        $versionOutput = (& $JavaPath -version 2>&1 | Out-String)
        if ($versionOutput -match 'version\s+"(\d+)') {
            return [int]$Matches[1]
        }
        if ($versionOutput -match 'openjdk\s+(\d+)') {
            return [int]$Matches[1]
        }
    } catch {
        return 0
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }

    return 0
}

function Get-FirstExistingFile {
    param([System.Collections.Generic.List[string]]$Candidates)

    foreach ($candidate in $Candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return $candidate
        }
    }

    return $null
}

function Get-AppProcessIds {
    param(
        [string]$AdbPath,
        [string]$DeviceSerial,
        [string]$PackageName
    )

    $output = @(& $AdbPath '-s' $DeviceSerial 'shell' 'pidof' $PackageName 2>$null)
    if ($LASTEXITCODE -ne 0) {
        return @()
    }

    $text = (($output | ForEach-Object { $_.ToString().Trim() }) -join ' ').Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        return @()
    }

    return @($text -split '\s+' | Where-Object { $_ -match '^\d+$' })
}

try {
    if ($BuildOnly -and $LogsOnly) { throw '-BuildOnly and -LogsOnly cannot be combined.' }
    $projectRoot = Split-Path -Parent $PSScriptRoot
    $androidRoot = Join-Path $projectRoot 'android'
    $appGradlePath = Join-Path $androidRoot 'app\build.gradle'
    $manifestPath = Join-Path $androidRoot 'app\src\main\AndroidManifest.xml'
    $variablesPath = Join-Path $androidRoot 'variables.gradle'
    $localPropertiesPath = Join-Path $androidRoot 'local.properties'

    if (-not (Test-Path -LiteralPath $androidRoot -PathType Container)) {
        throw "Android project directory was not found: $androidRoot"
    }
    if (-not (Test-Path -LiteralPath $appGradlePath -PathType Leaf)) {
        throw "Android app Gradle file was not found: $appGradlePath"
    }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "AndroidManifest.xml was not found: $manifestPath"
    }

    Write-Host '=== Orbbound Android USB device test ===' -ForegroundColor Cyan
    Write-Host "Project: $projectRoot"

    # Read the actual application id and launcher activity from project files.
    $appGradleText = Get-Content -LiteralPath $appGradlePath -Raw
    if ($appGradleText -notmatch '(?m)^\s*applicationId\s+["'']([^"'']+)["'']') {
        throw "applicationId was not found in $appGradlePath"
    }
    $packageName = $Matches[1]

    $manifestXml = [xml](Get-Content -LiteralPath $manifestPath -Raw)
    $androidNamespace = 'http://schemas.android.com/apk/res/android'
    $namespaceManager = New-Object System.Xml.XmlNamespaceManager($manifestXml.NameTable)
    $namespaceManager.AddNamespace('android', $androidNamespace)
    $launcherNode = $manifestXml.SelectSingleNode(
        "//activity[intent-filter/action[@android:name='android.intent.action.MAIN'] and intent-filter/category[@android:name='android.intent.category.LAUNCHER']]",
        $namespaceManager
    )
    if ($null -eq $launcherNode) {
        throw "A MAIN/LAUNCHER activity was not found in $manifestPath"
    }

    $activityName = $launcherNode.GetAttribute('name', $androidNamespace)
    if ([string]::IsNullOrWhiteSpace($activityName)) {
        throw "The launcher activity has no android:name in $manifestPath"
    }

    if ($activityName.StartsWith('.')) {
        $fullActivityName = "$packageName$activityName"
    } elseif ($activityName.Contains('.')) {
        $fullActivityName = $activityName
    } else {
        $fullActivityName = "$packageName.$activityName"
    }
    $componentName = "$packageName/$fullActivityName"

    Write-Host "Package: $packageName"
    Write-Host "Launcher activity: $fullActivityName"

    # Read the compile SDK from the Android project before selecting an SDK root.
    $variablesText = Get-Content -LiteralPath $variablesPath -Raw
    if ($variablesText -notmatch '(?m)^\s*compileSdkVersion\s*=\s*(\d+)') {
        throw "compileSdkVersion was not found in $variablesPath"
    }
    $compileSdk = $Matches[1]

    $sdkCandidates = [System.Collections.Generic.List[string]]::new()
    Add-UniquePath $sdkCandidates $env:ANDROID_HOME
    Add-UniquePath $sdkCandidates $env:ANDROID_SDK_ROOT

    if (Test-Path -LiteralPath $localPropertiesPath -PathType Leaf) {
        $sdkLine = Get-Content -LiteralPath $localPropertiesPath | Where-Object { $_ -match '^\s*sdk\.dir\s*=' } | Select-Object -First 1
        if ($sdkLine -and $sdkLine -match '^\s*sdk\.dir\s*=(.*)$') {
            Add-UniquePath $sdkCandidates (Normalize-SdkPath $Matches[1])
        }
    }

    if ($env:LOCALAPPDATA) {
        Add-UniquePath $sdkCandidates (Join-Path $env:LOCALAPPDATA 'Android\Sdk')
    }
    if ($env:USERPROFILE) {
        Add-UniquePath $sdkCandidates (Join-Path $env:USERPROFILE 'AppData\Local\Android\Sdk')
    }
    if ($env:ProgramFiles) {
        Add-UniquePath $sdkCandidates (Join-Path $env:ProgramFiles 'Android\Sdk')
    }
    if (${env:ProgramFiles(x86)}) {
        Add-UniquePath $sdkCandidates (Join-Path ${env:ProgramFiles(x86)} 'Android\Sdk')
    }

    $existingSdkRoots = @($sdkCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container })
    if ($existingSdkRoots.Count -eq 0) {
        throw 'Android SDK was not found. Set ANDROID_HOME/ANDROID_SDK_ROOT or install it in the Android Studio default location.'
    }

    $sdkPath = $existingSdkRoots | Where-Object {
        (Test-Path -LiteralPath (Join-Path $_ 'platform-tools\adb.exe') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $_ "platforms\android-$compileSdk\android.jar") -PathType Leaf)
    } | Select-Object -First 1
    if (-not $sdkPath) {
        $sdkPath = $existingSdkRoots | Where-Object {
            Test-Path -LiteralPath (Join-Path $_ 'platform-tools\adb.exe') -PathType Leaf
        } | Select-Object -First 1
    }
    if (-not $sdkPath) {
        $sdkPath = $existingSdkRoots | Select-Object -First 1
    }

    $env:ANDROID_HOME = $sdkPath
    $env:ANDROID_SDK_ROOT = $sdkPath
    Write-Host "Android SDK: $sdkPath"

    $adbCandidates = [System.Collections.Generic.List[string]]::new()
    Add-UniquePath $adbCandidates $env:ADB
    Add-UniquePath $adbCandidates (Join-Path $sdkPath 'platform-tools\adb.exe')
    foreach ($candidateSdk in $sdkCandidates) {
        Add-UniquePath $adbCandidates (Join-Path $candidateSdk 'platform-tools\adb.exe')
    }
    $adbCommand = Get-Command adb.exe -ErrorAction SilentlyContinue
    if ($adbCommand) {
        Add-UniquePath $adbCandidates $adbCommand.Source
        Add-UniquePath $adbCandidates $adbCommand.Path
    }
    foreach ($programRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if ($programRoot) {
            Add-UniquePath $adbCandidates (Join-Path $programRoot 'NetEase\MuMu\nx_main\adb.exe')
        }
    }
    $adbPath = Get-FirstExistingFile $adbCandidates
    if (-not $adbPath) {
        throw 'adb.exe was not found. Install Android SDK Platform-Tools or add its platform-tools directory to PATH.'
    }
    Write-Host "ADB: $adbPath"

    $platformPath = Join-Path $sdkPath "platforms\android-$compileSdk"
    if (-not (Test-Path -LiteralPath (Join-Path $platformPath 'android.jar') -PathType Leaf)) {
        throw "Android platform android-$compileSdk is missing from $sdkPath"
    }
    $buildToolsRoot = Join-Path $sdkPath 'build-tools'
    $buildTools = @()
    if (Test-Path -LiteralPath $buildToolsRoot -PathType Container) {
        $buildTools = @(Get-ChildItem -LiteralPath $buildToolsRoot -Directory | Where-Object {
            Test-Path -LiteralPath (Join-Path $_.FullName 'aapt2.exe')
        } | Sort-Object Name -Descending)
    }
    if ($buildTools.Count -eq 0) {
        throw "Android Build Tools with aapt2.exe were not found under $buildToolsRoot"
    }
    Write-Host "Compile SDK: android-$compileSdk"
    Write-Host "Build Tools: $($buildTools.Name -join ', ')"

    # Prefer a JDK 21 installation because this project compiles Java 21 sources.
    $jdkCandidates = [System.Collections.Generic.List[string]]::new()
    Add-UniquePath $jdkCandidates $env:JAVA_HOME
    if ($env:ProgramFiles) {
        Add-UniquePath $jdkCandidates (Join-Path $env:ProgramFiles 'Android\Android Studio\jbr')
        foreach ($jdk in @(Get-ChildItem (Join-Path $env:ProgramFiles 'Java') -Directory -Filter 'jdk*' -ErrorAction SilentlyContinue)) {
            Add-UniquePath $jdkCandidates $jdk.FullName
        }
        foreach ($root in @('Eclipse Adoptium', 'Microsoft', 'Amazon Corretto', 'BellSoft', 'Zulu')) {
            $javaRoot = Join-Path $env:ProgramFiles $root
            foreach ($jdk in @(Get-ChildItem $javaRoot -Directory -Filter 'jdk*' -ErrorAction SilentlyContinue)) {
                Add-UniquePath $jdkCandidates $jdk.FullName
            }
        }
    }
    if (${env:ProgramFiles(x86)}) {
        foreach ($jdk in @(Get-ChildItem (Join-Path ${env:ProgramFiles(x86)} 'Java') -Directory -Filter 'jdk*' -ErrorAction SilentlyContinue)) {
            Add-UniquePath $jdkCandidates $jdk.FullName
        }
    }
    $javacCommand = Get-Command javac.exe -ErrorAction SilentlyContinue
    if ($javacCommand) {
        Add-UniquePath $jdkCandidates (Split-Path (Split-Path $javacCommand.Source -Parent) -Parent)
    }

    $jdkPath = $null
    foreach ($candidateJdk in $jdkCandidates) {
        $javaExe = Join-Path $candidateJdk 'bin\java.exe'
        $javacExe = Join-Path $candidateJdk 'bin\javac.exe'
        if ((Test-Path -LiteralPath $javaExe -PathType Leaf) -and (Test-Path -LiteralPath $javacExe -PathType Leaf)) {
            if ((Get-JavaMajorVersion $javaExe) -ge 21) {
                $jdkPath = $candidateJdk
                break
            }
        }
    }
    if (-not $jdkPath) {
        throw 'JDK 21 or newer was not found. This project uses Java 21 compile options.'
    }
    $env:JAVA_HOME = $jdkPath
    $env:Path = "$jdkPath\bin;$env:Path"
    Write-Host "JDK: $jdkPath"

    $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npmCommand) {
        throw 'npm.cmd was not found. Install Node.js before running the Android test flow.'
    }
    $npmPath = $npmCommand.Source
    if (-not $npmPath) {
        $npmPath = $npmCommand.Path
    }
    $gradlePath = Join-Path $androidRoot 'gradlew.bat'
    if (-not (Test-Path -LiteralPath $gradlePath -PathType Leaf)) {
        throw "Gradle wrapper was not found: $gradlePath"
    }

    Write-Host ''
    Write-Host '[1/5] Checking USB devices...' -ForegroundColor Cyan
    # ADB daemon startup messages use stderr even when startup succeeds.
    $ErrorActionPreference = 'Continue'
    $deviceOutput = @(& $adbPath 'devices' '-l' 2>&1)
    $deviceExitCode = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    if ($deviceExitCode -ne 0) {
        throw "adb devices failed: $($deviceOutput -join ' ')"
    }

    $deviceRecords = @(
        foreach ($line in $deviceOutput) {
            if ($line -match '^\s*(?<Serial>\S+)\s+(?<State>device|unauthorized|offline|bootloader|recovery|sideload|unknown)(?:\s+(?<Details>.*))?$') {
                [pscustomobject]@{
                    Serial = $Matches.Serial
                    State = $Matches.State
                    Details = $Matches.Details
                }
            }
        }
    )

    if (-not $BuildOnly) {
    if ($deviceRecords.Count -eq 0) {
        Write-Host '[INFO] No USB Android device was detected.' -ForegroundColor Yellow
        throw 'Device detection completed with zero devices. Connect a phone, enable USB debugging, and run the script again.'
    }

    Write-Host 'Detected devices:'
    $deviceRecords | Format-Table Serial, State, Details -AutoSize | Out-Host

    if (-not $Serial -and $deviceRecords.Count -gt 1) {
        throw 'Multiple devices detected. Re-run with -Serial <serial> to select one explicitly.'
    }
    $targetRecords = @($deviceRecords | Where-Object { -not $Serial -or $_.Serial -eq $Serial })
    $unauthorized = @($targetRecords | Where-Object State -eq 'unauthorized')
    if ($unauthorized.Count -gt 0) {
        throw 'A device is unauthorized. Unlock the phone and accept the "Allow USB debugging" prompt, then run again.'
    }

    $offline = @($targetRecords | Where-Object State -eq 'offline')
    if ($offline.Count -gt 0) {
        throw 'A device is offline. Reconnect the USB cable, restart USB debugging, or run "adb kill-server" followed by this script.'
    }

    $readyDevices = @($deviceRecords | Where-Object State -eq 'device')
    if ($Serial) {
        $selectedDevice = $readyDevices | Where-Object Serial -eq $Serial | Select-Object -First 1
        if (-not $selectedDevice) {
            throw "The requested serial was not in ready state: $Serial"
        }
    } elseif ($readyDevices.Count -eq 1) {
        $selectedDevice = $readyDevices[0]
        if ($selectedDevice.Serial -match '^emulator-|:|_adb-tls-') {
            throw 'Automatic selection requires a USB device. Use -Serial <serial> to explicitly select this transport.'
        }
    } elseif ($readyDevices.Count -gt 1) {
        throw 'Multiple ready devices were detected. Re-run with -Serial <serial> to avoid installing on the wrong device.'
    } else {
        throw 'No device in ready state was detected.'
    }
    $selectedSerial = $selectedDevice.Serial
    Write-Host "Selected device: $selectedSerial"
    }

    if (-not $LogsOnly) {
    Write-Host ''
    Write-Host '[2/5] Building web assets and syncing Capacitor...' -ForegroundColor Cyan
    Push-Location $projectRoot
    try {
        & $npmPath 'run' 'sync:android'
        if ($LASTEXITCODE -ne 0) {
            throw "npm run sync:android failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    Write-Host ''
    Write-Host '[3/5] Building debug APK...' -ForegroundColor Cyan
    Push-Location $projectRoot
    try {
        # Gradle gives local.properties precedence over the environment.
        # Keep other local properties; replace only the SDK entry.
        $properties = @()
        if (Test-Path $localPropertiesPath) {
            $properties = @(Get-Content $localPropertiesPath | Where-Object { $_ -notmatch '^\s*sdk\.dir\s*=' })
        }
        $properties += 'sdk.dir=' + $sdkPath.Replace('\', '/')
        [IO.File]::WriteAllLines($localPropertiesPath, $properties, [Text.UTF8Encoding]::new($false))
        & $gradlePath '-p' $androidRoot 'assembleDebug' '--console=plain'
        if ($LASTEXITCODE -ne 0) {
            throw "Gradle assembleDebug failed with exit code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }

    $metadataPath = Join-Path $androidRoot 'app\build\outputs\apk\debug\output-metadata.json'
    $metadata = Get-Content $metadataPath -Raw | ConvertFrom-Json
    if (@($metadata.elements).Count -ne 1) { throw 'Multiple APK outputs require explicit variant support; stopping.' }
    $apkPath = Join-Path (Split-Path $metadataPath) $metadata.elements[0].outputFile
    if (-not (Test-Path -LiteralPath $apkPath -PathType Leaf)) {
        throw "Debug APK was not produced at the expected path: $apkPath"
    }
    $apkInfo = Get-Item -LiteralPath $apkPath
    Write-Host "Debug APK: $($apkInfo.FullName) ($($apkInfo.Length) bytes)"
    # Read the merged, packaged manifest (includes Gradle overrides and aliases).
    $aaptPath = Join-Path $buildTools[0].FullName 'aapt.exe'
    $badging = (& $aaptPath dump badging $apkPath | Out-String)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the built APK manifest.' }
    if ($badging -notmatch "package: name='([^']+)'") { throw 'APK package was not found.' }
    $packageName = $Matches[1]
    if ($badging -notmatch "launchable-activity: name='([^']+)'") { throw 'APK launcher was not found.' }
    $fullActivityName = $Matches[1]
    $componentName = "$packageName/$fullActivityName"
    Write-Host "Verified APK package/activity: $componentName"
    if ($BuildOnly) { exit 0 }

    Write-Host ''
    Write-Host '[4/5] Installing APK with adb install -r...' -ForegroundColor Cyan
    & $adbPath '-s' $selectedSerial 'install' '-r' $apkPath
    if ($LASTEXITCODE -ne 0) {
        throw "adb install -r failed ($LASTEXITCODE). For UPDATE_INCOMPATIBLE use the original signing key; for VERSION_DOWNGRADE increase versionCode. No uninstall or data clearing is performed."
    }
    Write-Host 'Install succeeded; existing app data was preserved.' -ForegroundColor Green
    }

    Write-Host ''
    Write-Host '[5/5] Starting and verifying the app...' -ForegroundColor Cyan
    $logRoot = Join-Path $projectRoot '.build\android-device'
    New-Item -ItemType Directory -Force $logRoot | Out-Null
    $logPrefix = Join-Path $logRoot (Get-Date -Format 'yyyyMMdd-HHmmss')
    $deviceSince = ((& $adbPath '-s' $selectedSerial shell date '+%m-%d_%H:%M:%S.000') -join '').Trim().Replace('_', ' ')
    if ($LASTEXITCODE -ne 0 -or $deviceSince -notmatch '^\d\d-\d\d ') { throw 'Cannot read device clock for Logcat.' }
    $packageInfo = (& $adbPath '-s' $selectedSerial shell dumpsys package $packageName) -join "`n"
    if ($packageInfo -notmatch 'userId=(\d+)') { throw 'Installed application UID was not found.' }
    $appUid = $Matches[1]
    $logArgs = @('-s', $selectedSerial, 'logcat', '-b', 'main', '-b', 'system', '-b', 'crash', "--uid=$appUid", '-T', $deviceSince, '-v', 'threadtime')
    if ($LogsOnly) {
        Write-Host "App UID: $appUid; logs: $logPrefix-app.log (Ctrl+C to stop)"
        & $adbPath @logArgs | Tee-Object -FilePath "$logPrefix-app.log"
        exit $LASTEXITCODE
    }
    $startOutput = @(& $adbPath '-s' $selectedSerial 'shell' 'am' 'start' '-W' '-n' $componentName 2>&1)
    $startText = $startOutput -join [Environment]::NewLine
    if ($startText) {
        Write-Host $startText
    }
    if ($LASTEXITCODE -ne 0 -or $startText -match '(?i)Error|Exception') {
        throw "The launcher activity could not be started: $componentName"
    }

    $appPids = @()
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $appPids = @(Get-AppProcessIds $adbPath $selectedSerial $packageName)
        if ($appPids.Count -gt 0) {
            break
        }
        Start-Sleep -Milliseconds 500
    }

    # Observe beyond the first process creation so immediate crashes are caught.
    Start-Sleep -Seconds 5
    $appPids = @(Get-AppProcessIds $adbPath $selectedSerial $packageName)
    $focusedOutput = @(& $adbPath '-s' $selectedSerial 'shell' 'dumpsys' 'activity' 'activities' 2>$null) -join "`n"
    $resumed = @($focusedOutput -split "`n" | Where-Object { $_ -match '(mResumedActivity|topResumedActivity)' -and $_ -match ([regex]::Escape($packageName) + '/') })
    $appStarted = ($appPids.Count -gt 0) -and ($resumed.Count -gt 0)
    & $adbPath @logArgs '-d' | Set-Content "$logPrefix-app.log"
    if (-not $appStarted) {
        throw "The start command returned, but the app was not found running: $packageName"
    }

    if ($appPids.Count -gt 0) {
        $primaryPid = $appPids[0]
        Write-Host "App process detected: PID $primaryPid" -ForegroundColor Green
    } else {
        $primaryPid = $null
        Write-Host 'App appears in the foreground, but no process id was returned yet.' -ForegroundColor Yellow
    }
    Write-Host "App started: $componentName" -ForegroundColor Green

    Write-Host ''
    Write-Host 'Filtered Logcat (press Ctrl+C to stop):' -ForegroundColor Cyan
    if ($primaryPid -and -not $NoLogStream) {
        Write-Host "App UID: $appUid; logs: $logPrefix-app.log"
        Write-Host 'UID filtering follows app processes. A process exit triggers crash diagnostics.'
        $quotedArgs = @($logArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
        $logProcess = Start-Process -FilePath $adbPath -ArgumentList $quotedArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput "$logPrefix-live.log" -RedirectStandardError "$logPrefix-logcat-error.log"
        $shown = 0
        try {
            while ($true) {
                Start-Sleep -Seconds 1
                $lines = @(Get-Content "$logPrefix-live.log" -ErrorAction SilentlyContinue)
                if ($lines.Count -gt $shown) { $lines | Select-Object -Skip $shown | Out-Host; $shown = $lines.Count }
                if ($logProcess.HasExited) { throw "Logcat stopped. See $logPrefix-logcat-error.log" }
                if (@(Get-AppProcessIds $adbPath $selectedSerial $packageName).Count -eq 0) {
                    throw 'App process exited (crash or normal termination); collecting diagnostics.'
                }
            }
        } finally {
            if (-not $logProcess.HasExited) { Stop-Process -Id $logProcess.Id -ErrorAction SilentlyContinue }
        }
    } elseif (-not $NoLogStream) {
        Write-Host "No PID was available. Use: adb -s $selectedSerial logcat -v threadtime | findstr /i `"$packageName AndroidRuntime FATAL EXCEPTION libc chromium WebView Capacitor`""
    } else {
        Write-Host 'Log streaming skipped because -NoLogStream was specified.'
    }
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
    if ($logPrefix -and $selectedSerial) {
        # Native crash reports are emitted by debuggerd/crash_dump, not the app UID.
        # Save the bounded crash buffer separately to preserve complete backtraces.
        $ErrorActionPreference = 'Continue'
        & $adbPath @logArgs '-d' | Set-Content "$logPrefix-app.log"
        & $adbPath '-s' $selectedSerial logcat -b crash -d -T $deviceSince -v threadtime | Set-Content "$logPrefix-crash.log"
        Write-Host "Diagnostics: $logPrefix-app.log and $logPrefix-crash.log"
        Select-String -Path "$logPrefix-app.log","$logPrefix-crash.log" -Pattern 'FATAL EXCEPTION|Caused by:|Fatal signal|backtrace:|chromium|CONSOLE|Capacitor|WebView' -Context 2,8 | Out-Host
    }
    exit 1
}

exit 0
