/**
 * 下载引擎：解析播放列表 → 并发下载分片 → 合并 → 转封装 → 清理。
 * 集与集之间按 episodeConcurrency 并行（默认 1 = 逐集串行）；
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

/** 单集处理结果；aborted 不计入 failed（属于用户中断，可续传） */
type EpisodeOutcome = 'merged' | 'skipped' | 'failed' | 'aborted';

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

  // 并行集会同时改写清单，写盘串行化，避免交错写坏 JSON；
  // 失败只抛给触发本次保存的调用方，不阻断后续保存。
  let saveChain: Promise<void> = Promise.resolve();
  const saveManifestSerial = (): Promise<void> => {
    const run = () => saveManifest(plan.seriesDir, manifest);
    const pending = saveChain.then(run, run);
    saveChain = pending.catch(() => undefined);
    return pending;
  };

  const processEpisode = async (episode: ManifestEpisode): Promise<EpisodeOutcome> => {
    // 已合并且文件在 → 跳过
    if (episode.status === 'merged' && episode.outputFile) {
      const exists = await fs
        .stat(episode.outputFile)
        .then((s) => s.isFile() && s.size > 0)
        .catch(() => false);
      if (exists) {
        hooks.log.info(`已完成，跳过：${path.basename(episode.outputFile)}`);
        return 'skipped';
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
      await saveManifestSerial();

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
      await saveManifestSerial();
      await cleanupParts(partsDir);
      hooks.onEpisodeMerged?.(episode, outputFile);
      return 'merged';
    } catch (err) {
      if (signal?.aborted) {
        hooks.log.warn(`已中断：${episode.label}（重新执行同一命令可续传）`);
        return 'aborted';
      }
      const error = err instanceof Error ? err : new Error(String(err));
      hooks.onEpisodeFailed?.(episode, error);
      return 'failed';
    }
  };

  const episodeConcurrency = Math.max(1, config.episodeConcurrency);

  /** 跑一队列集，返回本轮失败的集（aborted 的不计入，由 interrupted 汇总） */
  const runPass = async (queue: ManifestEpisode[]): Promise<ManifestEpisode[]> => {
    const failedNow: ManifestEpisode[] = [];
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < queue.length && !signal?.aborted) {
        const episode = queue[cursor++]!;
        const outcome = await processEpisode(episode);
        if (outcome === 'merged') summary.merged++;
        else if (outcome === 'skipped') summary.skipped++;
        else if (outcome === 'failed') failedNow.push(episode);
        else return; // aborted：本 worker 退出
      }
    };
    await Promise.all(Array.from({ length: Math.min(episodeConcurrency, queue.length) }, worker));
    return failedNow;
  };

  // 失败集自动重试：CDN 限流/抖动通常几十秒内恢复；分片级续传保证重试只补缺口
  let failed = await runPass(plan.selected);
  const RETRY_DELAY_MS = 20_000;
  let sweeps = Math.max(0, config.episodeRetries);
  while (failed.length > 0 && sweeps > 0 && !signal?.aborted) {
    hooks.log.warn(
      `有 ${failed.length} 集下载失败，${Math.round(RETRY_DELAY_MS / 1000)} 秒后自动重试（剩余 ${sweeps} 轮）…`,
    );
    const continueRun = await sleepAbortable(RETRY_DELAY_MS, signal);
    if (!continueRun) break;
    sweeps--;
    failed = await runPass(failed);
  }
  await saveChain;
  summary.failed = failed.length;

  summary.interrupted = Math.max(
    0,
    plan.selected.length - summary.merged - summary.skipped - summary.failed,
  );
  return summary;
}

/** 可被 Ctrl+C 打断的睡眠；返回 false 表示等待期间被中断 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (notAborted: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(notAborted);
    };
    const timer = setTimeout(() => finish(true), ms);
    const onAbort = () => finish(false);
    signal?.addEventListener('abort', onAbort);
  });
}
