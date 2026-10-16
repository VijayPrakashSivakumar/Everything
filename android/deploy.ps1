<#
.SYNOPSIS
  Builds the Android wrapper and installs it on a connected device as an UPDATE -
  never as an uninstall + reinstall.

.DESCRIPTION
  Updating in place is the whole point. Android only accepts an update when the new
  APK carries a HIGHER versionCode and is signed with the SAME key as the installed
  one; this script guarantees both (a monotonic versionCode derived from the build
  time, and a stable keystore shared by the debug and release build types), so
  `adb install -r` succeeds and the WebView's login session, settings and any
  not-yet-synced local data survive the update.

  If an update is genuinely impossible (for example, the copy already on the phone
  was signed with a different key), the script explains why and stops. It will not
  uninstall unless you pass -Force, and even then it warns first: uninstalling
  deletes the app's local data.

  Run it from anywhere:

      pwsh android/deploy.ps1               # build + update the connected device
      pwsh android/deploy.ps1 -BuildOnly    # just build the APK
      pwsh android/deploy.ps1 -Check        # what would happen, without building
      pwsh android/deploy.ps1 -Force        # allow an uninstall if an update is impossible

  From the repo root you can also use:  npm run android:deploy
#>
[CmdletBinding()]
param(
    # Do not build - check the device and report what would happen.
    [switch]$Check,
    # Build the APK but do not install it.
    [switch]$BuildOnly,
    # Override the versionCode (must be higher than what is installed).
    [int]$VersionCode,
    # Override the versionName shown in Settings.
    [string]$VersionName,
    # Point this build at a different deployment (e.g. a preview URL).
    [string]$Url,
    # Explicitly allow an uninstall. Without this the script refuses and explains.
    [switch]$Force,
    # Install the release variant instead of the debug one.
    [switch]$Release,
    # Use this adb binary instead of looking for one on PATH / in the SDK.
    [string]$AdbPath,
    # Use this gradle binary instead of looking for one on PATH.
    [string]$GradlePath
)

$ErrorActionPreference = 'Stop'

$PackageName = 'com.everything.app'
$AndroidDir  = $PSScriptRoot
$AppDir      = Join-Path $AndroidDir 'app'
$PropsFile   = Join-Path $AndroidDir 'version.properties'
$Keystore    = Join-Path $AppDir 'debug.keystore'
$Variant     = if ($Release) { 'release' } else { 'debug' }

function Write-Note([string]$m) { Write-Host "  $m" }
function Write-Ok([string]$m)   { Write-Host "  OK    $m" -ForegroundColor Green }
function Write-Warn2([string]$m){ Write-Host "  CHECK $m" -ForegroundColor Yellow }
function Die([string]$m)        { Write-Host "`n  Cannot continue: $m" -ForegroundColor Red; exit 1 }

