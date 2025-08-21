# har-collector-extension

一个用于保存 HAR 文件的浏览器扩展。

## 功能

- 捕获并保存浏览器网络请求的 HAR 文件
- 简洁的弹窗界面
- 支持离线处理

## 目录结构

```
src/
  manifest.json         # 扩展清单
  assets/               # 图标资源
  background/           # 后台脚本
  offscreen/            # 离屏页面
  popup/                # 弹窗页面
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

## 许可协议

[Apache License](LICENSE)