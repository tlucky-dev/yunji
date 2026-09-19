/**
 * 任务规划：输入 URL → 站点适配器解析剧集 → 生成/续用任务清单 → 确定本次要下载的分集。
 */
import * as path from 'node:path';
import type { YunjiConfig } from '../config.js';
import { httpGetText } from '../core/http.js';
import type { SiteContext, SiteAdapter } from '../core/models.js';
import { resolveAdapter } from '../core/registry.js';
import { assignEpisodeFileTitles, parseEpisodeSpec, sanitizeName } from '../util/filename.js';
import type { Manifest, ManifestEpisode } from './manifest.js';
import { loadManifest, saveManifest } from './manifest.js';

export interface PlanRequest {
  /** 播放页 / 详情页 / m3u8 地址 */
  inputUrl: string;
  /** 播放源（sid 或源名） */
  source?: string;
  /** 选集表达式（默认全部） */
  episodesSpec?: string;
  /** 仅解析列出，不做 m3u8 定位与下载 */
  listOnly?: boolean;
}

export interface Plan {
  seriesDir: string;
  manifest: Manifest;
  /** 本次要处理的分集（含 m3u8） */
  selected: ManifestEpisode[];
  listOnly: boolean;
}

function buildSiteContext(config: YunjiConfig, log: SiteContext['log']): SiteContext {
  return {
    http: {
      getText: (url) =>
        httpGetText(url, { ua: config.ua, timeoutMs: config.timeoutMs, retries: config.retries }),
    },
    log,
    pageConcurrency: config.pageConcurrency,
  };
}

/** 直接给 m3u8 地址时的最小剧集结构 */
async function planFromM3u8(
  url: URL,
  request: PlanRequest,
  config: YunjiConfig,
): Promise<{ seriesDir: string; manifest: Manifest; selected: ManifestEpisode[] }> {
  // 尽量从路径里取一个可读名字：…/play/AbCdEf/index.m3u8 → AbCdEf
  const parts = url.pathname.split('/').filter(Boolean);
  const rawTitle = parts.length >= 2 ? decodeURIComponent(parts[parts.length - 2]!) : 'video';
  const title = sanitizeName(rawTitle);
  const seriesDir = path.join(config.outputDir, title);
  const episode: ManifestEpisode = {
    nid: 1,
    label: '第01集',
    playUrl: url.href,
    m3u8Url: url.href,
    status: 'pending',
    fileTitle: sanitizeName(`${title}-第01集`),
  };
  const manifest: Manifest = {
    version: 1,
    vodId: `m3u8:${url.href}`,
    title,
    sourceSid: 0,
    pageUrl: url.href,
    episodes: [episode],
  };
  const spec = parseEpisodeSpec(request.episodesSpec ?? '');
  const selected = manifest.episodes.filter((ep) => spec.matches(ep.nid));
  await saveManifest(seriesDir, manifest);
  return { seriesDir, manifest, selected };
}

