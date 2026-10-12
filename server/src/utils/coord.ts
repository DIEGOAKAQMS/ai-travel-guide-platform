/**
 * 坐标系转换：WGS84（GPS/Cesium/天地图） <-> GCJ-02（高德/腾讯，即"火星坐标"）
 *
 * 为什么必须有这一层：
 *   高德返回 GCJ-02，Cesium 用 WGS84，直接叠加会有 300~600 米偏移，肉眼可见。
 *   本项目约定：入库统一存 WGS84，回传高德时再转回 GCJ-02。
 *
 * 注意：百度的 BD-09 本项目暂未使用，如需接入需再套一层 BD-09 <-> GCJ-02。
 */

const PI = Math.PI
/** 克拉索夫斯基椭球长半轴 */
const A = 6378245.0
/** 椭球偏心率平方 */
const EE = 0.00669342162296594323

/** 中国大陆范围外不做偏移（境外 GCJ-02 与 WGS84 一致） */
function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let ret =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0
  return ret
}

function transformLng(x: number, y: number): number {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0
  return ret
}

/** WGS84 -> GCJ-02 */
export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]

  let dLat = transformLat(lng - 105.0, lat - 35.0)
  let dLng = transformLng(lng - 105.0, lat - 35.0)

  const radLat = (lat / 180.0) * PI
  let magic = Math.sin(radLat)
  magic = 1 - EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)

  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI)
  dLng = (dLng * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI)

  return [lng + dLng, lat + dLat]
}

/**
 * GCJ-02 -> WGS84
 * 正向变换没有解析反函数，采用迭代逼近，8 次迭代后误差约 1e-9 度（亚厘米级）。
 */
export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (outOfChina(lng, lat)) return [lng, lat]

  let wLng = lng
  let wLat = lat
  for (let i = 0; i < 8; i += 1) {
    const [gLng, gLat] = wgs84ToGcj02(wLng, wLat)
    const dLng = gLng - lng
    const dLat = gLat - lat
    if (Math.abs(dLng) < 1e-9 && Math.abs(dLat) < 1e-9) break
    wLng -= dLng
    wLat -= dLat
  }
  return [wLng, wLat]
}

/** 两点球面距离（米） */
export function haversine(lng1: number, lat1: number, lng2: number, lat2: number): number {
  const R = 6371008.8
  const dLat = ((lat2 - lat1) * PI) / 180
  const dLng = ((lng2 - lng1) * PI) / 180
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * PI) / 180) *
      Math.cos((lat2 * PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2)
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
