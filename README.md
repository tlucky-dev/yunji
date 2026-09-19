# 云集 yunji — 命令行视频下载器

> 追的剧，云集于此。

从影视站的剧集页面解析出真实视频资源（m3u8），分段下载、解密并合并为 mp4。

**仅供个人学习与离线备份使用，请勿用于任何商业用途或二次分发；请尊重版权。**

## 特性

- 输入播放页网址即可解析整部剧：剧名、播放源、全集列表一次拿到
- 直连 m3u8 下载，无需浏览器与第三方解析接口
- 支持 HLS 标准：master/媒体两级播放列表、AES-128 加密（显式 IV 与按分片序号推导）、`EXT-X-MAP`（fMP4 初始化段）、`EXT-X-BYTERANGE`
- 分片并发下载 + 重试，单集下载完后用 ffmpeg 无重编码转封装为 mp4
- **集级并行**：`--episode-concurrency` 同时下载多集，每集一条独立进度条
- **断点续传**：进程被杀 / Ctrl+C 中断后，重新执行同一命令自动跳过已完成分片与分集
- 多播放源支持（`--source` 切换），Windows 非法字符文件名清洗，重复集名自动去重
- 输出 `downloads/<剧名>/<剧名>-第01集.mp4` 结构，任务清单 `.yunji-manifest.json` 随目录保存

## 安装

要求 Node.js ≥ 20；ffmpeg 可选（用于 ts→mp4 转封装，缺失时保留 .ts 文件）。

```bash
npm install
npm run build
npm link        # 可选：注册全局命令 yunji
```

## 使用

```bash
# 下载整部剧（输入任意一集的播放页地址，默认当前播放源全集）
yunji "https://www.maliys.com/yun/11757-3-1.html"

# 只下载第 1 集
yunji "https://www.maliys.com/yun/11757-3-1.html" -e 1

# 指定集：1-8 集和第 12 集；15- 表示 15 到最后
yunji "..." -e 1-8,12
yunji "..." -e 15-

# 先看看解析结果，不下载
yunji "..." --list

# 切换播放源（红牛/天堂/暴风/量子/索尼……sid 或源名）
yunji "..." -s 1
yunji "..." -s 红牛

# 其他常用参数
yunji "..." -o D:/Videos              # 输出根目录
yunji "..." --concurrency 16          # 单集内分片并发数（默认 8）
yunji "..." -E 3                      # 同时下载 3 集（--episode-concurrency 短写）
yunji "..." --quality first           # master 列表选第一个变体（默认最高码率）
yunji "..." --keep-ts                 # 不转封装，保留 ts
yunji "..." --ffmpeg D:/tools/ffmpeg.exe

# 中断后恢复（通常直接重跑原命令即可，无需 resume）
yunji resume "downloads/赘婿"

# 直接给 m3u8 地址也可以
yunji "https://cdn.example.com/play/AbCd/index.m3u8"
```

退出码：`0` 成功；`2` 有分集失败；`130` 被中断（可续传）；`1` 参数/解析错误。

## 配置文件

偏好写进配置文件后，命令行就只需 `yunji <网址>`。加载优先级：

**默认值 < 用户级配置 < 工作目录配置 < 命令行参数**

- 用户级配置（全局生效，推荐放常用偏好）：`%APPDATA%\yunji\config.json`（Windows）或 `~/.config/yunji/config.json`
- 工作目录配置（仅该目录生效）：`./yunji.config.json`

```json
{
  "outputDir": "D:/Videos",
  "concurrency": 12,
  "episodeConcurrency": 3,
  "timeoutMs": 30000,
  "retries": 2,
  "quality": "highest",
  "remux": true,
  "ffmpegPath": "ffmpeg",
  "ua": "Mozilla/5.0 ..."
}
```

## 工作原理

以 MacCMS V10 + stui 模板站点（如 maliys.com）为例，实测解析链路：

```
播放页 /{prefix}/{vodId}-{sid}-{nid}.html
  └─ 页面内嵌 var player_data = {...}
       url / url_next：直连 m3u8（encrypt 0 明文 / 1 unescape / 2 unescape+base64）
       vod_data.vod_name：剧名；sid：播放源
  └─ m3u8 两种形态：
       ① 平铺媒体列表（部分源 AES-128 加密，密钥就在列表同目录，明文可取）
       ② master → variant 两级列表
  └─ 分片下载 → AES-128-CBC 解密（node:crypto）→ 顺序合并 → ffmpeg -c copy 转 mp4
```

全链路不依赖任何第三方“解析接口”，与浏览器播放器（hls.js）使用同一套标准 HLS 流程。

## 项目结构

```
src/
├── cli/          命令定义、进度条与日志
├── config.ts     默认值 < yunji.config.json < 命令行参数
├── core/         http 封装（UA/超时/重试/字符集）、类型、适配器注册表
├── sites/        站点适配器（maccms-stui 通用模板，可扩展其它站点）
├── hls/          m3u8 解析、AES-128 解密、分片并发下载
├── download/     任务规划、清单（断点续传）、下载编排、合并转封装
└── util/         文件名清洗、选集表达式
test/             单元测试（node:test）
```

## 开发

```bash
npm run dev      # 免编译运行（tsx）
npm run build    # tsc 编译到 dist/
npm test         # 编译 + 单元测试
npm run lint     # eslint
```

## 已知边界

- 不处理 DRM 加密（Widevine 等）与需要第三方解密接口的站点；播放列表声明非 AES-128 加密时明确报错
- 仅实现了 MacCMS 系站点适配器：stui 模板（player_data）、原生/ewave 模板（player_aaaa）均已实测适配，其它 MacCMS 模板走通用链接扫描兜底；非 MacCMS 站点在 `src/sites/` 实现 `SiteAdapter` 并注册即可
- 部分老站的选集“第X集”标签本身有误（同一集名出现两次），本工具按站点内部集号（nid）为准，文件名自动去重
