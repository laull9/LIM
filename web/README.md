# LIM Web

LIM 的标准 Web 聊天客户端。界面按潮汐主题实现：深色为「涨潮」，浅色为「退潮」，左侧导轨带有缓慢漂移的波浪动效。功能上支持使用设备令牌进入已分配的 `host` 会话、查看历史、双向收发和断线恢复；会话和设备由服务操作员预先配置，界面明确标明「宿主可读」。

## 启动双端 demo

在仓库根目录执行以下命令。示例使用 macOS arm64 的 Debug 产物，其他平台请传入实际的 `lim-server` 可执行文件路径。启动脚本使用 Python 3.11+。

```sh
xmake build lim-server
pnpm --dir web install --frozen-lockfile
python3 web/demo.py build/xmake/macosx/arm64/debug/lim-server
```

打开 [本地客户端](http://127.0.0.1:5173/)，在两个标签页分别粘贴终端输出的 Alice 和 Bob 设备令牌。打开同一个会话后，两端可以互发消息。脚本启动独立的临时 SQLite 数据库，创建两个设备和一个会话，并写入两条示例消息。`Ctrl+C` 停止服务并清理临时数据库，`--web-port` 可指定其他端口。

已有 `lim-server` 时，在 `web/` 执行 `pnpm dev`，然后输入已配置且分配了会话的设备令牌。Vite 默认转发到 `http://127.0.0.1:7400`，也可在启动时设置 `LIM_SERVER_URL`。浏览器前进后退可用：会话地址是 `/c/{conversation_id}`。

```sh
LIM_SERVER_URL=http://127.0.0.1:7400 pnpm dev
```

## 技术选型

| 层 | 选择与职责 |
| --- | --- |
| 基础 | React 19、TypeScript 6（`strict`）、Vite 8；沿用现有脚手架。开发与 CI 使用 Node.js 26 LTS 和 pnpm 11，以 `pnpm-lock.yaml` 锁定依赖。 |
| 路由与布局 | React Router 声明式路由，支持会话链接和浏览器前进后退。桌面并列展示导轨、会话目录、消息区与可选的信息面板，窄屏在目录与消息之间切换。 |
| 消息列表 | React Virtuoso（MIT 许可的 `react-virtuoso`）渲染可变高度的消息列表。向上加载历史时保持阅读位置，位于底部时跟随新消息。[Virtuoso API](https://virtuoso.dev/react-virtuoso/api-reference/virtuoso/) · [许可](https://virtuoso.dev/pricing/) |
| 基础组件 | shadcn/ui 的 Radix 版本提供按钮、输入框、菜单、弹层与对话框，源码按需引入。[shadcn/ui 的 Vite 安装指南](https://ui.shadcn.com/docs/installation/vite) |
| 样式 | Tailwind CSS 4 通过 `@tailwindcss/vite` 接入，用于布局与响应式规则；`index.css` 定义潮汐色板（`--tide`、`--coral`、`--rail` 等）并映射到 Tailwind 主题，CSS Modules 承载消息、输入器和侧栏的局部样式。[Tailwind CSS 与 CSS Modules](https://tailwindcss.com/docs/compatibility#css-modules) |
| 协议 | 原生 `fetch` 与 `AbortController`，使用 Zod 4 校验 RPC 响应。TypeScript 协议模块独立于 React，统一解析错误、UUID 和十进制字符串序号。序号比较使用 `bigint`。 |
| 数据 | IndexedDB + Dexie 存储消息、同步游标和待发队列；通过 `dexie-react-hooks` 订阅本地查询。`chat/store.tsx` 把会话目录、时间线和同步状态收敛为一个上下文。 |
| 验证 | `pnpm lint` 检查代码，`pnpm build` 检查 TypeScript 并打包。浏览器联调使用 Playwright 和真实 `lim-server`。 |

## 源码结构

| 路径 | 职责 |
| --- | --- |
| `src/App.tsx` | 入口页（设备令牌）与工作区外壳，组合导轨、目录和消息区。 |
| `src/chat/protocol.ts` | JSON-RPC、长轮询与错误语义，不含 React。 |
| `src/chat/sync.ts` | 历史补齐、长轮询循环与待发消息投递。 |
| `src/chat/storage.ts` | Dexie 表结构、游标推进和本地时间线。 |
| `src/chat/store.tsx` | 把上述能力组合成 `ChatProvider`，暴露目录、时间线与操作。 |
| `src/components/*` | 导轨、会话目录、会话头部、消息气泡、输入器、信息面板与波浪装饰。 |
| `src/theme.ts`、`src/ThemeProvider.tsx` | 退潮／涨潮外观切换，按设备记忆选择。 |

## 同步与部署

- 首版用 `POST /rpc` 完成设备验证、会话目录、发送和事件补齐，活动会话通过 `/v1/conversations/{id}/wait` 等待新消息。前台每 30 秒刷新目录，重连及页面重新可见时立即对账。收到提示时按已保存的游标拉取，切换会话或退出时取消旧等待。服务端支持 WebSocket 后，同步层可接入新的提示来源，继续沿用相同的补齐流程。[JSON-RPC](../docs/rpc.md) · [长轮询契约](../docs/protocol.md#http-长轮询)
- 同步层把收到的连续事件与游标写入同一个 IndexedDB 事务。发送前先保存原始正文、内容类型和 `client_message_id`。超时后按原键和原文重试，恢复代次变化时停止旧请求自动重发。缓存按设备和恢复代次隔离，设备令牌仅保存在内存，重新加载后先验证设备身份再恢复同步。
- `pnpm build` 生成 `dist/`。生产由 TLS 反向代理同源提供静态文件，并转发 `/rpc` 和 `/v1/` 到回环上的 `lim-server`。界面路由回退到 `index.html`。开发时用 Vite 代理复用相同的 API 路径。[Vite 静态部署](https://vite.dev/guide/static-deploy)
- MLS 接入以项目共用的密码库选型和浏览器环境验证为前置条件。浏览器端将按协议原子保存 MLS 状态、事件处理进度和待发密文。[加密与信任设计](../docs/security.md#多设备-历史与状态持久化)

## 客户端行为

- 会话列表显示服务端 UUID 的短尾号、完整编号和最新序号；标题与头像底色都由 UUID 派生。搜索框支持按编号过滤，`⌘K`（Windows 为 `Ctrl+K`）聚焦搜索框。
- 消息区按发送设备分组显示。自己的消息贴右侧、使用潮水绿气泡；其他设备贴左侧并显示设备短号。气泡下方显示服务端序号，待发消息显示等待、已发送或失败原因，悬停消息可复制正文。
- 首次打开会话加载最近 48 条可见消息，列表顶部的波浪分隔提示「这里是潮水的起点」或可继续打捞更早消息。刷新后先再次验证设备身份，再打开待发消息所属的会话继续发送。
- 右上角信息面板显示会话的可见起点、最新序号、恢复代次、账号与设备，以及本地同步游标（起点、已补齐位置、向上边界），并可触发加载更早消息、刷新目录或重新同步。
- 导轨可在涨潮（深色）与退潮（浅色）之间切换，选择写入 `localStorage`；设备菜单提供刷新目录与断开设备。
- 浏览器中的宿主可读消息和待发内容保存在本机 IndexedDB。关闭标签页或退出设备会清除内存中的令牌。本地缓存可通过浏览器的站点数据设置清除。

## 构建检查

```sh
pnpm lint
pnpm build
```
