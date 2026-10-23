#!/usr/bin/env python3
"""圈地自萌邀请语解析测试。

不导入 MCP / bilibili-api，只从真实 mcp_server.py 里抽出规则函数执行，
所以既测的是生产代码，又不需要网络、登录态或第三方依赖。
"""
import ast
import re
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "vendor" / "bilibili-mcp" / "mcp_server.py"
tree = ast.parse(SRC.read_text(encoding="utf-8"), filename=str(SRC))

wanted = {"_CIRCLE_NEG", "_CIRCLE_POS", "_circle_invite_match"}
nodes = []
for node in tree.body:
    if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id in wanted for t in node.targets):
        nodes.append(node)
    elif isinstance(node, ast.FunctionDef) and node.name in wanted:
        nodes.append(node)

assert len(nodes) == 3, f"应从真实源码抽出 3 个圈地节点，实际 {len(nodes)}"
module = ast.Module(body=[ast.Import(names=[ast.alias(name="re")])] + nodes, type_ignores=[])
ast.fix_missing_locations(module)
ns = {}
exec(compile(module, str(SRC), "exec"), ns)
match = ns["_circle_invite_match"]

passed = [
    "大肥鱼快来",
    "鱼来",
    "@大肥鱼 快来",
    "鱼塘的鱼，快来玩",
    "快来，大肥鱼",
    "鱼来评论区",
]
rejected = {
    "大肥鱼不要来": "negative",
    "别来": "negative",
    "大肥鱼来了": "not-invite",
    "鱼来了": "not-invite",
    "普通用户说鱼来": "not-invite",
    "今天天气不错": "not-invite",
}
for text in passed:
    ok, why = match(text)
    assert ok is True, f"应识别为邀请：{text!r}，实际 why={why}"
for text, why in rejected.items():
    ok, got = match(text)
    assert ok is False, f"不应识别为邀请：{text!r}"
    assert got == why, f"拒绝原因不对：{text!r} expected={why} got={got}"

print(f"[OK] circle invite tests: {len(passed) + len(rejected)} cases")
