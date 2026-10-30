@echo off
chcp 65001 > nul
title Kinship-PCSensor 构建脚本

echo ========================================
echo   Kinship PC 感知采集器 构建脚本
echo ========================================
echo.

:: 检查 pyinstaller
where pyinstaller >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [错误] 未找到 pyinstaller，请先安装:
    echo   pip install pyinstaller
    pause
    exit /b 1
)

:: 检查入口文件
if not exist pc_sensor_app.py (
    echo [错误] 未找到 pc_sensor_app.py
    echo 请在 desktop/pc-sensor/ 目录下运行此脚本
    pause
    exit /b 1
)

:: 配置文件不入 git(含 token/密码), 首次构建时从示例生成
if not exist config.json if exist config.example.json copy /Y config.example.json config.json >nul
if not exist pc_sensor_config.json if exist pc_sensor_config.example.json copy /Y pc_sensor_config.example.json pc_sensor_config.json >nul

echo [1/3] 清理旧构建...
if exist build rmdir /s /q build >nul 2>&1
if exist dist rmdir /s /q dist >nul 2>&1
if exist Kinship-PCSensor.spec del Kinship-PCSensor.spec >nul 2>&1

:: PyInstaller 在 conda 环境下需要把 <环境>\Library\bin 加入 PATH，
:: 否则无法解析扩展模块依赖的 DLL（ffi-8.dll / libjpeg.dll / tiff.dll 等），
:: 打包出的 exe 会报 "DLL load failed while importing _ctypes / _imaging"。
if defined CONDA_PREFIX (
    set "PATH=%CONDA_PREFIX%\Library\bin;%PATH%"
    echo [信息] 已注入 conda DLL 搜索路径: %CONDA_PREFIX%\Library\bin
) else (
    echo [警告] 未检测到已激活的 conda 环境。
    echo         若打包出的 exe 提示缺少 DLL，请先运行: conda activate axeuh-multi-agent
)
echo.

echo [2/3] 开始打包...
pyinstaller --onefile --noconsole --name Kinship-PCSensor ^
    --add-data "config.json;." ^
    --add-data "pc_sensor_config.json;." ^
    --add-data "static;static" ^
    --add-data "assets;assets" ^
    --icon "assets\kinship-pc-sensor.ico" ^
    --hidden-import pystray ^
    --hidden-import pystray._win32 ^
    --hidden-import PIL._tkinter_finder ^
    --additional-hooks-dir . ^
    pc_sensor_app.py

if %ERRORLEVEL% NEQ 0 (
    echo [错误] 打包失败
    pause
    exit /b 1
)

echo [3/3] 打包完成!
echo.
echo 输出文件: %cd%\dist\Kinship-PCSensor.exe
echo.
echo 使用方式:
echo   1. 双击 Kinship-PCSensor.exe 运行，右下角托盘出现图标
echo   2. 右键托盘图标可打开配置网页、启停采集、设置开机自启
echo   3. config.json 与 pc_sensor_config.json 会自动生成在 exe 同目录
echo.

pause
