<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import maplibregl from 'maplibre-gl';
  import 'maplibre-gl/dist/maplibre-gl.css';
  import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
  import {
    clickMode,
    context,
    facilitiesFC,
    facilitiesView,
    isolatedLines,
    isochrone,
    origin,
    pendingSnap,
    roads,
    selectedFacilityId,
    selectedPath
  } from '../lib/stores';
  import { requestSnap } from '../lib/controller';
  import { bboxOfLines } from '../lib/geo';
  import { STATUS_TEXT, type LngLat } from '../lib/types';

  let container: HTMLDivElement;
  let map: maplibregl.Map;
  let ready = false;
  let unsubs: (() => void)[] = [];

  const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

  function setData(id: string, data: FeatureCollection) {
    if (!ready) return;
    const src = map.getSource(id) as maplibregl.GeoJSONSource | undefined;
    if (src) src.setData(data);
  }

  function esc(s: string): string {
    return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  function fitToRoads() {
    const r = get(roads);
    if (!r || r.features.length === 0 || !ready) return;
    const lines = r.features.map((f) => f.geometry.coordinates as LngLat[]);
    const [minX, minY, maxX, maxY] = bboxOfLines(lines);
    map.fitBounds(
      [
        [minX, minY],
        [maxX, maxY]
      ],
      { padding: 60, duration: 400 }
    );
  }

  function originFC(): FeatureCollection {
    const o = get(origin);
    if (!o) return EMPTY;
    const link: Feature<LineString> = {
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [o.point, o.proj] },
      properties: {}
    };
    const pt: Feature<Point> = {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: o.point },
      properties: {}
    };
    return { type: 'FeatureCollection', features: [link, pt] };
  }

  function snapFC(): FeatureCollection {
    const s = get(pendingSnap);
    if (!s) return EMPTY;
    const features: Feature[] = [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: s.point },
        properties: { kind: 'click' }
      }
    ];
    for (const c of s.candidates) {
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: [s.point, c.proj] },
        properties: { kind: 'link', barrier: c.crossesBarrier }
      });
      features.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: c.proj },
        properties: { kind: 'candidate', barrier: c.crossesBarrier, edge: c.edgeId }
      });
    }
    return { type: 'FeatureCollection', features };
  }

  function isolatedFC(): FeatureCollection {
    const lines = get(isolatedLines);
    return {
      type: 'FeatureCollection',
      features: lines.map((c) => ({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: c },
        properties: {}
      }))
    };
  }

  function selectedFC(): FeatureCollection {
    const id = get(selectedFacilityId);
    const v = get(facilitiesView).find((x) => x.id === id);
    if (!v) return EMPTY;
    return {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: v.coord },
          properties: {}
        }
      ]
    };
  }

  function popupHtml(id: string): string {
    const v = get(facilitiesView).find((x) => x.id === id);
    if (!v) return '';
    const r = v.result;
    const status = r ? STATUS_TEXT[r.status] : '未求解';
    const time = r?.timeMin !== undefined ? `<br/>步行约 <b>${r.timeMin}</b> 分钟（${r.distanceM} 米）` : '';
    return `<div class="popup"><b>${esc(v.name)}</b> <span class="cat">${esc(v.category)}</span><br/>状态：${esc(status)}${time}</div>`;
  }

  onMount(() => {
    map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        sources: {},
        layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e9ede3' } }]
      },
      center: [120.006, 30.005],
      zoom: 13,
      attributionControl: false
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

    map.on('load', () => {
      // ---- 数据源 ----
      for (const id of [
        'water',
        'boundary',
        'isolated',
        'roads',
        'isochrone',
        'path',
        'facilities',
        'selected-facility',
        'origin',
        'snap'
      ]) {
        map.addSource(id, { type: 'geojson', data: EMPTY });
      }

      // ---- 图层（顺序即绘制顺序）----
      map.addLayer({
        id: 'water',
        type: 'fill',
        source: 'water',
        paint: { 'fill-color': '#a9cce6', 'fill-opacity': 0.85 }
      });
      map.addLayer({
        id: 'boundary',
        type: 'line',
        source: 'boundary',
        paint: { 'line-color': '#7a8a99', 'line-width': 1.5, 'line-dasharray': [4, 3], 'line-opacity': 0.9 }
      });
      map.addLayer({
        id: 'isolated',
        type: 'line',
        source: 'isolated',
        paint: { 'line-color': '#c051c0', 'line-width': 7, 'line-opacity': 0.45 }
      });
      map.addLayer({
        id: 'roads-base',
        type: 'line',
        source: 'roads',
        filter: ['!=', ['get', 'highway'], 'steps'],
        paint: {
          'line-color': [
            'match',
            ['get', 'oneway'],
            'yes',
            '#e8912d',
            '-1',
            '#e8912d',
            ['match', ['get', 'bridge'], 'yes', '#5b84ad', '#96a0ad']
          ],
          'line-width': 2.5
        }
      });
      map.addLayer({
        id: 'roads-steps',
        type: 'line',
        source: 'roads',
        filter: ['==', ['get', 'highway'], 'steps'],
        paint: { 'line-color': '#c44e52', 'line-width': 2, 'line-dasharray': [1.5, 1.5] }
      });
      map.addLayer({
        id: 'isochrone',
        type: 'line',
        source: 'isochrone',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'match',
            ['get', 'band'],
            0,
            '#1a9850',
            1,
            '#91cf60',
            2,
            '#fee08b',
            '#f46d43'
          ],
          'line-width': 5,
          'line-opacity': 0.8,
          'line-blur': 0.4
        }
      });
      map.addLayer({
        id: 'path',
        type: 'line',
        source: 'path',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#d81b8c', 'line-width': 4.5, 'line-opacity': 0.95 }
      });
      map.addLayer({
        id: 'facilities',
        type: 'circle',
        source: 'facilities',
        paint: {
          'circle-radius': 7,
          'circle-color': [
            'match',
            ['get', 'status'],
            'ok',
            '#1a9850',
            'beyond-time',
            '#fdae61',
            'disconnected',
            '#d73027',
            'stairs-only',
            '#7b3294',
            'data-gap',
            '#9e9e9e',
            'outside-extent',
            '#542788',
            '#2b83ba'
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2
        }
      });
      map.addLayer({
        id: 'selected-facility',
        type: 'circle',
        source: 'selected-facility',
        paint: {
          'circle-radius': 12,
          'circle-color': 'rgba(0,0,0,0)',
          'circle-stroke-color': '#111111',
          'circle-stroke-width': 2,
          'circle-stroke-opacity': 0.9
        }
      });
      map.addLayer({
        id: 'origin-link',
        type: 'line',
        source: 'origin',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: { 'line-color': '#2166ac', 'line-width': 1.5, 'line-dasharray': [2, 2] }
      });
      map.addLayer({
        id: 'origin-point',
        type: 'circle',
        source: 'origin',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 8,
          'circle-color': '#2166ac',
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5
        }
      });
      map.addLayer({
        id: 'snap-links',
        type: 'line',
        source: 'snap',
        filter: ['==', ['get', 'kind'], 'link'],
        paint: {
          'line-color': ['case', ['get', 'barrier'], '#d73027', '#777777'],
          'line-width': 1.5,
          'line-dasharray': [2, 2]
        }
      });
      map.addLayer({
        id: 'snap-candidates',
        type: 'circle',
        source: 'snap',
        filter: ['==', ['get', 'kind'], 'candidate'],
        paint: {
          'circle-radius': 6,
          'circle-color': ['case', ['get', 'barrier'], '#d73027', '#1a9850'],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2
        }
      });
      map.addLayer({
        id: 'snap-click',
        type: 'circle',
        source: 'snap',
        filter: ['==', ['get', 'kind'], 'click'],
        paint: {
          'circle-radius': 6,
          'circle-color': 'rgba(33,102,172,0.35)',
          'circle-stroke-color': '#2166ac',
          'circle-stroke-width': 2
        }
      });

      ready = true;

      // 初始填充
      setData('roads', (get(roads) as FeatureCollection | null) ?? EMPTY);
      setData('water', get(context).water ?? EMPTY);
      setData('boundary', get(context).boundary ?? EMPTY);
      setData('isolated', isolatedFC());
      setData('isochrone', get(isochrone));
      setData('facilities', get(facilitiesFC));
      setData('origin', originFC());
      fitToRoads();
    });

    // ---- 交互 ----
    map.on('click', (e) => {
      if (get(clickMode) === 'origin') {
        void requestSnap([e.lngLat.lng, e.lngLat.lat]);
      }
    });
    map.on('click', 'facilities', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      const id = String(f.properties?.id ?? '');
      selectedFacilityId.set(id);
      const coord = (f.geometry as Point).coordinates as LngLat;
      new maplibregl.Popup({ closeButton: true, maxWidth: '280px' })
        .setLngLat(coord)
        .setHTML(popupHtml(id))
        .addTo(map);
    });
    map.on('mouseenter', 'facilities', () => (map.getCanvas().style.cursor = 'pointer'));
    map.on('mouseleave', 'facilities', () => (map.getCanvas().style.cursor = ''));

    // ---- 订阅 store → 更新数据源 ----
    unsubs = [
      roads.subscribe((r) => {
        setData('roads', (r as FeatureCollection | null) ?? EMPTY);
        if (r) fitToRoads();
      }),
      context.subscribe((c) => {
        setData('water', c.water ?? EMPTY);
        setData('boundary', c.boundary ?? EMPTY);
      }),
      isolatedLines.subscribe(() => setData('isolated', isolatedFC())),
      isochrone.subscribe((fc) => setData('isochrone', fc)),
      facilitiesFC.subscribe((fc) => setData('facilities', fc)),
      selectedPath.subscribe((fc) => setData('path', fc)),
      origin.subscribe(() => setData('origin', originFC())),
      pendingSnap.subscribe(() => setData('snap', snapFC())),
      selectedFacilityId.subscribe(() => setData('selected-facility', selectedFC())),
      facilitiesView.subscribe(() => setData('selected-facility', selectedFC())),
      clickMode.subscribe((m) => {
        if (map) map.getCanvas().style.cursor = m === 'origin' ? 'crosshair' : '';
      })
    ];
  });

  onDestroy(() => {
    unsubs.forEach((u) => u());
    if (map) map.remove();
  });
</script>

<div class="map" bind:this={container}></div>

<style>
  .map {
    position: absolute;
    inset: 0;
  }
  :global(.maplibregl-popup-content) {
    font-size: 13px;
    line-height: 1.5;
  }
  :global(.popup .cat) {
    color: #888;
    font-size: 12px;
  }
</style>
