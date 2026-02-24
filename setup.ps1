# MyCode installer - adds mycode to PATH
# Usage: powershell -ExecutionPolicy Bypass -File setup.ps1
$ErrorActionPreference = "Stop"

$APP         = "mycode"
$EXE_NAME    = "mycode.exe"
$INSTALL_DIR = "$env:USERPROFILE\.local\bin"
$SOURCE      = Join-Path $PSScriptRoot "dist\mycode.exe"

function Write-Step { param($msg) Write-Host "  > " -NoNewline -ForegroundColor Cyan;  Write-Host $msg }
function Write-OK   { param($msg) Write-Host "  v " -NoNewline -ForegroundColor Green; Write-Host $msg }
function Write-Warn { param($msg) Write-Host "  ! " -NoNewline -ForegroundColor Yellow; Write-Host $msg -ForegroundColor DarkGray }
function Write-Fail { param($msg) Write-Host "  X " -NoNewline -ForegroundColor Red;   Write-Host $msg; exit 1 }

Write-Host ""
Write-Host "  +--------------------------------------------------+" -ForegroundColor Cyan
Write-Host "  |  MyCode Installer                                |" -ForegroundColor Cyan
Write-Host "  |  Adds 'mycode' command to user PATH              |" -ForegroundColor Cyan
Write-Host "  +--------------------------------------------------+" -ForegroundColor Cyan
Write-Host ""

# 1. Check source binary
Write-Step "Checking binary..."
if (-not (Test-Path $SOURCE)) {
    Write-Fail "Not found: $SOURCE"
    Write-Host "    Run 'bun run build:win' first" -ForegroundColor DarkGray
}
Write-OK "Found: $SOURCE"

# 2. Create install directory
Write-Step "Install directory: $INSTALL_DIR"
if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
    Write-OK "Created: $INSTALL_DIR"
} else {
    Write-OK "Already exists"
}

# 3. Copy binary
$dest = Join-Path $INSTALL_DIR $EXE_NAME
Write-Step "Installing $EXE_NAME..."
Copy-Item -Path $SOURCE -Destination $dest -Force
$sizeMB = [Math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-OK "Copied to: $dest  ($sizeMB MB)"

# 4. Add to user PATH
Write-Step "Updating PATH..."
$userPath = [Environment]::GetEnvironmentVariable("PATH", "User")
if ($userPath -like "*$INSTALL_DIR*") {
    Write-OK "PATH already includes $INSTALL_DIR"
} else {
    $newPath = if ($userPath) { "$userPath;$INSTALL_DIR" } else { $INSTALL_DIR }
    [Environment]::SetEnvironmentVariable("PATH", $newPath, "User")
    Write-OK "Added $INSTALL_DIR to user PATH"
    Write-Warn "Restart your terminal for PATH to take effect"
}

# 5. Quick verification in current session
$env:PATH += ";$INSTALL_DIR"
$found = Get-Command $APP -ErrorAction SilentlyContinue
if ($found) {
    Write-OK "Verified: $($found.Source)"
}

Write-Host ""
Write-Host "  Done! " -ForegroundColor Green -NoNewline
Write-Host "Open a new terminal and type: " -NoNewline
Write-Host "mycode" -ForegroundColor Cyan
Write-Host ""
