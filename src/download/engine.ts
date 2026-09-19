/**
 * 下载引擎：逐集处理（解析播放列表 → 并发下载分片 → 合并 → 转封装 → 清理）。
 * 分片级断点续传由 downloadSegments 的 .parts 跳过机制实现；
 * 集级续传由清单 status 与已存在的输出文件实现。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { YunjiConfig } from '../config.js';
import { httpGetText } from '../core/http.js';
import { concatPartFiles, downloadSegments, type SegmentProgress } from '../hls/downloader.js';
import { resolveMediaPlaylist } from '../hls/playlist.js';
import { cleanupParts, findFfmpeg, outputPath, remuxToMp4 } from './merge.js';
import type { Manifest, ManifestEpisode } from './manifest.js';
import { saveManifest } from './manifest.js';
import type { Plan } from './planner.js';

export interface EngineHooks {
  /** 某集开始下载（此时总 分片数已知） */
  onEpisodeStart?(episode: ManifestEpisode, totalSegments: number): void;
  onProgress?(episode: ManifestEpisode, progress: SegmentProgress): void;
  onEpisodeMerged?(episode: ManifestEpisode, outputFile: string): void;
  onEpisodeFailed?(episode: ManifestEpisode, error: Error): void;
  log: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export interface RunSummary {
  merged: number;
  skipped: number;
  failed: number;
  /** 因中断而未处理完的分集数 */
  interrupted: number;
}

/** 执行下载计划；signal 用于响应 Ctrl+C，中断时保留现场可续传 */
export async function runPlan(
  plan: Plan,
  config: YunjiConfig,
  hooks: EngineHooks,
  signal?: AbortSignal,
): Promise<RunSummary> {
  const summary: RunSummary = { merged: 0, skipped: 0, failed: 0, interrupted: 0 };
  const getText = (url: string) =>
    httpGetText(url, { ua: config.ua, timeoutMs: config.timeoutMs, retries: config.retries, signal });

  const ffmpegPath = config.remux ? await findFfmpeg(config.ffmpegPath) : null;
  if (config.remux && !ffmpegPath) {
    hooks.log.warn('未找到 ffmpeg，将保留合并后的 .ts 文件（可用 --ffmpeg 指定路径）');
  }
  let warnedNoFfmpeg = false;

  const manifest: Manifest = plan.manifest;

  for (const episode of plan.selected) {
    if (signal?.aborted) break;

    // 已合并且文件在 → 跳过
    if (episode.status === 'merged' && episode.outputFile) {
      const exists = await fs
        .stat(episode.outputFile)
        .then((s) => s.isFile() && s.size > 0)
        .catch(() => false);
      if (exists) {
        summary.skipped++;
        hooks.log.info(`已完成，跳过：${path.basename(episode.outputFile)}`);
        continue;
      }
      hooks.log.warn(`清单标记已完成但文件缺失，重新下载：${episode.fileTitle}`);
      episode.status = 'pending';
    }

    const partsDir = path.join(plan.seriesDir, '.parts', String(episode.nid).padStart(3, '0'));
    try {
      if (!episode.m3u8Url) {
        throw new Error('缺少 m3u8 地址');
      }
      const playlist = await resolveMediaPlaylist(getText, episode.m3u8Url, config.quality);
      if (playlist.encryption === 'other') {
        throw new Error('该播放源使用了暂不支持的加密方式（非 AES-128 / 明文 HLS）');
      }
      if (playlist.segments.length === 0) {
        throw new Error('播放列表中没有分片');
      }

      hooks.onEpisodeStart?.(episode, playlist.segments.length + (playlist.initSegment ? 1 : 0));

      const result = await downloadSegments({
        playlist,
        partsDir,
        concurrency: config.concurrency,
        timeoutMs: config.timeoutMs,
        retries: config.retries,
        ua: config.ua,
        signal,
        onProgress: (p) => hooks.onProgress?.(episode, p),
      });

      episode.status = 'downloaded';
      await saveManifest(plan.seriesDir, manifest);

      // 合并 + 转封装
      const tsPath = outputPath(plan.seriesDir, episode.fileTitle, 'ts.tmp');
      await concatPartFiles(result.partFiles, tsPath);

      let outputFile: string;
      if (config.remux && ffmpegPath) {
        const mp4Path = outputPath(plan.seriesDir, episode.fileTitle, 'mp4');
        await remuxToMp4(tsPath, mp4Path, ffmpegPath);
        await fs.rm(tsPath, { force: true });
        outputFile = mp4Path;
      } else {
        if (config.remux && !warnedNoFfmpeg) {
          warnedNoFfmpeg = true;
          hooks.log.warn('ffmpeg 不可用，本任务输出 .ts 文件');
        }
        const finalTs = outputPath(plan.seriesDir, episode.fileTitle, 'ts');
        await fs.rename(tsPath, finalTs);
        outputFile = finalTs;
      }

      episode.status = 'merged';
      episode.outputFile = outputFile;
      await saveManifest(plan.seriesDir, manifest);
      await cleanupParts(partsDir);
      summary.merged++;
      hooks.onEpisodeMerged?.(episode, outputFile);
    } catch (err) {
      if (signal?.aborted) {
        hooks.log.warn(`已中断：${episode.label}（重新执行同一命令可续传）`);
        break;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      summary.failed++;
      hooks.onEpisodeFailed?.(episode, error);
    }
  }

  summary.interrupted = Math.max(
    0,
    plan.selected.length - summary.merged - summary.skipped - summary.failed,
  );
  return summary;
}
