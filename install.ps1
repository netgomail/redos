# MyCode installer for Windows
# Usage: irm https://raw.githubusercontent.com/YOURNAME/mycode/main/install.ps1 | iex
$ErrorActionPreference = "Stop"

$REPO        = "netgomail/mycode"
$VERSION     = "0.1.0"
$APP         = "mycode"
$INSTALL_DIR = "$env:USERPROFILE\.local\bin"
$BINARY_NAME = "mycode.exe"
$DOWNLOAD_URL = "https://github.com/$REPO/releases/download/v$VERSION/$BINARY_NAME"

function Write-Step { param($msg) Write-Host "  > " -NoNewline -ForegroundColor Cyan;   Write-Host $msg }
function Write-OK   { param($msg) Write-Host "  v " -NoNewline -ForegroundColor Green;  Write-Host $msg }
function Write-Warn { param($msg) Write-Host "  ! " -NoNewline -ForegroundColor Yellow; Write-Host $msg -ForegroundColor DarkGray }
function Write-Fail { param($msg) Write-Host "  X " -NoNewline -ForegroundColor Red;    Write-Host $msg; exit 1 }

Write-Host ""
Write-Host "  +--------------------------------------------------+" -ForegroundColor Cyan
Write-Host "  |  MyCode Installer  v$VERSION" -ForegroundColor Cyan
Write-Host "  |  https://github.com/$REPO" -ForegroundColor Cyan
Write-Host "  +--------------------------------------------------+" -ForegroundColor Cyan
Write-Host ""

# 1. Create install dir
Write-Step "Install directory: $INSTALL_DIR"
if (-not (Test-Path $INSTALL_DIR)) {
    New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
    Write-OK "Created: $INSTALL_DIR"
} else {
    Write-OK "Already exists"
}

# 2. Download binary
$dest = Join-Path $INSTALL_DIR $BINARY_NAME
Write-Step "Downloading $BINARY_NAME from GitHub..."
try {
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $DOWNLOAD_URL -OutFile $dest -UseBasicParsing
} catch {
    Write-Fail "Download failed: $DOWNLOAD_URL`n  $_"
}
$sizeMB = [Math]::Round((Get-Item $dest).Length / 1MB, 1)
Write-OK "Downloaded: $dest  ($sizeMB MB)"

# 3. Add to PATH
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

Write-Host ""
Write-Host "  Done! " -ForegroundColor Green -NoNewline
Write-Host "Open a new terminal and type: " -NoNewline
Write-Host $APP -ForegroundColor Cyan
Write-Host ""
