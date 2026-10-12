-- ============================================================================
-- 旅游攻略 B 端 · 数据库结构
--
-- 【坐标系约定】非常重要，搞错会导致地图上点位偏移 300~600 米
--   lng / lat          -> WGS84 (EPSG:4326)  供 Cesium 直接渲染
--   lng_gcj / lat_gcj  -> GCJ-02 (火星坐标)  供高德接口回传（路径规划等）
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- 攻略主表
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guide (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL,
  region        text,
  prompt        text,                                  -- 用户原始输入
  summary       text,
  total_days    int  NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'draft',         -- draft | confirmed | archived
  route_engine  text,                                  -- 路线数据来源：amap | manual | none
  raw_llm       jsonb,                                 -- LLM 原始输出，便于回溯与重生成
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE guide IS '旅游攻略主表';

-- 软删除（归档）：非空表示已归档，列表默认不展示但数据保留、可恢复
ALTER TABLE guide ADD COLUMN IF NOT EXISTS archived_at timestamptz;
COMMENT ON COLUMN guide.archived_at IS '软删除（归档）时间；非空即已归档，可恢复';

-- ---------------------------------------------------------------------------
-- 行程天
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guide_day (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id      uuid NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
  day_index     int  NOT NULL,
  title         text,
  summary       text,
  drive_km      numeric(8, 2),
  drive_minutes int,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guide_id, day_index)
);

COMMENT ON TABLE guide_day IS '攻略分日行程';

-- 分日行程的丰富字段（幂等新增，兼容早期已建的表）
ALTER TABLE guide_day ADD COLUMN IF NOT EXISTS route_text       text;   -- 路线串联：成都 → 都江堰 → 四姑娘山镇
ALTER TABLE guide_day ADD COLUMN IF NOT EXISTS stay_text        text;   -- 住宿地
ALTER TABLE guide_day ADD COLUMN IF NOT EXISTS highlights       text;   -- 当日看点
ALTER TABLE guide_day ADD COLUMN IF NOT EXISTS cautions         text;   -- 当日注意事项 / 纪律
ALTER TABLE guide_day ADD COLUMN IF NOT EXISTS drive_hours      text;   -- 车程文案，如 '4–5 h'
ALTER TABLE guide_day ADD COLUMN IF NOT EXISTS sleep_altitude_m int;    -- 住宿海拔（米）
ALTER TABLE guide_day ADD COLUMN IF NOT EXISTS max_altitude_m   int;    -- 当日最高海拔（米）
ALTER TABLE guide_day ADD COLUMN IF NOT EXISTS notes            jsonb;  -- 当日提示文案数组

