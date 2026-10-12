import * as Cesium from 'cesium'
import { HIGHLIGHT_CORE_COLOR, HIGHLIGHT_COLOR, PROBLEM_COLOR, dayColor } from '@/config/guide'
import {
  baseIconKeyOf,
  findStartPoiId,
  iconUri,
  legendKeyOf,
  type IconKey,
  type LegendKey,
} from '@/config/mapIcons'
import type { GuideDto, GuidePoiDto, GuideRouteDto } from '@/types/guide'

const DATA_SOURCE_NAME = 'travel-guide'

// ---------------------------------------------------------------- 导航路线：沿线箭头材质

/**
 * 导航路线的方向箭头用**自定义材质**画：一条折线 + 一个材质，
 * 按「沿线第几米」取模生成重复的「>」，**图元数不随箭头数增长**。
 *
 * 要害是让图案钉在**地理**位置上，而不是屏幕上：否则地图一平移或旋转，
 * 箭头就跟着在线上滑，看着像贴在屏幕上的浮标。
 * 做法是拿贴地折线的 `st.s`（整条线的归一化弧长）乘上线长，算出「第几米」——
 * 为什么不能用屏幕坐标、也不能直接拿 `st.s` 当周期，见着色器里那段注释。
 */
const ROUTE_ARROW_MATERIAL_TYPE = 'GuideRouteArrow'

/**
 * 观感目标是高德导航那种「粗线 + 线内嵌一排箭头」。
 *
 * 尺寸之间的关系（都是屏幕 px，必须一起看）：
 *
 *   ┌──────────────── lineWidth = 12 ────────────────┐
 *   │  ↕ 半宽 6                                        │
 *   │        ╲     ╱          ╲     ╱                 │  ← halfWidth = 4
 *   │         ╲   ╱            ╲   ╱                  │     （箭头半宽，要 < lineWidth/2）
 *   │          ╲ ╱              ╲ ╱                   │
 *   └───────────V────────────────V────────────────────┘
 *           └─ size = 7.5 ─┘
 *
 * 校验式： halfWidth + stroke/2 (= 5.5) < lineWidth/2 (= 6)，箭头才完整落在「线的面」里；
 * 着色器里再加一道 `arrowMask *= lineMask` 兜底，参数调飘了也不会溢出线外。
 */
/** 折线的几何宽度（px）：只需容得下最外沿（lineWidth/2），留点余量防抗锯齿被切 */
const ROUTE_ARROW_WIDTH = 16
/** 线身宽度（px）：比原先的 4px 粗不少，向高德导航的观感靠 */
const ROUTE_LINE_WIDTH = 12
/** 箭头半宽（px）：箭头整体的横向尺寸 = 2 * 它，必须小于 lineWidth/2 */
const ROUTE_ARROW_HALF_WIDTH = 4
/**
 * 箭头在屏幕上的间距 = 米/像素 × 这个系数，再夹在上下限里。
 *
 * 方向和直觉相反，别改回去：**视野拉得越远，间距越大**（屏幕上越稀）。
 * 两条错路都走过：
 *   - 固定屏幕间距（一律 64px）：拉远时整条线挤满箭头，看起来像一串点；
 *   - 按地理间距排布（一律 4km）：拉远时 4km 折到屏幕上只剩几个像素，比固定间距还密。
 * 所以按「米/像素」线性放大 —— 等价于「每屏能看到的箭头数随视野变大而减少」。
 */
const ROUTE_ARROW_INTERVAL_PER_MPP = 2.5
/** 拉近（视野小）时的下限，别再更密了：一屏大约 6 个 */
const ROUTE_ARROW_INTERVAL_MIN_PX = 144
/** 拉远（视野大）时的封顶，再远就只剩零星几个，别让箭头彻底消失 */
const ROUTE_ARROW_INTERVAL_MAX_PX = 1280
/**
 * 比例尺封顶对应的相机高度：超过它以后箭头不再继续变稀。
 *
 * 100km 以内按真实比例尺走（拉远变稀，见 ROUTE_ARROW_INTERVAL_PER_MPP）；
 * 超过之后把参与箭头计算的「米/像素」冻结在 100km 处的取值，
 * 于是间距与图案相位都不再随视角变化 —— 屏幕上箭头的**数量与 100km 时一致**，
 * 而不是越拉远越少、最后只剩零星几个。
 */
const ROUTE_ARROW_SCALE_MAX_HEIGHT_M = 100_000
/**
 * 视角再拉远时的「减半」档：越过 A 起箭头数量减半，越过 B 起再减半。
 * 用「间距倍增」实现（数量 ∝ 1/间距），只影响数量，箭头形状不受影响。
 */
const ROUTE_ARROW_HALVE_HEIGHT_A_M = 500_000
const ROUTE_ARROW_HALVE_HEIGHT_B_M = 1_000_000

// ---------------------------------------------------------------- 渲染层级
//
// Cesium 的 zIndex 只在**同一类图元**之间排序。这里的线全部是贴地折线
// （clampToGround → GroundPolylinePrimitive），所以能互相比较、按 zIndex 叠放。
//
// 叠放顺序（由下到上）：线身 → 箭头 → 图标 → 标注。
//   - 高亮段的外圈/内芯属于「线身」，压在箭头之下，免得盖住别的路段的箭头；
//   - 带箭头的普通路段整条就是「箭头层」，要高过所有线身；
//   - 高亮段的箭头最高，因为它是最重要的方向指示；
//   - 图标与标注走 Billboard/Label 集合，绘制在全部折线之上（天然压过 zIndex），
//     这里仍显式给出更大的取值，把「图标及其标注永远在最上面」固化下来。
const Z_INDEX_TRANSFER_ROUTE = 10
const Z_INDEX_HIGHLIGHT_RING = 12
const Z_INDEX_HIGHLIGHT_CORE = 14
const Z_INDEX_ROUTE_ARROW = 20
const Z_INDEX_HIGHLIGHT_ARROW = 22
/** 图标与标注：数值远大于折线层，且标注再高一点，保证标注压在图标之上 */
const Z_INDEX_POI_ICON = 100
const Z_INDEX_POI_LABEL = 101

// ---------------------------------------------------------------- 拐弯规避

/**
 * 转角超过这个角度就算「拐弯」，箭头要躲开它。
 */
const ROUTE_BEND_MIN_TURN = Cesium.Math.toRadians(15)
/**
 * 判定拐弯时，朝前、朝后各看多远（米）。
 *
 * 不能直接量「相邻三个点的夹角」：导航路径的点很密，一个 90° 的大弯会被采样成
 * 十几个几度的小折角，逐个看全都够不着阈值。站远一点比较前后两个方向，
 * 才量得出真实转向 —— 点密点疏都不影响。
 */
