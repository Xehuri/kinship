"""守卫测试：analysis 模板脚本注释不得残留个人实例日期与用户引语。"""

import re
from pathlib import Path

ANALYSIS_DIR = Path(__file__).resolve().parents[1]

FORBIDDEN_PATTERNS = (
    re.compile('明明冷到爆'),
    re.compile('用户(说|定|指出|原话)'),
    re.compile(r'批次\d+\s*实证'),
    re.compile('2026-09-24'),
)


def _scan_offenders() -> list[str]:
    offenders: list[str] = []
    for path in sorted(ANALYSIS_DIR.glob('*.py')):
        text = path.read_text(encoding='utf-8')
        for pattern in FORBIDDEN_PATTERNS:
            if pattern.search(text):
                offenders.append(f'{path.name}: {pattern.pattern}')
    return offenders


def test_analysis_comments_have_no_instance_dates_or_user_quotes() -> None:
    offenders = _scan_offenders()
    assert offenders == [], (
        '模板注释残留个人实例信息，请改写为通用表述：\n' + '\n'.join(offenders)
    )
