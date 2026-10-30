"""
安全审查工具 - AI 自检脚本用

用法:
    python ai/data/tasks/check.py ai/data/tasks/hello_production.py
"""

import ast
import sys
import os

ALLOWED_IMPORTS = {
    "math", "json", "re", "datetime", "time", "random",
    "typing", "collections", "pathlib",
}

ALLOWED_OS_PATH_METHODS = {
    "exists", "getsize", "getmtime", "basename", "dirname",
    "join", "splitext", "isfile", "isdir", "normpath",
}

BLOCKED_BUILTINS = {"eval", "exec", "compile", "__import__", "open", "input"}
BLOCKED_MODULES = {"os", "subprocess", "socket", "shutil", "ctypes",
                   "requests", "http", "asyncio", "threading", "multiprocessing"}


class Checker(ast.NodeVisitor):
    def __init__(self):
        self.errors = []
        self.used = set()

    def visit_Import(self, node):
        for alias in node.names:
            if alias.name in BLOCKED_MODULES:
                self.errors.append(f"禁止模块: {alias.name}")
            elif alias.name not in ALLOWED_IMPORTS:
                self.errors.append(f"未在白名单: {alias.name}")
            else:
                self.used.add(alias.name)

    def visit_ImportFrom(self, node):
        m = node.module or ""
        if m == "os.path":
            for alias in node.names:
                if alias.name not in ALLOWED_OS_PATH_METHODS:
                    self.errors.append(f"禁止的 os.path 方法: {alias.name}")
                else:
                    self.used.add(f"os.path.{alias.name}")
            return
        if m in BLOCKED_MODULES:
            self.errors.append(f"禁止模块: {m}")
            return
        if m not in ALLOWED_IMPORTS:
            self.errors.append(f"未在白名单: {m}")

    def visit_Call(self, node):
        if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_BUILTINS:
            self.errors.append(f"禁止内置函数: {node.func.id}()")
        if isinstance(node.func, ast.Name) and node.func.id == "getattr":
            self.errors.append("禁止 getattr() - 可用于绕过导入限制")
        if isinstance(node.func, ast.Attribute):
            if node.func.attr in ("format", "format_map"):
                self.errors.append("禁止 format() - 类遍历绕过")
            if node.func.attr == "getattr":
                self.errors.append("禁止 getattr 调用")
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if node.attr.startswith("_"):
            self.errors.append(f"禁止私有属性访问: {node.attr}")
        self.generic_visit(node)


def check(source: str) -> dict:
    tree = ast.parse(source)
    c = Checker()
    c.visit(tree)
    return {
        "passed": len(c.errors) == 0,
        "errors": c.errors,
        "used": sorted(c.used),
        "lines": len(source.splitlines()),
    }


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python ai/check.py <script.py>")
        sys.exit(1)

    path = sys.argv[1]
    if not os.path.isfile(path):
        print(f"文件不存在: {path}")
        sys.exit(1)

    with open(path, "r", encoding="utf-8") as f:
        source = f.read()

    # 检查 frontmatter
    has_fm = source.lstrip().startswith('"""') or source.lstrip().startswith("'''")
    
    result = check(source)

    print(f"\n文件: {path}")
    print(f"Frontmatter: {'有' if has_fm else '无'}")
    print(f"安全审查: {'通过' if result['passed'] else '未通过'}")
    print(f"检查行数: {result['lines']}")
    print(f"使用模块: {', '.join(result['used']) or '无'}")

    if result['errors']:
        print(f"\n问题 ({len(result['errors'])} 个):")
        for e in result['errors']:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print("\n无问题")
        sys.exit(0)