const ROUTE_BEND_LOOKAHEAD_M = 250
/** 最多躲开几个急弯（着色器里是 4 个 vec4 的槽位） */
const ROUTE_BEND_SLOTS = 16
/** 箭头离拐弯多近就抹掉：按箭头间距的比例算，0.3 表示前后各 0.3 个间隔 */
const ROUTE_BEND_CLEARANCE_RATIO = 0.3
/** 箭头臂长（沿线方向的长度）/ 箭头笔画粗细（px）：与线宽绑定，不随比例尺变 */
const ROUTE_ARROW_SIZE = 7.5
const ROUTE_ARROW_STROKE = 3

/** 箭头材质的片元着色器 */
const ROUTE_ARROW_GLSL = `
uniform vec4 color;
uniform vec4 arrowColor;
uniform float lineWidth;
uniform float polylineWidth;
uniform float interval;
uniform float size;
// arrowStretch：>1 表示已越过封顶高度，沿线方向的尺寸要按它放大回真实像素
uniform float arrowStretch;
uniform float halfWidth;
uniform float stroke;
// routeLength：这条路线沿线的实际长度（米），用来把归一化弧长还原成「第几米」
uniform float routeLength;
// metersPerPixel：当前比例尺，1 CSS 像素约合多少米
uniform float metersPerPixel;
// 急弯位置：整条线的归一化弧长。乘上「整条线折成多少屏幕像素」就是沿线的像素位置。
// 空槽填 -1，永远匹配不上，于是省掉一个计数 uniform；16 个槽位打包进 4 个 vec4。
uniform vec4 bendA;
uniform vec4 bendB;
uniform vec4 bendC;
uniform vec4 bendD;
// 箭头离拐弯多近就抹掉（px）
uniform float bendClearance;

float segmentDistance(vec2 p, vec2 a, vec2 b)
{
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

// 这个位置是不是压在某个急弯上（沿线像素坐标）。
// 展开写而不是循环：动态下标取 vec4 分量在老设备（GLSL ES 1.0）上不合法，
// 不值得为这点篇幅冒编译不过的风险。
float bendHit(float alongPx, float bendScale)
{
  float hit = 0.0;
  if (abs(alongPx - bendA.x * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendA.y * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendA.z * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendA.w * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendB.x * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendB.y * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendB.z * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendB.w * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendC.x * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendC.y * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendC.z * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendC.w * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendD.x * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendD.y * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendD.z * bendScale) < bendClearance) hit = 1.0;
  if (abs(alongPx - bendD.w * bendScale) < bendClearance) hit = 1.0;
  return hit;
}

czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);

  vec2 st = materialInput.st;

  // 横向：st.t 从 0 到 1 正好跨过折线的几何宽度，乘回去就是「距中线多少像素」
  float across = (st.t - 0.5) * polylineWidth;

  // 纵向：把「在整条线的第几米」按比例尺折成屏幕像素。
  //
  // 这里的前两版都因为「图案没钉在地面上」而作废，别再回去：
  //   - 直接拿 st.s 当周期：普通折线的 st.s 是「每段各自 0→1」，图案会在
  //     每个顶点重启，路径点一密就碎成一串点；
  //   - 用 gl_FragCoord 旋到沿线方向（Cesium 的 PolylineDashMaterial 就这么干）：
  //     位置稳、也不会被顶点切断，但它是**屏幕**坐标 —— 地图一平移或旋转，
  //     箭头就跟着在线上滑，看着像浮在屏幕上的贴纸。
  //
  // 贴地折线（GroundPolylinePrimitive）的 st.s 是另一回事：GroundPolylineGeometry
  // 用「段长/整线长」和「累计长/整线长」把它重新归一化过（见该文件里的
  // texcoordNormalization3DX/Y），所以 st.s 就是**整条线的归一化弧长**。
  // 乘上线长就是沿线米数 —— 钉在地理位置上，视角怎么动它都不动。
  // 再除比例尺换成屏幕像素，与下面所有尺寸常量同单位。
  float alongMeters = st.s * routeLength;
  float along = alongMeters / max(metersPerPixel, 1e-6);

  // 1) 线身：中线两侧各半个 lineWidth
  float lineMask = 1.0 - smoothstep(lineWidth * 0.5 - 1.0, lineWidth * 0.5 + 1.0, abs(across));

  // 2) 沿线重复的「>」：每个周期一个，尖端落在周期后段，两翼向后张开 halfWidth
  //
  // 沿线方向的尺寸乘 arrowStretch 还原成真实像素：越过封顶高度后比例尺被冻结，
  // 沿线的「伪像素」比真实像素小，固定尺寸的图案在屏幕上沿线会被压扁；
  // 横向 across 一直是真实像素，只有沿线方向需要补这个倍数（未封顶时为 1）。
  float u = mod(along, interval);
  float tip = interval * 0.72;
  float sizeStretched = size * arrowStretch;
  vec2 p = vec2(u, across);
  float d = min(
    segmentDistance(p, vec2(tip, 0.0), vec2(tip - sizeStretched, halfWidth)),
    segmentDistance(p, vec2(tip, 0.0), vec2(tip - sizeStretched, -halfWidth))
  );
  float arrowMask = 1.0 - smoothstep(stroke * 0.5 - 0.9, stroke * 0.5 + 0.9, d);
  // 箭头严格嵌在「线的面」里：参数调飘了也不会溢出到线外
  arrowMask *= lineMask;

  // 拐弯处不画箭头：算出这一周期里箭头尖端在整条线上的位置，
  // 压到任一急弯上就把整支抹掉（而不是只削掉一角）。0.72 与上面的 tip 同源。
  float arrowTipAlong = (floor(along / interval) + 0.72) * interval;
  arrowMask *= 1.0 - bendHit(arrowTipAlong, routeLength / max(metersPerPixel, 1e-6));

  vec4 outColor = mix(color, arrowColor, arrowMask);
  outColor.a = max(lineMask, arrowMask) * color.a;
  outColor = czm_gammaCorrect(outColor);

  material.diffuse = outColor.rgb;
  material.alpha = outColor.a;
  return material;
}
`

/**
 * 当前帧「1 CSS 像素 ≈ 多少地面米」。
 *
 * 箭头间距要按比例尺折算，而这个换算只能在外面做：贴地折线的材质拿不到
 * 眼睛空间坐标（`PolylineShadowVolumeFS` 只往 `materialInput` 里填了 `st`），
 * `v_width` 又是没乘过米/像素的原始像素宽度，靠不住。
 * 所以每帧估一个比例尺塞进 uniform。
 *
 * 用「相机高度 + 竖直视场角」近似，俯视时基本准；斜视会偏一些，
 * 而箭头疏密本来就是观感参数，不值得为此引一套精确换算。
 *
 * 相机高度超过 `ROUTE_ARROW_SCALE_MAX_HEIGHT_M` 时按该高度封顶：
 * 封顶后比例尺不再增大，箭头间距与图案相位一并冻结，数量保持不变。
 */
