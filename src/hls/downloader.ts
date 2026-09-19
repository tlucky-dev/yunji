/**
 * 分片并发下载器：
 * 每个分片下载 → （按需）解密 → 原子写入 .parts 目录；
 * 已存在且非空的分片直接跳过，实现断点续传。
 */
import { createReadStream, createWriteStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { httpGetBuffer } from '../core/http.js';
import { decryptInitSegment, decryptSegment, KeyFetcher } from './decrypt.js';
import type { HlsMap, HlsSegment, MediaPlaylist } from './playlist.js';

export interface SegmentProgress {
  /** 已完成分片数（含跳过） */
  done: number;
  total: number;
  /** 累计字节 */
  bytes: number;
}

export interface DownloadSegmentsOptions {
  playlist: MediaPlaylist;
  /** 分片存放目录 */
  partsDir: string;
  concurrency: number;
  timeoutMs: number;
  retries: number;
  ua: string;
  onProgress?(p: SegmentProgress): void;
  signal?: AbortSignal;
  /** 全池无进展多少毫秒判定停滞并中止在途请求（默认 30 秒） */
  stallTimeoutMs?: number;
}

export interface DownloadSegmentsResult {
  /** 按顺序拼接的完整分片文件列表（init 段在最前） */
  partFiles: string[];
  bytes: number;
  total: number;
  skipped: number;
}

function partFileName(index: number): string {
  return `seg${String(index).padStart(6, '0')}.ts`;
}

async function fileExistsNonEmpty(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

/** 原子写入：先写 .tmp 再改名，避免中断留下半截分片 */
async function writeAtomic(file: string, data: Buffer): Promise<void> {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

/**
 * 下载整个媒体播放列表的分片。
 * 抛错时已下载的分片保留在 partsDir，供下次续传。
 */
export async function downloadSegments(opts: DownloadSegmentsOptions): Promise<DownloadSegmentsResult> {
  const { playlist, partsDir, signal } = opts;
  const concurrency = Math.max(1, opts.concurrency);
  const stallTimeoutMs = opts.stallTimeoutMs ?? 30_000;
  await fs.mkdir(partsDir, { recursive: true });

  // 停滞看门狗：CDN 限流时可能瞬间掐断全部连接，undici 的 fetch promise 可能
  // 永不落定、socket 句柄随之关闭，事件循环被排空会导致进程无声退出。
  // 看门狗在「有在途请求但长时间零进展」时主动中止它们，让本集走失败重试；
  // 定时器持有引用，也保证下载期间事件循环不会被排空。
  const stall = new AbortController();
  let inFlight = 0;
  let lastActivity = Date.now();
  const bump = () => {
    lastActivity = Date.now();
  };
  const requestSignal = () => (signal ? AbortSignal.any([signal, stall.signal]) : stall.signal);

  const keyFetcher = new KeyFetcher((url) =>
    httpGetBuffer(url, { ua: opts.ua, timeoutMs: opts.timeoutMs, signal: requestSignal() }),
  );

  // 任务列表：init 段（若有）+ 全部分片
  interface Job {
    name: string;
    uri: string;
    byteRange?: { length: number; offset: number };
    decrypt: (data: Buffer) => Promise<Buffer>;
  }
  const jobs: Job[] = [];
  if (playlist.initSegment) {
    const map: HlsMap = playlist.initSegment;
    jobs.push({
      name: 'init.ts',
      uri: map.uri,
      byteRange: map.byteRange,
      decrypt: (data) => decryptInitSegment(data, map, keyFetcher),
    });
  }
  playlist.segments.forEach((seg: HlsSegment, index: number) => {
    jobs.push({
      name: partFileName(index),
      uri: seg.uri,
      byteRange: seg.byteRange,
      decrypt: (data) => decryptSegment(data, seg.key, seg.sequence, keyFetcher),
    });
  });

  const total = jobs.length;
  let done = 0;
  let bytes = 0;
  let skipped = 0;

  const emit = () => opts.onProgress?.({ done, total, bytes });

  // 预扫描已完成的分片（断点续传）
  const pending: Job[] = [];
  for (const job of jobs) {
    const file = path.join(partsDir, job.name);
    if (await fileExistsNonEmpty(file)) {
      const stat = await fs.stat(file);
      bytes += stat.size;
      done++;
      skipped++;
    } else {
      pending.push(job);
    }
  }
  emit();

  async function runJob(job: Job): Promise<void> {
    if (signal?.aborted) throw new Error('已取消');
    const headers: Record<string, string> = {};
    if (job.byteRange) {
      headers.range = `bytes=${job.byteRange.offset}-${job.byteRange.offset + job.byteRange.length - 1}`;
    }
    const data = await httpGetBuffer(job.uri, {
      ua: opts.ua,
      timeoutMs: opts.timeoutMs,
      retries: opts.retries,
      headers,
      signal: requestSignal(),
    });
    const decrypted = await job.decrypt(data);
    await writeAtomic(path.join(partsDir, job.name), decrypted);
    done++;
    bytes += decrypted.length;
    emit();
  }

  let cursor = 0;
  const failures: { error: Error; job: Job }[] = [];
  async function worker(): Promise<void> {
    while (
      cursor < pending.length &&
      failures.length === 0 &&
      !signal?.aborted &&
      !stall.signal.aborted
    ) {
      const job = pending[cursor++]!;
      bump();
      inFlight++;
      try {
        await runJob(job);
      } catch (err) {
        failures.push({ error: err instanceof Error ? err : new Error(String(err)), job });
      } finally {
        inFlight--;
        bump();
      }
    }
  }

  const checkMs = Math.min(5_000, Math.max(200, Math.floor(stallTimeoutMs / 2)));
  const watchdog =
    pending.length > 0
      ? setInterval(() => {
          if (inFlight > 0 && Date.now() - lastActivity >= stallTimeoutMs) {
            stall.abort();
          }
        }, checkMs)
      : null;

  const stallMessage = `下载停滞（${Math.round(stallTimeoutMs / 1000)} 秒无任何进展），已中止本集等待自动重试`;

  try {
    // 停滞中止后，卡死的请求可能对 abort 也不响应（服务器黑洞连接），
    // 给 5 秒宽限仍未收尾就直接逃逸报失败，由集级重试用全新连接补试。
    let graceTimer: NodeJS.Timeout | null = null;
    const escaped = new Promise<never>((_, reject) => {
      stall.signal.addEventListener(
        'abort',
        () => {
          graceTimer = setTimeout(() => reject(new Error(stallMessage)), 5_000);
        },
        { once: true },
      );
    });
    try {
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker)),
        escaped,
      ]);
    } catch (err) {
      // 真实的分片异常原样抛出；停滞引发的一律映射为停滞报错
      if (!stall.signal.aborted) throw err;
    } finally {
      if (graceTimer) clearTimeout(graceTimer);
    }
    if (stall.signal.aborted) throw new Error(stallMessage);
  } finally {
    if (watchdog) clearInterval(watchdog);
  }

  if (signal?.aborted) {
    throw new Error('已取消');
  }
  if (failures.length > 0) {
    const { error, job } = failures[0]!;
    throw new Error(`分片下载失败（${job.name}）：${error.message}`);
  }

  const partFiles = [
    ...(playlist.initSegment ? ['init.ts'] : []),
    ...playlist.segments.map((_, index) => partFileName(index)),
  ].map((name) => path.join(partsDir, name));

  return { partFiles, bytes, total, skipped };
}

/** 顺序拼接分片文件到目标文件（流式，内存占用恒定） */
export async function concatPartFiles(partFiles: string[], outFile: string): Promise<void> {
  const ws = createWriteStream(outFile);
  try {
    for (const part of partFiles) {
      await new Promise<void>((resolve, reject) => {
        const rs = createReadStream(part);
        rs.on('error', reject);
        rs.pipe(ws, { end: false });
        rs.on('end', resolve);
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      ws.end(() => resolve());
      ws.on('error', reject);
    });
  }
}