/** 主入口：解析 URL 并生成下载计划（含断点续传的清单合并） */
export async function createPlan(
  request: PlanRequest,
  config: YunjiConfig,
  log: SiteContext['log'],
): Promise<Plan> {
  let url: URL;
  try {
    url = new URL(request.inputUrl);
  } catch {
    throw new Error(`无效的网址：${request.inputUrl}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`仅支持 http/https 地址：${url.href}`);
  }

  if (/\.m3u8($|\?)/i.test(url.pathname + url.search)) {
    const plan = await planFromM3u8(url, request, config);
    return { ...plan, listOnly: request.listOnly ?? false };
  }

  const adapter: SiteAdapter = resolveAdapter(url);
  const ctx = buildSiteContext(config, log);
  const series = await adapter.resolveSeries(url, { source: request.source }, ctx);

  const seriesDir = path.join(config.outputDir, sanitizeName(series.title));
  const existing = await loadManifest(seriesDir);
  const sameTask =
    existing && existing.vodId === series.vodId && existing.sourceSid === series.sourceSid;

  if (existing && !sameTask) {
    log.warn(
      `目录 ${seriesDir} 已存在其它任务（${existing.title} / 源${existing.sourceSid}），` +
        `本次将重建清单；已完成的旧文件不受影响。`,
    );
  }

  // 稳定的输出文件名：对全集一次性分配，避免每次运行名字漂移
  const fileTitles = assignEpisodeFileTitles(series.title, series.episodes);
  const previousByNid = new Map(
    (sameTask ? existing!.episodes : []).map((ep) => [ep.nid, ep]),
  );

  const episodes: ManifestEpisode[] = series.episodes.map((ref, i) => {
    const prev = previousByNid.get(ref.nid);
    return {
      nid: ref.nid,
      label: ref.label,
      playUrl: ref.playUrl,
      m3u8Url: prev?.m3u8Url ?? null,
      status: prev?.status ?? 'pending',
      fileTitle: fileTitles[i]!,
      outputFile: prev?.outputFile,
    };
  });

  const manifest: Manifest = {
    version: 1,
    vodId: series.vodId,
    title: series.title,
    sourceSid: series.sourceSid,
    sourceLabel: series.sourceLabel,
    pageUrl: series.pageUrl,
    episodes,
  };

  const spec = parseEpisodeSpec(request.episodesSpec ?? '');
  let selected = manifest.episodes.filter((ep) => spec.matches(ep.nid));
  if (selected.length === 0) {
    const available = manifest.episodes.map((ep) => ep.nid).join(',');
    throw new Error(
      `选集表达式“${request.episodesSpec}”没有匹配到任何一集。可用集号：${available}`,
    );
  }

  // 为缺失 m3u8 的选中分集定位媒体地址
  if (!request.listOnly) {
    const needResolve = selected.filter((ep) => !ep.m3u8Url);
    if (needResolve.length > 0) {
      log.info(`解析 ${needResolve.length} 集的媒体地址…`);
      const { media, failures } = await adapter.resolveEpisodeMedia(
        needResolve.map((ep) => ({ nid: ep.nid, label: ep.label, playUrl: ep.playUrl })),
        ctx,
      );
      const byNid = new Map(media.map((m) => [m.nid, m.m3u8Url]));
      for (const ep of selected) {
        ep.m3u8Url = ep.m3u8Url ?? byNid.get(ep.nid) ?? null;
      }
      for (const failure of failures) {
        log.warn(
          `第 ${failure.episode.nid} 集（${failure.episode.label}）媒体地址解析失败：${failure.error.message}`,
        );
      }
      selected = selected.filter((ep) => ep.m3u8Url);
      if (selected.length === 0) {
        throw new Error('所有分集的媒体地址均解析失败，请稍后重试或更换播放源（--source）。');
      }
    }
  }

  await saveManifest(seriesDir, manifest);
  return { seriesDir, manifest, selected, listOnly: request.listOnly ?? false };
}

/** resume 子命令：从已有清单目录恢复计划 */
export async function createPlanFromManifest(
  seriesDir: string,
  config: YunjiConfig,
  log: SiteContext['log'],
): Promise<Plan> {
  const manifest = await loadManifest(seriesDir);
  if (!manifest) {
    throw new Error(`目录中没有可恢复的任务清单：${seriesDir}`);
  }
  // 补齐尚未定位到 m3u8 的分集（重新走一遍站点解析）
  const unresolved = manifest.episodes.filter((ep) => !ep.m3u8Url && ep.status !== 'merged');
  if (unresolved.length > 0) {
    const adapter = resolveAdapter(new URL(manifest.pageUrl));
    const ctx = buildSiteContext(config, log);
    const { media, failures } = await adapter.resolveEpisodeMedia(unresolved, ctx);
    const byNid = new Map(media.map((m) => [m.nid, m.m3u8Url]));
    for (const ep of unresolved) {
      ep.m3u8Url = byNid.get(ep.nid) ?? null;
      if (!ep.m3u8Url) {
        const failure = failures.find((f) => f.episode.nid === ep.nid);
        log.warn(`第 ${ep.nid} 集媒体地址解析失败：${failure?.error.message ?? '未知错误'}`);
      }
    }
  }
  const selected = manifest.episodes.filter((ep) => ep.m3u8Url && ep.status !== 'merged');
  await saveManifest(seriesDir, manifest);
  return { seriesDir, manifest, selected, listOnly: false };
}
