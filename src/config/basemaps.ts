import type { TiandituLayerOptions } from '@/services/tianditu'

/** 底图预设：一组「底图 + 注记」的搭配 */
export interface BasemapPreset {
  key: string
  name: string
  /** 预览色，用于切换按钮色块 */
  swatch: string
  /** 底图图层 */
  base: TiandituLayerOptions
  /** 注记图层（可关闭） */
  label?: TiandituLayerOptions
}

/** 可切换的底图：卫星 / 矢量 */
export const BASEMAPS: BasemapPreset[] = [
  {
    key: 'img',
    name: '卫星',
    swatch: 'linear-gradient(135deg,#2b4a3f,#5d7f6c)',
    base: { type: 'img' },
    label: { type: 'cia' },
  },
  {
    key: 'vec',
    name: '矢量',
    swatch: 'linear-gradient(135deg,#d9e6f5,#8fb4d6)',
    base: { type: 'vec' },
    label: { type: 'cva' },
  },
]
