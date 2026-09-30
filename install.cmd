@echo off
rem Installs opencode-goal-plugin for Windows Command Prompt (cmd.exe)
rem Delegating to install.ps1 via PowerShell with execution policy bypass

setlocal enabledelayedexpansion

set SCRIPT_DIR=%~dp0
set FORCE_ARG=

:parse_args
if "%~1"=="" goto run_install
if /i "%~1"=="-f" set FORCE_ARG=-Force
if /i "%~1"=="--force" set FORCE_ARG=-Force
if /i "%~1"=="/f" set FORCE_ARG=-Force
if /i "%~1"=="-h" goto show_help
if /i "%~1"=="--help" goto show_help
if /i "%~1"=="/?" goto show_help
shift
goto parse_args

:show_help
echo usage: install.cmd [-f]
echo Installs opencode-goal-plugin into the global OpenCode plugins directory.
exit /b 0

:run_install
where powershell >nul 2>&1
if %ERRORLEVEL% equ 0 (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" %FORCE_ARG%
  exit /b %ERRORLEVEL%
)

where pwsh >nul 2>&1
if %ERRORLEVEL% equ 0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" %FORCE_ARG%
  exit /b %ERRORLEVEL%
)

echo error: PowerShell is required to run the installer script on Windows. >&2
exit /b 1
