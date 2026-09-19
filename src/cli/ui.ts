/**
 * CLI 界面：彩色日志与分集下载进度块。
 * 多集并行时每集占一行原地刷新；输出日志前先擦除进度块，日志后再恢复，互不踩踏。
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

/** 单集进度行：速度用 EMA 平滑，避免抖动 */
class EpisodeLineState {
  label: string;
  total: number;
  done = 0;
  bytes = 0;
  #lastBytes = 0;
  #lastAt = Date.now();
  speedEma = 0;
  lastDraw = 0;
  lastPrint = 0;

  constructor(label: string, total: number) {
    this.label = label;
    this.total = total;
  }

  /** 返回 true 表示自上次以来速度窗口已刷新 */
  sampleSpeed(): boolean {
    const now = Date.now();
    const dt = (now - this.#lastAt) / 1000;
    if (dt < 0.5) return false;
    const speed = (this.bytes - this.#lastBytes) / dt;
    this.speedEma = this.speedEma === 0 ? speed : this.speedEma * 0.7 + speed * 0.3;
    this.#lastBytes = this.bytes;
    this.#lastAt = now;
    return true;
  }

  text(): string {
    const pct = this.total > 0 ? Math.floor((this.done / this.total) * 100) : 0;
    const speed = this.speedEma;
    const avgPerSeg = this.done > 0 ? this.bytes / this.done : 0;
    const eta = speed > 1 ? ((this.total - this.done) * avgPerSeg) / speed : Number.NaN;
    return (
      `${this.label} ${color('36', renderBar(this.done, this.total))} ` +
      `${this.done}/${this.total} ${pct}% ${formatBytes(this.bytes)} ` +
      `${formatBytes(speed)}/s ETA ${formatDuration(eta)}`
    );
  }
}

/**
 * 分集进度块：每集一行，插入顺序即开始顺序。
 * TTY 下整块原地刷新；非 TTY 下退化为周期性单行日志。
 */
export class MultiEpisodeProgressRenderer {
  #lines = new Map<number, EpisodeLineState>();
  /** 当前已在终端上占用的行数（光标停在块下方） */
  #rows = 0;
  #lastRender = 0;
  #active = true;

  begin(nid: number, label: string, total: number): void {
    this.#lines.set(nid, new EpisodeLineState(label, total));
    if (!isTTY) {
      process.stderr.write(`${label} 开始下载（共 ${total} 个分片）\n`);
      return;
    }
    this.#render(true);
  }

  update(nid: number, progress: SegmentProgress): void {
    const line = this.#lines.get(nid);
    if (!line || !this.#active) return;
    line.done = progress.done;
    line.bytes = progress.bytes;
    if (!isTTY) {
      line.sampleSpeed();
      const now = Date.now();
      if (progress.done >= progress.total || now - line.lastPrint >= 5000) {
        line.lastPrint = now;
        process.stderr.write(`${line.text()}\n`);
      }
      return;
    }
    line.sampleSpeed();
    const final = progress.done >= progress.total;
    const now = Date.now();
    if (!final && now - this.#lastRender < 100) return;
    this.#render(final);
  }

  /** 擦除该集所在行（完成/失败后由调用方输出日志，再 draw() 恢复其余行） */
  remove(nid: number): void {
    if (!this.#lines.delete(nid)) return;
    if (!isTTY) return;
    this.#render(true);
  }

  /** 日志输出前调用：把进度块整个擦掉，光标停在块首行 */
  clear(): void {
    if (!isTTY || this.#rows === 0) return;
    this.#eraseBlock();
  }

  /** 日志输出后调用：恢复进度块 */
  draw(): void {
    if (!isTTY || !this.#active) return;
    this.#render(true);
  }

  finish(): void {
    if (!this.#active) return;
    this.#active = false;
    if (isTTY) this.#eraseBlock();
  }

  #eraseBlock(): void {
    if (this.#rows === 0) return;
    process.stderr.write(`\x1b[${this.#rows}A`);
    for (let i = 0; i < this.#rows; i++) {
      const last = i === this.#rows - 1;
      process.stderr.write(`\x1b[1G\x1b[K${last ? '' : '\n'}`);
    }
    this.#rows = 0;
  }

  #render(force: boolean): void {
    if (!this.#active) return;
    const now = Date.now();
    if (!force && now - this.#lastRender < 100) return;
    this.#lastRender = now;

    const lines = [...this.#lines.values()];
    if (this.#rows > 0) {
      process.stderr.write(`\x1b[${this.#rows}A`);
    }
    for (const line of lines) {
      process.stderr.write(`\x1b[1G\x1b[K${line.text()}\n`);
    }
    if (this.#rows > lines.length) {
      // 块缩小后残留的空行清掉，光标停在块下一行
      process.stderr.write('\x1b[0J');
    }
    this.#rows = lines.length;
  }
}
