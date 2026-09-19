/**
 * CLI 界面：彩色日志与单行分片下载进度条。
 */
import type { SegmentProgress } from '../hls/downloader.js';

const isTTY = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

function color(code: string, text: string): string {
  return isTTY ? `\x1b[${code}m${text}\x1b[0m` : text;
}

export interface Logger {
  info(msg: string): void;
  success(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(): Logger {
  return {
    info: (msg) => process.stderr.write(`${msg}\n`),
    success: (msg) => process.stderr.write(`${color('32', '✓')} ${msg}\n`),
    warn: (msg) => process.stderr.write(`${color('33', '!')} ${msg}\n`),
    error: (msg) => process.stderr.write(`${color('31', '✗')} ${color('31', msg)}\n`),
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderBar(done: number, total: number, width = 20): string {
  const filled = total > 0 ? Math.round((done / total) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

/** 单集下载进度渲染：单行原地刷新 */
export class EpisodeProgressRenderer {
  #label: string;
  #lastBytes = 0;
  #lastAt = Date.now();
  #speedEma = 0;
  #lastDraw = 0;
  #active = true;

  constructor(label: string, _total: number) {
    this.#label = label;
  }

  update(progress: SegmentProgress): void {
    const now = Date.now();
    const dt = (now - this.#lastAt) / 1000;
    if (dt >= 0.5) {
      const speed = (progress.bytes - this.#lastBytes) / dt;
      this.#speedEma = this.#speedEma === 0 ? speed : this.#speedEma * 0.7 + speed * 0.3;
      this.#lastBytes = progress.bytes;
      this.#lastAt = now;
    }
    if (now - this.#lastDraw < 100 && progress.done < progress.total) return;
    this.#lastDraw = now;
    this.draw(progress.done, progress.total, progress.bytes);
  }

  private draw(done: number, total: number, bytes: number): void {
    if (!this.#active) return;
    const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
    const speed = this.#speedEma;
    const avgPerSeg = done > 0 ? bytes / done : 0;
    const eta = speed > 1 ? ((total - done) * avgPerSeg) / speed : Number.NaN;
    const line =
      `${this.#label} ${color('36', renderBar(done, total))} ` +
      `${done}/${total} ${pct}% ${formatBytes(bytes)} ` +
      `${formatBytes(speed)}/s ETA ${formatDuration(eta)}`;
    const clear = isTTY ? '\x1b[1G\x1b[K' : '\r';
    process.stderr.write(`${clear}${line}`);
  }

  finish(): void {
    if (!this.#active) return;
    this.#active = false;
    process.stderr.write('\n');
  }
}