let metersPerPixel = 0
/** 当前相机高度（米，真实值、不封顶）：用来决定箭头的「减半」档 */
let cameraHeightM = 0
/**
 * 真实比例尺 ÷ 冻结比例尺（两者都 >0 时 ≥1）。
 *
 * 越过封顶高度后比例尺被冻结，沿线的「伪像素」刻度比真实屏幕像素小：
 * 固定伪像素尺寸的图案在屏幕上沿线会被压缩。着色器用这个倍数把箭头**沿线方向**
 * 的尺寸放大回真实像素（横向本来就是真实像素，不动），箭头才不会压扁。
 * 未越过封顶时恒为 1。
 */
let arrowStretch = 1

/**
 * 比例尺估算。给 `maxHeightM` 时按该相机高度封顶 —— 用来得到冻结刻度本身。
 */
function estimateMetersPerPixel(viewer: Cesium.Viewer, maxHeightM?: number): number {
  const scene = viewer.scene
  const frustum = scene.camera.frustum
  const rawHeight = scene.camera.positionCartographic.height
  // 超过封顶高度就按封顶算：拉得再远，刻度也不再放大
  const height = maxHeightM === undefined ? rawHeight : Math.min(rawHeight, maxHeightM)
  const canvasHeight = scene.canvas.clientHeight
  if (!(frustum instanceof Cesium.PerspectiveFrustum) || !(height > 0) || !canvasHeight) return 0
  // fovy 在 d.ts 里是可选的（透视相机也可能只设了 fov），拿不到就退化成不折算
  const fovy = frustum.fovy
  if (!fovy) return 0
  return (2 * height * Math.tan(fovy * 0.5)) / canvasHeight
}

/** 同时算两个比例尺：冻结刻度定箭头数量，真实刻度用来把箭头形状还原成真实像素 */
function updateMapScale(viewer: Cesium.Viewer): void {
  const rawHeight = viewer.scene.camera.positionCartographic.height
  cameraHeightM = rawHeight > 0 ? rawHeight : 0
  const real = estimateMetersPerPixel(viewer)
  const clamped = estimateMetersPerPixel(viewer, ROUTE_ARROW_SCALE_MAX_HEIGHT_M)
  metersPerPixel = clamped
  arrowStretch = real > 0 && clamped > 0 ? real / clamped : 1
}

/** 已经挂过比例尺监听的 viewer（每帧只做个乘法，很便宜） */
const scaleTrackedViewers = new WeakSet<Cesium.Viewer>()

function trackMapScale(viewer: Cesium.Viewer): void {
  updateMapScale(viewer)
  if (scaleTrackedViewers.has(viewer)) return
  scaleTrackedViewers.add(viewer)
  viewer.scene.preRender.addEventListener(() => {
    updateMapScale(viewer)
  })
}

/** 当前比例尺下，箭头该隔多少屏幕像素排一个（拉远变稀、拉近变密） */
function arrowIntervalPx(): number {
  if (!(metersPerPixel > 0)) return ROUTE_ARROW_INTERVAL_MIN_PX
  const px = metersPerPixel * ROUTE_ARROW_INTERVAL_PER_MPP
  const base = Math.min(Math.max(px, ROUTE_ARROW_INTERVAL_MIN_PX), ROUTE_ARROW_INTERVAL_MAX_PX)
  // 100km 以上刻度已冻结，这里再按真实相机高度逐档减半：间距倍增即数量减半
  let multiplier = 1
  if (cameraHeightM >= ROUTE_ARROW_HALVE_HEIGHT_A_M) multiplier = 2
  if (cameraHeightM >= ROUTE_ARROW_HALVE_HEIGHT_B_M) multiplier = 4
  return base * multiplier
}

/** 材质只需往 Cesium 的材质缓存里注册一次 */
let routeArrowMaterialReady = false

function ensureRouteArrowMaterial(): void {
  if (routeArrowMaterialReady) return
  routeArrowMaterialReady = true
  // `_materialCache` 是 Cesium 官方示例注册自定义材质的入口，但没有进 .d.ts，只能绕过类型
  const cache = (
    Cesium.Material as unknown as {
      _materialCache: {
        addMaterial(type: string, material: { fabric: unknown; translucent: boolean }): void
      }
    }
  )._materialCache

  cache.addMaterial(ROUTE_ARROW_MATERIAL_TYPE, {
    fabric: {
      type: ROUTE_ARROW_MATERIAL_TYPE,
      uniforms: {
        color: Cesium.Color.WHITE,
        arrowColor: Cesium.Color.WHITE,
        lineWidth: ROUTE_LINE_WIDTH,
        polylineWidth: ROUTE_ARROW_WIDTH,
        // 这几个真正生效的值都由 RouteArrowMaterialProperty.getValue 按路线/比例尺写回
        interval: ROUTE_ARROW_INTERVAL_MIN_PX,
        size: ROUTE_ARROW_SIZE,
        arrowStretch: 1,
        halfWidth: ROUTE_ARROW_HALF_WIDTH,
        stroke: ROUTE_ARROW_STROKE,
        routeLength: 0,
        metersPerPixel: 0,
        // 拐弯槽位默认全 -1（永不匹配）；bendClearance 为 0 时等于不规避
        bendA: new Cesium.Cartesian4(-1, -1, -1, -1),
        bendB: new Cesium.Cartesian4(-1, -1, -1, -1),
        bendC: new Cesium.Cartesian4(-1, -1, -1, -1),
        bendD: new Cesium.Cartesian4(-1, -1, -1, -1),
        bendClearance: 0,
      },
      source: ROUTE_ARROW_GLSL,
    },
    translucent: true,
  })
}

/**
 * 自定义材质的 `MaterialProperty`。
 *
 * 有几条 Cesium 没写进文档的契约，都踩过：
 *
 * 1. **不能 `extends Cesium.MaterialProperty`**。那个类的构造函数是
 *    `DeveloperError.throwInstantiationError()`——它只用来描述接口，`super()` 会当场抛错。
 *    Cesium 自己的 `PolylineDashMaterialProperty` 同样是纯手写、不继承的。
 *    好在 entity 的 `material` 描述符只检查「有没有 `getValue`」，鸭子类型就够。
 * 2. **`getValue(time, result)` 要把 uniform 写进 `result`，而不是返回一个 `Material`**。
 *    Cesium 走的是 `MaterialProperty.getValue(time, property, material)`：
 *    先用 `property.getType(time)` 拿类型 → `Material.fromType(type)` → 再调
 *    `property.getValue(time, material.uniforms)` 把值写回 uniform。所以这里只写
 *    每条路线各不相同的 `color`，其余 uniform 全部沿用注册时的默认值。
 * 3. **`isConstant` 得是 `false`**：箭头间距要跟着比例尺走，每帧都得重算一次。
 *    标成常量的话 Cesium 会把 uniform 缓存住，间距就永远停在第一帧的档位上。
 *    代价只是贴地折线的材质批处理每帧多更新一次 uniform，可以忽略。
 */
