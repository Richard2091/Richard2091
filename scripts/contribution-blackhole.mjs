#!/usr/bin/env node
// 贡献黑洞：把一年的 GitHub 贡献格子画成 SVG，中间出现像素风黑洞，
// 格子一边旋转一边被吸进去，吸完再按列重新出现，循环播放。
// 纯 CSS 动画，可直接放进 README（GitHub 以 <img> 渲染 SVG，不执行脚本）。
//
// 用法：
//   GITHUB_TOKEN=xxx node scripts/contribution-blackhole.mjs <用户名> [输出目录]
//   node scripts/contribution-blackhole.mjs --from-json calendar.json [输出目录]
// 输出：<输出目录>/github-contribution-blackhole.svg 与 -dark.svg

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// ---------- 参数 ----------
const CELL = 11; // 格子边长
const STEP = 14; // 格子间距（含空隙）
const PAD_X = 24;
const GRID_TOP = 56;
const ROWS = 7;
const PIX = 4; // 黑洞像素块大小
const R_HORIZON = 20; // 事件视界半径
const R_RING = 25; // 光子环外沿
const R_DISK = 52; // 吸积盘外沿

const T = 15; // 循环总时长（秒）
const BH_IN = [2.4, 3.3]; // 黑洞出现
const SUCK_START = 3.2; // 最近一圈开始被吸
const SUCK_SPREAD = 4.6; // 最远一圈比最近一圈晚多少秒
const SUCK_DUR = 2.2; // 单个格子被吸入的时长
const HIDE_AT = 10.1; // 全部吸完后隐藏格子
const BH_OUT = [10.2, 11.0]; // 黑洞消失
const RESET_AT = 10.4; // 被吸格子回到原位（此时不可见）
const REAPPEAR = [11.0, 1.8, 0.5]; // 重新出现：开始时间、从首列到末列的跨度、单列时长
const SUCK_BUCKETS = 28;

const THEMES = {
  light: {
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    text: "#57606a",
    horizon: "#0d1117",
  },
  dark: {
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    text: "#8b949e",
    horizon: "#000000",
  },
};

const LEVEL_INDEX = {
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
};

// ---------- 数据 ----------
const QUERY = `query($login: String!) {
  user(login: $login) {
    contributionsCollection {
      contributionCalendar {
        totalContributions
        weeks { contributionDays { date weekday contributionCount contributionLevel } }
      }
    }
  }
}`;

