# har-collector-extension

一个 Chrome 浏览器扩展，通过 DevTools Protocol 捕获网络请求并导出为标准 HAR 文件。

## 功能

- 通过 Chrome DevTools Protocol 实时捕获网络请求
- 数据持久化到 IndexedDB，支持离线缓存
- 一键导出标准 HAR 文件
- 兜底下载机制：offscreen 不可用时自动回退到临时页下载
- Service Worker 保活，自动重连丢失的 debugger
- DevTools 冲突检测与通知
- 中英文多语言支持（自动跟随浏览器语言）

## 目录结构

```
src/
  manifest.json         # 扩展清单
  _locales/             # 多语言资源
    en/messages.json    # 英文
    zh_CN/messages.json # 中文
  assets/               # 图标资源
  background/           # 后台 Service Worker
  offscreen/            # 离屏文档（Blob 下载）
  fallback/             # 兜底下载页
  popup/                # 弹窗界面
  lib/                  # 可测试的纯函数模块
  __tests__/            # 单元测试
```

## 安装与开发

1. 克隆仓库
   ```bash
   git clone https://github.com/kekxv/har-collector-extension.git
   cd har-collector-extension
   ```

2. 安装依赖
   ```bash
   pnpm install
   ```

3. 本地开发
   ```bash
   pnpm run dev
   ```

4. 打包发布
   ```bash
   pnpm run build
   ```

5. 运行测试
   ```bash
   pnpm test          # watch 模式
   pnpm run test:run  # 一次性运行
   ```

6. 加载到 Chrome
   - 打开 `chrome://extensions/`
   - 开启「开发者模式」
   - 点击「加载已解压的扩展程序」，选择 `dist` 目录

## 架构

- **background**: 管理 debugger 生命周期，通过 `Network.*` 事件捕获请求/响应，存储到 IndexedDB
- **popup**: 控制开关、显示计数、触发导出，支持多语言
- **offscreen**: 创建 Blob URL 触发下载（优先路径）
- **fallback**: offscreen 不可用时的兜底临时页，通过 storage/消息请求 HAR 数据后下载
- **saveHar 三层策略**: 数据校验 → offscreen 下载 → fallback 临时页
- **i18n**: 通过 `_locales` 目录提供多语言，`chrome.i18n.getMessage()` 获取本地化文本

## 许可协议

[Apache License](LICENSE)