class RouteArrowMaterialProperty {
  readonly isConstant = false
  readonly definitionChanged = new Cesium.Event()

  private readonly _color: Cesium.Color
  private readonly _lengthM: number
  private readonly _bendA: Cesium.Cartesian4
  private readonly _bendB: Cesium.Cartesian4
  private readonly _bendC: Cesium.Cartesian4
  private readonly _bendD: Cesium.Cartesian4

  constructor(color: Cesium.Color, lengthM: number, bends: number[]) {
    ensureRouteArrowMaterial()
    this._color = color
    this._lengthM = lengthM
    // 空槽补 -1：着色器拿它当「永不匹配」的哨兵，省掉一个计数 uniform
    const slots = bends.slice(0, ROUTE_BEND_SLOTS)
    while (slots.length < ROUTE_BEND_SLOTS) slots.push(-1)
    this._bendA = new Cesium.Cartesian4(slots[0], slots[1], slots[2], slots[3])
    this._bendB = new Cesium.Cartesian4(slots[4], slots[5], slots[6], slots[7])
    this._bendC = new Cesium.Cartesian4(slots[8], slots[9], slots[10], slots[11])
    this._bendD = new Cesium.Cartesian4(slots[12], slots[13], slots[14], slots[15])
  }

  getType(): string {
    return ROUTE_ARROW_MATERIAL_TYPE
  }

  getValue(_time?: Cesium.JulianDate, result?: Record<string, unknown>): Record<string, unknown> {
    const uniforms = result ?? {}
    const interval = arrowIntervalPx()
    uniforms.color = this._color
    // 间距按比例尺来：拉远时屏幕间距变大、数量变少
    uniforms.interval = interval
    // 图案钉在这条线的地理位置上，所以还得知道它有多长、当前一像素合几米
    uniforms.routeLength = this._lengthM
    uniforms.metersPerPixel = metersPerPixel > 0 ? metersPerPixel : 1
    // 越过封顶高度后 >1：把箭头沿线尺寸放大回真实像素，避免被压扁
    uniforms.arrowStretch = arrowStretch
    // 躲开拐弯：窗口跟着间距走，否则一条短线会被几个弯整段吃掉
    uniforms.bendClearance = interval * ROUTE_BEND_CLEARANCE_RATIO
    uniforms.bendA = this._bendA
    uniforms.bendB = this._bendB
    uniforms.bendC = this._bendC
    uniforms.bendD = this._bendD
    return uniforms
  }

  /**
   * 同色（同一天）的路线会被 Cesium 归进同一个批次、共用一个材质，能少一批图元。
   * 长度和拐弯位置也得一起比：图案相位从线头零米起算，两条长度不同的线共用材质，
   * 短的那条会被按长的相位画；拐弯位置不同则会让其中一条躲错地方。
   */
  equals(other: unknown): boolean {
    return (
      other instanceof RouteArrowMaterialProperty &&
      Cesium.Color.equals(this._color, other._color) &&
      this._lengthM === other._lengthM &&
      Cesium.Cartesian4.equals(this._bendA, other._bendA) &&
      Cesium.Cartesian4.equals(this._bendB, other._bendB) &&
      Cesium.Cartesian4.equals(this._bendC, other._bendC) &&
      Cesium.Cartesian4.equals(this._bendD, other._bendD)
    )
  }
}

/** 自定义材质一旦不可用就退回普通实线：宁可没有箭头，也不能让整条路线渲染不出来 */
let routeArrowMaterialBroken = false

/** 造一条路线的材质（带兜底）：箭头周期钉在地理位置，还要带上线长和该躲开的拐弯 */
function createRouteMaterial(
  color: Cesium.Color,
  alpha: number,
  lengthM: number,
  bends: number[],
): Cesium.MaterialProperty {
  const tinted = color.withAlpha(alpha)
  if (routeArrowMaterialBroken) return new Cesium.ColorMaterialProperty(tinted)
  try {
    return new RouteArrowMaterialProperty(tinted, lengthM, bends)
  } catch (error) {
    routeArrowMaterialBroken = true
    console.warn('[guideRenderer] 方向箭头材质不可用，已回退为普通实线：', error)
    return new Cesium.ColorMaterialProperty(tinted)
  }
}

export interface RenderOptions {
  hiddenDays: number[]
  /** 被隐藏的图例分类（图标类型 / 线类型），缺省即全部显示 */
  hiddenCategories?: LegendKey[]
  /** 需要突出的路线段（点击时间轴上的车辆图标时高亮） */
  highlightRouteId?: string | null
  /** 当前选中的节点（地图图标与时间轴节点行联动高亮） */
  selectedPoiId?: string | null
  /** 是否对重叠标注做避让（缺省即开）；导出静态图时可关掉，保留全部标注 */
  labelAvoidance?: boolean
}

/**
 * 每个 viewer 对应的攻略图层。
 *
 * 不能靠「add 之后立刻 getByName 查回来」来判断图层是否已存在：
 * `DataSourceCollection.add()` 是**微任务异步入列**的，同一 tick 内查不到刚加进去的图层。
 * 一旦因此在同一 tick 建出两个同名 DataSource，`getByName(...)[0]` 只会命中第一个，
 * 第二个图层的实体会永久留在屏幕上——表现为所有显隐控制都失效。
 * 所以这里改为按 viewer 直接缓存实例。
 */
const guideSources = new WeakMap<Cesium.Viewer, Cesium.CustomDataSource>()

/** 清掉该 viewer 上除 keep 之外的攻略图层（含异步竞态遗留的孤儿同名图层） */
function purgeOrphanSources(viewer: Cesium.Viewer, keep: Cesium.CustomDataSource | null): void {
  for (const stale of viewer.dataSources.getByName(DATA_SOURCE_NAME)) {
    if (stale === keep) continue
    // remove 是同步的；万一它还在异步入列中（remove 返回 false），
    // 至少把实体清空，避免两层实体叠在图上
    if (!viewer.dataSources.remove(stale as Cesium.CustomDataSource, true)) {
      stale.entities.removeAll()
    }
  }
}

