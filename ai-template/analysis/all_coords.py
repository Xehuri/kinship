"""检查多日全部唯一 GPS 坐标及出现次数

用法:
    python analysis/all_coords.py <日期> [日期...]
    例: python analysis/all_coords.py 2026-01-01 2026-01-02
"""
import json
import os
import sys
from collections import Counter

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.normpath(os.path.join(_SCRIPT_DIR, '..', 'data'))


def main():
    days = sys.argv[1:]
    if not days:
        print('用法: python analysis/all_coords.py <日期> [日期...]')
        sys.exit(1)

    coords_by_day = {}
    for day in days:
        path = os.path.join(_DATA_DIR, day, 'perception.jsonl')
        try:
            with open(path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        e = json.loads(line)
                        if e.get('type') == 'sensor' and e.get('gps'):
                            coords_by_day.setdefault(day, Counter())[e['gps']] += 1
                    except Exception:
                        pass
        except FileNotFoundError:
            pass

    # 输出每日全部唯一坐标及条数
    for day, coords in sorted(coords_by_day.items()):
        print(f'\n=== {day} ===')
        for coord, count in coords.most_common():
            print(f'  {coord}: {count}条')


if __name__ == '__main__':
    main()
