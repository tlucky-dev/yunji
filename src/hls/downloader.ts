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
  await fs.mkdir(partsDir, { recursive: true });

  const keyFetcher = new KeyFetcher((url) =>
    httpGetBuffer(url, { ua: opts.ua, timeoutMs: opts.timeoutMs, signal }),
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
      signal,
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
    while (cursor < pending.length && failures.length === 0 && !signal?.aborted) {
      const job = pending[cursor++]!;
      try {
        await runJob(job);
      } catch (err) {
        failures.push({ error: err instanceof Error ? err : new Error(String(err)), job });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));

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
