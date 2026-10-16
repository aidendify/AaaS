@echo off
cd /d "%~dp0"
where node >nul 2>nul || (echo Install Node.js 20+ from https://nodejs.org then run this again. & pause & exit /b 1)
if not exist node_modules (echo Installing... & call npm install || (pause & exit /b 1))
if not exist .env (copy .env.example .env >nul & echo Created .env - paste your OPENROUTER_API_KEY into it, save, and run start.bat again. & notepad .env & exit /b 0)
start "" http://localhost:3000
node server.js
pause
