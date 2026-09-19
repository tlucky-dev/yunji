/**
 * 下载任务清单：记录剧集、各集 m3u8 与状态，支撑断点续传。
 * 清单存放在剧集输出目录下（.yunji-manifest.json），分片级断点由 .parts 目录承担。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export type EpisodeStatus = 'pending' | 'downloaded' | 'merged';

export interface ManifestEpisode {
  nid: number;
  label: string;
  playUrl: string;
  /** 解析出的 m3u8 地址（未解析时为 null） */
  m3u8Url: string | null;
  status: EpisodeStatus;
  /** 输出文件名（不含扩展名） */
  fileTitle: string;
  /** 最终输出文件绝对路径（merged 后填写） */
  outputFile?: string;
}

export interface Manifest {
  version: 1;
  vodId: string;
  title: string;
  sourceSid: number;
  sourceLabel?: string;
  pageUrl: string;
  /** 全部剧集（含未选择的），按 nid 升序 */
  episodes: ManifestEpisode[];
}

export function manifestPath(seriesDir: string): string {
  return path.join(seriesDir, '.yunji-manifest.json');
}

/** 读取清单；文件不存在或损坏时返回 null */
export async function loadManifest(seriesDir: string): Promise<Manifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(seriesDir), 'utf-8');
    const parsed = JSON.parse(raw) as Manifest;
    if (parsed?.version !== 1 || !Array.isArray(parsed.episodes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 原子写入清单（先写临时文件再改名） */
export async function saveManifest(seriesDir: string, manifest: Manifest): Promise<void> {
  await fs.mkdir(seriesDir, { recursive: true });
  const file = manifestPath(seriesDir);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.rename(tmp, file);
}

/** 按 nid 查找清单中的分集 */
export function findEpisode(manifest: Manifest, nid: number): ManifestEpisode | undefined {
  return manifest.episodes.find((ep) => ep.nid === nid);
}
