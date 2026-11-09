export const pageStyle = `
html.ui-review-next-inspecting body,html.ui-review-next-inspecting body * { cursor:crosshair!important }
html.ui-review-next-inspecting body ui-review-next { cursor:default!important }
`;

export const icons = {
  annotate: [["path", { d: "M12 4v16M4 12h16" }], ["circle", { cx: "12", cy: "12", r: "7" }]],
  pause: [["path", { d: "M9 6v12M15 6v12" }]],
  advanced: [["rect", { x: "4", y: "4", width: "6", height: "6", rx: "1" }], ["rect", { x: "14", y: "4", width: "6", height: "6", rx: "1" }], ["rect", { x: "4", y: "14", width: "6", height: "6", rx: "1" }], ["path", { d: "M17 14v6M14 17h6" }]],
  markers: [["path", { d: "M3 12s3.5-5 9-5 9 5 9 5-3.5 5-9 5-9-5-9-5Z" }], ["circle", { cx: "12", cy: "12", r: "2.5" }]],
  notes: [["path", { d: "M5 5h14v11H9l-4 3V5Z" }], ["path", { d: "M8 9h8M8 12h6" }]],
  more: [["circle", { cx: "5", cy: "12", r: "1" }], ["circle", { cx: "12", cy: "12", r: "1" }], ["circle", { cx: "19", cy: "12", r: "1" }]],
  close: [["path", { d: "m7 7 10 10M17 7 7 17" }]],
};

