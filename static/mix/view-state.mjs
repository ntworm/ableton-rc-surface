export function resolveHistoryView(historyState, fallback = { kind: "tracks" }) {
  const view = historyState && historyState.v;
  if (!view || typeof view.kind !== "string") return { kind: "tracks" };
  if (view.kind === "track" && typeof view.trackId === "string") return { kind: "track", trackId: view.trackId };
  if (view.kind === "device" && typeof view.trackId === "string" && typeof view.deviceId === "string") {
    return { kind: "device", trackId: view.trackId, deviceId: view.deviceId };
  }
  if (view.kind === "tracks" || view.kind === "loading" || view.kind === "error") return { kind: view.kind };
  return fallback && fallback.kind ? fallback : { kind: "tracks" };
}

function deviceIndexFromId(id) {
  const raw = String(id || "").split(":dev:")[1];
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function deviceListItems(perDevice) {
  if (!perDevice || typeof perDevice.entries !== "function") return [];
  const out = [];
  for (const [id, perParam] of perDevice.entries()) {
    if (!perParam || perParam.size === 0) continue;
    const first = perParam.values().next().value;
    const index = deviceIndexFromId(id);
    out.push({
      id,
      index,
      name: first && first.deviceName ? first.deviceName : `Device ${index + 1}`,
      paramCount: perParam.size,
    });
  }
  out.sort((a, b) => a.index - b.index);
  return out;
}

export function deviceListSignature(perDevice) {
  return deviceListItems(perDevice)
    .map((item) => `${item.id}:${item.name}:${item.paramCount}`)
    .join("|");
}

export function shortFilterChoiceLabel(label) {
  const text = String(label || "").trim();
  const lower = text.toLowerCase();
  const dbMatch = text.match(/(\d{1,2})\s*dB/i);
  const slope = dbMatch ? dbMatch[1] : "";
  if (lower.includes("low")) return `LP${slope}`;
  if (lower.includes("high")) return `HP${slope}`;
  if (lower.includes("band")) return `BP${slope}`;
  if (lower.includes("notch")) return "NOTCH";
  if (lower.includes("res")) return "RSV";
  if (lower.includes("vocal")) return "VOCAL";
  if (lower.includes("crush")) return "CRUSH";
  if (lower.includes("clean")) return "CLEAN";
  if (lower.includes("dj")) return "DJ";
  if (lower.includes("moog")) return "MOOG";
  return text.length > 10 ? text.slice(0, 10).toUpperCase() : text.toUpperCase();
}
