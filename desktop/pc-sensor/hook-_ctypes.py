# -*- coding: utf-8 -*-
"""PyInstaller hook：收集 conda 环境下 ctypes 所需的 ffi DLL。

conda-forge 打包的 CPython 把 _ctypes.pyd 的依赖 ffi-8.dll 放在
<环境>/Library/bin 下（非标准 DLLs 目录）。PyInstaller 6.x 在部分 conda
环境无法自动收集该 DLL，导致打包后的 exe 运行时报：

    ImportError: this platform is not supported:
    DLL load failed while importing _ctypes: 找不到指定的模块

进而 pystray 等依赖 ctypes 的库全部导入失败。

本 hook 在打包阶段动态搜索当前 Python 环境下的 ffi DLL 并随包分发，
不依赖任何硬编码路径，因此在任意 conda / 官方 Python 环境下均可生效。
"""

import glob
import os
import sys

binaries = []

# 候选目录：conda 的 Library/bin、标准 DLLs、环境根目录
_candidate_dirs = [
    os.path.join(sys.prefix, "Library", "bin"),
    os.path.join(sys.prefix, "DLLs"),
    sys.prefix,
]

# 候选文件名：conda-forge 用 ffi-8.dll，官方 Python 用 libffi-8.dll
_candidate_patterns = (
    "ffi-*.dll",
    "libffi-*.dll",
    "ffi.dll",
)

for _dir in _candidate_dirs:
    for _pattern in _candidate_patterns:
        for _path in glob.glob(os.path.join(_dir, _pattern)):
            if os.path.isfile(_path):
                binaries.append((_path, "."))
