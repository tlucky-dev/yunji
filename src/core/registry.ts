/**
 * 站点适配器注册表：按 URL 选择处理适配器。
 * 新增站点时实现 SiteAdapter 并在此注册即可。
 */
import type { SiteAdapter } from './models.js';

const adapters: SiteAdapter[] = [];

export function registerAdapter(adapter: SiteAdapter): void {
  adapters.push(adapter);
}

/** 根据 URL 找到处理它的适配器；找不到时抛出带提示的错误 */
export function resolveAdapter(url: URL): SiteAdapter {
  const adapter = adapters.find((a) => a.match(url));
  if (!adapter) {
    throw new Error(
      `无法识别的网址：${url.href}\n` +
        `当前支持的站点适配器：${adapters.map((a) => a.name).join('、')}。` +
        `也可能是尚未实现的站点类型。`,
    );
  }
  return adapter;
}

/** 已注册的适配器名（用于错误提示与 --help 输出） */
export function registeredAdapterNames(): string[] {
  return adapters.map((a) => a.name);
}
