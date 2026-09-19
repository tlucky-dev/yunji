/**
 * 「自定义路由 + JS 变量播放器」站点适配器（mengnijia.com 实测）。
 *
 * 与 MacCMS 标准路由不同：播放页 /{prefix}/{vodId}/{pageId}.html 的 pageId 是
 * 与集号无关的页面 id；页面无 player_data / player_aaaa，m3u8 藏在内嵌 JS 变量里
 * （thisUrl = "https://…/index.m3u8"，交给 artplayer iframe 播放）。
 *
 * 解析链路（实测验证）：
 *   播放页 <title>「剧名第01集-…」 → 剧名
 *   └─ 选集列表：页面上同 vodId 的全部播放链接，按出现顺序即集序，
 *      标签「第NN集」可解析时用标签集号，否则按顺序编号
 *   └─ m3u8：优先 player_data / player_aaaa，回退扫描内嵌 JS 中的 .m3u8 字符串
 * 该类站点通常只有单一播放源。
 */
import * as cheerio from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import type {
  EpisodeMedia,
  EpisodeRef,
  SiteAdapter,
  SiteContext,
  SeriesInfo,
} from '../core/models.js';
import { extractPlayerData, toAbsoluteUrl } from './maccms-stui.js';

/** 已确认适配的站点；此类路由 /movie/{id}/{id}.html 太常见，仅按站点名单启用 */
const KNOWN_HOSTS = new Set(['mengnijia.com', 'www.mengnijia.com']);

/** 播放页路径 /{prefix}/{vodId}/{pageId}.html，pageId 与集号无关 */
const PLAY_PATH = /^\/([a-z][a-z0-9_-]*)\/(\d+)\/(\d+)\.html$/i;

/** 播放页 URL 的结构化信息 */
export interface JsPlayUrlInfo {
  prefix: string;
  vodId: string;
  pageId: string;
}

export function parseJsPlayUrl(url: URL): JsPlayUrlInfo | null {
  const m = PLAY_PATH.exec(url.pathname);
  if (!m) return null;
  return { prefix: m[1]!, vodId: m[2]!, pageId: m[3]! };
}

/** 从播放链接推导集号：标签「第NN集/话/期」优先，否则按出现顺序编号 */
function episodeNumber(label: string): number | null {
  const m = /^第(\d+)[集话期]/.exec(label.trim());
  return m ? Number(m[1]) : null;
}

/** 收集播放页上同 vodId 的全部选集链接（按 DOM 顺序，pageId 去重） */
export function collectJsEpisodeLinks($: CheerioAPI, pageUrl: string): EpisodeRef[] {
  const base = parseJsPlayUrl(new URL(pageUrl));
  if (!base) return [];
  // 页面标题链接可能与「第01集」指向同一 pageId 但标签冗长，优先取「第NN集」样式的标签
  const byPageId = new Map<string, { ref: EpisodeRef; num: number | null }>();
  for (const a of $('a[href]').toArray()) {
    const href = $(a).attr('href') ?? '';
    const abs = new URL(href, pageUrl);
    const info = parseJsPlayUrl(abs);
    if (!info || info.vodId !== base.vodId) continue;
    const label = $(a).text().trim();
    const num = episodeNumber(label);
    const existing = byPageId.get(info.pageId);
    if (existing) {
      if (num !== null && existing.num === null) {
        existing.num = num;
        existing.ref.label = label;
      }
      continue;
    }
    byPageId.set(info.pageId, {
      ref: { nid: 0, label, playUrl: abs.href },
      num,
    });
  }
  const raw = [...byPageId.values()];
  // 全部标签都带集号时用标签集号，否则退化为出现顺序
  const useLabelNums = raw.length > 0 && raw.every((r) => r.num !== null);
  raw.forEach((r, i) => {
    r.ref.nid = useLabelNums ? r.num! : i + 1;
  });
  return raw.map((r) => r.ref).sort((a, b) => a.nid - b.nid);
}

/** 从 <title> 提取剧名：「剧名第01集-剧名免费在线观看 - 站名」→「剧名」 */
export function extractSeriesTitle(html: string): string {
  const t = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  if (!t) return '';
  const cut = t.replace(/第\d+[集话期][\s\S]*$/, '').trim();
  return cut.replace(/[-_|·]\s*$/, '').trim();
}

/**
 * 从播放页 HTML 定位 m3u8：
 * ① player_data / player_aaaa（部分源仍用标准结构）
 * ② 内嵌 JS 字符串里的 .m3u8 地址（thisUrl = "…" 等，变量名不限）
 */
export function extractM3u8Url(html: string, pageUrl: string): string {
  try {
    const playerData = extractPlayerData(html, pageUrl);
    if (playerData.url) return toAbsoluteUrl(playerData.url, pageUrl);
  } catch {
    // 无标准播放数据，继续扫 JS 变量
  }
  const m = /["'](https?:\/\/[^"'\s]+?\.m3u8[^"'\s]*)["']/i.exec(html);
  if (m) return toAbsoluteUrl(m[1]!, pageUrl);
  throw new Error(`页面中未找到 m3u8 地址：${pageUrl}`);
}

export class JsvarPlayAdapter implements SiteAdapter {
  name = 'jsvar-play';

  match(url: URL): boolean {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    return KNOWN_HOSTS.has(url.hostname) && parseJsPlayUrl(url) !== null;
  }

  async resolveSeries(
    url: URL,
    opts: { source?: string },
    ctx: SiteContext,
  ): Promise<SeriesInfo> {
    const play = parseJsPlayUrl(url);
    if (!play) {
      throw new Error(`不是可识别的播放页地址：${url.href}`);
    }
    if (opts.source !== undefined && opts.source !== '1') {
      throw new Error(`该站点只识别到单一播放源，无法切换到“${opts.source}”`);
    }
    const html = await ctx.http.getText(url.href);
    const episodes = collectJsEpisodeLinks(cheerio.load(html), url.href);
    if (episodes.length === 0) {
      throw new Error(`未能从页面解析出任何剧集：${url.href}`);
    }
    const title = extractSeriesTitle(html) || `vod-${play.vodId}`;
    return {
      vodId: play.vodId,
      title,
      sourceSid: 1,
      pageUrl: url.href,
      episodes,
    };
  }

  async resolveEpisodeMedia(
    episodes: EpisodeRef[],
    ctx: SiteContext,
  ): Promise<{ media: EpisodeMedia[]; failures: { episode: EpisodeRef; error: Error }[] }> {
    const media: EpisodeMedia[] = [];
    const failures: { episode: EpisodeRef; error: Error }[] = [];
    let cursor = 0;
    const pageConcurrency = Math.max(1, ctx.pageConcurrency ?? 4);

    async function worker(): Promise<void> {
      while (cursor < episodes.length) {
        const episode = episodes[cursor++]!;
        try {
          const html = await ctx.http.getText(episode.playUrl);
          media.push({
            nid: episode.nid,
            label: episode.label,
            playUrl: episode.playUrl,
            m3u8Url: extractM3u8Url(html, episode.playUrl),
          });
        } catch (err) {
          failures.push({
            episode,
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(pageConcurrency, episodes.length) }, worker));
    media.sort((a, b) => a.nid - b.nid);
    return { media, failures };
  }
}

/** 默认导出的适配器实例 */
export const jsvarPlayAdapter = new JsvarPlayAdapter();