# --- 1. The stable keystore -------------------------------------------------------------------
# Every build must be signed with the same key or Android treats a new APK as a
# different app and demands an uninstall. This generates one key once and reuses it
# for every build afterwards. Losing this file (or uninstalling an app signed with
# it) is the one thing that forces a fresh install.
function Ensure-Keystore {
    if (Test-Path $Keystore) { return }
    $keytool = Get-Command keytool -ErrorAction SilentlyContinue
    if (-not $keytool) { Die "Java's keytool was not found. Install a JDK (Android Studio bundles one) and add it to PATH." }
    Write-Note "Creating the stable signing key (one-time)..."
    & $keytool.Source -genkeypair -keystore $Keystore -alias everything `
        -keyalg RSA -keysize 2048 -validity 10950 `
        -storepass everything -keypass everything `
        -dname "CN=Everything, OU=Everything, O=Everything, L=Unknown, S=Unknown, C=US" | Out-Null
    if ($LASTEXITCODE -ne 0) { Die "Could not create the signing key." }
    Write-Ok "Signing key created at android\app\debug.keystore (keep it safe - do not delete it)."
}

# --- 2. versionCode ---------------------------------------------------------------------------
# Derived from the build time (YYMMDDHH) plus a counter, so no two builds of the
# same hour can produce the same number. It only ever goes up, which is exactly
# what makes an APK an update rather than a no-op or a downgrade.
function Get-NextVersion {
    $props = @{}
    if (Test-Path $PropsFile) {
        Get-Content $PropsFile | ForEach-Object {
            if ($_ -match '^\s*([A-Za-z_]+)\s*=\s*(.+?)\s*$') { $props[$Matches[1]] = $Matches[2] }
        }
    }
    $now  = Get-Date
    $base = [int]$now.ToString('yyMMddHH')
    $next = $base * 10 + 1
    if ($VersionCode) { $next = $VersionCode }
    elseif ($props['VERSION_CODE'] -and [int]$props['VERSION_CODE'] -ge $next) {
        $next = [int]$props['VERSION_CODE'] + 1
    }

    $name = if ($VersionName) { $VersionName }
            elseif ($props['VERSION_NAME']) { $props['VERSION_NAME'] } else { '1.0.0' }

    $lines = @(
        '# Single source of truth for the wrapper version. Written by deploy.ps1 before each build.'
        '# VERSION_CODE must only ever go up - Android refuses a lower one as a downgrade, and an'
        '# equal one makes a "new" APK a no-op. It is derived from the build time (YYMMDDHH plus a'
        '# per-hour counter) so no two builds can produce the same number. See android/README.md.'
        "VERSION_CODE=$next"
        "VERSION_NAME=$name"
    )
    Set-Content -Path $PropsFile -Value $lines -Encoding ascii

    return @{ Code = $next; Name = $name }
}

# --- 3. Build ---------------------------------------------------------------------------------
function Invoke-Gradle([string[]]$Arguments) {
    $gradle = $null
    if ($GradlePath) { $gradle = $GradlePath }
    else {
        $wrapper = Join-Path $AndroidDir 'gradlew.bat'
        if (Test-Path $wrapper) { $gradle = $wrapper }
        else {
            $cmd = Get-Command gradle -ErrorAction SilentlyContinue
            if ($cmd) { $gradle = $cmd.Source }
        }
    }
    if (-not $gradle) { Die "No Gradle found. Open the android\ folder in Android Studio once (it supplies Gradle), or install Gradle and re-run." }

    & $gradle @Arguments
    if ($LASTEXITCODE -ne 0) { Die "The Gradle build failed - see the output above." }
}

function Build-Apk([hashtable]$Version) {
    Ensure-Keystore
    $task = ":app:assemble$($Variant.Substring(0,1).ToUpper() + $Variant.Substring(1))"
    Write-Note "Building the $Variant APK (version $($Version.Name), code $($Version.Code))..."
    $props = @("-PVERSION_CODE=$($Version.Code)", "-PVERSION_NAME=$($Version.Name)")
    if ($Url) {
        $props += "-PAPP_URL=$Url"
        Write-Note "  app url override: $Url"
    }
    Invoke-Gradle (@($task) + $props)

    $apk = Join-Path $AppDir "build\outputs\apk\$Variant\app-$Variant.apk"
    if (-not (Test-Path $apk)) { Die "Build finished but the APK is missing at $apk" }
    Write-Ok "APK built: $apk"
    return $apk
}


# --- 4. adb -----------------------------------------------------------------------------------
function Find-Adb {
    if ($AdbPath) { return $AdbPath }
    $cmd = Get-Command adb -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    foreach ($root in @($env:LOCALAPPDATA, "$env:LOCALAPPDATA\Android", 'C:\Android', "$env:PROGRAMFILES\Android")) {
        if (-not $root) { continue }
        $hit = Get-ChildItem -Path $root -Filter adb.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

function Get-Device([string]$adb) {
    $lines = & $adb devices | Select-Object -Skip 1
    $ready = @()
    foreach ($line in $lines) {
        $parts = ($line -split '\s+') | Where-Object { $_ }
        if ($parts.Count -ge 2 -and $parts[1] -eq 'device') { $ready += $parts[0] }
        elseif ($parts.Count -ge 2 -and $parts[1] -eq 'unauthorized') { Die "The device is connected but not authorised. Unlock it and accept the 'Allow USB debugging' prompt." }
    }
    if ($ready.Count -eq 0) { return $null }
    if ($ready.Count -gt 1) { Die "More than one device is connected. Disconnect the others and re-run." }
    return $ready[0]
}

function Get-InstalledCode([string]$adb, [string]$serial) {
    $out = & $adb -s $serial shell dumpsys package $PackageName 2>$null | Out-String
    if ($out -match 'versionCode=(\d+)') { return [int]$Matches[1] }
    return $null
}


# --- 5. Install as an update ------------------------------------------------------------------
function Install-Apk([string]$apk, [string]$adb, [string]$serial, [int]$builtCode) {
    $installed = Get-InstalledCode $adb $serial
    if ($null -eq $installed) {
        Write-Note "App is not installed yet - installing fresh (nothing to preserve)."
    } else {
        if ($builtCode -le $installed) {
            Die "The APK carries versionCode $builtCode but the phone already has $installed, so Android would reject it. Re-run without -VersionCode so a fresh, higher one is generated."
        }
        Write-Note "Updating in place: versionCode $installed -> $builtCode. The app is NOT uninstalled, so data, settings and login are kept."
    }

    $output = & $adb -s $serial install -r $apk 2>&1 | Out-String
    Write-Host $output

    if ($LASTEXITCODE -ne 0) {
        if ($Force) {
            Write-Warn2 "-Force was passed: uninstalling the app, which DELETES its local data (login session, settings, anything not yet synced)."
            & $adb -s $serial uninstall $PackageName | Out-Null
            $retry = & $adb -s $serial install $apk 2>&1 | Out-String
            Write-Host $retry
            if ($LASTEXITCODE -ne 0) { Die "Install still failed." }
            Write-Ok "Installed (fresh - this was a reinstall, not an update)."
            return
        }
        Write-Host "`n  The update was refused. The usual reason is that the copy already on the phone was signed with a DIFFERENT key (an older build, or one made on another machine)." -ForegroundColor Red
        Write-Host "  Android would only accept it after an uninstall - which DELETES the app's local data (login session, settings, anything not yet synced)." -ForegroundColor Red
        Write-Host "  Re-run with -Force if you accept that, or rebuild with the original signing key." -ForegroundColor Yellow
        exit 1
    }
    Write-Ok "Installed as an update (the app was never uninstalled)."
}

