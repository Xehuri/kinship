"""分析单个日期的传感器数据覆盖度

用法:
    python analysis/sensor_coverage.py <日期>
    例: python analysis/sensor_coverage.py 2026-01-01
"""
import json
import os
import sys

_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_DATA_DIR = os.path.normpath(os.path.join(_SCRIPT_DIR, '..', 'data'))


def main():
    day = sys.argv[1] if len(sys.argv) > 1 else None
    if not day:
        print('用法: python analysis/sensor_coverage.py <日期>')
        sys.exit(1)

    data_dir = os.path.join(_DATA_DIR, day)
    events = []
    perception = os.path.join(data_dir, 'perception.jsonl')
    if os.path.exists(perception):
        with open(perception, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        events.append(json.loads(line))
                    except Exception:
                        pass

    # GPS 数据
    gps_events = [e for e in events if e.get('gps')]
    print(f'GPS事件数: {len(gps_events)}')
    if gps_events:
        for g in gps_events[:3]:
            print(f"  {g.get('t', '')} {g.get('gps')}")

    # foreground_app 分布
    app_events = [e for e in events if e.get('foreground_app')]
    print(f'\nforeground_app事件数: {len(app_events)}')
    apps = {}
    for e in app_events:
        a = e.get('foreground_app', '')
        apps[a] = apps.get(a, 0) + 1
    for a, c in sorted(apps.items(), key=lambda x: -x[1])[:15]:
        print(f'  {a}: {c}')

    # sensor 事件带 foreground_app
    sensor_with_app = [e for e in events if e.get('type') == 'sensor' and e.get('foreground_app')]
    print(f'\nsensor事件带foreground_app: {len(sensor_with_app)}')

    # sample 类型事件
    samples_type = [e for e in events if e.get('type') == 'sample']
    print(f'\nsample类型事件数: {len(samples_type)}')
    if samples_type:
        print(f'  样例字段: {list(samples_type[0].keys())[:10]}')

    # voice 事件带 sensors 嵌套
    voice_with_sensors = [e for e in events if e.get('type') == 'voice' and e.get('sensors')]
    print(f'\nvoice事件带sensors嵌套: {len(voice_with_sensors)}')

    # 健康数据中的各指标覆盖范围
    samples = []
    health_path = os.path.join(data_dir, 'health.json')
    if os.path.exists(health_path):
        with open(health_path, 'r', encoding='utf-8') as f:
            health = json.load(f)
        samples = health.get('samples', [])
    total = len(samples)
    print(f'\n健康数据覆盖 (n={total}):')
    if total:
        for field, label in [('hr', '心率'), ('steps', '步数'), ('spo2', '血氧'), ('stress', '压力')]:
            count = sum(1 for s in samples if s.get(field))
            print(f'  {label}({field}): {count} ({count / total * 100:.0f}%)')


if __name__ == '__main__':
    main()