-- ---------------------------------------------------------------------------
-- 行程节点（景点 / 垭口 / 城镇 / 用餐 / 赶路 / 休整）
--
-- 说明：本表早期只存「景点」，现已升级为「行程节点」——
-- 时间轴上的每一个节点都存一行，便于按序渲染整条日时间轴。
-- 只有带坐标的节点（city 可检索到）才会在地图上打点。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guide_poi (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id          uuid NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
  day_id            uuid REFERENCES guide_day(id) ON DELETE CASCADE,
  seq               int  NOT NULL DEFAULT 0,           -- 当天内游玩顺序
  name              text NOT NULL,
  city              text,
  address           text,
  lng               double precision,                  -- WGS84
  lat               double precision,                  -- WGS84
  lng_gcj           double precision,                  -- GCJ-02
  lat_gcj           double precision,                  -- GCJ-02
  geom              geometry(Point, 4326),
  stay_minutes      int,
  arrive_time       text,                              -- 建议到达时间 'HH:mm'
  notes             text,
  -- 落点质量追溯
  geocode_status    text NOT NULL DEFAULT 'pending',   -- pending|ok|suspect|failed|manual|skipped
  geocode_score     int,
  geocode_provider  text,                              -- amap | tianditu | manual
  geocode_keyword   text,                              -- 实际用于检索的关键词
  verified          boolean NOT NULL DEFAULT false,    -- 是否经人工校正
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE guide_poi IS '攻略行程节点（景点/垭口/城镇/用餐/赶路），坐标为 WGS84/GCJ-02 双存';
COMMENT ON COLUMN guide_poi.geocode_status IS 'ok=正常; suspect=越界可疑; failed=未落点; manual=人工指定; skipped=无需落点(赶路/休整)';

ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS kind       text NOT NULL DEFAULT 'spot';
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS priority   text NOT NULL DEFAULT 'normal';
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS warnings   text;          -- 避坑提醒
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS tips       text;          -- 实用建议
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS leg_km     numeric(8, 1); -- 与上一节点之间的里程（LLM 估算）

-- 弹窗详情字段：时间轴只展示玩法/避坑/建议，这些是「点开点位后的详情卡」专用内容
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS detail         text;   -- 详细介绍（弹窗正文）
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS highlights     jsonb;  -- 看点 / 亮点短句数组
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS best_time      text;   -- 最佳时段 / 季节
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS photo_keywords jsonb;  -- 配图检索关键词（LLM 给）
ALTER TABLE guide_poi ADD COLUMN IF NOT EXISTS photos         jsonb;  -- 实景图 [{title,url}]（高德 POI 图片）

COMMENT ON COLUMN guide_poi.kind     IS 'spot=景点; view=观景/垭口; town=城镇住宿; meal=用餐; drive=赶路; rest=休整';
COMMENT ON COLUMN guide_poi.priority IS 'key=关键节点; normal=常规; optional=可选';
COMMENT ON COLUMN guide_poi.leg_km   IS '距上一节点的里程，用于时间轴上的分段里程胶囊';
COMMENT ON COLUMN guide_poi.detail   IS '弹窗详细介绍，与 desc/warnings/tips 分工，不复述时间轴内容';
COMMENT ON COLUMN guide_poi.photos   IS '实景图 [{title,url}]，来自高德 POI 图片（可能为空，弹窗会按需补图）';

-- ---------------------------------------------------------------------------
-- 路线段（景点之间）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guide_route (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guide_id      uuid NOT NULL REFERENCES guide(id) ON DELETE CASCADE,
  day_id        uuid REFERENCES guide_day(id) ON DELETE CASCADE,
  from_poi_id   uuid REFERENCES guide_poi(id) ON DELETE CASCADE,
  to_poi_id     uuid REFERENCES guide_poi(id) ON DELETE CASCADE,
  seq           int  NOT NULL DEFAULT 0,
  geom          geometry(LineString, 4326),            -- WGS84 折线
  path          jsonb,                                 -- [[lng,lat], ...] WGS84
  distance_m    int,
  duration_s    int,
  provider      text,                                  -- amap | manual
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE guide_route IS '节点间驾车路线段，按天分组渲染';

-- 跨天转移路段：上一日最后一个落点 → 次日第一个落点。
-- 有了它，地图上的行程折线才不会在「天与天之间」断开。
ALTER TABLE guide_route ADD COLUMN IF NOT EXISTS transfer boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN guide_route.transfer IS 'true=跨天转移路段（上一日终点 → 次日起点），前端画虚线区分';

-- ---------------------------------------------------------------------------
-- 索引
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_guide_created      ON guide (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_guide_day_guide    ON guide_day (guide_id, day_index);
CREATE INDEX IF NOT EXISTS idx_guide_poi_guide    ON guide_poi (guide_id, seq);
CREATE INDEX IF NOT EXISTS idx_guide_poi_day      ON guide_poi (day_id, seq);
CREATE INDEX IF NOT EXISTS idx_guide_poi_geom     ON guide_poi USING GIST (geom);
CREATE INDEX IF NOT EXISTS idx_guide_route_guide  ON guide_route (guide_id, seq);
CREATE INDEX IF NOT EXISTS idx_guide_route_day    ON guide_route (day_id, seq);
CREATE INDEX IF NOT EXISTS idx_guide_route_geom   ON guide_route USING GIST (geom);

-- ---------------------------------------------------------------------------
-- updated_at 自动维护
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guide_touch ON guide;
CREATE TRIGGER trg_guide_touch BEFORE UPDATE ON guide
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- geom 与 lng/lat 自动同步（避免手工维护出错）
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_poi_geom() RETURNS trigger AS $$
BEGIN
  IF NEW.lng IS NOT NULL AND NEW.lat IS NOT NULL THEN
    NEW.geom = ST_SetSRID(ST_MakePoint(NEW.lng, NEW.lat), 4326);
  ELSE
    NEW.geom = NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_poi_geom ON guide_poi;
CREATE TRIGGER trg_poi_geom BEFORE INSERT OR UPDATE OF lng, lat ON guide_poi
  FOR EACH ROW EXECUTE FUNCTION sync_poi_geom();
