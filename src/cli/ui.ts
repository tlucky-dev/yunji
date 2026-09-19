/**
 * CLI 界面：彩色日志与分集下载进度块。
 * 多集并行时每集占一行原地刷新；输出日志前先擦除进度块，日志后再恢复，互不踩踏。
 */
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';
import type { SegmentProgress } from '../hls/downloader.js';

const isTTY = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;

// Windows 遗留控制台的两个坑（实测踩过）：
// ① 快速编辑模式：控制台进入文本选择状态（单击窗口即触发）时，向控制台写入会阻塞
//    调用线程，进度渲染一写就冻结整个进程；
// ② 绕过 TTY 直接对控制台句柄写字节（fs.createWriteStream(fd:2)）不做 UTF-16 转换，
//    中文与 ANSI 序列全部乱码。
// 解法：TTY 下转交给专职渲染子进程（它持有真正的 TTY stderr，编码与 ANSI 都正确），
// 主进程只写管道——异步、带缓冲，选择状态只会让子进程排队，下载主流程不受影响。
let ttySink: Writable | null = null;
if (isTTY) {
  try {
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stderr)'],
      { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true },
    );
    child.unref();
    child.on('error', () => {
      ttySink = null;
    });
    child.stdin!.on('error', () => {
      // 子进程意外退出时降级为直写，避免 EPIPE 崩溃
      ttySink = null;
    });
    ttySink = child.stdin!;
  } catch {
    ttySink = null;
  }
}

/** stderr 统一出口；控制台场景经渲染子进程异步写入 */
export function writeErr(text: string): void {
  if (ttySink) {
    ttySink.write(text);
    return;
  }
  process.stderr.write(text);
}

/** 进程正常结束前收口：刷出缓冲并关闭渲染子进程的输入 */
export function closeErr(): void {
  try {
    if (ttySink && !ttySink.writableEnded) ttySink.end();
  } catch {
    // 已关闭则忽略
  }
}

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
    info: (msg) => writeErr(`${msg}\n`),
    success: (msg) => writeErr(`${color('32', '✓')} ${msg}\n`),
    warn: (msg) => writeErr(`${color('33', '!')} ${msg}\n`),
    error: (msg) => writeErr(`${color('31', '✗')} ${color('31', msg)}\n`),
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
export type ErrWriter = (text: string) => void;

export class MultiEpisodeProgressRenderer {
  #lines = new Map<number, EpisodeLineState>();
  /** 当前已在终端上占用的行数（光标停在块下方） */
  #rows = 0;
  #lastRender = 0;
  #active = true;
  #write: ErrWriter;
  #tty: boolean;

  /** write/tty 可注入用于测试；默认写 stderr 并按运行环境判定 TTY */
  constructor(opts: { write?: ErrWriter; tty?: boolean } = {}) {
    this.#write = opts.write ?? writeErr;
    this.#tty = opts.tty ?? isTTY;
  }

  begin(nid: number, label: string, total: number): void {
    this.#lines.set(nid, new EpisodeLineState(label, total));
    if (!this.#tty) {
      this.#write(`${label} 开始下载（共 ${total} 个分片）\n`);
      return;
    }
    this.#render(true);
  }

  update(nid: number, progress: SegmentProgress): void {
    const line = this.#lines.get(nid);
    if (!line || !this.#active) return;
    line.done = progress.done;
    line.bytes = progress.bytes;
    if (!this.#tty) {
      line.sampleSpeed();
      const now = Date.now();
      if (progress.done >= progress.total || now - line.lastPrint >= 5000) {
        line.lastPrint = now;
        this.#write(`${line.text()}\n`);
      }
      return;
    }
    line.sampleSpeed();
    const final = progress.done >= progress.total;
    const now = Date.now();
    if (!final && now - this.#lastRender < 100) return;
    this.#render(final);
  }

  /**
   * 该集完成/失败：从块中移除并擦掉整块。只擦不画——
   * 调用方随后输出的日志落在擦净的位置，draw() 再把剩余行画到日志下方；
   * 若在此处重画，日志行会被后续重画覆盖（v1.3.2 实测踩坑）。
   */
  remove(nid: number): void {
    if (!this.#lines.delete(nid)) return;
    if (!this.#tty) return;
    this.#eraseBlock();
  }

  /** 日志输出后调用：在当前光标处恢复进度块 */
  draw(): void {
    if (!this.#tty || !this.#active) return;
    this.#render(true);
  }

  finish(): void {
    if (!this.#active) return;
    this.#active = false;
    if (this.#tty) this.#eraseBlock();
  }

  #eraseBlock(): void {
    if (this.#rows === 0) return;
    // 光标回到块首并从那里清到屏幕末尾：日志与重画将从块首无缝填充。
    // 若只清行而把光标留在块底，日志上方的被清行没人填，每合并一集会留 (并发数-1) 个空行。
    this.#write(`\x1b[${this.#rows}A`);
    this.#write('\x1b[J');
    this.#rows = 0;
  }

  #render(force: boolean): void {
    if (!this.#active) return;
    const now = Date.now();
    if (!force && now - this.#lastRender < 100) return;
    this.#lastRender = now;

    const lines = [...this.#lines.values()];
    if (this.#rows > 0) {
      this.#write(`\x1b[${this.#rows}A`);
    }
    for (const line of lines) {
      this.#write(`\x1b[1G\x1b[K${line.text()}\n`);
    }
    if (this.#rows > lines.length) {
      // 块缩小后残留的空行清掉，光标停在块下一行
      this.#write('\x1b[0J');
    }
    this.#rows = lines.length;
  }
}
