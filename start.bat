@echo off
cd /d "%~dp0"
echo 启动本地服务器: http://localhost:8080
start chrome.exe "http://localhost:8080"
python -m http.server 8080
pause
