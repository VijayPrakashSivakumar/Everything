@echo off
setlocal
pushd "%~dp0"
call "C:\Users\VIJAYPRAKASH\.gradle\wrapper\dists\gradle-9.8.1-all\694sjqlzlkdyf2wxiw00wlz0w\gradle-9.8.1\bin\gradle.bat" -p "%~dp0." %*
set "GRADLE_EXIT_CODE=%ERRORLEVEL%"
popd
exit /b %GRADLE_EXIT_CODE%