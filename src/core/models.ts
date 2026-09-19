/**
 * 核心领域模型：剧集、分集、媒体资源。
 */

/** 单集引用（来自站点选集列表，此时还不知道 m3u8 地址） */
export interface EpisodeRef {
  /** 集的序号（播放页 URL 中的 nid，是站点内稳定的集索引） */
  nid: number;
  /** 页面上展示的集名，如 “第01集” */
  label: string;
  /** 该集播放页的绝对地址 */
  playUrl: string;
}

/** 一次解析得到的剧集信息（限同一播放源） */
export interface SeriesInfo {
  /** 站点内部剧集 id（MacCMS vod id） */
  vodId: string;
  /** 剧名 */
  title: string;
  /** 播放源序号（MacCMS sid） */
  sourceSid: number;
  /** 播放源展示名，如 “红牛云播” */
  sourceLabel?: string;
  /** 解析所依据的播放页地址 */
  pageUrl: string;
  /** 该源下全部剧集（按 nid 升序） */
  episodes: EpisodeRef[];
}

/** 已定位到 m3u8 的单集 */
export interface EpisodeMedia {
  nid: number;
  label: string;
  playUrl: string;
  /** 该集视频的 m3u8 地址（master 或媒体播放列表） */
  m3u8Url: string;
}

/** 站点适配器需要实现的接口 */
export interface SiteAdapter {
  /** 适配器名称，如 “maccms-stui” */
  name: string;
  /** 判断该 URL 是否归此适配器处理（不得发起网络请求） */
  match(url: URL): boolean;
  /** 解析剧集信息；opts.source 用于切换播放源（sid 数字或源名） */
  resolveSeries(url: URL, opts: { source?: string }, ctx: SiteContext): Promise<SeriesInfo>;
  /** 并发解析一批分集的 m3u8 地址；失败的分集跳过并在结果里报告 */
  resolveEpisodeMedia(episodes: EpisodeRef[], ctx: SiteContext): Promise<{
    media: EpisodeMedia[];
    failures: { episode: EpisodeRef; error: Error }[];
  }>;
}

/** 传给适配器的运行上下文 */
export interface SiteContext {
  http: {
    getText(url: string): Promise<string>;
  };
  log: {
    warn(msg: string): void;
    info(msg: string): void;
  };
  /** 播放页解析并发数 */
  pageConcurrency?: number;
}