export const css = `
:host { all:initial; color:#f7f8fa; font-family:Inter,ui-sans-serif,system-ui,sans-serif }
*,*::before,*::after { box-sizing:border-box }
button,input,textarea { font:inherit }
button { cursor:pointer }
.root { position:fixed; z-index:2147483646; inset:0; pointer-events:none; color:#f7f8fa; font-size:13px; line-height:1.35 }
.bar,.panel,.marker,.launcher,.context-card,.menu,.selection-hud { pointer-events:auto }
.launcher { position:fixed; right:18px; bottom:18px; width:48px; height:48px; display:grid; place-items:center; border:1px solid #3a404c; border-radius:50%; color:#fff; background:#181a1f; box-shadow:0 12px 32px rgba(9,12,20,.24); transition:transform 140ms ease-out,background 140ms ease-out }
.launcher:hover,.launcher:focus-visible { background:#262a32; transform:scale(1.04); outline:2px solid #7e8cf4; outline-offset:2px }
.launcher svg { width:22px; height:22px; fill:none; stroke:currentColor; stroke-width:1.8; stroke-linecap:round; stroke-linejoin:round }
.launcher .count { right:-2px; top:-2px }
.launcher,.drag-grip { touch-action:none; user-select:none }
.drag-grip { flex:0 0 16px; width:16px; min-height:44px; padding:0; border:0; border-radius:8px; color:#aeb6c6; background:transparent; cursor:grab; font-size:18px }
.drag-grip:active,.launcher:active { cursor:grabbing }
.drag-grip:focus-visible { outline:2px solid #7e8cf4; outline-offset:-1px }
.bar { position:fixed; right:18px; bottom:18px; min-height:48px; display:flex; gap:2px; align-items:center; padding:4px; background:#181a1f; border:1px solid #3a404c; border-radius:25px; box-shadow:0 12px 32px rgba(9,12,20,.24); animation:reveal 180ms cubic-bezier(.2,.8,.2,1) }
.icon { position:relative; flex:0 0 40px; width:40px; min-height:40px; display:grid; place-items:center; border:0; border-radius:10px; color:#cdd2dc; background:transparent; transition:background 140ms ease-out,color 140ms ease-out }
.icon svg { width:19px; height:19px; fill:none; stroke:currentColor; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round }
.icon:hover,.icon:focus-visible { color:#fff; background:#30343d; outline:2px solid #7e8cf4; outline-offset:1px }
.icon.active { color:#fff; background:#5264e9 }
.icon.danger:hover { background:#63343a }
.divider { width:1px; height:22px; background:#3a404c; margin:0 2px }
.icon::after { content:attr(data-tooltip); position:absolute; left:50%; bottom:calc(100% + 10px); transform:translate(-50%,3px); opacity:0; pointer-events:none; padding:5px 7px; border-radius:6px; color:#fff; background:#111318; box-shadow:0 5px 16px #0005; white-space:nowrap; font-size:11px; font-weight:650; transition:opacity 120ms ease-out,transform 120ms ease-out }
.icon:hover::after,.icon:focus-visible::after { opacity:1; transform:translate(-50%,0) }
.count { position:absolute; right:0; top:0; min-width:16px; height:16px; padding:0 4px; display:grid; place-items:center; border:2px solid #181a1f; border-radius:9px; color:#fff; background:#5264e9; font-size:9px; font-weight:800 }
.save-check { flex:0 0 8px; width:8px; height:8px; margin:0 4px; border-radius:50%; background:#74c991; opacity:.85 }
.save-check.saving { background:#ffd080; animation:pulse .8s ease-in-out infinite }
.offline { margin:0 6px; color:#ffd080; font-size:11px; font-weight:700 }
.menu { position:fixed; right:72px; bottom:74px; min-width:205px; padding:7px; display:grid; gap:3px; color:#f7f8fa; background:#181a1f; border:1px solid #3a404c; border-radius:14px; box-shadow:0 12px 32px rgba(9,12,20,.24); animation:reveal 160ms ease-out }
.menu button { min-height:44px; display:flex; align-items:center; justify-content:space-between; gap:12px; border:0; border-radius:9px; padding:8px 10px; color:#f7f8fa; background:transparent; text-align:left }
.menu button:hover,.menu button:focus-visible { background:#30343d; outline:2px solid #7e8cf4; outline-offset:-2px }
.menu small { color:#aeb6c6 }
.mobile-only { display:none!important }
.panel { position:fixed; right:18px; bottom:76px; width:min(344px,calc(100vw - 36px)); max-height:calc(var(--review-viewport-height,100vh) - 108px); display:flex; flex-direction:column; background:#181a1f; border:1px solid #3a404c; border-radius:16px; box-shadow:0 12px 32px rgba(9,12,20,.24); overflow:hidden; animation:reveal 180ms cubic-bezier(.2,.8,.2,1) }
.head { min-height:48px; display:flex; gap:8px; justify-content:space-between; align-items:center; padding:9px 8px 9px 14px; border-bottom:1px solid #343943 }
.head h2 { margin:0; font-size:14px; font-weight:750 }
.head .subtle { color:#aeb6c6; font-size:11px }
.hint,.notice { padding:9px 12px; color:#aeb6c6; border-bottom:1px solid #343943; font-size:12px }
.notice { color:#ffd080 }
.empty { padding:22px 16px; color:#aeb6c6; text-align:center }
.list { overflow:auto; min-height:0; max-height:48vh }
.row { display:grid; grid-template-columns:24px 1fr; gap:9px; padding:10px 12px; border-bottom:1px solid #30343d; background:#181a1f }
.row:hover,.row:focus-visible,.row.selected { background:#262a32; outline:none }
.number { width:22px; height:22px; display:grid; place-items:center; border-radius:50%; color:#fff; background:#5264e9; font-size:10px; font-weight:800 }
.body { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; overflow:hidden; color:#f7f8fa; overflow-wrap:anywhere }
.row.selected .body,.reply,.fix { display:block; -webkit-line-clamp:unset }
.state { margin-top:3px; color:#aeb6c6; font-size:10px; text-transform:capitalize }
.reply,.fix { margin-top:7px; padding:7px 8px; border-radius:8px; color:#dfe3eb; background:#20232a; font-size:11px }
.actions { display:flex; gap:6px; justify-content:flex-end; flex-wrap:wrap; margin-top:8px }
.actions button,.editor button,.selection-hud button { min-height:36px; border:0; border-radius:9px; padding:7px 10px; color:#dfe3eb; background:transparent; font-weight:650 }
.actions button:hover,.actions button:focus-visible,.editor button:hover,.editor button:focus-visible,.selection-hud button:hover,.selection-hud button:focus-visible { background:#343943; outline:2px solid #7e8cf4; outline-offset:1px }
.actions .primary,.editor .primary,.selection-hud .primary { color:#fff; background:#5264e9 }
.context-card { position:fixed; z-index:3; width:min(286px,calc(100vw - 24px)); max-height:min(500px,calc(var(--review-viewport-height,100vh) - 24px)); overflow:auto; color:#f7f8fa; background:#181a1f; border:1px solid #3a404c; border-radius:16px; box-shadow:0 12px 32px rgba(9,12,20,.28); animation:compose 160ms cubic-bezier(.2,.8,.2,1) }
.editor { display:grid; gap:9px; padding:12px }
.target-line { color:#aeb6c6; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.quote { padding:7px 8px; border-radius:8px; color:#dfe3eb; background:#262a32; font-size:11px; font-style:italic; overflow-wrap:anywhere }
.editor textarea,.editor input { width:100%; min-height:42px; padding:9px 10px; color:#fff; background:#20232a; border:1px solid #474e5d; border-radius:9px; outline:none }
.editor textarea { min-height:68px; resize:vertical }
.editor textarea:focus,.editor input:focus { border-color:#6d7cf1; box-shadow:0 0 0 2px #5264e933 }
.disclosure { justify-self:start!important; padding-left:0!important; color:#aeb6c6!important; font-size:11px }
.inline-text { position:fixed; z-index:4; pointer-events:auto; padding:0; margin:0; border:0; outline:2px solid #6d7cf1; outline-offset:2px; border-radius:2px; resize:none; overflow:auto; box-shadow:0 0 0 4px #5264e925; white-space:pre-wrap }
.inline-hint { color:#aeb6c6; font-size:11px }
.preview-switch { position:fixed; left:50%; top:12px; transform:translateX(-50%); display:flex; flex-wrap:wrap; justify-content:center; align-items:center; gap:4px; max-width:calc(100% - 24px); width:max-content; pointer-events:auto; padding:4px 8px; border:1px solid #3a404c; border-radius:12px; color:#dfe3eb; background:#181a1f; box-shadow:0 6px 20px #0003 }
.preview-switch > span:first-child { font-size:11px; margin-right:4px }
.preview-switch button { min-height:32px; padding:5px 9px; color:#dfe3eb; background:transparent; border:0; border-radius:7px }
.preview-switch button[aria-pressed=true],.actions button[aria-pressed=true] { background:#5264e9; color:white }
.preview-switch button:focus-visible { outline:2px solid #9ba7ff }
.text-comparison { display:grid; gap:5px; margin-top:8px; color:#dfe3eb; font-size:12px; white-space:pre-wrap; overflow-wrap:anywhere }
.preview-warning { color:#ffd080; font-size:11px; padding:4px 0 }
.marker { position:fixed; display:grid; place-items:center; min-width:24px; height:24px; padding:0 5px; margin:-12px 0 0 -12px; border:2px solid #fff; border-radius:13px; background:#5264e9; color:#fff; font:800 10px/1 ui-sans-serif; box-shadow:0 3px 10px #0007; transition:transform 140ms ease-out }
.marker:hover,.marker:focus-visible,.marker.highlight { transform:scale(1.12); outline:3px solid #9ba7ff; outline-offset:2px }
.marker.cluster { min-width:28px }
.target-ring,.area-preview,.hover-ring,.member-ring,.layout-ring { position:fixed; pointer-events:none; border:2px solid #6d7cf1; border-radius:7px; background:#5264e917; box-shadow:0 0 0 1px #fff8 }
.target-ring { animation:pulse .8s ease-in-out 2 }
.area-preview { border-style:dashed; border-color:#53b883; background:#53b8831c }
.member-ring { border-color:#53b883; background:#53b88312 }
.layout-ring.destination { border-style:dashed; border-color:#ffd080; background:#ffd08012 }
.hover-label { position:fixed; z-index:4; max-width:240px; padding:4px 7px; border-radius:6px; color:#fff; background:#111318eb; font-size:10px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; pointer-events:none }
.pointer-plus { position:fixed; z-index:5; width:22px; height:22px; display:grid; place-items:center; margin:-11px 0 0 -11px; border:2px solid #fff; border-radius:50%; color:#fff; background:#5264e9; box-shadow:0 2px 8px #0005; font:800 18px/16px ui-sans-serif; pointer-events:none }
.selection-hud { position:fixed; right:18px; bottom:76px; display:flex; align-items:center; gap:8px; padding:7px 9px; border:1px solid #3a404c; border-radius:13px; color:#f7f8fa; background:#181a1f; box-shadow:0 12px 32px rgba(9,12,20,.24) }
.selection-hud.hint-toast { pointer-events:none }
@keyframes reveal { from { opacity:0; transform:translateY(5px) } }
@keyframes compose { from { opacity:0; transform:translateY(4px) scale(.97) } }
@keyframes pulse { 50% { filter:brightness(1.4) } }
@media (max-width:600px) {
  .preview-switch button,.actions button { min-height:44px }
  .launcher,.bar { right:12px; bottom:12px }
  .bar { max-width:calc(100vw - 24px); gap:0; padding:2px }
  .drag-grip { flex-basis:44px; width:44px }
  .bar > .divider { display:none }
  .bar > .save-check { position:absolute; right:2px; bottom:2px; width:6px; height:6px; margin:0 }
  .bar > .offline { position:absolute; right:0; bottom:100%; padding:3px 6px; border-radius:5px; background:#181a1f }
  .icon { flex-basis:44px; width:44px; min-height:44px }
  .panel { right:0; bottom:66px; width:100%; max-width:none; max-height:min(72vh,calc(var(--review-viewport-height,100vh) - 78px)); border-radius:16px 16px 0 0 }
  .menu { right:12px; bottom:68px; width:min(250px,calc(100vw - 24px)) }
  .mobile-only { display:flex!important }
  .desktop-only { display:none!important }
  .context-card { left:12px!important; right:12px!important; bottom:68px; top:auto!important; width:auto }
  .selection-hud { right:12px; bottom:68px }
  .list { max-height:44vh }
  .pointer-plus,.hover-ring,.hover-label { display:none }
}
`;
