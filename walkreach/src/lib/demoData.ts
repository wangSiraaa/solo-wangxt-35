import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import type { ContextData, FacilitiesFC, FacilityProps, LngLat, RoadsFC, RoadProps } from './types';

/**
 * 演示数据：一座被河流分成两岸的小镇。
 * 完全本地生成，不需要任何外部地图服务或密钥。
 * 包含：单行街、台阶小径（禁行）、与主网断开的小巷、
 * 数据范围边界，以及落在范围外/离路网太远的设施（用于演示“无法判定”而非“不可达”）。
 */

const LNG0 = 120.0;
const LAT0 = 30.0;
const DX = 0.0026; // ≈ 250 m
const DY = 0.00225; // ≈ 250 m
const N = 5; // 网格 0..5

const pt = (i: number, j: number): LngLat => [LNG0 + i * DX, LAT0 + j * DY];

/** 河中心线（随纬度轻微摆动） */
const riverCenter = (j: number) => LNG0 + 2.5 * DX + 0.0004 * Math.sin(j * 1.2);
const HALF_W = 0.0003; // 河半宽 ≈ 29 m
const GAP = 0.00006; // 河岸到路头的间隙
const bankW = (j: number) => riverCenter(j) - HALF_W - GAP;
const bankE = (j: number) => riverCenter(j) + HALF_W + GAP;

const H_NAMES = ['南一街', '南二街', '中山街', '北二街', '北一街', '环北路'];
const V_NAMES = ['西环路', '文华路', '解放路', '建设路', '民生路', '东环路'];
const BRIDGES: Record<number, string> = { 1: '永安桥', 4: '青山桥' };

function road(coords: LngLat[], props: RoadProps): Feature<LineString, RoadProps> {
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: props };
}

function buildRoads(): RoadsFC {
  const features: Feature<LineString, RoadProps>[] = [];

  // 东西向街道：在河岸处断开，仅 y=1、y=4 有桥
  for (let y = 0; y <= N; y++) {
    const name = H_NAMES[y]!;
    const oneway = y === 2 ? 'yes' : y === 5 ? '-1' : 'no';
    const west: LngLat[] = [];
    for (let x = 0; x <= 2; x++) west.push(pt(x, y));
    west.push([bankW(y), LAT0 + y * DY]);
    features.push(road(west, { name, highway: 'residential', oneway }));

    if (BRIDGES[y]) {
      features.push(
        road(
          [
            [bankW(y), LAT0 + y * DY],
            [bankE(y), LAT0 + y * DY]
          ],
          { name: BRIDGES[y]!, highway: 'residential', oneway, bridge: 'yes' }
        )
      );
    }
    const east: LngLat[] = [[bankE(y), LAT0 + y * DY]];
    for (let x = 3; x <= N; x++) east.push(pt(x, y));
    features.push(road(east, { name, highway: 'residential', oneway }));
  }

  // 南北向街道
  for (let x = 0; x <= N; x++) {
    const coords: LngLat[] = [];
    for (let y = 0; y <= N; y++) coords.push(pt(x, y));
    features.push(road(coords, { name: V_NAMES[x]!, highway: 'residential', oneway: 'no' }));
  }

  // 台阶小径：连接解放路东侧的口袋绿地（台阶禁行 → 该绿地仅台阶可达）
  const pocket: LngLat = pt(1.5, 2.5);
  const pocketJoin: LngLat = pt(1.5, 2.25);
  features.push(road([pocket, pocketJoin], { name: '口袋绿地步道', highway: 'footway', oneway: 'no' }));
  features.push(road([pocketJoin, pt(1, 2)], { name: '绿地南台阶', highway: 'steps', oneway: 'no' }));
  features.push(road([pocketJoin, pt(1, 3)], { name: '绿地北台阶', highway: 'steps', oneway: 'no' }));

  // 断开的小巷：与民生路平行但端点差十几米，没有接上（自成一个连通分量）
  features.push(
    road([pt(4.05, 2.05), pt(4.05, 2.95)], { name: '背街小巷', highway: 'service', oneway: 'no' })
  );

  return { type: 'FeatureCollection', features };
}

function buildFacilities(): FacilitiesFC {
  const f = (
    id: string,
    name: string,
    category: string,
    i: number,
    j: number,
    offLng = 0.00012,
    offLat = 0.0001
  ): Feature<Point, FacilityProps> => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [LNG0 + i * DX + offLng, LAT0 + j * DY + offLat] },
    properties: { id, name, category }
  });
  return {
    type: 'FeatureCollection',
    features: [
      f('f1', '图书馆', '文化', 1, 1),
      f('f2', '社区诊所', '医疗', 2, 4),
      f('f3', '滨河公园', '休闲', 0, 3),
      f('f4', '实验小学', '教育', 4, 1),
      f('f5', '惠民超市', '商业', 5, 3),
      f('f6', '养老院', '养老', 3, 3),
      f('f7', '社区活动室', '文化', 1.5, 2.5, 0.00008, 0.00006), // 口袋绿地：仅台阶相连
      f('f8', '快递柜', '生活', 4.08, 2.5, 0, 0), // 背街小巷：路网断开
      f('f9', '滨河观景台', '休闲', 2.2, 3, 0, 0), // 河岸断头路尽头
      f('f10', '体育馆', '体育', 5.7, 2, 0, 0), // 数据范围之外
      f('f11', '变电站', '市政', 4.5, 0.5, 0, 0), // 离路网太远：疑似数据缺失
      f('f12', '北门菜场', '商业', 2, 5.6, 0, 0) // 数据范围之外（北）
    ]
  };
}

function buildContext(): ContextData {
  // 河流多边形（吸附屏障）
  const left: LngLat[] = [];
  const right: LngLat[] = [];
  for (let j = -0.5; j <= N + 0.5; j += 0.5) {
    left.push([riverCenter(j) - HALF_W, LAT0 + j * DY]);
    right.push([riverCenter(j) + HALF_W, LAT0 + j * DY]);
  }
  const river: Feature<Polygon> = {
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [[...left, ...right.reverse(), left[0]!]] },
    properties: { name: '清河' }
  };
  // 数据范围边界：比路网略大的矩形
  const boundary: Feature<Polygon> = {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [LNG0 - 0.0012, LAT0 - 0.0012],
          [LNG0 + N * DX + 0.0012, LAT0 - 0.0012],
          [LNG0 + N * DX + 0.0012, LAT0 + N * DY + 0.0012],
          [LNG0 - 0.0012, LAT0 + N * DY + 0.0012],
          [LNG0 - 0.0012, LAT0 - 0.0012]
        ]
      ]
    },
    properties: { name: '数据范围' }
  };
  return {
    water: { type: 'FeatureCollection', features: [river] },
    boundary: { type: 'FeatureCollection', features: [boundary] },
    boundaryApprox: false
  };
}

export interface DemoData {
  roads: RoadsFC;
  facilities: FacilitiesFC;
  context: ContextData;
  defaultOrigin: LngLat;
}

export function makeDemoData(): DemoData {
  return {
    roads: buildRoads(),
    facilities: buildFacilities(),
    context: buildContext(),
    defaultOrigin: pt(1.1, 1.1)
  };
}
