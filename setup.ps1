#Requires -Version 5.1
<#
.SYNOPSIS
    Dojutsu Interactive Installer (PowerShell)

.DESCRIPTION
    Two-mode installer:
      [1] Agent-Mux mode  -- distributes work across multiple detected engines
      [2] Native mode     -- uses current agent only with MODEL tier hints

    Re-running is safe (idempotent). Existing non-symlink dirs are backed up.

.NOTES
    Equivalent to setup.sh for Windows / PowerShell environments.
#>

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
#  Paths
# ---------------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$SkillsSrc  = Join-Path $ScriptDir 'skills'
$DojutsuToml = Join-Path $SkillsSrc 'dojutsu' 'dojutsu.toml'
$Skills     = @('rinnegan', 'byakugan', 'rasengan', 'sharingan', 'dojutsu')

# ---------------------------------------------------------------------------
#  Cost estimates per mode
# ---------------------------------------------------------------------------
$CostNativeLow  = '0.08'
$CostNativeHigh = '0.25'
$CostMuxLow     = '0.04'
$CostMuxHigh    = '0.15'

# ---------------------------------------------------------------------------
#  Agent registry:  Label, Command, SkillDir
# ---------------------------------------------------------------------------
$AgentRegistry = @(
    @{ Label = 'Claude Code'; Cmd = 'claude';   SkillDir = Join-Path $HOME '.claude'  'commands' }
    @{ Label = 'Codex';       Cmd = 'codex';    SkillDir = Join-Path $HOME '.codex'   'skills'   }
    @{ Label = 'OpenCode';    Cmd = 'opencode'; SkillDir = Join-Path $HOME '.config'  'opencode' 'command' }
    @{ Label = 'Gemini CLI';  Cmd = 'gemini';   SkillDir = Join-Path $HOME '.gemini'  'skills'   }
)

# ---------------------------------------------------------------------------
#  Colour helpers
# ---------------------------------------------------------------------------
function Write-Header  { param([string]$Msg) Write-Host "`n=== $Msg ===`n" -ForegroundColor Blue }
function Write-Step    { param([string]$Msg) Write-Host "  =>  $Msg"       -ForegroundColor Cyan }
function Write-Ok      { param([string]$Msg) Write-Host "   OK  $Msg"      -ForegroundColor Green }
function Write-Err     { param([string]$Msg) Write-Host "  ERR  $Msg"      -ForegroundColor Red }
function Write-Warn    { param([string]$Msg) Write-Host "   !   $Msg"      -ForegroundColor Yellow }
function Write-Info    { param([string]$Msg) Write-Host "       $Msg"      -ForegroundColor DarkGray }

