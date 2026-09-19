#!/usr/bin/env node
import('../dist/src/cli/index.js').catch((err) => {
  console.error('加载 CLI 失败，请先执行 npm run build：', err?.message ?? err);
  process.exitCode = 1;
});
