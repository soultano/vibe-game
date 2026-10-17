#!/usr/bin/env python3
"""Rasterize public-domain Natural Earth admin polygons at one degree per cell.

Usage: python3 scripts/generate-world.py [source.geojson] [output.json]
Source: https://github.com/nvkelso/natural-earth-vector/blob/master/geojson/ne_110m_admin_0_countries.geojson
"""
import json
import math
import pathlib
import sys
import urllib.request

WIDTH, HEIGHT = 360, 180
URL = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson'

def contains_ring(lon, lat, ring):
    inside = False
    prev = ring[-1]
    for cur in ring:
        x1, y1 = prev
        x2, y2 = cur
        if (y1 > lat) != (y2 > lat):
            cross = x1 + (lat-y1) * (x2-x1) / (y2-y1)
            if lon < cross:
                inside = not inside
        prev = cur
    return inside

def rasterize_polygon(polygon, land):
    outer = polygon[0]
    minx = max(0, int(math.floor(min(p[0] for p in outer) + 180)))
    maxx = min(WIDTH-1, int(math.floor(max(p[0] for p in outer) + 180)))
    miny = max(0, int(math.floor(90 - max(p[1] for p in outer))))
    maxy = min(HEIGHT-1, int(math.floor(90 - min(p[1] for p in outer))))
    for y in range(miny, maxy+1):
        lat = 90-y-0.5
        for x in range(minx, maxx+1):
            lon = x-180+0.5
            if contains_ring(lon, lat, outer) and not any(contains_ring(lon, lat, hole) for hole in polygon[1:]):
                land[y*WIDTH+x] = 1

def main():
    if len(sys.argv) > 1:
        data = json.loads(pathlib.Path(sys.argv[1]).read_text())
    else:
        with urllib.request.urlopen(URL) as response:
            data = json.load(response)
    land = [0]*(WIDTH*HEIGHT)
    for feature in data['features']:
        properties = feature.get('properties', {})
        if properties.get('ADMIN') == 'Antarctica' or properties.get('CONTINENT') == 'Antarctica':
            continue
        geometry = feature.get('geometry')
        if not geometry:
            continue
        polygons = [geometry['coordinates']] if geometry['type'] == 'Polygon' else geometry['coordinates']
        for polygon in polygons:
            rasterize_polygon(polygon, land)
    raw_cities = [
        ('Ташкент', 69.2401, 41.2995),
        ('Москва', 37.6173, 55.7558),
        ('Нью-Йорк', -74.0060, 40.7128),
        ('Лондон', -0.1276, 51.5072),
        ('Токио', 139.6917, 35.6895),
        ('Рио', -43.1729, -22.9068),
        ('Каир', 31.2357, 30.0444),
        ('Сидней', 151.2093, -33.8688),
        ('Париж', 2.3522, 48.8566),
        ('Пекин', 116.4074, 39.9042),
        ('Мумбаи', 72.8777, 19.0760),
        ('Кейптаун', 18.4241, -33.9249),
        ('Лос-Анджелес', -118.2437, 34.0522),
        ('Буэнос-Айрес', -58.3816, -34.6037),
        ('Стамбул', 28.9784, 41.0082),
        ('Дубай', 55.2708, 25.2048),
    ]
    cities = []
    for name, lon, lat in raw_cities:
        x,y = int(math.floor(lon+180)), int(math.floor(90-lat))
        # City markers snap within two cells of true center to avoid unplayable coastal cells.
        if not land[y*WIDTH+x]:
            options = [(dx*dx+dy*dy, y+dy, x+dx) for dy in range(-2,3) for dx in range(-2,3)
                       if 0 <= x+dx < WIDTH and 0 <= y+dy < HEIGHT and land[(y+dy)*WIDTH+x+dx]]
            if options:
                _,y,x = min(options)
        cities.append({'name':name,'x':x,'y':y})
    result = {'width':WIDTH,'height':HEIGHT,'land':land,'cities':cities,'source':'Natural Earth public domain; 1:110m admin-0 countries; Antarctica excluded'}
    output = pathlib.Path(sys.argv[2] if len(sys.argv)>2 else 'dist/world-mask.json')
    output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,separators=(',',':'),ensure_ascii=False))
    print(f'{output}: {sum(land):,} land cells; {len(cities)} cities; {output.stat().st_size:,} bytes')

if __name__ == '__main__':
    main()
