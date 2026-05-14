# har-collector-extension

一个 Chrome 浏览器扩展，通过 DevTools Protocol 捕获网络请求并导出为标准 HAR 文件。

## 功能

- 通过 Chrome DevTools Protocol 实时捕获网络请求（`Network.*` 事件）
- 多表 IndexedDB 架构：metadata 与 body 数据分离，自动分片（35MB/片）
- v1 → v2 自动数据迁移，保留旧版本数据
- 按需组装 body 数据，避免全量加载内存溢出
- 25MB 字节预算控制，规避 `chrome.runtime.sendMessage` 64MB 限制
- 直连 IndexedDB 下载：fallback 页面直接读取 IDB，消息通信仅作兜底
- 一键导出标准 HAR 文件（支持单文件合并 / 多文件拆分）
- Service Worker 保活，自动重连丢失的 debugger
- DevTools 冲突检测与通知
- 中英文多语言支持（自动跟随浏览器语言）
- 150+ 单元测试覆盖核心逻辑

## 目录结构

```
src/
  manifest.json         # 扩展清单（版本从 package.json 同步）
  _locales/             # 多语言资源
    en/messages.json    # 英文
    zh_CN/messages.json # 中文
  assets/               # 图标资源
  background/           # 后台 Service Worker（请求捕获 & IndexedDB 写入）
  fallback/             # 兜底下载页（直连 IndexedDB + 消息兜底）
    main.ts             # 页面逻辑
    har-builder-direct.ts # 直连 IndexedDB 的 HAR 构建函数
  popup/                # 弹窗界面
  lib/                  # 可测试的纯函数模块
    idb.ts              # 统一 IndexedDB 打开 & 升级处理
    idb-schema.ts       # v2 schema 常量与类型定义
    idb-cursor.ts       # 游标批量读取 + body 组装
    idb-migration.ts    # v1→v2 迁移逻辑
    har-builder.ts      # HAR entry 构建与估算
    streaming-har.ts    # 分块 HAR 构建器
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

### 数据流

```
网页请求 → DevTools Protocol (Network.*) → background Service Worker
  → IndexedDB (requests_meta + request_bodies)
  → fallback 页面直连读取 → 分块构建 HAR JSON → chrome.downloads 下载
```

### IndexedDB 设计（v2）

| Store | 键 | 说明 |
|-------|-----|------|
| `requests_meta` | `[tabId, requestId]` | 轻量 metadata，不含 body |
| `request_bodies` | `[tabId, requestId, bodyType, chunkIndex]` | body 数据，超大时分片存储 |
| `db_metadata` | `key` | 数据库版本追踪 |

Body 超过 35MB 自动分片，带 offset 字段，支持 UTF-8 边界安全切割。

### 下载路径

1. **主路径**：fallback 页面通过 `indexedDB` API 直接读取数据，在 tab 上下文中构建 HAR JSON，通过 `chrome.downloads` 下载，完全绕过 `chrome.runtime.sendMessage` 的 64MB 限制
2. **兜底路径**：通过 `chrome.runtime.sendMessage` 由 Service Worker 代为构建和发送

### saveHar 三层策略

数据校验 → offscreen 下载 → fallback 临时页（直连 IDB 优先 + 消息兜底）

### i18n

通过 `_locales` 目录提供多语言，`chrome.i18n.getMessage()` 获取本地化文本，自动跟随浏览器语言设置。

## 许可协议

[Apache License](LICENSE)