/** 取得（必要时创建）攻略专用的 DataSource，便于整体清理而不影响其它业务图层 */
function ensureDataSource(viewer: Cesium.Viewer): Cesium.CustomDataSource {
  const cached = guideSources.get(viewer)
  if (cached) {
    purgeOrphanSources(viewer, cached)
    return cached
  }

  purgeOrphanSources(viewer, null)

  const dataSource = new Cesium.CustomDataSource(DATA_SOURCE_NAME)
  void viewer.dataSources.add(dataSource)
  guideSources.set(viewer, dataSource)
  return dataSource
}

/** 清空攻略图层（保留图层实例，只清实体，避免异步 add 竞态） */
export function clearGuideLayer(viewer: Cesium.Viewer | null): void {
  if (!viewer || viewer.isDestroyed()) return
  const cached = guideSources.get(viewer)
  if (cached) cached.entities.removeAll()
  // 图层清空了，避让队列也要清，否则会一直操作已被移除的实体
  labelEntries.set(viewer, [])
  purgeOrphanSources(viewer, cached ?? null)
}

/**
 * 点位标签文案：`第几天-当天第几个  名称`，例如 `1-1  塔尔寺`
 * （时间在时间轴里看，地图上编号更利于和侧边栏对照）
 */
function nodeLabel(dayIndex: number, poi: GuidePoiDto): string {
  return `${dayIndex}-${poi.seq + 1}  ${poi.name}`
}

// ---------------------------------------------------------------- 标注重叠避让

/**
 * Cesium 的 Entity 标注没有内建避让，重叠只能自己做。
 *
 * 做法是「屏幕空间贪心」：相机变化后，把每个标注投影成屏幕矩形，
 * 按优先级从高到低依次放置，与已放置矩形相交的就隐藏。
 * 这样留下的是重要标注，而不是简单地让后画的盖住先画的。
 *
 * 相交判定是 O(n²)，所以只在相机变化后重算一次，不每帧跑；
 * 若以后节点数涨到上千，需要换成网格 / 四叉树加速。
 */
/** 标注字体 / 底衬 / 偏移：测量屏幕矩形必须与 label 配置用同一组参数 */
const LABEL_FONT = '700 15px "PingFang SC", "Microsoft YaHei", sans-serif'
const LABEL_FONT_SIZE = 15
const LABEL_PADDING_X = 8
const LABEL_PADDING_Y = 4
/** 标注相对锚点的像素偏移（在图标上方，与 label.pixelOffset 保持一致） */
const LABEL_OFFSET_Y = -48

/** 一个参与避让的标注 */
interface LabelEntry {
  entity: Cesium.Entity
  /** 节点世界坐标：标注锚点由它在屏幕上的投影决定 */
  position: Cesium.Cartesian3
  /** 标注矩形尺寸（px，含底衬） */
  width: number
  height: number
  /** 优先级：越小越优先保留 */
  rank: number
  /** 上一次的显隐：只在变化时改 Property，避免每帧重建 ConstantProperty */
  shown: boolean
}

const labelEntries = new WeakMap<Cesium.Viewer, LabelEntry[]>()
const labelDirty = new WeakMap<Cesium.Viewer, boolean>()
const labelTrackedViewers = new WeakSet<Cesium.Viewer>()
const labelOccluders = new WeakMap<Cesium.Viewer, Cesium.EllipsoidalOccluder>()

/**
 * 标注避让的优先级：数值越小越优先保留。
 * 选中的节点最高（用户正看着它），其次是景点，再按关键 / 常规 / 可选。
 */
function labelRankOf(poi: GuidePoiDto, isSelected: boolean): number {
  if (isSelected) return 0
  if (poi.kind === 'spot') return 1
  if (poi.priority === 'key') return 2
  if (poi.priority === 'optional') return 4
  return 3
}

let labelMeasureCtx: CanvasRenderingContext2D | null | undefined
const labelWidthCache = new Map<string, number>()

/** 估算标注矩形：宽度用 canvas 量文字（结果缓存），高度按字号行高算 */
function measureLabelBox(text: string): { width: number; height: number } {
  let textWidth = labelWidthCache.get(text)
  if (textWidth === undefined) {
    if (labelMeasureCtx === undefined) {
      labelMeasureCtx = document.createElement('canvas').getContext('2d')
    }
    if (labelMeasureCtx) {
      labelMeasureCtx.font = LABEL_FONT
      textWidth = labelMeasureCtx.measureText(text).width
    } else {
      // 拿不到 2D context（理论上不会）时按字号粗估
      textWidth = text.length * LABEL_FONT_SIZE
    }
    labelWidthCache.set(text, textWidth)
  }
  return {
    width: textWidth + LABEL_PADDING_X * 2 + 2,
    height: LABEL_FONT_SIZE * 1.35 + LABEL_PADDING_Y * 2,
  }
}

/** 只在显隐真的变化时才改 Property */
function setLabelShown(entry: LabelEntry, show: boolean): void {
  if (entry.shown === show) return
  entry.shown = show
  if (entry.entity.label) entry.entity.label.show = show
}

/** 把屏幕距离过近的标注按优先级隐藏掉 */
function applyLabelAvoidance(viewer: Cesium.Viewer): void {
  const entries = labelEntries.get(viewer)
  if (!entries || entries.length === 0) return

  const scene = viewer.scene
  const camera = viewer.camera
  let occluder = labelOccluders.get(viewer)
  if (!occluder) {
    occluder = new Cesium.EllipsoidalOccluder(Cesium.Ellipsoid.WGS84, camera.positionWC)
    labelOccluders.set(viewer, occluder)
  }
  occluder.cameraPosition = camera.positionWC

  const toCamera = new Cesium.Cartesian3()
  const boxes: { entry: LabelEntry; left: number; right: number; top: number; bottom: number }[] = []

  for (const entry of entries) {
    // 相机背后 / 被地球挡住的标注收起，也不参与占位
    Cesium.Cartesian3.subtract(entry.position, camera.positionWC, toCamera)
    const behind = Cesium.Cartesian3.dot(camera.directionWC, toCamera) <= 0
    if (behind || !occluder.isPointVisible(entry.position)) {
      setLabelShown(entry, false)
      continue
    }
    const windowPos = Cesium.SceneTransforms.worldToWindowCoordinates(scene, entry.position)
    if (!windowPos) {
      // 投影还没就绪（首帧等）：保持原样，别把标注永久藏掉
      continue
    }
    // 标注是「图标上方、底边居中」：x 居中，底边再上移一个 pixelOffset
    const bottom = windowPos.y + LABEL_OFFSET_Y
    boxes.push({
      entry,
      left: windowPos.x - entry.width / 2,
      right: windowPos.x + entry.width / 2,
      top: bottom - entry.height,
      bottom,
    })
  }

  // 优先级高的先放；同档保持原顺序（日期 / seq），Array.sort 是稳定的
  boxes.sort((a, b) => a.entry.rank - b.entry.rank)

  const placed: { left: number; right: number; top: number; bottom: number }[] = []
  for (const box of boxes) {
    let clash = false
    for (const other of placed) {
      if (
        box.left < other.right &&
        box.right > other.left &&
        box.top < other.bottom &&
        box.bottom > other.top
      ) {
        clash = true
        break
      }
    }
    if (clash) {
      setLabelShown(box.entry, false)
      continue
    }
    setLabelShown(box.entry, true)
    placed.push({ left: box.left, right: box.right, top: box.top, bottom: box.bottom })
  }
}

