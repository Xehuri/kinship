"""
GPS坐标逆地理编码工具
并发限制：最多2个请求同时进行（1秒最多2次），超出会触发百度API告警
使用方法:
    python analysis/geocode_tool.py <lat,lng> [lat,lng ...]
    python analysis/geocode_tool.py --batch <file.json>  # 从JSON文件读取坐标列表

示例:
    python analysis/geocode_tool.py <lat1>,<lon1> <lat2>,<lon2>
    python analysis/geocode_tool.py --file data/2026-01-01/gps_points.json
"""

import requests
import time
import sys
import json
import os

# 百度地图开放平台 AK（Web 服务 API）
# TODO: 替换为你自己的 AK
AK = '{百度地图AK}'
CONCURRENCY_LIMIT = 1
DELAY_BETWEEN_BATCHES = 2.0  # 每批之间延时2秒（1秒最多1次，省配额）

# 缓存：避免重复解析相同坐标
_cache = {}

def reverse_geocode(lat, lng, retry=2):
    """解析单个GPS坐标，返回地址信息"""
    cache_key = '{},{}'.format(lat, lng)
    if cache_key in _cache:
        return _cache[cache_key]

    url = 'https://api.map.baidu.com/reverse_geocoding/v3/?ak={}&output=json&coordtype=wgs84ll&location={},{}'.format(
        AK, lat, lng)

    for attempt in range(retry):
        try:
            r = requests.get(url, timeout=10)
            data = r.json()
            if data.get('status') == 0:
                result = data.get('result', {})
                addr = result.get('formatted_address', '')
                poi = result.get('pois', [])
                poi_names = [p.get('name', '') for p in poi[:3]]
                business = result.get('business', '')

                info = {
                    'gps': cache_key,
                    'address': addr,
                    'poi': poi_names,
                    'business': business,
                    'province': result.get('addressComponent', {}).get('province', ''),
                    'city': result.get('addressComponent', {}).get('city', ''),
                    'district': result.get('addressComponent', {}).get('district', ''),
                    'street': result.get('addressComponent', {}).get('street', ''),
                    'street_number': result.get('addressComponent', {}).get('street_number', ''),
                }
                _cache[cache_key] = info
                return info
            else:
                print('  [WARN] API error {} for {}'.format(data.get('status'), cache_key), file=sys.stderr)
                if attempt < retry - 1:
                    time.sleep(1)
        except Exception as e:
            print('  [WARN] Request error for {}: {}'.format(cache_key, e), file=sys.stderr)
            if attempt < retry - 1:
                time.sleep(1)

    return None


def geocode_batch(coords, labels=None):
    """
    批量解析GPS坐标（带并发控制）
    
    参数:
        coords: [(lat,lng), ...] 或 ["lat,lng", ...]
        labels: [str, ...] 可选标签
    
    返回: [info_dict, ...]
    """
    # 标准化输入
    parsed_coords = []
    for c in coords:
        if isinstance(c, str):
            parts = c.split(',')
            parsed_coords.append((float(parts[0].strip()), float(parts[1].strip())))
        else:
            parsed_coords.append((float(c[0]), float(c[1])))

    if labels is None:
        labels = ['点{}'.format(i+1) for i in range(len(parsed_coords))]

    results = []
    batch_num = 0

    for i in range(0, len(parsed_coords), CONCURRENCY_LIMIT):
        batch = parsed_coords[i:i+CONCURRENCY_LIMIT]
        batch_labels = labels[i:i+CONCURRENCY_LIMIT]
        batch_num += 1

        if batch_num > 1:
            time.sleep(DELAY_BETWEEN_BATCHES)

        # 打印信息
        print('--- 批次{} (坐标{}-{}) ---'.format(
            batch_num, i+1, min(i+CONCURRENCY_LIMIT, len(parsed_coords))))

        for (lat, lng), label in zip(batch, batch_labels):
            info = reverse_geocode(lat, lng)
            if info:
                print('{} ({}): {} {}'.format(label, info['gps'], info['address'],
                      ' | POI: {}'.format(', '.join(info['poi'])) if info['poi'] else ''))
                results.append(info)
            else:
                print('{} ({},{}): 解析失败'.format(label, lat, lng))
                results.append(None)

    return results


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    coords = []
    labels = []

    if sys.argv[1] == '--file' or sys.argv[1] == '-f':
        # 从文件读取
        filepath = sys.argv[2]
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data, list):
            for item in data:
                if isinstance(item, dict):
                    coords.append((item['lat'], item['lng']))
                    labels.append(item.get('label', ''))
                else:
                    coords.append(item)
                    labels.append('')
        elif isinstance(data, dict):
            for label, gps_str in data.items():
                parts = gps_str.split(',')
                coords.append((float(parts[0].strip()), float(parts[1].strip())))
                labels.append(label)
    else:
        # 从命令行参数读取
        for arg in sys.argv[1:]:
            if ',' in arg:
                coords.append(arg)
                labels.append('')

    if not coords:
        print('没有有效的坐标输入', file=sys.stderr)
        sys.exit(1)

    print('共{}个坐标，并发上限{}，分批解析...'.format(len(coords), CONCURRENCY_LIMIT))
    geocode_batch(coords, labels if any(labels) else None)
    print('\n完成。缓存了{}个坐标结果。'.format(len(_cache)))


if __name__ == '__main__':
    main()
