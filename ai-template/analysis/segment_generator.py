"""
示例：自动生成5分钟分段格式的理解文件
用法: python analysis/segment_generator.py 2026-01-01 --hours 10:00~12:00
输出示例到文件
"""
import json, sys, os
from collections import defaultdict

def load_events(date_str):
    for base in [os.path.join(os.path.dirname(__file__), '..'), os.getcwd()]:
        # 优先新路径 data/daily/，回退旧路径 data/
        for rel in [os.path.join('data', 'daily', date_str), os.path.join('data', date_str)]:
            path = os.path.join(base, rel, 'perception.jsonl')
            if os.path.exists(path):
                with open(path, 'r', encoding='utf-8') as f:
                    return [json.loads(l) for l in f if l.strip()]
    return None

def segment_key(t):
    """返回时间戳所在的5分钟段起点，如 '10:03' -> '10:00'"""
    h, m = t[:2], int(t[3:5])
    return f'{h}:{m//5*5:02d}'

def generate_segments(events, time_range=None):
    # 过滤时间
    if time_range:
        start_t, end_t = time_range.split('~')
        events = [e for e in events if start_t <= e.get('t','')[:5] <= end_t]
    
    # 按5分钟段分组
    buckets = defaultdict(lambda: defaultdict(list))
    seen_gps = set()
    
    for e in events:
        t = e.get('t', '')
        seg = segment_key(t)
        tp = e.get('type', '')
        
        if tp == 'sensor':
            gps = e.get('gps')
            if gps and gps not in seen_gps:
                seen_gps.add(gps)
                buckets[seg]['gps'].append((t, gps))
            
            hr = e.get('hr', 0)
            if hr:
                buckets[seg]['hr'].append((t, hr))
            
            steps = e.get('steps', 0)
            if steps and not buckets[seg]['steps']:
                buckets[seg]['steps'].append((t, steps))
                
            battery = e.get('battery')
            if battery is not None:
                if not buckets[seg]['battery']:
                    buckets[seg]['battery'].append((t, battery))
        
        elif tp == 'voice':
            for s in e.get('segments', []):
                text = s.get('text', '').strip()
                if not text or 'nospeech' in text or 'Event_UNK' in text:
                    continue
                sim = s.get('voiceprint_sim') or 0
                tag = '[环境]' if sim < 0.3 else '[混合]' if sim < 0.5 else '[用户]'
                emo = s.get('emotion_tag', '')
                db = s.get('avg_db', '')
                extra = ''
                if emo: extra += f' emo={emo}'
                if db: extra += f' db={db:.1f}'
                buckets[seg]['voice'].append((t, sim, tag, text[:120], extra))
        
        # Voice去重：同一段内相同文本只保留一条
        if 'voice' in buckets[seg]:
            seen_voice = set()
            deduped = []
            for item in buckets[seg]['voice']:
                key = item[3][:30]  # 前30字去重
                if key not in seen_voice:
                    deduped.append(item)
                    seen_voice.add(key)
            buckets[seg]['voice'] = deduped
            
            # Audio events
            for ae in e.get('audio_events', []):
                label = ae.get('label_cn', ae.get('label', ''))
                prob = ae.get('probability', 0)
                if prob >= 0.2:
                    buckets[seg]['audio'].append((label, prob))
        
        elif tp == 'screen':
            buckets[seg]['screen'].append((t, '解锁' if e.get('locked') == False else '锁屏'))
        
        elif tp == 'app':
            name = e.get('app', '')
            if name:
                buckets[seg]['app'].append((t, name))
        
        elif tp == 'media':
            title = e.get('media_title', '')
            if title:
                state = e.get('media_state', '')
                buckets[seg]['media'].append(f'"{title}" [{state}]')
        
        elif tp == 'notify':
            text = e.get('text', '')
            if text:
                pkg = e.get('pkg', '')
                buckets[seg]['notify'].append((t, pkg, text[:60]))
        
        elif tp == 'input':
            text = e.get('text', '')
            if text:
                buckets[seg]['input'].append((t, text[:60]))
        
        elif tp == 'device_env':
            wifi = e.get('wifi', {})
            conn = wifi.get('connected')
            if conn is not None:
                status = 'WiFi连' if conn else 'WiFi断'
                # 只记录连接状态变化，忽略RSSI
                buckets[seg]['device_env'].append((t, status))
    
    # 格式化输出
    lines = []
    sorted_segs = sorted(buckets.keys())
    
    for seg in sorted_segs:
        data = buckets[seg]
        lines.append(f'\n### {seg}~{seg[:3]}{int(seg[3:5])+4:02d}')
        lines.append('')
        lines.append('【原始数据】')
        
        # GPS
        if data['gps']:
            for t, gps in data['gps'][:1]:  # 只显示最新的
                lines.append(f'- GPS: {gps}')
        else:
            lines.append('- GPS: 无变化')
        
        # HR
        if data['hr']:
            hr_str = ' '.join([f'{t} HR={h}' for t, h in data['hr']])
            lines.append(f'- HR: {hr_str}')
        else:
            lines.append('- HR: 无')
        
        # Steps
        if data['steps']:
            lines.append(f'- Steps: {data["steps"][-1][1]}')
        else:
            lines.append('- Steps: 无')
        
        # Battery
        if data['battery']:
            lines.append(f'- Battery: {data["battery"][-1][1]}%')
        else:
            lines.append('- Battery: 无')
        
        # Screen
        if data['screen']:
            for t, status in data['screen']:
                lines.append(f'- Screen: {t} {status}')
        else:
            lines.append('- Screen: 无')
        
        if data['app']:
            for t, name in data['app']:
                lines.append(f'- App: {t} {name}')
        else:
            lines.append('- App: 无')
        
        # Voice - 全量不截断
        if data['voice']:
            for item in data['voice']:
                t, sim, tag, text, extra = item
                lines.append(f'- Voice: {t} sim={sim:.2f}{tag} "{text}"{extra}')
        else:
            lines.append('- Voice: 无')
        
        # Audio events
        if data['audio']:
            seen = {}
            for label, prob in data['audio']:
                if label not in seen or prob > seen[label]:
                    seen[label] = prob
            top = sorted(seen.items(), key=lambda x: -x[1])[:4]
            lines.append(f'- Audio: {", ".join([f"{l}[{p*100:.0f}%]" for l, p in top])}')
        else:
            lines.append('- Audio: 无')
        
        # Media
        if data['media']:
            lines.append(f'- Media: {"; ".join(data["media"])}')
        else:
            lines.append('- Media: 无')
        
        # Notify
        if data['notify']:
            seen_notify = set()
            for t, pkg, text in data['notify']:
                key = (pkg, text[:30])  # 去重：同一App+前30字相同视为重复
                if key not in seen_notify:
                    lines.append(f'- Notify: {t} {pkg}: {text}')
                    seen_notify.add(key)
        else:
            lines.append('- Notify: 无')
        
        # Input
        if data['input']:
            for t, text in data['input']:
                lines.append(f'- Input: {t} "{text}"')
        else:
            lines.append('- Input: 无')
        
        # Device_env
        if data['device_env']:
            seen_states = set()
            for t, status in data['device_env']:
                if status not in seen_states:
                    lines.append(f'- device_env: {t} {status}')
                    seen_states.add(status)
        else:
            lines.append('- device_env: 无')
        
        # 占位符
        lines.append('【理解】(待填写)')
    
    return '\n'.join(lines)

if __name__ == '__main__':
    date = sys.argv[1] if len(sys.argv) > 1 else '2026-01-01'
    events = load_events(date)
    if not events:
        print('No data')
        sys.exit(1)
    
    time_range = None
    for i, arg in enumerate(sys.argv):
        if arg == '--hours' and i+1 < len(sys.argv):
            time_range = sys.argv[i+1]
    
    output = generate_segments(events, time_range)
    
    # Write to file
    out_path = f'data/daily/{date}/分段示例-{time_range.replace("~","-至-").replace(":","点") if time_range else "全天"}.md'
    os.makedirs(os.path.dirname(out_path) or '.', exist_ok=True)
    
    full = f'# 自动分段示例 - {date} {time_range or "全天"}\n\n{output}\n'
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(full)
    
    print(full)
    print(f'\n---已保存到 {out_path}---')
