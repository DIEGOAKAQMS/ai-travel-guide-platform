# 旅游攻略管理平台 · 三维地图底座

代码ai编程

基于 **Cesium + Vue3 + Vite + TypeScript + Node/Express + PostgreSQL(PostGIS)** 的 B 端旅游攻略系统。

**已完成的端到端能力**：一句话 → DeepSeek 生成行程骨架 → 高德地理编码逐个落点（含越界校验）→ 写入 PostGIS → 高德驾车路径规划 → 前端对话框与地图渲染。

- 前端：Cesium 场景、天地图三种底图模式（卫星 / 高程 / 矢量）、真实三维高程地形、  
  右下角 AI 横条与地图切换、左上角天数图例、底部状态栏，默认视角定位**四川省**
- 后端：`server/` 目录，详见 [九、后端服务](#九后端服务)

## 一、技术栈

| 能力   | 选型                                               |
| ---- | ------------------------------------------------ |
| 三维引擎 | Cesium（npm 包，静态资源由 Vite 托管）                      |
| 前端框架 | Vue 3 + `<script setup>` + TypeScript            |
| 构建工具 | Vite 5                                           |
| 状态管理 | Pinia                                            |
| 地图服务 | 天地图 WMTS（`vec` / `cva` / `img` / `cia` / `ter`）  |
| 高程地形 | ArcGIS World Elevation 3D（默认）/ Cesium Ion / 自建服务 |

## 二、快速开始

项目分为两个部分：

- **前端**（根目录）—— Cesium 地图 + AI 对话框，端口 `5188`
- **后端**（`server/`）—— DeepSeek + 高德 + PostgreSQL，端口 `5300`

### 2.0 前置要求（clone 后先做这些）

下面四项不满足，后面任何一步都跑不起来：

**① Node.js ≥ 22**

前端依赖 Cesium 1.126，它在 `package-lock.json` 里声明了 `engines.node >= 22.0.0`，  
Node 18 / 20 下 `npm install` 会报 `EBADENGINE`、构建也可能失败。后端本身只要 18+（用了全局 `fetch`）。

```bash
node -v      # 期望 v22.x
```

**② PostgreSQL + PostGIS 扩展**

`server/sql/schema.sql` 的第一步就是 `CREATE EXTENSION IF NOT EXISTS postgis`（还有 `pgcrypto`），  
数据库没装 PostGIS 会直接失败。扩展需要超级用户权限，本地安装的默认 `postgres` 用户一般够用。

**③ 先建一个空库**（`migrate` 只建扩展和表，**不会建库**）

```bash
createdb travel_guide
# 或：psql -U postgres -c "CREATE DATABASE travel_guide;"
```

库不存在时报错：`database "travel_guide" does not exist`。

**④ 两次 `npm install`**

根目录和 `server/` 是两个独立的 `package.json`，都要装：

```bash
npm install                 # 根目录：前端（Cesium / Vue / Vite）
cd server && npm install    # 后端（Express / pg / tsx）
```

> **两个常见坑**
>
> - 改了后端端口 `PORT` 之后，必须同步改 `vite.config.ts` 里 proxy 的 `target` —— `http://127.0.0.1:5300` 是硬编码的，否则前端 `/api/*` 全部 404。前端端口 `5188` 同样是写死的。
> - 高德 key 必须申请 **「Web 服务」** 类型（不是「Web端(JS API)」），否则地理编码与路径规划会直接无权限。

做完这四步 → 见 2.2 填 `config.env`（4 项必填）→ 2.3 起前端。启动顺序：**先后端 5300，再前端 5188**。

### 2.1 后端（建议先启动）

```bash
cd server
npm install
npm run migrate     # 建表（启动时也会自动执行，可跳过）
npm run dev         # http://127.0.0.1:5300
```

### 2.2 配置（前后端共用一份）

所有配置（含需要付费的 key）都集中在仓库根目录的 **`config.env`**，前后端共用一份，  
文件里逐项写了「去哪申请 / 留空的后果 / 计费等级」。最小可跑需要填：  
`PGPASSWORD`、`DEEPSEEK_API_KEY`、`AMAP_KEY`、`VITE_TIANDITU_TOKEN`。

读取优先级（同一项取第一个非空值）：

```
外部环境变量 > config.env > 根 .env > server/.env > 代码默认值
```

所以某一项在 `config.env` 里留空 = 自动让下面的旧文件兜底，不会因此起不来。

> `config.env` 已纳入 git，里面请保持占位符；真实密钥建议填在 `.env` / `server/.env`（这两个文件在 `.gitignore` 里）。  
> 改完 `VITE_*` 那几项需要重启 `npm run dev` —— 前端配置是构建期注入的，热更新不会重读文件。

### 2.3 前端

```bash
# 在项目根目录
npm install
npm run dev         # http://localhost:5188，自动打开浏览器
```

前端通过 Vite 代理把 `/api/*` 转发到 `http://127.0.0.1:5300`，无需额外处理跨域。

### 2.4 其它命令

```bash
npm run build       # 前端生产构建
npm run preview     # 预览构建产物
npm run type-check  # 前端类型检查
```

> **注意**：Cesium 的 Worker / Assets 等静态资源必须经 HTTP 提供，**不能直接双击 `index.html` 打开**（`file://` 协议下会 404）。  
> 请使用 `npm run dev`（开发）或 `npm run preview`（构建产物预览）。

## 三、天地图配置

1. 到 [天地图控制台](https://console.tianditu.gov.cn/api/key) 申请 token。
2. 编辑项目根目录 `config.env`：

```ini
# 前端底图瓦片用（必须带 VITE_ 前缀，Vite 才会注入到浏览器端代码）
VITE_TIANDITU_TOKEN=你的token

# 后端落点兜底地理编码用（可选）
TIANDITU_TOKEN=你的token
```

1. **把 `localhost:5188` 与 `127.0.0.1:5188` 加入天地图控制台的域名白名单**，否则瓦片会返回 403。  
   天地图 token 与域名绑定，部署上线时需把正式域名一并加入白名单。

修改 `config.env` 后需重启 `npm run dev` 才会生效（前端配置是构建期注入的）。

## 四、图层体系说明

### 4.1 地图模式（右下角互斥切换）

| key   | 按钮 | 底图图层    | 注记图层    | 说明                               |
| ----- | -- | ------- | ------- | -------------------------------- |
| `img` | 卫星 | `img_w` | `cia_w` | 卫星影像，默认模式                        |
| `ter` | 高程 | `ter_w` | `cva_w` | 地形晕渲，服务最大有效层级为 **14**（更高层级返回空瓦片） |
| `vec` | 矢量 | `vec_w` | `cva_w` | 标准矢量底图                           |

> `ter_w` 的 14 级上限已实测确认：第 15 级起返回的是同一张空白占位图。  
> 因此该图层 `maximumLevel` 设为 14，Cesium 会自动用 14 级瓦片拉伸显示，避免出现空白。

### 4.2 三维高程地形（DEM）

**天地图不提供高程地形服务**，其 `ter` 服务只是带阴影的平面栅格图，不含高程，山体不会隆起。  
真实三维高程需要 quantized-mesh 或 ArcGIS ImageServer 地形服务。本项目按以下优先级自动选择：

| 优先级 | 数据源                                          | 配置项                                      |
| --- | -------------------------------------------- | ---------------------------------------- |
| 1   | 自定义地形服务                                      | `VITE_TERRAIN_URL` + `VITE_TERRAIN_TYPE` |
| 2   | Cesium Ion World Terrain                     | `VITE_CESIUM_ION_TOKEN`                  |
| 3   | **公共 ArcGIS World Elevation 3D（默认，免 token）** | 无需配置                                     |

下面这几项同样填在根目录 `config.env`：

```ini
# 关闭高程地形，回退为光滑椭球面
VITE_TERRAIN_ENABLED=false

# 自定义 quantized-mesh 服务（指向 layer.json 所在目录）
VITE_TERRAIN_URL=https://your-terrain-server/terrain
VITE_TERRAIN_TYPE=cesium

# 或自定义 ArcGIS ImageServer 地形服务
VITE_TERRAIN_URL=https://your-arcgis-server/.../Terrain3D/ImageServer
VITE_TERRAIN_TYPE=arcgis
```

> 默认的 ArcGIS 公共服务为公开免 token 资源，存在限流与网络延迟，**生产环境建议配置自建服务或 Cesium Ion**。  
> 地形启用后 `scene.globe.depthTestAgainstTerrain` 会自动开启，确保山体遮挡关系正确。

## 五、目录结构

```
src/
├─ main.ts                        # 应用入口
├─ App.vue                        # 整体布局骨架（顶栏 + 全屏地图 + 底部停靠区 + 状态栏）
├─ api/guide.ts                   # 后端接口客户端（含 SSE 流式解析）
├─ types/guide.ts                 # 与后端对齐的 DTO 类型
├─ config/
│  ├─ index.ts                    # 环境变量 / 全局常量（含初始视角 HOME_VIEW）
│  ├─ basemaps.ts                 # 地图模式预设（卫星 / 高程 / 矢量）
│  └─ guide.ts                    # 行程天数配色
├─ services/
│  ├─ tianditu.ts                 # 天地图 WMTS Provider 工厂 + token 校验
│  └─ guideRenderer.ts            # 攻略图层渲染：图标标记 + 贴地路线 + 高亮 + 视野自适应
├─ stores/
│  ├─ map.ts                      # Pinia：Viewer、底图、视角、状态栏数据
│  └─ guide.ts                    # Pinia：生成流程、进度、日志、天数显隐
├─ components/
│  ├─ layout/
│  │  ├─ AppHeader.vue            # 顶栏
│  │  └─ AppStatusBar.vue         # 底部状态栏（经纬度 / 视高 / FPS）
│  ├─ ai/
│  │  └─ AiAssistant.vue          # 右下角 AI 横条（输入 / 流式进度 / 过程日志）
│  ├─ panel/
│  │  └─ GuideTimeline.vue        # 左侧行程时间轴（逐天折叠 / 逐天显隐 / 点击定位）
│  └─ map/
│     ├─ CesiumViewer.vue         # Cesium 容器：场景 / 地形 / 拾取 / 统计
│     └─ MapModeSwitcher.vue      # 地图模式切换（卫星 / 高程 / 矢量）
└─ styles/index.css               # 主题变量与通用样式
```

## 六、使用方式

1. 打开 <http://localhost:5188>
2. 右下角横条输入一句话，例如：**帮我做一份川西大环线 6 天自驾攻略**
3. 点击「生成攻略」，横条上方会实时显示：
   - 当前阶段（理解需求 → 规划骨架 → 解析坐标 → 写入数据库 → 规划路线）
   - 模型思考过程（`deepseek-flash` 的推理内容实时流出，避免长时间静默）
   - 景点落点进度百分比
4. 完成后地图自动飞到攻略范围，并渲染：
   - **每天一种颜色**的景点标记（序号为「天-序号」）
   - 景点之间的**贴地驾车路线**
   - 左上角天数图例，点击可逐天显隐
5. 落点可疑（`suspect`）或失败（`failed`）的点位会用**红色**标记，图例下方给出提示，  
   可通过 `PATCH /api/guide/poi/:poiId` 接口人工校正。

### 布局说明

| 位置  | 内容                          |
| --- | --------------------------- |
| 顶栏  | 平台标题、天地图服务状态灯               |
| 左上角 | 行程天数图例（有攻略时出现）              |
| 右上角 | 地图工具条（复位 / 缩放 / 2D-3D / 全屏） |
| 右下角 | 地图模式切换 + AI 横条              |
| 底栏  | 鼠标经纬度、视高、场景模式、FPS           |

## 七、关键 API（供后续功能开发使用）

通过 Pinia `useMapStore()` 即可拿到地图能力：

```ts
const map = useMapStore()

map.viewer                    // 原生 Cesium.Viewer 实例
map.flyTo(104.07, 30.67)      // 飞到指定经纬度（成都）
map.flyToHome()               // 复位到四川省全境
map.zoom(0.4)                 // 缩放（正数拉近）
map.setBasemap('img')         // 切换地图模式：img / ter / vec
map.toggleSceneMode()         // 2D / 3D 切换
```

## 八、后续开发约定

新增业务功能的推荐做法：

1. 在 `src/services/` 下新增图层数据源封装；
2. 在 `src/stores/` 中扩展对应的显隐状态与加载 action；
3. 功能按钮统一挂在 `map-stage` 内做悬浮控件（参考 `MapModeSwitcher.vue` 的定位与样式）；
4. 业务点位/路线统一挂到 `map.viewer.entities` 或独立 `DataSource` 下，便于分组管理。

## 九、后端服务

### 9.1 目录结构

```
server/
├─ sql/schema.sql            # 表结构（幂等，可重复执行）
├─ src/
│  ├─ index.ts               # 入口：自动建表 + 路由挂载 + 错误处理
│  ├─ config.ts              # 分层加载配置（config.env > 根 .env > server/.env）+ 区域包围盒
│  ├─ db/
│  │  ├─ pool.ts             # 连接池 / 事务 / 健康探测
│  │  └─ migrate.ts          # 执行 schema.sql
│  ├─ services/
│  │  ├─ llm.ts              # DeepSeek 客户端 + 行程规划提示词
│  │  ├─ amap.ts             # 高德 POI搜索 / 地理编码 / 驾车路径规划
│  │  ├─ tianditu.ts         # 天地图地理编码（兜底）
│  │  └─ guide.ts            # 编排：LLM → 落点 → 校验 → 入库
│  ├─ routes/guide.ts        # HTTP 接口
│  ├─ utils/
│  │  ├─ coord.ts            # GCJ-02 ↔ WGS84 转换
│  │  └─ async.ts            # 并发受限 map / 串行限速队列
│  └─ types.ts
└─ .env                      # 历史遗留配置（优先级低于仓库根目录的 config.env）
```

### 9.2 接口一览

| 方法     | 路径                      | 说明                                             |
| ------ | ----------------------- | ---------------------------------------------- |
| GET    | `/api/health`           | 健康检查（数据库 / 模型 / 各 key 配置状态）                    |
| POST   | `/api/guide/generate`   | **一句话生成攻略**，body: `{ prompt, days?, region? }` |
| GET    | `/api/guide`            | 攻略列表                                           |
| GET    | `/api/guide/:id`        | 攻略详情（含分日与点位）                                   |
| POST   | `/api/guide/:id/route`  | 计算各天景点间驾车路线并回填里程                               |
| PATCH  | `/api/guide/poi/:poiId` | 人工校正点位坐标（标记 `manual` + `verified`）             |
| GET    | `/api/guide/:id/text`   | 导出攻略纯文本（供后续生成 PDF 用）                           |
| DELETE | `/api/guide/:id`        | 删除攻略（级联删除天 / 点 / 路线）                           |

### 9.3 关键设计决策

**① LLM 不产出坐标**  
DeepSeek 只输出「景点名 + 所属行政区划 + 游玩提示」，坐标一律由后端调地图服务解析。  
原因是 LLM 编造坐标的概率极高，且无法校验。

**② 落点四级兜底 + 区域校验**  
按「高德 POI（行政区限定）→ 高德 POI（不限）→ 高德结构化地址 → 天地图」依次尝试，  
只有落在 `REGION_BBOX` 范围内的结果才判定为 `ok`，越界的标记为 `suspect` 等待人工校正，  
全部失败标记 `failed`。绝不静默丢弃可疑结果。

**③ 坐标双存**  
`lng/lat` 存 WGS84（Cesium 直接渲染），`lng_gcj/lat_gcj` 存 GCJ-02（回传高德接口用）。  
`geom` 由数据库触发器自动同步，避免手工维护出错。

**④ 高德强制串行限速**  
实测并发请求会触发 `10021 CUQPS_HAS_EXCEEDED_THE_LIMIT`，且一旦触发后续请求会连续失败。  
所有高德请求经 `createSerialQueue` 串行化，按 `AMAP_MIN_INTERVAL_MS`（默认 350ms）限速，并对限流错误退避重试。

**⑤ 推理模型 token 预算**  
`deepseek-flash` 的 `reasoning_content` 会占用 `max_tokens`（实测占输出 84%）。  
预算不足时 `content` 会是空串，故 `llm.ts` 实现了「预算不足自动加倍重试」。

### 9.4 数据表


| 表             | 说明                                                                                   |
| ------------- | ------------------------------------------------------------------------------------ |
| `guide`       | 攻略主表，保留 `raw_llm` 原始输出便于回溯与重生成                                                       |
| `guide_day`   | 分日行程，含 `drive_km` / `drive_minutes`                                                  |
| `guide_poi`   | 景点点位，含落点追溯字段（`geocode_status` / `geocode_provider` / `geocode_keyword` / `verified`） |
| `guide_route` | 景点间路线段，存 GeoJSON `path` + PostGIS `geom` 折线                                          |

### 9.5 实测数据

以「川西大环线 6 天自驾」端到端验证：

| 指标    | 结果                                |
| ----- | --------------------------------- |
| 落点成功率 | 21 / 21（100%）                     |
| 生成耗时  | 约 54 秒（含模型推理）                     |
| 路线段   | 15 段，总里程 1163.5 km，0 失败           |
| token | completion 10732 / reasoning 9308 |

### 9.6 已知限制

- **高德 API 配额**：个人 key 有日调用量与 QPS 限制，生产环境需升级配额。  
  `AMAP_MIN_INTERVAL_MS` 可调小以提速，但可能触发限流。
- **天地图地理编码不可信**：实测「理塘」被解析到浙江（`120.4°E`）且 `score` 仍为 99，`mapBound` 参数实测无效。  
  因此仅作兜底，且必须过 bbox 校验。
- **路径规划 ≠ 旅游路线**：高德按最短 / 最快路径规划，可能走高速而非观景线路，需支持人工增删途经点。
- **越界点位的处理**：`geocode_status` 为 `suspect` / `failed` 的点位不应直接参与路线规划，需先人工校正。
