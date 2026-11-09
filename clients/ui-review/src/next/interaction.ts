export function areaFromPoints(start, end, viewport) {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.max(1, Math.abs(end.x - start.x)), height: Math.max(1, Math.abs(end.y - start.y)), viewport };
}
export function escapeAction(tool, open) { return tool ? "cancel-tool" : open ? "hide-panel" : "open-panel"; }
export function locationAction(target, route) { return target?.route && target.route !== route ? "open-location" : "show"; }
export function suggestion(before, after) { return { before: String(before || ""), after: String(after || "") }; }

export function clampDockPosition(position, size, viewport) {
  const bound = (value, maximum) => Math.max(8, Math.min(Number.isFinite(value) ? value : 18, Math.max(8, maximum - 8)));
  return { right: bound(position.right, viewport.width - size.width), bottom: bound(position.bottom, viewport.height - size.height) };
}