/** 首次渲染时挂上监听：相机变了标脏，渲染前统一重算一次避让 */
function trackLabelAvoidance(viewer: Cesium.Viewer): void {
  if (labelTrackedViewers.has(viewer)) return
  labelTrackedViewers.add(viewer)
  // 相机变化的通知阈值调小，拖动时避让才跟得上
  viewer.camera.percentageChanged = 0.01
  viewer.camera.changed.addEventListener(() => {
    labelDirty.set(viewer, true)
  })
  viewer.scene.preRender.addEventListener(() => {
    if (!labelDirty.get(viewer)) return
    labelDirty.set(viewer, false)
    applyLabelAvoidance(viewer)
  })
}

function toPositions(points: [number, number][]): Cesium.Cartesian3[] {
  return Cesium.Cartesian3.fromDegreesArray(points.flat())
}

/** 粗略估算折线长度（米），仅用于决定箭头密度 */
function roughLengthM(points: [number, number][]): number {
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const dx = (points[i][0] - points[i - 1][0]) * 85_000
    const dy = (points[i][1] - points[i - 1][1]) * 111_320
    total += Math.hypot(dx, dy)
  }
  return total
}

/**
 * 沿线长度（米），口径要和 Cesium 生成贴地几何时用的一致。
 *
 * `st.s` 是拿这条线的实际 3D 长度归一化的（GroundPolylineGeometry 里用
 * `Cartesian3.distance` 逐段累加），所以这里也照同一种量法来。
 * 用 `roughLengthM` 那种「每度多少米」的粗估当图案周期基准，
 * 高纬度上能差出十几个百分点，箭头间距会整体偏掉。
 */
function routeLengthM(points: [number, number][]): number {
  if (points.length < 2) return 0
  const cartesians = toPositions(points)
  let total = 0
  for (let i = 1; i < cartesians.length; i += 1) {
    total += Cesium.Cartesian3.distance(cartesians[i - 1], cartesians[i])
  }
  return total
}

/**
 * 挑出路线上的急弯，返回它们在整条线上的**归一化弧长**（也就是着色器里 `st.s` 的取值）。
 *
 * 不能在相邻三个点上量夹角：导航路径的点很密，一个 90° 的大弯会被采样成十几个
 * 几度的小折角，逐个看全都够不着阈值。这里改成「站远一点看」—— 每个点分别朝前、
 * 朝后各取 ROUTE_BEND_LOOKAHEAD_M 米，比较这两个方向，才量得出真实转向，
 * 点密点疏都不影响。
 *
 * 名额有限（着色器里只有 ROUTE_BEND_SLOTS 个槽位），所以先按转角从大到小排，
 * 再丢掉彼此靠得太近的 —— 一个长弯本来就会被采成许多个「弯」，不合并会把名额吃光。
 */
function bendRatios(points: [number, number][]): number[] {
  if (points.length < 3) return []

  // 米制平面近似：只用来量转向和相对位置，不需要精确到米
  const lonScale = 111_320 * Math.cos((points[0][1] * Math.PI) / 180)
  const latScale = 111_320
  const xs = points.map((point) => point[0] * lonScale)
  const ys = points.map((point) => point[1] * latScale)

  const cum: number[] = [0]
  let total = 0
  for (let i = 1; i < xs.length; i += 1) {
    total += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])
    cum.push(total)
  }
  if (!(total > 0)) return []

  /** 取「沿线 cum 米处」的坐标，段内线性插值：点密或点疏都不会把方向量歪 */
  const pointAt = (targetM: number): [number, number] => {
    const clamped = Math.min(Math.max(targetM, 0), total)
    let i = 1
    while (i < cum.length - 1 && cum[i] < clamped) i += 1
    const span = cum[i] - cum[i - 1]
    const t = span > 0 ? (clamped - cum[i - 1]) / span : 0
    return [xs[i - 1] + (xs[i] - xs[i - 1]) * t, ys[i - 1] + (ys[i] - ys[i - 1]) * t]
  }

  const bends: { ratio: number; turn: number }[] = []
  for (let i = 1; i < xs.length - 1; i += 1) {
    const before = pointAt(cum[i] - ROUTE_BEND_LOOKAHEAD_M)
    const after = pointAt(cum[i] + ROUTE_BEND_LOOKAHEAD_M)
    const ux = xs[i] - before[0]
    const uy = ys[i] - before[1]
    const vx = after[0] - xs[i]
    const vy = after[1] - ys[i]
    const lu = Math.hypot(ux, uy)
    const lv = Math.hypot(vx, vy)
    if (lu < 1 || lv < 1) continue
    const cos = Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (lu * lv)))
    const turn = Math.acos(cos)
    if (turn >= ROUTE_BEND_MIN_TURN) bends.push({ ratio: cum[i] / total, turn })
  }

  // 先保最急的弯
  bends.sort((a, b) => b.turn - a.turn)

  // 再把靠得太近的合并掉
  const picked: number[] = []
  const minGapRatio = (ROUTE_BEND_LOOKAHEAD_M * 2) / total
  for (const bend of bends) {
    if (picked.length >= ROUTE_BEND_SLOTS) break
    if (picked.every((ratio) => Math.abs(ratio - bend.ratio) >= minGapRatio)) {
      picked.push(bend.ratio)
    }
  }
  return picked
}

/**
 * 把折线按长度均分成若干段。
 *
 * 用途：Cesium 的 `PolylineArrowMaterial` 是「一条细线 + 末端一个箭头」，
 * 整条线只画一个箭头，而且会被端点标记挡住。把导航线切成多段分别绘制，
 * 每段末端就都有一个箭头，连起来就是沿路指引前进方向的效果。
 */