# ---------------------------------------------------------------------------
#  Helper: test whether a command exists on PATH
# ---------------------------------------------------------------------------
function Test-CommandExists {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

# ---------------------------------------------------------------------------
#  Helper: update dojutsu.toml [dispatch] section
# ---------------------------------------------------------------------------
function Update-TomlDispatch {
    param(
        [string]$Mode,
        [string]$DefaultEngine,
        [string]$AvailableEnginesToml,
        [string]$VerifierEngine
    )

    if (-not (Test-Path $DojutsuToml)) {
        Write-Warn "dojutsu.toml not found at $DojutsuToml -- skipping config update"
        return
    }

    $lines        = Get-Content $DojutsuToml
    $newLines     = [System.Collections.Generic.List[string]]::new()
    $inDispatch   = $false
    $dispatchDone = $false

    foreach ($line in $lines) {
        if ($line -match '^\[dispatch\]') {
            $inDispatch   = $true
            $dispatchDone = $true
            $newLines.Add('[dispatch]')
            $newLines.Add("mode = `"$Mode`"                     # `"native`" or `"agent-mux`" -- set by setup.ps1")
            $newLines.Add("default_engine = `"$DefaultEngine`"           # which engine the user is running in")
            $newLines.Add("available_engines = $AvailableEnginesToml      # detected by setup.ps1")
            $newLines.Add("verifier_engine = `"$VerifierEngine`"          # auto-selected: different from default_engine when possible")
            continue
        }

        if ($inDispatch) {
            if ($line -match '^\[.+\]') {
                $inDispatch = $false
                $newLines.Add($line)
            }
            continue
        }

        $newLines.Add($line)
    }

    if (-not $dispatchDone) {
        $newLines.Add('')
        $newLines.Add('[dispatch]')
        $newLines.Add("mode = `"$Mode`"")
        $newLines.Add("default_engine = `"$DefaultEngine`"")
        $newLines.Add("available_engines = $AvailableEnginesToml")
        $newLines.Add("verifier_engine = `"$VerifierEngine`"")
    }

    $newLines | Set-Content $DojutsuToml -Encoding UTF8
    Write-Ok "Updated dojutsu.toml  (dispatch.mode = `"$Mode`")"
}

# =========================================================================
#  MAIN INSTALLER FLOW
# =========================================================================

Write-Header 'Dojutsu Installer'

Write-Host '  Welcome! This will set up the Dojutsu quality pipeline on your machine.'
Write-Host "  It takes about a minute. Let's get started.`n"

# -- Step 1: Prerequisites ------------------------------------------------
Write-Header 'Checking Prerequisites'

# Python 3.9+
if (-not (Test-CommandExists 'python3') -and -not (Test-CommandExists 'python')) {
    Write-Err 'python3 (or python) is not installed.'
    Write-Info 'Install from https://www.python.org/downloads/ or:  winget install Python.Python.3.12'
    exit 1
}

$pythonCmd = if (Test-CommandExists 'python3') { 'python3' } else { 'python' }
$pyVersionRaw = & $pythonCmd -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")'
$pyParts = $pyVersionRaw.Split('.')
$pyMajor = [int]$pyParts[0]
$pyMinor = [int]$pyParts[1]

if ($pyMajor -lt 3 -or ($pyMajor -eq 3 -and $pyMinor -lt 9)) {
    Write-Err "Python 3.9+ is required (you have $pyVersionRaw)."
    Write-Info 'Upgrade from https://www.python.org/downloads/'
    exit 1
}
Write-Ok "Python $pyVersionRaw"

# git
if (-not (Test-CommandExists 'git')) {
    Write-Err 'git is not installed.'
    Write-Info 'Install from https://git-scm.com/download/win or:  winget install Git.Git'
    exit 1
}
$gitVer = (git --version) -replace 'git version ',''
Write-Ok "git $gitVer"

# -- Step 2: Detect coding agents -----------------------------------------
Write-Header 'Detecting Coding Agents'

$detectedAgents = [System.Collections.Generic.List[hashtable]]::new()

foreach ($agent in $AgentRegistry) {
    if (Test-CommandExists $agent.Cmd) {
        $detectedAgents.Add($agent)
        Write-Ok "$($agent.Label)  ($($agent.Cmd) found in PATH)"
    } else {
        Write-Info "$($agent.Label)  ($($agent.Cmd) not found -- will skip)"
    }
}

if ($detectedAgents.Count -eq 0) {
    Write-Warn 'No supported coding agents were detected on your PATH.'
    Write-Info 'Dojutsu works with: claude, codex, opencode, or gemini.'
    Write-Host ''
    $forceAll = Read-Host '  Install skill symlinks for all agents anyway? [y/N]'
    if ($forceAll -notmatch '^[Yy]') {
        Write-Step 'Nothing installed. Come back when you have an agent on PATH!'
        exit 0
    }
    foreach ($agent in $AgentRegistry) {
        $detectedAgents.Add($agent)
    }
}

# Build TOML-formatted available_engines list
$engineCmds = $detectedAgents | ForEach-Object { "`"$($_.Cmd)`"" }
$availableEnginesToml = '[' + ($engineCmds -join ', ') + ']'
$firstEngine = $detectedAgents[0].Cmd

# Pick a verifier engine (prefer one different from the default)
$verifierEngine = $firstEngine
foreach ($agent in $detectedAgents) {
    if ($agent.Cmd -ne $firstEngine) {
        $verifierEngine = $agent.Cmd
        break
    }
}

# -- Step 3: Mode selection ------------------------------------------------
Write-Header 'Choose Installation Mode'

Write-Host '  Dojutsu can run in two modes:'
Write-Host ''
Write-Host '  [1] Agent-Mux mode' -ForegroundColor White
Write-Host '      Distributes work across all detected engines for speed and cost savings.'
Write-Host '      Requires agent-mux (Go binary). We will help you install it if needed.'
Write-Host "      Estimated cost per full run: " -NoNewline
Write-Host "`$$CostMuxLow -- `$$CostMuxHigh" -ForegroundColor Green
Write-Host ''
Write-Host '  [2] Native mode' -ForegroundColor White
Write-Host '      Uses your current agent only, with Haiku/Sonnet/Opus model tier hints.'
Write-Host '      No extra dependencies needed. Simpler, but single-engine.'
Write-Host "      Estimated cost per full run: " -NoNewline
Write-Host "`$$CostNativeLow -- `$$CostNativeHigh" -ForegroundColor Green
Write-Host ''

if ($detectedAgents.Count -lt 2) {
    Write-Info 'Tip: Only one agent detected. Native mode is the simpler choice.'
}

$modeChoice = Read-Host '  Enter your choice [1/2]'

switch ($modeChoice) {
    '1' { $installMode = 'agent-mux' }
    '2' { $installMode = 'native' }
    default {
        Write-Warn 'Invalid choice. Defaulting to Native mode.'
        $installMode = 'native'
    }
}

Write-Ok "Selected mode: $installMode"

# -- Step 4a: Agent-Mux mode flow -----------------------------------------
$agentMuxReady = $false

if ($installMode -eq 'agent-mux') {
    Write-Header 'Setting Up Agent-Mux'

    if (Test-CommandExists 'agent-mux') {
        $amPath = (Get-Command 'agent-mux').Source
        Write-Ok "agent-mux already installed ($amPath)"
        $agentMuxReady = $true
    } else {
        Write-Step 'agent-mux not found on PATH. Let us install it.'

        if (Test-CommandExists 'go') {
            $goVer = (go version) -replace '^go version ',''
            Write-Ok "Go found ($goVer)"
        } else {
            Write-Step 'Go is not installed.'
            Write-Host ''
            Write-Info 'Agent-Mux requires Go to build from source.'
            Write-Info 'Install Go from: https://go.dev/dl/'
            Write-Info 'Or run:  winget install GoLang.Go'
            Write-Warn 'Cannot build agent-mux without Go. Falling back to Native mode.'
            $installMode = 'native'
        }

        # Build agent-mux if Go is available and we are still in agent-mux mode
        if ($installMode -eq 'agent-mux' -and (Test-CommandExists 'go')) {
            Write-Step 'Building agent-mux from source...'

            $buildDir = Join-Path $env:TEMP 'agent-mux-build'
            if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force }

            try {
                git clone https://github.com/buildoak/agent-mux $buildDir 2>$null
                Push-Location $buildDir
                try {
                    go build -o agent-mux.exe ./cmd/agent-mux
                    $installDir = Join-Path $HOME 'bin'
                    if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Path $installDir -Force | Out-Null }
                    Move-Item (Join-Path $buildDir 'agent-mux.exe') (Join-Path $installDir 'agent-mux.exe') -Force
                    Write-Ok "agent-mux installed to $installDir\agent-mux.exe"

                    # Check if ~/bin is on PATH
                    $pathDirs = $env:PATH -split ';'
                    if ($installDir -notin $pathDirs) {
                        Write-Warn "$installDir is not on your PATH."
                        Write-Info 'Add it via: [Environment]::SetEnvironmentVariable("PATH", "$HOME\bin;$env:PATH", "User")'
                    }

                    $agentMuxReady = $true
                } finally {
                    Pop-Location
                }
            } catch {
                Write-Err "agent-mux build failed: $_"
                Write-Warn 'Falling back to Native mode.'
                $installMode = 'native'
            } finally {
                if (Test-Path $buildDir) { Remove-Item $buildDir -Recurse -Force -ErrorAction SilentlyContinue }
            }
        }
    }

    # Generate agent-mux config if ready
    if ($agentMuxReady) {
        $muxConfigDir  = Join-Path $HOME '.agent-mux'
        $muxConfigFile = Join-Path $muxConfigDir 'config.toml'

        if (-not (Test-Path $muxConfigDir)) { New-Item -ItemType Directory -Path $muxConfigDir -Force | Out-Null }

        Write-Step 'Generating agent-mux config...'

        $engineCount = $detectedAgents.Count
        $midIdx      = if ($engineCount -gt 1) { 1 } else { 0 }
        $verifierIdx = if ($engineCount -gt 1) { ($midIdx + 1) % $engineCount } else { 0 }

        $configLines = @(
            '# agent-mux config -- generated by dojutsu setup.ps1'
            '# Maps dojutsu pipeline roles to detected engines.'
            ''
            '[defaults]'
            'timeout = 600'
            'retry = 1'
            ''
            '# Scanner roles -- high volume, low cost'
            '[[roles]]'
            'name = "scanner"'
            "engine = `"$($detectedAgents[0].Cmd)`""
            'model_tier = "cheap"'
            'timeout = 600'
            ''
            '[[roles]]'
            'name = "aggregator"'
            "engine = `"$($detectedAgents[0].Cmd)`""
            'model_tier = "cheap"'
            'timeout = 600'
            ''
            '# Mid-tier roles -- code understanding'
            '[[roles]]'
            'name = "enricher"'
            "engine = `"$($detectedAgents[$midIdx].Cmd)`""
            'model_tier = "mid"'
            'timeout = 600'
            ''
            '[[roles]]'
            'name = "fixer"'
            "engine = `"$($detectedAgents[$midIdx].Cmd)`""
            'model_tier = "mid"'
            'timeout = 600'
            ''
            '[[roles]]'
            'name = "verifier"'
            "engine = `"$($detectedAgents[$verifierIdx].Cmd)`""
            'model_tier = "mid"'
            'timeout = 1200'
            ''
            '# Premium roles -- high-quality output'
            '[[roles]]'
            'name = "narrator"'
            "engine = `"$($detectedAgents[0].Cmd)`""
            'model_tier = "premium"'
            'timeout = 1800'
            ''
            '[[roles]]'
            'name = "master_hub_generator"'
            "engine = `"$($detectedAgents[0].Cmd)`""
            'model_tier = "premium"'
            'timeout = 1800'
        )

        $configLines | Set-Content $muxConfigFile -Encoding UTF8
        Write-Ok "Generated $muxConfigFile"
    }
}

# -- Step 4b: Update dojutsu.toml -----------------------------------------
Write-Header 'Updating Configuration'

Update-TomlDispatch -Mode $installMode `
                    -DefaultEngine $firstEngine `
                    -AvailableEnginesToml $availableEnginesToml `
                    -VerifierEngine $verifierEngine

# -- Step 5: Install skill symlinks ----------------------------------------
Write-Header 'Installing Skills'

Write-Host '  Installing 5 skills into each detected agent skill directory.'
Write-Host ''

$installCount = 0
$failCount    = 0

foreach ($agent in $detectedAgents) {
    $skillDir = $agent.SkillDir
    Write-Step "Installing for $($agent.Label)  ($skillDir)"

    if (-not (Test-Path $skillDir)) {
        New-Item -ItemType Directory -Path $skillDir -Force | Out-Null
    }

    foreach ($skill in $Skills) {
        $src  = Join-Path $SkillsSrc $skill
        $dest = Join-Path $skillDir  $skill

        if (-not (Test-Path $src -PathType Container)) {
            Write-Err "Source missing: $src"
            $failCount++
            continue
        }

        # Idempotent handling
        if (Test-Path $dest) {
            $item = Get-Item $dest -Force

            # Check if it is already a symlink pointing to the correct source
            if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
                $existingTarget = $item.Target
                # .Target may be an array on some PS versions; normalise
                if ($existingTarget -is [array]) { $existingTarget = $existingTarget[0] }

                if ($existingTarget -eq $src) {
                    Write-Ok "$skill  (already linked)"
                    $installCount++
                    continue
                }
                # Stale symlink -- remove and re-link
                Remove-Item $dest -Force
                Write-Info "Replaced stale symlink for $skill"
            } elseif ($item.PSIsContainer) {
                $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
                $backup    = "${dest}.bak.${timestamp}"
                Write-Warn "$skill exists as a directory -- backed up to $(Split-Path $backup -Leaf)"
                Rename-Item $dest $backup
            } else {
                $timestamp = Get-Date -Format 'yyyyMMddHHmmss'
                $backup    = "${dest}.bak.${timestamp}"
                Write-Warn "$skill exists as a file -- backed up to $(Split-Path $backup -Leaf)"
                Rename-Item $dest $backup
            }
        }

        try {
            New-Item -ItemType SymbolicLink -Path $dest -Target $src -Force | Out-Null
            Write-Ok $skill
            $installCount++
        } catch {
            Write-Err "Failed to create symlink for $skill -- $_"
            Write-Info 'On Windows you may need to run PowerShell as Administrator, or enable Developer Mode.'
            $failCount++
        }
    }

    Write-Host ''
}

# -- Step 6: Self-test (pytest) --------------------------------------------
Write-Header 'Running Self-Tests'

$testDirs = [System.Collections.Generic.List[string]]::new()
foreach ($subdir in @('rinnegan', 'rasengan')) {
    $testPath = Join-Path $SkillsSrc $subdir 'tests'
    if (Test-Path $testPath -PathType Container) {
        $testDirs.Add($testPath)
    }
}
$topTests = Join-Path $ScriptDir 'tests'
if (Test-Path $topTests -PathType Container) {
    $testDirs.Add($topTests)
}

$testsPassed = $true

if ($testDirs.Count -gt 0) {
    foreach ($testDir in $testDirs) {
        $testLabel = (Split-Path (Split-Path $testDir -Parent) -Leaf) + '/tests'
        Write-Step "Running pytest on $testLabel..."

        try {
            $pytestOutput = & $pythonCmd -m pytest $testDir -q 2>&1
            if ($LASTEXITCODE -eq 0) {
                Write-Ok "$testLabel passed"
            } else {
                Write-Warn "$testLabel had failures (skills are installed but may need attention)"
                $testsPassed = $false
            }
        } catch {
            Write-Warn "$testLabel could not run: $_"
            $testsPassed = $false
        }
    }
} else {
    Write-Info 'No test directories found -- skipping self-tests.'
}

# -- Step 7: Verify symlinks -----------------------------------------------
Write-Header 'Verifying Symlinks'

$verifyPass = 0
$verifyFail = 0

foreach ($agent in $detectedAgents) {
    foreach ($skill in $Skills) {
        $dest = Join-Path $agent.SkillDir $skill

        $skillMd = $null
        $candidates = @('SKILL.md', 'skill.md', 'CLAUDE.md')
        foreach ($candidate in $candidates) {
            $candidatePath = Join-Path $dest $candidate
            if (Test-Path $candidatePath -PathType Leaf) {
                $skillMd = $candidatePath
                break
            }
        }

        if ($null -ne $skillMd) {
            $verifyPass++
        } elseif ((Test-Path $dest) -and (Get-Item $dest -Force).PSIsContainer) {
            Write-Warn "$($agent.Label)/$skill -- no SKILL.md found (non-critical)"
            $verifyPass++
        } else {
            Write-Err "$($agent.Label)/$skill -- symlink broken or missing"
            $verifyFail++
        }
    }
}

if ($verifyFail -eq 0) {
    Write-Ok "All $verifyPass skill symlinks verified and readable."
} else {
    Write-Warn "$verifyPass verified, $verifyFail failed -- check errors above."
}

# -- Summary ---------------------------------------------------------------
Write-Header 'Installation Complete'

Write-Host "  Mode:   $installMode"
$summaryMsg = "  Skills: $installCount installed across $($detectedAgents.Count) agent(s)"
if ($failCount -gt 0) {
    $summaryMsg += "  "
    Write-Host $summaryMsg -NoNewline
    Write-Host "($failCount failed)" -ForegroundColor Red
} else {
    Write-Host $summaryMsg
}

if ($installMode -eq 'agent-mux') {
    Write-Host "  Engines: $availableEnginesToml"
}

Write-Host ''
Write-Host '  Estimated cost per full pipeline run:'
if ($installMode -eq 'agent-mux') {
    Write-Host "    `$$CostMuxLow -- `$$CostMuxHigh  (multi-engine, optimized routing)" -ForegroundColor Green
} else {
    Write-Host "    `$$CostNativeLow -- `$$CostNativeHigh  (single-engine, tier-based model hints)" -ForegroundColor Green
}

Write-Host ''
Write-Host '  Available commands:'
Write-Host '    /dojutsu   ' -ForegroundColor Cyan -NoNewline
Write-Host ' Full automated pipeline (audit, analyze, fix, verify)'
Write-Host '    /rinnegan  ' -ForegroundColor Cyan -NoNewline
Write-Host ' Audit codebase for engineering rule violations'
Write-Host '    /byakugan  ' -ForegroundColor Cyan -NoNewline
Write-Host ' Deep analysis -- dependencies, blast radius, scorecards'
Write-Host '    /rasengan  ' -ForegroundColor Cyan -NoNewline
Write-Host ' Autonomously fix audit findings phase by phase'
Write-Host '    /sharingan ' -ForegroundColor Cyan -NoNewline
Write-Host ' Evidence-based QA pipeline (6 verification gates)'
Write-Host ''
Write-Host '  Run ' -NoNewline
Write-Host '/dojutsu' -ForegroundColor White -NoNewline
Write-Host ' in any project to start the full pipeline.'
Write-Host '  Run ' -NoNewline
Write-Host '.\uninstall.sh' -ForegroundColor White -NoNewline
Write-Host ' (or the future uninstall.ps1) to cleanly remove all symlinks.'
Write-Host ''