async function fetchCalendar(login, token) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "contribution-blackhole",
    },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL 请求失败：${res.status} ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GitHub GraphQL 返回错误：${JSON.stringify(json.errors)}`);
  return pickCalendar(json);
}

function pickCalendar(json) {
  const cal = json?.data?.user?.contributionsCollection?.contributionCalendar;
  if (!cal) throw new Error("数据里没有 contributionCalendar，检查用户名或 JSON 文件");
  return cal;
}

// ---------- 工具 ----------
const pct = (t) => `${((t / T) * 100).toFixed(3)}%`;
const r1 = (n) => Math.round(n * 10) / 10;

// 确定性伪随机，保证每次生成的黑洞图案一致
function hash(i, j) {
  let h = (i * 374761393 + j * 668265263) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function lerpColor(a, b, t) {
  const pa = a.match(/\w\w/g).map((x) => parseInt(x, 16));
  const pb = b.match(/\w\w/g).map((x) => parseInt(x, 16));
  return (
    "#" +
    pa
      .map((v, k) => Math.round(v + (pb[k] - v) * t).toString(16).padStart(2, "0"))
      .join("")
  );
}

// 吸积盘配色：内圈白热 → 橙 → 品红 → 紫，外圈逐渐稀疏
const DISK_STOPS = ["#fff4c2", "#ffb347", "#ff6b35", "#e83f6f", "#9b4dca", "#5b3a8c"];
function diskColor(t) {
  const x = Math.min(Math.max(t, 0), 0.999) * (DISK_STOPS.length - 1);
  const k = Math.floor(x);
  return lerpColor(DISK_STOPS[k], DISK_STOPS[k + 1], x - k);
}

// ---------- 黑洞像素 ----------
function blackHolePixels(theme) {
  const horizon = [];
  const ring = [];
  const disk = [];
  const dust = [];
  const n = Math.ceil(R_DISK / PIX) + 4;
  for (let i = -n; i < n; i++) {
    for (let j = -n; j < n; j++) {
      const x = i * PIX;
      const y = j * PIX;
      const r = Math.hypot(x + PIX / 2, y + PIX / 2);
      const a = Math.atan2(y + PIX / 2, x + PIX / 2);
      const rnd = hash(i, j);
      if (r < R_HORIZON) {
        horizon.push([x, y, theme.horizon]);
      } else if (r < R_RING) {
        ring.push([x, y, rnd < 0.5 ? "#fffbe6" : "#ffd166"]);
      } else if (r < R_DISK) {
        const t = (r - R_RING) / (R_DISK - R_RING);
        // 两条螺旋臂：臂上像素更亮更密，臂间稀疏
        const arm = Math.cos(2 * a - r * 0.22);
        const keep = arm > -0.2 ? 1 - t * 0.55 : 0.55 - t * 0.5;
        if (rnd < keep) {
          disk.push([x, y, diskColor(t + (arm > 0.5 ? -0.12 : 0.05))]);
        }
      } else if (r < R_DISK + 14 && rnd < 0.07) {
        dust.push([x, y, rnd < 0.035 ? "#c9a7ff" : "#ff9f6b"]);
      }
    }
  }
  const rects = (list) =>
    list.map(([x, y, c]) => `<rect x="${x}" y="${y}" width="${PIX}" height="${PIX}" fill="${c}"/>`).join("");
  return {
    horizon: rects(horizon),
    ring: rects(ring),
    disk: rects(disk),
    dust: rects(dust),
  };
}

// ---------- 主绘制 ----------
function render(calendar, themeName) {
  const theme = THEMES[themeName];
  const weeks = calendar.weeks;
  const cols = weeks.length;
  const gridW = cols * STEP - (STEP - CELL);
  const gridH = ROWS * STEP - (STEP - CELL);
  const width = gridW + PAD_X * 2;
  const height = GRID_TOP + gridH + 56;
  // 取整：黑洞像素落在整像素上，避免抗锯齿造成的像素缝
  const cx = Math.round(PAD_X + gridW / 2);
  const cy = Math.round(GRID_TOP + gridH / 2);

  // 收集格子（相对黑洞中心的坐标）
  const cells = [];
  weeks.forEach((week, w) => {
    for (const day of week.contributionDays) {
      const x = PAD_X + w * STEP - cx;
      const y = GRID_TOP + day.weekday * STEP - cy;
      const level = LEVEL_INDEX[day.contributionLevel] ?? 0;
      cells.push({ x, y, col: w, level, dist: Math.hypot(x + CELL / 2, y + CELL / 2), day });
    }
  });
  const maxDist = Math.max(...cells.map((c) => c.dist));

  const css = [];

  // 被吸入：外层 g 以黑洞中心为原点，同时旋转 + 缩小，轨迹即一条向内收紧的螺旋。
  // 分两段：先收拢、只偏转一点（远处格子不会转出画布），再加速旋进中心。
  // 第一段收拢到半径约 IN_R 以内，保证转到竖直方向时也在画布里。
  const IN_R = 70;
  for (let k = 0; k < SUCK_BUCKETS; k++) {
    const f = k / (SUCK_BUCKETS - 1);
    const ts = SUCK_START + f * SUCK_SPREAD;
    const tm = ts + SUCK_DUR * 0.5;
    const te = ts + SUCK_DUR;
    const bucketDist = ((k + 1) / SUCK_BUCKETS) * maxDist;
    const s1 = Math.min(0.8, IN_R / bucketDist).toFixed(3);
    const spin = Math.round(380 + 260 * f);
    css.push(
      `@keyframes s${k}{0%,${pct(ts)}{transform:rotate(0deg) scale(1);animation-timing-function:cubic-bezier(.4,0,.8,.6)}` +
        `${pct(tm)}{transform:rotate(25deg) scale(${s1});animation-timing-function:cubic-bezier(.3,.1,.9,.5)}` +
        `${pct(te)},${pct(RESET_AT)}{transform:rotate(${spin}deg) scale(0)}` +
        `${pct(RESET_AT + 0.01)},100%{transform:rotate(0deg) scale(1)}}` +
        `.s${k}{animation:s${k} ${T}s linear infinite}`,
    );
  }

  // 重新出现：内层 rect 按列从左到右弹出
  for (let c = 0; c < cols; c++) {
    const [start, spread, dur] = REAPPEAR;
    const ts = start + (cols > 1 ? (c / (cols - 1)) * spread : 0);
    css.push(
      `@keyframes p${c}{0%,${pct(HIDE_AT)}{opacity:1;transform:scale(1)}` +
        `${pct(HIDE_AT + 0.05)},${pct(ts)}{opacity:0;transform:scale(0);animation-timing-function:ease-out}` +
        `${pct(ts + dur * 0.6)}{opacity:1;transform:scale(1.3)}` +
        `${pct(ts + dur)},100%{opacity:1;transform:scale(1)}}` +
        `.p${c}{animation:p${c} ${T}s linear infinite}`,
    );
  }

  // 黑洞本体：像素化地弹出，吞完后鼓一下再收缩消失
  css.push(
    `@keyframes bh{0%,${pct(BH_IN[0])}{opacity:0;transform:scale(0)}` +
      `${pct(BH_IN[0] + 0.05)}{opacity:1;transform:scale(0);animation-timing-function:steps(6,end)}` +
      `${pct(BH_IN[1])}{opacity:1;transform:scale(1.15);animation-timing-function:ease-out}` +
      `${pct(BH_IN[1] + 0.3)},${pct(BH_OUT[0])}{opacity:1;transform:scale(1)}` +
      `${pct(BH_OUT[0] + 0.25)}{opacity:1;transform:scale(1.25);animation-timing-function:steps(6,end)}` +
      `${pct(BH_OUT[1])}{opacity:1;transform:scale(0)}` +
      `${pct(BH_OUT[1] + 0.01)},100%{opacity:0;transform:scale(0)}}`,
    `@keyframes spin{to{transform:rotate(360deg)}}`,
    `@keyframes spinr{to{transform:rotate(-360deg)}}`,
    `@keyframes flick{0%,100%{opacity:1}50%{opacity:.55}}`,
    `.o{transform-box:view-box;transform-origin:0 0}`,
    `.c{transform-box:fill-box;transform-origin:center}`,
    `.bh{opacity:0;animation:bh ${T}s linear infinite}`,
    `.disk{animation:spin 2.4s steps(24) infinite}`,
    `.dust{animation:spinr 7s steps(36) infinite}`,
    `.ring{animation:flick .5s steps(1) infinite}`,
    `.t{font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;fill:${theme.text}}`,
    `@media (prefers-reduced-motion:reduce){*{animation:none!important}.bh{opacity:0}}`,
  );

  const bucketOf = (dist) => Math.min(SUCK_BUCKETS - 1, Math.floor((dist / maxDist) * SUCK_BUCKETS));
  const cellEls = cells
    .map((c) => {
      const title = `${c.day.date}：${c.day.contributionCount} 次贡献`;
      return (
        `<g class="o s${bucketOf(c.dist)}"><rect class="c p${c.col}" x="${r1(c.x)}" y="${r1(c.y)}" ` +
        `width="${CELL}" height="${CELL}" rx="2" fill="${theme.levels[c.level]}"><title>${title}</title></rect></g>`
      );
    })
    .join("");

  const px = blackHolePixels(theme);
  const total = calendar.totalContributions;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="贡献黑洞：过去一年 ${total} 次贡献">` +
    `<style>${css.join("")}</style>` +
    `<g transform="translate(${r1(cx)} ${r1(cy)})">` +
    cellEls +
    `<g class="o bh" shape-rendering="crispEdges">` +
    `<g class="o dust">${px.dust}</g>` +
    `<g class="o disk">${px.disk}</g>` +
    `<g class="ring">${px.ring}</g>` +
    `<g>${px.horizon}</g>` +
    `</g></g>` +
    `<text class="t" x="${PAD_X}" y="${height - 18}">过去一年 · ${total} 次贡献</text>` +
    `</svg>\n`
  );
}

// ---------- 入口 ----------
async function main() {
  const args = process.argv.slice(2);
  let calendar;
  let outDir;
  if (args[0] === "--from-json") {
    calendar = pickCalendar(JSON.parse(await readFile(args[1], "utf8")));
    outDir = args[2] ?? "dist";
  } else {
    const login = args[0] ?? process.env.GITHUB_USER;
    const token = process.env.GITHUB_TOKEN;
    if (!login || !token) throw new Error("需要用户名参数和 GITHUB_TOKEN 环境变量");
    calendar = await fetchCalendar(login, token);
    outDir = args[1] ?? "dist";
  }
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "github-contribution-blackhole.svg"), render(calendar, "light"));
  await writeFile(join(outDir, "github-contribution-blackhole-dark.svg"), render(calendar, "dark"));
  console.log(`已生成 ${outDir}/github-contribution-blackhole(-dark).svg，共 ${calendar.totalContributions} 次贡献`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