function splitPath(points: [number, number][], segments: number): [number, number][][] {
  if (points.length < 2 || segments < 2) return [points]

  const cumulative: number[] = [0]
  let total = 0
  for (let i = 1; i < points.length; i += 1) {
    const dx = (points[i][0] - points[i - 1][0]) * 85_000
    const dy = (points[i][1] - points[i - 1][1]) * 111_320
    total += Math.hypot(dx, dy)
    cumulative.push(total)
  }
  if (total <= 0) return [points]

  const step = total / segments
  const result: [number, number][][] = []
  let current: [number, number][] = [points[0]]
  let target = step

  for (let i = 1; i < points.length; i += 1) {
    while (target < cumulative[i] && result.length < segments - 1) {
      const segLength = cumulative[i] - cumulative[i - 1]
      const ratio = segLength > 0 ? (target - cumulative[i - 1]) / segLength : 0
      const cut: [number, number] = [
        points[i - 1][0] + (points[i][0] - points[i - 1][0]) * ratio,
        points[i - 1][1] + (points[i][1] - points[i - 1][1]) * ratio,
      ]
      current.push(cut)
      result.push(current)
      current = [cut]
      target += step
    }
    current.push(points[i])
  }
  result.push(current)
  return result
}

/**
 * 渲染攻略：先画路线，再画点位图标。
 *
 * 所有要素都使用 CLAMP_TO_GROUND + 关闭深度测试，
 * 否则在开启真实高程地形后，标记会被山体遮挡甚至埋进地下。
 */
export function renderGuide(
  viewer: Cesium.Viewer | null,
  guide: GuideDto | null,
  options: RenderOptions,
): void {
  if (!viewer || viewer.isDestroyed()) return

  const { hiddenDays, hiddenCategories = [], highlightRouteId = null, selectedPoiId = null } = options
  // 箭头间距要按比例尺折算成屏幕像素，先让这个 viewer 开始跟踪相机高度
  trackMapScale(viewer)
  // ensureDataSource 内部会清掉同名孤儿图层：只要屏幕上还叠着一层没被清空的实体，
  // 显隐控制就永远看不出效果
  const dataSource = ensureDataSource(viewer)
  dataSource.entities.removeAll()
  labelEntries.set(viewer, [])
  if (!guide) return

  /** 整条行程的起点：单独成类，图标与其它节点区分 */
  const startPoiId = findStartPoiId(guide)

  const highlightColor = Cesium.Color.fromCssColorString(HIGHLIGHT_COLOR)
  const coreColor = Cesium.Color.fromCssColorString(HIGHLIGHT_CORE_COLOR)
  // 高亮路段必须是**当前这份数据里真实存在**的：改稿 / 重新规划路线后路线 id 全变了，
  // 若还按「有高亮」去淡化其它路线，会出现「一段都没高亮、整张图的路线却一起变透明」。
  const highlighted = highlightRouteId
    ? guide.routes.find((route) => route.id === highlightRouteId) ?? null
    : null
  const hasHighlight = highlighted !== null

  // 高亮路段两端的节点，图标要加一圈蓝色描边
  const highlightNodeIds = new Set<string>()
  if (highlighted?.from_poi_id) highlightNodeIds.add(highlighted.from_poi_id)
  if (highlighted?.to_poi_id) highlightNodeIds.add(highlighted.to_poi_id)

  // ---------- 路线 ----------
  for (const route of guide.routes) {
    const day = guide.days.find((item) => item.id === route.day_id)
    if (!day || hiddenDays.includes(day.day_index)) continue
    if (!route.path || route.path.length < 2) continue
    // 图例里把「导航路线」与「跨天转移」分开控制
    if (hiddenCategories.includes(route.transfer ? 'transfer' : 'route')) continue

    const color = Cesium.Color.fromCssColorString(dayColor(day.day_index))
    const isHighlighted = route.id === highlightRouteId

    if (isHighlighted) {
      renderHighlightedRoute(dataSource, route, highlightColor, coreColor)
      continue
    }

    // 跨天转移段：保持虚线 —— 虚线本来就和实线区分得开，这里优先保住这个区分
    if (route.transfer) {
      dataSource.entities.add({
        id: `route:${route.id}`,
        polyline: {
          positions: toPositions(route.path),
          width: 3,
          clampToGround: true,
          material: new Cesium.PolylineDashMaterialProperty({
            color: color.withAlpha(hasHighlight ? 0.25 : 0.8),
            dashLength: 18,
          }),
          zIndex: Z_INDEX_TRANSFER_ROUTE,
        },
      })
      continue
    }

    // 普通路段：一条折线 + 自定义箭头材质 —— 沿线一串「》》》」，指向前进方向
    dataSource.entities.add({
      id: `route:${route.id}`,
      polyline: {
        positions: toPositions(route.path),
        width: ROUTE_ARROW_WIDTH,
        clampToGround: true,
        material: createRouteMaterial(
          color,
          hasHighlight ? 0.18 : 0.95,
          routeLengthM(route.path),
          bendRatios(route.path),
        ),
        zIndex: Z_INDEX_ROUTE_ARROW,
      },
    })
  }

  // ---------- 点位（图标） ----------
  // 顺带记下每个标注的屏幕矩形与优先级，交给 applyLabelAvoidance 做避让
  const labelBoxes: LabelEntry[] = []
  for (const day of guide.days) {
    if (hiddenDays.includes(day.day_index)) continue

    const color = dayColor(day.day_index)

    for (const poi of day.pois) {
      // 赶路 / 休整类节点以及未落点的节点没有坐标，跳过（后续由人工校正补齐）
      if (poi.lng === null || poi.lat === null) continue

      // 图标：起点用旗子，其余按节点类型；分类：起点优先且「赶路」并入起点
      const iconKey: IconKey = poi.id === startPoiId ? 'start' : baseIconKeyOf(poi)
      if (hiddenCategories.includes(legendKeyOf(poi, startPoiId))) continue

      const isProblem = poi.geocode_status !== 'ok' && poi.geocode_status !== 'manual'
      const isOptional = poi.priority === 'optional'
      const isKey = poi.priority === 'key'
      const isSelected = poi.id === selectedPoiId
      const markerColor = isProblem ? PROBLEM_COLOR : color

      const poiPosition = Cesium.Cartesian3.fromDegrees(poi.lng, poi.lat)
      const labelText = nodeLabel(day.day_index, poi)
      const entity = dataSource.entities.add({
        id: `poi:${poi.id}`,
        name: poi.name,
        position: poiPosition,
        properties: {
          dayIndex: day.day_index,
          poiId: poi.id,
          kind: poi.kind,
          priority: poi.priority,
          status: poi.geocode_status,
          arriveTime: poi.arrive_time ?? '',
          notes: poi.notes ?? '',
          warnings: poi.warnings ?? '',
          tips: poi.tips ?? '',
          address: poi.address ?? '',
        },
        billboard: {
          // 仅选中 / 高亮路段端点加蓝圈，其余不加任何外框
          image: iconUri(
            iconKey,
            markerColor,
            isSelected || highlightNodeIds.has(poi.id) ? 'select' : 'none',
          ),
          width: 40,
          height: 40,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -2),
          // 可选节点淡一些，关键节点更实
          color: Cesium.Color.WHITE.withAlpha(isOptional && !isSelected ? 0.72 : 1),
          scale: (isKey ? 1.15 : 1) * (isSelected ? 1.3 : 1),
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // 拉远后缩小，避免图标糊成一片
          scaleByDistance: new Cesium.NearFarScalar(1.8e6, 1.0, 6e6, 0.7),
          // 图标永远压过所有折线层（含箭头）
          zIndex: Z_INDEX_POI_ICON,
        },
        label: {
          text: labelText,
          // 字号偏小 + 纯描边在卫星底图上容易糊，这里加大字号并加浅色底衬
          font: LABEL_FONT,
          fillColor: Cesium.Color.fromCssColorString(isOptional ? '#44536b' : '#0f1a2e'),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          showBackground: true,
          backgroundColor: new Cesium.Color(1, 1, 1, 0.86),
          backgroundPadding: new Cesium.Cartesian2(LABEL_PADDING_X, LABEL_PADDING_Y),
          pixelOffset: new Cesium.Cartesian2(0, LABEL_OFFSET_Y),
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          // 放宽淡出距离：原来 3.5e6 就完全透明，拉远后相当于「看不见」
          translucencyByDistance: new Cesium.NearFarScalar(2.5e6, 1.0, 8e6, 0.25),
          // 标注再压过图标：最上面一层
          zIndex: Z_INDEX_POI_LABEL,
        },
      })

      const box = measureLabelBox(labelText)
      labelBoxes.push({
        entity,
        position: poiPosition,
        width: box.width,
        height: box.height,
        rank: labelRankOf(poi, isSelected),
        shown: true,
      })
    }
  }

  if (options.labelAvoidance === false) {
    // 关掉避让：队列在开头已清空，这里只需清掉待重算标记
    labelDirty.set(viewer, false)
    return
  }
  labelEntries.set(viewer, labelBoxes)
  trackLabelAvoidance(viewer)
  labelDirty.set(viewer, true)
}

