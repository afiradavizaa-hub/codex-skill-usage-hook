@echo off
rem ===========================================================================
rem Launcher for skill-usage-hook.mjs (Windows).
rem Order: node on PATH -> Codex bundled cua_node -> common install locations.
rem When no node is found the launcher exits quietly: a missing runtime must
rem never break a tool call.
rem
rem CLI passthrough: skill-usage-hook.mjs --check / --discover / --stats
rem ===========================================================================
setlocal
set "HOOK=%~dp0skill-usage-hook.mjs"

for /f "delims=" %%p in ('where node 2^>nul') do (
  set "NODE_EXE=%%p"
  goto run
)

for /d %%d in ("%LOCALAPPDATA%\OpenAI\Codex\runtimes\cua_node\*") do (
  if exist "%%d\bin\node.exe" (
    set "NODE_EXE=%%d\bin\node.exe"
    goto run
  )
)

for %%c in ("%ProgramFiles%\nodejs\node.exe" "%LOCALAPPDATA%\Programs\nodejs\node.exe" "%APPDATA%\nvm\node.exe") do (
  if exist "%%~c" (
    set "NODE_EXE=%%~c"
    goto run
  )
)

rem no usable node found: stay silent rather than break the tool call
exit /b 0

:run
"%NODE_EXE%" --no-warnings "%HOOK%" %*
exit /b 0
