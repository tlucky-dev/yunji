/**
 * MacCMS V10 系站点适配器，覆盖两种实测过的模板形态：
 *
 * ① stui 模板（maliys.com）：播放页内嵌 var player_data = {...}
 * ② 原生 / ewave 模板（pdy7.com）：播放页内嵌 var player_aaaa = {...}（字段同构）
 *
 * 解析链路（实测验证）：
 *   播放页 /{prefix}/{vodId}-{sid}-{nid}.html 内嵌播放数据
 *   ├─ url / url_next：直连 m3u8 地址（encrypt 0 明文 / 1 unescape / 2 unescape+base64）
 *   ├─ vod_data.vod_name：剧名
 *   └─ 选集列表：stui 在 .play-content .play-item 块（.play-tab 提供源名）；
 *      其它模板走通用兜底——按同 vodId 的播放链接按 sid 分组，ewave 源名读自
 *      li[data-target="#ewave-playlist-<sid>"]。
 * 全部源均为直连 m3u8，无第三方解析接口。
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
import { pad2 } from '../util/filename.js';

/** 播放页路径 /{prefix}/{vodId}-{sid}-{nid}.html */
const PLAY_PATH = /^\/([a-z0-9_]+)\/(\d+)-(\d+)-(\d+)\.html$/i;
/** 详情页路径 /{prefix}/{vodId}.html */
const DETAIL_PATH = /^\/([a-z0-9_]+)\/(\d+)\.html$/i;

/** 已确认适配的站点；其它同模板站点靠播放页路径模式识别 */
const KNOWN_HOSTS = new Set(['maliys.com', 'www.maliys.com']);

/** 播放页 URL 结构化信息 */
interface PlayUrlInfo {
  prefix: string;
  vodId: string;
  sid: number;
  nid: number;
}

/** 页面内嵌的 player_data（字段较多，只声明用到的） */
interface PlayerData {
  url: string;
  url_next?: string;
  link_next?: string;
  encrypt: number;
  from?: string;
  sid: number;
  nid: number;
  id?: string;
  vod_data?: { vod_name?: string };
}

/** 页面上解析出的单个播放源分块 */
interface SourceBlock {
  sid: number;
  label?: string;
  episodes: EpisodeRef[];
}

export function parsePlayUrl(url: URL): PlayUrlInfo | null {
  const m = PLAY_PATH.exec(url.pathname);
  if (!m) return null;
  return {
    prefix: m[1]!,
    vodId: m[2]!,
    sid: Number(m[3]),
    nid: Number(m[4]),
  };
}

export function parseDetailUrl(url: URL): { vodId: string } | null {
  const m = DETAIL_PATH.exec(url.pathname);
  if (!m) return null;
  return { vodId: m[2]! };
}

/**
 * 从 HTML 中提取 `var <name> = {...};` 的对象字面量。
 * 使用括号配对扫描而非贪婪正则，避免对象内字符串含 "}" 时截断错误。
 */
