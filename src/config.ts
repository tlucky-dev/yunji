/**
 * 配置：默认值 < 用户级配置 < 工作目录配置 < 命令行参数，四级覆盖。
 * 用户级配置在 %APPDATA%\yunji\config.json（Windows）或 ~/.config/yunji/config.json（其它）；
 * 工作目录配置为执行命令时所在目录下的 yunji.config.json。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { DEFAULT_UA } from './core/http.js';

export interface YunjiConfig {
  /** 输出根目录 */
  outputDir: string;
  /** 单集内分片下载并发数 */
  concurrency: number;
  /** 同时下载的分集数（1 为逐集串行） */
  episodeConcurrency: number;
  /** 全部集下载完后，对失败集自动重试的轮数（间隔 20 秒，0 关闭） */
  episodeRetries: number;
  /** 播放页解析并发数 */
  pageConcurrency: number;
  /** 单次 HTTP 超时（毫秒） */
  timeoutMs: number;
  /** HTTP 重试次数 */
  retries: number;
  /** master playlist 码率选择：最高或第一个 */
  quality: 'highest' | 'first';
  /** 是否用 ffmpeg 转封装为 mp4（false 或 ffmpeg 缺失时输出 ts） */
  remux: boolean;
  /** ffmpeg 可执行文件路径 */
  ffmpegPath: string;
  /** 请求 UA */
  ua: string;
}

export const DEFAULT_CONFIG: YunjiConfig = {
  outputDir: path.join(process.cwd(), 'downloads'),
  concurrency: 8,
  episodeConcurrency: 1,
  episodeRetries: 2,
  pageConcurrency: 4,
  timeoutMs: 30_000,
  retries: 2,
  quality: 'highest',
  remux: true,
  ffmpegPath: 'ffmpeg',
  ua: DEFAULT_UA,
};

/** 用户级配置目录（跨目录运行命令时全局生效） */
export function userConfigDir(): string {
  const base = process.env.APPDATA || path.join(homedir(), '.config');
  return path.join(base, 'yunji');
}

/** 读取单个配置文件（不存在或写错返回空对象，保证不崩溃） */
function readConfigFile(file: string): Partial<YunjiConfig> {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>;
    // 忽略未知键与错误类型
    const known = Object.keys(DEFAULT_CONFIG) as (keyof YunjiConfig)[];
    const result: Record<string, unknown> = {};
    for (const key of known) {
      const value = parsed[key];
      if (value !== undefined && typeof value === typeof DEFAULT_CONFIG[key]) {
        result[key] = value;
      }
    }
    return result as Partial<YunjiConfig>;
  } catch {
    return {};
  }
}

/** 从用户级与工作目录加载配置并与默认值合并 */
export function loadConfig(cwd: string = process.cwd(), userDir: string = userConfigDir()): YunjiConfig {
  return {
    ...DEFAULT_CONFIG,
    ...readConfigFile(path.join(userDir, 'config.json')),
    ...readConfigFile(path.join(cwd, 'yunji.config.json')),
  };
}

/** CLI 提供的可覆盖项 */
export interface CliOverrides {
  outputDir?: string;
  concurrency?: number;
  episodeConcurrency?: number;
  episodeRetries?: number;
  timeoutMs?: number;
  retries?: number;
  quality?: 'highest' | 'first';
  keepTs?: boolean;
  ffmpegPath?: string;
  ua?: string;
}

/** 应用命令行参数覆盖 */
export function applyCliOverrides(config: YunjiConfig, overrides: CliOverrides): YunjiConfig {
  return {
    ...config,
    ...(overrides.outputDir !== undefined && { outputDir: path.resolve(overrides.outputDir) }),
    ...(overrides.concurrency !== undefined && { concurrency: overrides.concurrency }),
    ...(overrides.episodeConcurrency !== undefined && { episodeConcurrency: overrides.episodeConcurrency }),
    ...(overrides.episodeRetries !== undefined && { episodeRetries: overrides.episodeRetries }),
    ...(overrides.timeoutMs !== undefined && { timeoutMs: overrides.timeoutMs }),
    ...(overrides.retries !== undefined && { retries: overrides.retries }),
    ...(overrides.quality !== undefined && { quality: overrides.quality }),
    ...(overrides.keepTs !== undefined && { remux: !overrides.keepTs }),
    ...(overrides.ffmpegPath !== undefined && { ffmpegPath: overrides.ffmpegPath }),
    ...(overrides.ua !== undefined && { ua: overrides.ua }),
  };
}
