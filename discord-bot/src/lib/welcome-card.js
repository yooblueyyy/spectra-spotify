// Draws the welcome image: avatar in a ring on Spectra's violet → teal card.
import { createCanvas, loadImage } from "@napi-rs/canvas";

const W = 1024, H = 340;
const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shrink text until it fits. */
function fit(ctx, text, max, size, weight) {
  let s = size;
  do { ctx.font = `${weight} ${s}px ${FONT}`; s -= 2; } while (ctx.measureText(text).width > max && s > 20);
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}

/**
 * @param {{ avatarUrl: string, displayName: string, serverName: string, memberCount: number }} o
 * @returns {Promise<Buffer>} PNG
 */
export async function welcomeCard({ avatarUrl, displayName, serverName, memberCount }) {
  const c = createCanvas(W, H);
  const ctx = c.getContext("2d");

  // Card: the icon's diagonal violet → teal gradient with a soft highlight.
  roundRect(ctx, 0, 0, W, H, 36);
  ctx.save();
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#8b5cf6");
  g.addColorStop(1, "#22d3a6");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const hl = ctx.createRadialGradient(W * 0.2, H * 0.1, 10, W * 0.2, H * 0.1, W * 0.6);
  hl.addColorStop(0, "rgba(255,255,255,0.22)");
  hl.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = hl;
  ctx.fillRect(0, 0, W, H);

  // Spectra's equalizer bars, faint, on the right.
  const bars = [0.38, 0.62, 0.86, 0.55, 0.3];
  ctx.fillStyle = "rgba(255,255,255,0.14)";
  bars.forEach((b, i) => {
    const bw = 34, gap = 22, x = W - 300 + i * (bw + gap), bh = b * (H - 70);
    roundRect(ctx, x, (H - bh) / 2, bw, bh, bw / 2);
    ctx.fill();
  });
  ctx.restore();

  // Avatar with a white ring.
  const cx = 175, cy = H / 2, r = 112;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 9, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  try {
    const img = await loadImage(avatarUrl);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
    ctx.restore();
  } catch {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#2b2140";
    ctx.fill();
  }

  // Text
  const x = 330, maxW = W - x - 60;
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.font = `600 34px ${FONT}`;
  ctx.fillText("Welcome", x, 118);
  ctx.fillStyle = "#ffffff";
  ctx.shadowColor = "rgba(30,10,60,0.35)";
  ctx.shadowBlur = 12;
  const name = fit(ctx, displayName, maxW, 66, 800);
  ctx.fillText(name, x, 192);
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.font = `600 32px ${FONT}`;
  ctx.fillText(`to ${serverName}!`, x, 244);
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = `500 26px ${FONT}`;
  ctx.fillText(`Member #${memberCount}`, x, 286);

  return c.encode("png");
}
