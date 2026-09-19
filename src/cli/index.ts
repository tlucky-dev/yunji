/**
 * yunji（云集）命令行入口。
 *
 * 用法：
 *   yunji <url>                 解析并下载（默认整部剧，当前播放源）
 *   yunji <url> -e 1-8,12       指定集
 *   yunji <url> --list          仅列出解析结果
 *   yunji resume <剧集目录>      恢复中断的任务
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { Command, Option } from 'commander';
import '../sites/index.js';
import { applyCliOverrides, loadConfig, type YunjiConfig } from '../config.js';
import { createPlan, createPlanFromManifest, type Plan } from '../download/planner.js';
import { runPlan } from '../download/engine.js';
import { MultiEpisodeProgressRenderer, createLogger } from './ui.js';

const pkg = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf-8'),
) as { version: string };

interface CliOptions {
  episodes?: string;
  source?: string;
  output?: string;
  list?: boolean;
  concurrency?: string;
  episodeConcurrency?: string;
  timeout?: string;
  retries?: string;
  quality?: string;
  keepTs?: boolean;
  ffmpeg?: string;
  ua?: string;
}

/** 数字参数解析：非法输入（空串/非数字）回退为 undefined，取配置默认 */
function num(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function buildConfig(opts: CliOptions): YunjiConfig {
  return applyCliOverrides(loadConfig(), {
    outputDir: opts.output,
    concurrency: num(opts.concurrency),
    episodeConcurrency: num(opts.episodeConcurrency),
    timeoutMs: num(opts.timeout),
    retries: num(opts.retries),
    quality: opts.quality as 'highest' | 'first' | undefined,
    keepTs: opts.keepTs,
    ffmpegPath: opts.ffmpeg,
    ua: opts.ua,
  });
}

/** 打印剧集概览 */
function printSeriesHeader(plan: Plan, logger: ReturnType<typeof createLogger>): void {
  const { manifest } = plan;
  const source = manifest.sourceLabel ? `${manifest.sourceLabel}（源${manifest.sourceSid}）` : `源${manifest.sourceSid}`;
  logger.info(`剧集：${manifest.title}`);
  logger.info(`播放源：${source}`);
  logger.info(`总集数：${manifest.episodes.length}，本次下载：${plan.selected.length} 集`);
  logger.info(`输出目录：${plan.seriesDir}`);
}

/** --list：打印解析结果 */
function printListing(plan: Plan, logger: ReturnType<typeof createLogger>): void {
  printSeriesHeader(plan, logger);
  logger.info('');
  for (const ep of plan.manifest.episodes) {
    const status =
      ep.status === 'merged'
        ? '[已完成]'
        : ep.status === 'downloaded'
          ? '[半成品]'
          : '[待下载]';
    const mark = plan.selected.some((s) => s.nid === ep.nid) ? '*' : ' ';
    logger.info(` ${mark} #${String(ep.nid).padStart(3, '0')} ${ep.label.padEnd(8, ' ')} ${status}`);
  }
  logger.info('');
  logger.info('说明：* 表示本次将被下载的集（受 -e 表达式影响）。');
}

/** 注册 Ctrl+C 处理，返回 AbortController */
function installSignalHandlers(logger: ReturnType<typeof createLogger>): AbortController {
  const controller = new AbortController();
  const onSignal = () => {
    if (controller.signal.aborted) {
      process.exit(130);
    }
    logger.warn('收到中断信号，正在停止…（再次 Ctrl+C 强制退出；重新执行同一命令可续传）');
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return controller;
}

async function execute(plan: Plan, config: YunjiConfig, logger: ReturnType<typeof createLogger>): Promise<number> {
  const controller = installSignalHandlers(logger);
  const renderer = new MultiEpisodeProgressRenderer();
  try {
    const summary = await runPlan(plan, config, {
      log: logger,
      onEpisodeStart: (episode, totalSegments) => {
        renderer.begin(episode.nid, episode.label, totalSegments);
      },
      onProgress: (episode, p) => renderer.update(episode.nid, p),
      onEpisodeMerged: (episode, outputFile) => {
        renderer.remove(episode.nid);
        logger.success(`${episode.label} → ${outputFile}`);
        renderer.draw();
      },
      onEpisodeFailed: (episode, error) => {
        renderer.remove(episode.nid);
        logger.error(`${episode.label} 下载失败：${error.message}`);
        renderer.draw();
      },
    }, controller.signal);

    renderer.finish();
    const parts: string[] = [];
    parts.push(`完成 ${summary.merged}`);
    if (summary.skipped > 0) parts.push(`跳过已存在 ${summary.skipped}`);
    if (summary.failed > 0) parts.push(`失败 ${summary.failed}`);
    if (summary.interrupted > 0) parts.push(`未完成 ${summary.interrupted}`);
    const mark = summary.failed === 0 && summary.interrupted === 0 ? '✓' : '!';
    process.stderr.write(`${mark} 全部结束：${parts.join('，')}\n`);
    if (summary.interrupted > 0) return 130;
    if (summary.failed > 0) return 2;
    return 0;
  } finally {
    renderer.finish();
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  }
}

async function main(url: string | undefined, opts: CliOptions): Promise<number> {
  if (!url) {
    throw new Error('缺少网址参数。用法：yunji <url> [-e 1-8,12] [--list]');
  }
  const config = buildConfig(opts);
  const logger = createLogger();
  const plan = await createPlan(
    { inputUrl: url, source: opts.source, episodesSpec: opts.episodes, listOnly: opts.list },
    config,
    logger,
  );
  if (opts.list) {
    printListing(plan, logger);
    return 0;
  }
  printSeriesHeader(plan, logger);
  return execute(plan, config, logger);
}

async function resume(dir: string, opts: CliOptions): Promise<number> {
  const config = buildConfig(opts);
  const logger = createLogger();
  const seriesDir = path.resolve(dir);
  const plan = await createPlanFromManifest(seriesDir, config, logger);
  printSeriesHeader(plan, logger);
  return execute(plan, config, logger);
}

const program = new Command();

program
  .name('yunji')
  .description('云集 yunji —— 命令行视频下载器：解析剧集页面，定位 m3u8 资源并下载合并为 mp4（仅供个人学习）')
  .version(pkg.version);

program
  .argument('[url]', '剧集播放页 / 详情页 / m3u8 地址')
  .option('-e, --episodes <spec>', '选集表达式，如 1-8,12（默认整部剧）')
  .option('-s, --source <sid|名称>', '切换播放源（数字 sid 或源名，如“红牛”）')
  .option('-o, --output <dir>', '输出根目录（默认 ./downloads）')
  .option('--list', '仅解析并列出剧集，不下载')
  .addOption(new Option('--quality <type>', '码率选择').choices(['highest', 'first']))
  .option('--concurrency <n>', '单集内分片下载并发数（默认 8）')
  .option('-E, --episode-concurrency <n>', '同时下载的分集数（默认 1，逐集串行）')
  .option('--timeout <ms>', '单请求超时毫秒')
  .option('--retries <n>', '请求重试次数')
  .option('--keep-ts', '不转封装，保留 ts 文件')
  .option('--ffmpeg <path>', 'ffmpeg 可执行文件路径')
  .option('--ua <ua>', '自定义 User-Agent')
  .action(async (url: string | undefined, opts: CliOptions) => {
    try {
      process.exitCode = await main(url, opts);
    } catch (err) {
      createLogger().error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program
  .command('resume')
  .description('从已有任务清单的剧集目录恢复下载')
  .argument('<dir>', '剧集输出目录')
  .option('--concurrency <n>', '单集内分片下载并发数（默认 8）')
  .option('-E, --episode-concurrency <n>', '同时下载的分集数（默认 1，逐集串行）')
  .option('--timeout <ms>', '单请求超时毫秒')
  .option('--retries <n>', '请求重试次数')
  .option('--keep-ts', '不转封装，保留 ts 文件')
  .option('--ffmpeg <path>', 'ffmpeg 可执行文件路径')
  .action(async (dir: string, opts: CliOptions) => {
    try {
      process.exitCode = await resume(dir, opts);
    } catch (err) {
      createLogger().error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });

program.parseAsync();
