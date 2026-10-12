/**
 * 导出 HTML 的内联样式。
 *
 * 沿用 `travel-guide-html` 技能沉淀的设计系统（暖纸感主题）：
 * 白卡片 + 细边框 + 圆角、语义色彩（青=游玩 / 红=关键 / 金=可选 / 琥珀=开车 / 紫=海拔 4000+）。
 * 这里只保留本项目导出时会用到的类，去掉清单 / 费用 / alert 等未生成的组件。
 */
export const EXPORT_CSS = `:root{
  --bg:#f7f5f0; --card:#fff; --ink:#1f2328; --ink2:#4a5158; --ink3:#8b939c;
  --line:#e6e1d8; --accent:#c0392b; --accent2:#0f6e6e; --gold:#b8860b; --soft:#faf8f4;
}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
  background:var(--bg);color:var(--ink);line-height:1.75;font-size:15px;padding-bottom:80px;}
.wrap{max-width:980px;margin:0 auto;padding:0 18px;}

.hero{background:linear-gradient(160deg,#1c3a4a 0%,#2c5f6d 45%,#3d7a6e 100%);
  color:#fff;padding:50px 18px 42px;margin-bottom:32px;position:relative;overflow:hidden;}
.hero::after{content:"";position:absolute;right:-60px;bottom:-70px;width:280px;height:280px;
  border-radius:50%;background:radial-gradient(circle,rgba(255,255,255,.10),transparent 70%);}
.hero .wrap{position:relative;z-index:2;}
.hero .kicker{font-size:12.5px;letter-spacing:3px;color:#9fd8c8;margin-bottom:12px;font-weight:600;}
.hero h1{font-size:30px;line-height:1.35;font-weight:800;letter-spacing:-.5px;margin-bottom:14px;}
.hero h1 em{font-style:normal;color:#ffd98a;}
.hero .sub{font-size:14.5px;color:#c9ddd8;max-width:680px;line-height:1.8;}
.hero .tags{margin-top:20px;display:flex;flex-wrap:wrap;gap:8px;}
.hero .tags span{background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.22);
  padding:4px 12px;border-radius:20px;font-size:12.5px;color:#e8f3ef;}

section{margin-bottom:38px;}
h2{font-size:20px;font-weight:800;letter-spacing:-.3px;padding-left:13px;
  border-left:4px solid var(--accent);margin-bottom:18px;line-height:1.3;}
h2 .en{font-size:12px;color:var(--ink3);font-weight:500;letter-spacing:1px;margin-left:8px;}
h3{font-size:16px;font-weight:700;margin:22px 0 10px;}
p{color:var(--ink2);margin-bottom:10px;}
strong{color:var(--ink);font-weight:700;}
em{font-style:normal;background:linear-gradient(transparent 62%,#ffe08a 62%);padding:0 1px;}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 15px;text-align:center;}
.stat .num{font-size:23px;font-weight:800;color:var(--accent);line-height:1.2;}
.stat .num small{font-size:12px;font-weight:600;color:var(--ink3);margin-left:2px;}
.stat .lbl{font-size:12.5px;color:var(--ink3);margin-top:5px;}

.route-strip{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 18px;margin-bottom:26px;}
.route-flow{display:flex;flex-wrap:wrap;align-items:center;gap:6px 4px;font-size:13.5px;}
.route-flow .node{background:var(--soft);border:1px solid var(--line);border-radius:7px;
  padding:5px 10px;font-weight:600;color:var(--ink);white-space:nowrap;}
.route-flow .node.hi{background:#fdf3f2;border-color:#f0cfc9;color:var(--accent);}
.route-flow .arw{color:var(--accent2);font-weight:700;font-size:13px;}

.map-card{position:relative;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:10px;}
.map-card img{display:block;width:100%;height:auto;border-radius:9px;}
.map-legend{position:absolute;right:18px;bottom:18px;display:flex;flex-wrap:wrap;align-items:center;
  gap:3px 9px;max-width:60%;background:rgba(255,255,255,.93);border:1px solid var(--line);
  border-radius:9px;padding:6px 10px;font-size:12px;color:var(--ink2);
  box-shadow:0 2px 10px rgba(20,40,60,.18);}
.map-legend__item{display:inline-flex;align-items:center;gap:4px;font-weight:600;white-space:nowrap;}
.map-legend__item i{display:inline-block;width:11px;height:11px;border-radius:3px;flex:0 0 auto;}

.day{background:var(--card);border:1px solid var(--line);border-radius:14px;margin-bottom:16px;overflow:hidden;}
.day-head{display:flex;align-items:center;gap:14px;padding:15px 18px;background:var(--soft);border-bottom:1px solid var(--line);}
.day-badge{flex:0 0 auto;min-width:56px;height:56px;border-radius:11px;
  background:linear-gradient(150deg,#2c5f6d,#3d7a6e);color:#fff;
  display:flex;flex-direction:column;align-items:center;justify-content:center;font-weight:800;line-height:1;padding:0 6px;}
.day-badge b{font-size:16px;}
.day-badge span{font-size:9px;letter-spacing:.5px;opacity:.85;font-weight:600;margin-top:3px;}
.day-head .t{flex:1;}
.day-head .t h4{font-size:15.5px;font-weight:800;line-height:1.4;}
.day-head .t .meta{font-size:12.5px;color:var(--ink3);margin-top:3px;}
.day-body{padding:15px 18px 16px;}

.kv{display:flex;gap:9px;margin-bottom:8px;font-size:13.5px;}
.kv .k{flex:0 0 auto;color:#fff;background:var(--accent2);font-size:11px;font-weight:700;
  border-radius:5px;padding:2px 7px;height:fit-content;margin-top:3px;}
.kv .k.high{background:var(--accent);}
.kv .k.gold{background:var(--gold);}
.kv .v{color:var(--ink2);flex:1;}

.note{background:#fbf7ec;border-left:3px solid var(--gold);border-radius:0 8px 8px 0;
  padding:9px 13px;margin-top:10px;font-size:13px;color:#6b5a2e;}
.note b{color:#8a6d1f;}

.tbl-scroll{overflow-x:auto;margin:12px 0;border:1px solid var(--line);border-radius:11px;}
table{border-collapse:collapse;width:100%;min-width:560px;font-size:13.5px;background:var(--card);}
th{background:#eef2f1;font-weight:700;text-align:left;padding:10px 13px;
  border-bottom:1px solid var(--line);white-space:nowrap;font-size:12.5px;}
td{padding:10px 13px;border-bottom:1px solid #f0ece4;color:var(--ink2);vertical-align:top;}
tr:last-child td{border-bottom:none;}
tr:nth-child(even) td{background:#fdfcfa;}
td b{color:var(--ink);}
.red{color:var(--accent);font-weight:700;}
.teal{color:var(--accent2);font-weight:700;}

/* ---------- 海拔 >4000 m 标记（紫 ▲） ---------- */
.alt4k{color:#fff !important;background:#8e44ad;font-weight:800;border-radius:5px;
  padding:2px 7px;white-space:nowrap;}
.alt4k::before{content:"▲ ";font-size:10px;}
.alt4k-inline{color:#fff;background:#8e44ad;font-weight:800;border-radius:4px;padding:0 5px;
  font-size:12.5px;white-space:nowrap;}
.alt4k-inline::before{content:"▲ ";font-size:10px;}

.legend{display:flex;flex-wrap:wrap;align-items:center;gap:14px;font-size:12px;color:var(--ink3);margin-top:10px;}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;}
.legend .d1{background:var(--accent);}
.legend .d2{background:var(--gold);}
.legend .d3{background:var(--accent2);}
/* 天数配色：用短横条表示「一段导航路线」，与圆点（节点类型）区分开 */
.legend__days{display:inline-flex;flex-wrap:wrap;align-items:center;gap:12px;
  padding-left:14px;border-left:1px solid var(--line);}
.legend__days i{width:14px;height:4px;border-radius:2px;}

/* ---------- 时间轴 ---------- */
.tl{list-style:none;margin:4px 0 0;padding:0;}
.tl li{position:relative;padding:0 0 0 74px;margin-bottom:14px;}
.tl li::before{content:"";position:absolute;left:66px;top:6px;bottom:-14px;width:2px;background:#e6e1d8;}
.tl li:last-child::before{display:none;}
.tl li::after{content:"";position:absolute;left:62px;top:5px;width:10px;height:10px;
  border-radius:50%;background:var(--accent2);border:2px solid #fff;box-shadow:0 0 0 1px #cfe5e2;}
.tl li.drive::after{background:#d97706;box-shadow:0 0 0 1px #f7dfb8;}
.tl li.drive .tm{color:#b45309;}
.tl li.drive .stop{color:#92400e;}
.tl li.drive .stop::before{content:"🚗";margin-right:5px;font-size:12px;}
.tl li.drive .stay{background:#fdf3e3;color:#92400e;border-color:#f0dcb4;}
.tl li.drive::before{background:#f5e3c8;}
.tl .tm{position:absolute;left:0;top:0;width:62px;text-align:right;
  font-size:12px;font-weight:700;color:var(--accent2);letter-spacing:.2px;padding-top:2px;}
.tl .stop{font-size:14px;font-weight:700;color:var(--ink);line-height:1.5;}
.tl .stay{display:inline-block;background:#eef6f5;color:var(--accent2);border:1px solid #cfe5e2;
  font-size:11px;font-weight:700;border-radius:5px;padding:1px 7px;margin-left:7px;vertical-align:1px;white-space:nowrap;}
.tl .stay.red{background:#fdf2f1;color:var(--accent);border-color:#f2d4d0;}
.tl .stay.gold{background:#fbf7ec;color:#8a6d1f;border-color:#eddfb8;}
.tl .ds{font-size:13px;color:var(--ink2);margin-top:3px;line-height:1.7;}
.tl li.has-leg{padding-bottom:2px;}
.tl .leg{display:inline-flex;align-items:center;gap:5px;margin:8px 0 2px;
  background:#eef2f1;color:#2c5f6d;border:1px dashed #b9cfcd;border-radius:20px;
  font-size:11px;font-weight:800;padding:2px 10px 2px 8px;white-space:nowrap;line-height:1.5;}
.tl .leg::before{content:"↓";font-size:10px;color:#7f9a98;}
.tl .leg .arw{color:#8fa3a2;font-weight:700;margin:0 3px;}
.tl li.drive .leg{background:#fdf3e3;color:#b45309;border-color:#eecfa0;}
.tl li.drive .leg::before{color:#d9a55f;}
.tl li.drive .leg .arw{color:#d9a55f;}

/* ---------- 景点攻略 & 注意事项 ---------- */
.spot{margin-top:16px;border:1px solid #e3dccf;border-radius:11px;overflow:hidden;background:#fdfcf9;}
.spot-head{background:linear-gradient(90deg,#f6f1e6,#fbf8f2);padding:9px 14px;font-size:13px;font-weight:800;
  color:#6b5a2e;border-bottom:1px solid #ece4d4;display:flex;align-items:center;gap:7px;}
.spot-head .zh{font-size:14px;}
.spot-item{padding:11px 14px;border-bottom:1px dashed #ece4d4;}
.spot-item:last-child{border-bottom:none;}
.spot-item .name{font-size:13.5px;font-weight:800;color:var(--ink);margin-bottom:3px;}
.spot-item .name .tick{color:var(--accent2);font-weight:700;font-size:12px;margin-left:6px;}
.spot-item .desc{font-size:13px;color:var(--ink2);line-height:1.72;}
.spot-item .warn{display:block;margin-top:5px;font-size:12.5px;color:#9a3b32;background:#fdf3f2;
  border-left:3px solid #e2b3ab;border-radius:0 6px 6px 0;padding:5px 9px;line-height:1.65;}
.spot-item .warn::before{content:"⚠ ";font-weight:800;}
.spot-item .good{display:block;margin-top:5px;font-size:12.5px;color:#255a56;background:#eef6f5;
  border-left:3px solid #a9d4d0;border-radius:0 6px 6px 0;padding:5px 9px;line-height:1.65;}
.spot-item .good::before{content:"💡 ";}

footer{text-align:center;color:var(--ink3);font-size:12px;margin-top:50px;
  padding-top:22px;border-top:1px solid var(--line);line-height:2;}
@media (max-width:560px){.hero h1{font-size:23px;}.hero{padding:36px 14px 32px;}h2{font-size:18px;}body{font-size:14.5px;}}
@media print{body{background:#fff;}
  .hero{background:#2c5f6d !important;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
  .day,.route-strip,.map-card,.stat{break-inside:avoid;}.tbl-scroll{overflow:visible;}}`