export function extractJsObject(html: string, varName: string): unknown {
  const re = new RegExp(`var\\s+${varName}\\s*=\\s*`, 'i');
  const m = re.exec(html);
  if (!m) return null;
  let i = m.index + m[0].length;
  if (html[i] !== '{') return null;
  const start = i;
  let depth = 0;
  let inString: string | null = null;
  let escaped = false;
  for (; i < html.length; i++) {
    const ch = html[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === inString) {
        inString = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = ch;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const literal = html.slice(start, i + 1);
        try {
          return JSON.parse(literal);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 等价于 JS 的 unescape：把 %XX 序列还原为字符 */
function jsUnescape(s: string): string {
  return s.replace(/%([0-9A-Fa-f]{2})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/** 等价于模板里的 base64decode（atob） */
function jsBase64Decode(s: string): string {
  return Buffer.from(s, 'base64').toString('latin1');
}

/** 按 player_data.encrypt 字段还原真实地址 */
export function decodePlayerUrl(raw: string, encrypt: number): string {
  switch (encrypt) {
    case 1:
      return jsUnescape(raw);
    case 2:
      return jsUnescape(jsBase64Decode(raw));
    default:
      return raw;
  }
}

/** 把相对/协议相对的媒体地址规整为绝对地址 */
export function toAbsoluteUrl(raw: string, baseUrl: string): string {
  const trimmed = raw.trim();
  if (/^\/\//.test(trimmed)) return `https:${trimmed}`;
  try {
    return new URL(trimmed, baseUrl).href;
  } catch {
    return trimmed;
  }
}

/** UI 控制链接（空 href、纯锚点）解析后恰好等于当前页地址，会冒充播放链接，一律跳过 */
/** UI 控制链接（空 href、纯锚点）解析后恰好等于当前页地址，会冒充播放链接，一律跳过 */
export function isUiAnchor(href: string): boolean {
  const trimmed = href.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * 从 <title> 提取剧名：「《大奉打更人》剧集第01集免费在线播放_8090电影网」→「大奉打更人」。
 * 逐级剥离集号后缀、片源常用修饰词、站名分隔符与书名号。
 */
export function extractSeriesTitle(html: string): string {
  const t = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim();
  if (!t) return '';
  let cut = t.replace(/第\d+[集话期][\s\S]*$/, '').trim();
  cut = cut.replace(/(?:剧集|电视剧|全集|正片|高清|完整版|在线播放|在线观看|免费观看|免费在线观看)+$/, '').trim();
  cut = cut.replace(/[-_|·]\s*$/, '').trim();
  const wrapped = /^《(.+)》$/.exec(cut);
  if (wrapped) cut = wrapped[1]!.trim();
  return cut;
}

/** 解析并解密播放页内嵌的播放数据；stui 模板为 player_data，原生/ewave 模板为 player_aaaa */
export function extractPlayerData(html: string, pageUrl: string): PlayerData {
  let raw: PlayerData | null = null;
  for (const varName of ['player_data', 'player_aaaa']) {
    const obj = extractJsObject(html, varName) as PlayerData | null;
    if (obj && typeof obj.url === 'string' && obj.url.length > 0) {
      raw = obj;
      break;
    }
  }
  if (!raw) {
    throw new Error(`页面中未找到可用的播放数据（player_data / player_aaaa）：${pageUrl}`);
  }
  return {
    ...raw,
    url: decodePlayerUrl(raw.url, raw.encrypt ?? 0),
    url_next: raw.url_next ? decodePlayerUrl(raw.url_next, raw.encrypt ?? 0) : undefined,
  };
}

/** 解析页面上的播放源分块与其源名；stui 专属选择器解析不到时走通用兜底 */
export function parseSourceBlocks($: CheerioAPI, pageUrl: string): SourceBlock[] {
  const blocks = parseStuiSourceBlocks($, pageUrl);
  if (blocks.length > 0) return blocks;
  return parseGenericSourceBlocks($, pageUrl);
}

/** stui 模板：.play-tab 与 .play-content .play-item 按下标对应 */
function parseStuiSourceBlocks($: CheerioAPI, pageUrl: string): SourceBlock[] {
  const $tabs = $('ul.play-tab li a');
  const blocks: SourceBlock[] = [];
  $('div.play-content div.play-item').each((blockIndex, el) => {
    const $links = $(el).find('ul.stui-play__list a');
    const firstHref = $links.first().attr('href');
    if (!firstHref) return;
    const first = parsePlayUrl(new URL(firstHref, pageUrl));
    if (!first) return;
    const seenNids = new Set<number>();
    const episodes: EpisodeRef[] = [];
    $links.each((_, a) => {
      const href = $(a).attr('href');
      if (!href || isUiAnchor(href)) return;
      const ep = parsePlayUrl(new URL(href, pageUrl));
      if (!ep || seenNids.has(ep.nid)) return;
      seenNids.add(ep.nid);
      const label = $(a).text().trim();
      episodes.push({
        nid: ep.nid,
        label: label || `第${pad2(ep.nid)}集`,
        playUrl: new URL(href, pageUrl).href,
      });
    });
    if (episodes.length === 0) return;
    const tabText = $tabs.eq(blockIndex).text().trim();
    blocks.push({ sid: first.sid, label: tabText || undefined, episodes });
  });
  return blocks;
}

/** ewave 模板源名：li[data-target="#ewave-playlist-<sid>"] 的直接文本（去掉集数角标） */
function parseEwaveTabLabels($: CheerioAPI): Map<number, string> {
  const labels = new Map<number, string>();
  $('li[data-target]').each((_, li) => {
    const target = /ewave-playlist-(\d+)/.exec($(li).attr('data-target') ?? '');
    if (!target) return;
    const text = $(li).clone().children().remove().end().text().trim();
    if (text) labels.set(Number(target[1]), text);
  });
  return labels;
}

/**
 * 通用兜底（ewave 及其它未知模板）：扫描页面上同一 vod 的全部播放链接，按 sid 分组。
 * 播放页上同 vod 的链接即选集列表（推荐位链接是其它 vod，天然被过滤）。
 */
function parseGenericSourceBlocks($: CheerioAPI, pageUrl: string): SourceBlock[] {
  const base = parsePlayUrl(new URL(pageUrl));
  if (!base) return [];
  const bySid = new Map<number, { seenNids: Set<number>; episodes: EpisodeRef[] }>();
  for (const a of $('a[href]').toArray()) {
    const href = $(a).attr('href') ?? '';
    if (isUiAnchor(href)) continue;
    const info = parsePlayUrl(new URL(href, pageUrl));
    if (!info || info.vodId !== base.vodId) continue;
    const label = $(a).text().trim();
    // 播放页顶部的“上一集/下一集”导航按钮也指向本剧其它集，排除以免污染选集标签
    if (/^(上一集|下一集)$/.test(label)) continue;
    let bucket = bySid.get(info.sid);
    if (!bucket) {
      bucket = { seenNids: new Set<number>(), episodes: [] };
      bySid.set(info.sid, bucket);
    }
    if (bucket.seenNids.has(info.nid)) continue;
    bucket.seenNids.add(info.nid);
    bucket.episodes.push({
      nid: info.nid,
      label: label || `第${pad2(info.nid)}集`,
      playUrl: new URL(href, pageUrl).href,
    });
  }
  const labels = parseEwaveTabLabels($);
  const blocks: SourceBlock[] = [];
  for (const [sid, { episodes }] of bySid) {
    if (episodes.length === 0) continue;
    blocks.push({ sid, label: labels.get(sid), episodes: episodes.sort((a, b) => a.nid - b.nid) });
  }
  return blocks;
}

export class MaccmsStuiAdapter implements SiteAdapter {
  name = 'maccms-stui';

  match(url: URL): boolean {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    if (KNOWN_HOSTS.has(url.hostname)) {
      return PLAY_PATH.test(url.pathname) || DETAIL_PATH.test(url.pathname);
    }
    // 其它站点：播放页路径模式足够独特，可泛化适配
    return PLAY_PATH.test(url.pathname);
  }

  async resolveSeries(
    url: URL,
    opts: { source?: string },
    ctx: SiteContext,
  ): Promise<SeriesInfo> {
    const detail = parseDetailUrl(url);
    if (detail && !parsePlayUrl(url)) {
      return this.resolveSeriesFromDetail(url, opts, ctx);
    }
    const play = parsePlayUrl(url);
    if (!play) {
      throw new Error(`不是可识别的播放页地址：${url.href}`);
    }
    return this.resolveSeriesFromPlay(url, play, opts.source, ctx);
  }

  /** 详情页入口：挑选播放源后跳转到对应播放页 */
  private async resolveSeriesFromDetail(
    url: URL,
    opts: { source?: string },
    ctx: SiteContext,
  ): Promise<SeriesInfo> {
    const html = await ctx.http.getText(url.href);
    const $ = cheerio.load(html);
    const sidOrder: number[] = [];
    const firstLinkBySid = new Map<number, string>();
    for (const a of $('a[href]').toArray()) {
      const href = $(a).attr('href') ?? '';
      if (isUiAnchor(href)) continue;
      const info = parsePlayUrl(new URL(href, url.href));
      if (!info) continue;
      if (!firstLinkBySid.has(info.sid)) {
        sidOrder.push(info.sid);
        firstLinkBySid.set(info.sid, new URL(href, url.href).href);
      }
    }
    if (sidOrder.length === 0) {
      throw new Error(`详情页上没有找到任何播放链接：${url.href}`);
    }
    const sid = this.chooseSourceSid(opts.source, sidOrder, undefined);
    const playUrl = firstLinkBySid.get(sid)!;
    ctx.log.info(`从详情页选择播放源 sid=${sid}，进入播放页 ${playUrl}`);
    const titleFromDetail =
      $('h1.title').first().text().trim() ||
      $('meta[property="og:title"]').attr('content')?.trim() ||
      '';
    const series = await this.resolveSeriesFromPlay(
      new URL(playUrl),
      parsePlayUrl(new URL(playUrl))!,
      undefined,
      ctx,
    );
    if (titleFromDetail && !series.title) series.title = titleFromDetail;
    return series;
  }

  /** 在可用源里挑选目标源（数字 sid 或包含匹配的源名），不合法时列出可选项 */
  private chooseSourceSid(
    source: string | undefined,
    availableSids: number[],
    labels: Map<number, string> | undefined,
  ): number {
    if (source === undefined) {
      return availableSids[0]!;
    }
    const numeric = Number(source);
    if (Number.isInteger(numeric) && availableSids.includes(numeric)) {
      return numeric;
    }
    if (labels) {
      for (const [sid, label] of labels) {
        if (label.includes(source)) return sid;
      }
    }
    const list = availableSids.map((s) => `${s}=${labels?.get(s) ?? '未知'}`).join('、');
    throw new Error(`找不到播放源“${source}”。可用：${list}`);
  }

  private async resolveSeriesFromPlay(
    url: URL,
    play: PlayUrlInfo,
    source: string | undefined,
    ctx: SiteContext,
  ): Promise<SeriesInfo> {
    let pageUrl = url.href;
    let html = await ctx.http.getText(pageUrl);
    let playerData = extractPlayerData(html, pageUrl);
    let blocks = parseSourceBlocks(cheerio.load(html), pageUrl);

    // --source 指定了别的源：跳到该源第 1 集的播放页重新解析
    if (source !== undefined) {
      const labels = new Map(blocks.map((b) => [b.sid, b.label ?? `sid${b.sid}`]));
      const availableSids = blocks.length > 0 ? blocks.map((b) => b.sid) : [play.sid];
      const targetSid = this.chooseSourceSid(source, availableSids, labels);
      if (targetSid !== playerData.sid) {
        pageUrl = new URL(`/${play.prefix}/${play.vodId}-${targetSid}-1.html`, url.origin).href;
        ctx.log.info(`切换播放源 ${playerData.sid} -> ${targetSid}：${pageUrl}`);
        html = await ctx.http.getText(pageUrl);
        playerData = extractPlayerData(html, pageUrl);
        blocks = parseSourceBlocks(cheerio.load(html), pageUrl);
      }
    }

    const title =
      playerData.vod_data?.vod_name?.trim() || extractSeriesTitle(html) || `vod-${play.vodId}`;
    let block = blocks.find((b) => b.sid === playerData.sid);
    if (!block) {
      // 兜底：包含当前页面路径的块，或第一个块
      block = blocks.find((b) => b.episodes.some((ep) => ep.playUrl === pageUrl)) ?? blocks[0];
    }

    let episodes: EpisodeRef[];
    if (block) {
      episodes = [...block.episodes].sort((a, b) => a.nid - b.nid);
    } else {
      ctx.log.warn('页面未找到选集列表，改用“下集”链接逐集追踪（较慢）');
      episodes = await this.walkEpisodeChain(pageUrl, playerData, ctx);
    }

    if (episodes.length === 0) {
      throw new Error(`未能从页面解析出任何剧集：${pageUrl}`);
    }

    return {
      vodId: playerData.id ?? play.vodId,
      title,
      sourceSid: playerData.sid,
      sourceLabel: block?.label,
      pageUrl,
      episodes,
    };
  }

  /** 兜底方案：顺着 link_next 一集一集走完（每集一次请求） */
  private async walkEpisodeChain(
    pageUrl: string,
    playerData: PlayerData,
    ctx: SiteContext,
  ): Promise<EpisodeRef[]> {
    const episodes: EpisodeRef[] = [];
    const seen = new Set<string>();
    let currentUrl: string | undefined = pageUrl;
    let currentData = playerData;
    while (currentUrl && !seen.has(currentUrl) && seen.size < 200) {
      seen.add(currentUrl);
      const info = parsePlayUrl(new URL(currentUrl));
      episodes.push({
        nid: info?.nid ?? seen.size,
        label: `第${pad2(info?.nid ?? seen.size)}集`,
        playUrl: currentUrl,
      });
      const next = currentData.link_next;
      if (!next) break;
      const nextUrl = toAbsoluteUrl(next, currentUrl);
      currentUrl = nextUrl;
      const html = await ctx.http.getText(nextUrl);
      currentData = extractPlayerData(html, nextUrl);
    }
    return episodes;
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
          const playerData = extractPlayerData(html, episode.playUrl);
          media.push({
            nid: episode.nid,
            label: episode.label,
            playUrl: episode.playUrl,
            m3u8Url: toAbsoluteUrl(playerData.url, episode.playUrl),
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
export const maccmsStuiAdapter = new MaccmsStuiAdapter();
