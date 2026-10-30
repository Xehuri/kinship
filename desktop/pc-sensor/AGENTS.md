# PC 感知采集器 (pc-sensor)

Windows 系统托盘常驻，采集前台窗口 / 无人 / 锁屏并上报后端。
功能、配置、HTTP API 详见 `README.md`（本文件只补充打包相关内容）。

## 打包为 exe

建议在 conda 环境 `axeuh-multi-agent` 下打包（exe 依赖该环境的 Python 3.11）。
未激活时 `build.bat` 只打印警告、不中断打包，但缺 DLL 的产物可能无法运行：

```bash
conda activate axeuh-multi-agent
cd desktop/pc-sensor
build.bat
```

产物：`dist/Kinship-PCSensor.exe`（单文件、无控制台，图标 `assets/kinship-pc-sensor.ico`）。

`build.bat` 内的实际打包命令（等价手动执行）：

```bash
pyinstaller --onefile --noconsole --name Kinship-PCSensor \
    --add-data "config.json;." \
    --add-data "pc_sensor_config.json;." \
    --add-data "static;static" \
    --add-data "assets;assets" \
    --icon "assets\kinship-pc-sensor.ico" \
    --hidden-import pystray \
    --hidden-import pystray._win32 \
    --hidden-import PIL._tkinter_finder \
    --additional-hooks-dir . \
    pc_sensor_app.py
```

## 打包注意事项（conda + PyInstaller）

- **建议激活 `axeuh-multi-agent`**：`build.bat` 会依据 `CONDA_PREFIX` 把 `<环境>\Library\bin`
  注入 PATH，PyInstaller 才能收集扩展模块依赖的 DLL。未激活时脚本仅告警，仍会继续打包。
- conda 把 `ffi-8.dll`、`libjpeg.dll`、`tiff.dll`、`openjp2.dll` 等放在 `<环境>\Library\bin`
  （非标准 `DLLs` 目录）。缺失时 exe 运行会报
  `DLL load failed while importing _ctypes / _imaging`，pystray、PIL 随之导入失败。
- `hook-_ctypes.py` 为兜底 hook，打包时动态收集 ffi DLL；配合 `--additional-hooks-dir .` 生效。
- `config.json`、`pc_sensor_config.json`、`static/` 内嵌进 exe，首次运行在 exe 同目录生成可写配置。
- 修改 `build.bat` 时保持 **CRLF 行尾**，否则 `^` 续行会失效。
- `dist/`、`build/`、`*.spec` 已在 `.gitignore` 忽略。

## 认证代理契约

- `GET /pc-sensor/auth-token` 需 Bearer `agent_token`，返回 `{token, expires_in}` 内存快照：
  未取得 Token 时 `token=""`、`expires_in=0`；静态 Token 的 `expires_in=null`；登录 Token 为剩余秒数。
- 该端点不得写日志、不得落盘；唯一消费者是桌面壳，Token 只用于注入 SPA，不得拼进 URL 查询串或 hash。

## 运行（开发）

```bash
python pc_sensor_app.py            # 自动打开配置页
python pc_sensor_app.py --silent   # 静默驻留托盘（开机自启）
```

## 桌面内嵌（无托盘）

```bash
python pc_sensor_app.py --silent --no-tray --data-dir <dir> --parent-pid <pid>
```

- `--no-tray`：不导入 pystray/Pillow，不创建托盘、不弹浏览器；主线程等待退出事件。
- `--data-dir` > `PC_SENSOR_DATA_DIR` > 程序目录：`config.json`、`pc_sensor_config.json`、
  `pc-sensor.log` 只写该目录；`static/` 仍从资源目录读取。
- `--parent-pid`：每 2 秒检查父进程，消失即退出（不杀父进程）。
- `POST /shutdown`（Bearer）返回 `{"success": true}` 后进程自行退出；SIGINT/SIGTERM 同效。
- 端口绑定失败时启动阶段直接非零退出，不留空转进程。
- 本地静态资源：`static/vendor/chart.umd.min.js`（Chart.js），配置页不引用外网 CDN。