function Verify-Update([string]$adb, [string]$serial, [int]$builtCode) {
    $now = Get-InstalledCode $adb $serial
    if ($null -eq $now) { Die "The phone no longer reports the app as installed - the install did not stick." }
    if ($now -ne $builtCode) { Die "The phone reports versionCode $now but $builtCode was just installed." }
    Write-Ok "Verified: the phone is now on versionCode $now."
    & $adb -s $serial shell am force-stop $PackageName 2>$null | Out-Null
    Write-Note "Launching the updated app..."
    & $adb -s $serial shell monkey -p $PackageName -c android.intent.category.LAUNCHER 1 2>$null | Out-Null
}


# --- run --------------------------------------------------------------------------------------
try {
    $version = Get-NextVersion

    if ($Check) {
        Write-Host "`n  What would happen (nothing was built or changed):" -ForegroundColor Cyan
        Write-Note "versionCode : $($version.Code) (next build)"
        Write-Note "versionName : $($version.Name)"
        $adb = Find-Adb
        if (-not $adb) { Write-Warn2 "adb not found - install the Android SDK platform-tools to deploy to a device." }
        else {
            $serial = Get-Device $adb
            if (-not $serial) { Write-Warn2 "No device connected (enable USB debugging and plug one in)." }
            else {
                $installed = Get-InstalledCode $adb $serial
                if ($null -eq $installed) { Write-Note "Device ${serial}: app not installed yet -> fresh install." }
                else { Write-Note "Device ${serial}: installed versionCode $installed -> would UPDATE to $($version.Code) in place (data kept)." }
            }
        }
        exit 0
    }

    $apk = Build-Apk $version
    if ($BuildOnly) { Write-Host "`n  Done (build only - nothing installed).`n" -ForegroundColor Cyan; exit 0 }

    $adb = Find-Adb
    if (-not $adb) { Write-Host "`n  Built OK, but no adb was found, so nothing was installed. Copy the APK to the phone and install it, or install the Android SDK platform-tools." -ForegroundColor Yellow; exit 0 }

    $serial = Get-Device $adb
    if (-not $serial) { Write-Host "`n  Built OK, but no device is connected. Enable USB debugging, plug the phone in, then re-run - or install the APK by hand." -ForegroundColor Yellow; exit 0 }

    Install-Apk $apk $adb $serial $version.Code
    Verify-Update $adb $serial $version.Code
    Write-Host "`n  Done - the app updated in place, with data, settings and login intact.`n" -ForegroundColor Green
}
catch {
    Write-Host "`n  Something went wrong: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}

