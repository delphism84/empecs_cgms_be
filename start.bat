@echo off
cd /d %~dp0
if not exist node_modules (
  call npm install
)
set PORT=58002
set MONGO_MEMORY=1
call npm run dev