/**
 * 高亮路段：外圈蓝色描边 + 白色芯线 + 沿途前进方向箭头
 */
function renderHighlightedRoute(
  dataSource: Cesium.CustomDataSource,
  route: GuideRouteDto,
  ringColor: Cesium.Color,
  coreColor: Cesium.Color,
): void {
  const path = route.path
  const positions = toPositions(path)

  // 1) 外圈描边（宽一圈蓝边，让高亮段从底图上跳出来）
  dataSource.entities.add({
    id: `route-ring:${route.id}`,
    polyline: {
      positions,
      // 普通路线现在是 ROUTE_LINE_WIDTH(12) 的粗线，外圈也跟着加宽才压得住
      width: 22,
      clampToGround: true,
      material: new Cesium.ColorMaterialProperty(ringColor),
      zIndex: Z_INDEX_HIGHLIGHT_RING,
    },
  })

  // 2) 内芯：白色细线，形成「蓝边白芯」的导航感
  dataSource.entities.add({
    id: `route-core:${route.id}`,
    polyline: {
      positions,
      width: 10,
      clampToGround: true,
      material: new Cesium.ColorMaterialProperty(coreColor),
      zIndex: Z_INDEX_HIGHLIGHT_CORE,
    },
  })

  // 3) 前进方向箭头：把线切段，每段末端生成一个箭头
  const lengthM = route.distance_m ?? roughLengthM(path)
  const segments = Math.min(Math.max(Math.round(lengthM / 12000), 3), 10)
  const chunks = splitPath(path, segments)

  chunks.forEach((chunk, index) => {
    if (chunk.length < 2) return
    dataSource.entities.add({
      id: `route-arrow:${route.id}:${index}`,
      polyline: {
        positions: toPositions(chunk),
        width: 18,
        clampToGround: true,
        material: new Cesium.PolylineArrowMaterialProperty(ringColor),
        zIndex: Z_INDEX_HIGHLIGHT_ARROW,
      },
    })
  })
}

/** 定位单个节点时的镜头高度（米）：留出足够周边视野，不要太贴脸 */
const POI_VIEW_HEIGHT = 50_000
/** 定位单段路线时的最小镜头高度（米） */
const ROUTE_VIEW_MIN_HEIGHT = 50_000

/** 飞到单个节点 */
export function flyToPoi(viewer: Cesium.Viewer | null, poi: GuidePoiDto): void {
  if (!viewer || viewer.isDestroyed()) return
  if (poi.lng === null || poi.lat === null) return

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(poi.lng, poi.lat, POI_VIEW_HEIGHT),
    duration: 1.2,
  })
}

/** 飞到某一段路线（含两端点位），镜头留出余量，避免贴得太近 */
export function flyToRoute(viewer: Cesium.Viewer | null, route: GuideRouteDto): void {
  if (!viewer || viewer.isDestroyed()) return
  const path = route.path ?? []
  if (path.length < 2) return

  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY

  for (const [lng, lat] of path) {
    minLng = Math.min(minLng, lng)
    maxLng = Math.max(maxLng, lng)
    minLat = Math.min(minLat, lat)
    maxLat = Math.max(maxLat, lat)
  }

  const centerLng = (minLng + maxLng) / 2
  const centerLat = (minLat + maxLat) / 2
  const spanDeg = Math.max(maxLng - minLng, maxLat - minLat)
  const height = Math.max(spanDeg * 111_320 * 2.4, ROUTE_VIEW_MIN_HEIGHT)

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(centerLng, centerLat, height),
    duration: 1.5,
  })
}

/** 飞到攻略覆盖范围 */
export function flyToGuide(viewer: Cesium.Viewer | null, guide: GuideDto | null): void {
  if (!viewer || viewer.isDestroyed() || !guide) return

  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY

  for (const day of guide.days) {
    for (const poi of day.pois) {
      if (poi.lng === null || poi.lat === null) continue
      minLng = Math.min(minLng, poi.lng)
      maxLng = Math.max(maxLng, poi.lng)
      minLat = Math.min(minLat, poi.lat)
      maxLat = Math.max(maxLat, poi.lat)
    }
  }

  if (!Number.isFinite(minLng)) return

  const centerLng = (minLng + maxLng) / 2
  const centerLat = (minLat + maxLat) / 2
  // 以跨度估算视高：留 2.2 倍余量，并设下限避免区域过小时贴地
  const spanDeg = Math.max(maxLng - minLng, maxLat - minLat)
  const height = Math.max(spanDeg * 111_320 * 2.2, 40_000)

  viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(centerLng, centerLat, height),
    duration: 1.8,
  })
}
