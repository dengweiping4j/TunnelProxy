# TunnelProxy 项目说明文档

> 本文档基于当前代码（package.json version = 1.0.4）整理，用于后续功能迭代时对照。
> 阅读顺序建议：第 1~3 节建立全局认识，第 4~6 节是改代码时必须遵守的契约，第 7 节是已知坑，第 8 节是「要做什么改动就改哪里」的清单。

---

## 1. 项目概览

一个 Electron 桌面工具，把「端口转发」这件事做成图形界面，支持两种模式：

| 模式 | 内部 type 值 | 数据流 | 底层实现 |
| --- | --- | --- | --- |
| 正向转发 | `forward` | 本机 `localPort` ←→ 远端 `remoteHost:remotePort` | Node `net` 模块写的**纯 TCP 代理**（本机监听 + 直连目标） |
| 反向 SSH | `reverse-ssh` | 远端 `remoteBindHost:remotePort` → 本机 `127.0.0.1:localPort` | `ssh2` 库 `forwardIn` 反向隧道 |

⚠️ 注意一个和 README 不一致的事实：**正向转发不经过 SSH，不加加密**，它只是把 `remoteHost:remotePort` 直连结果挂到本机端口上（等价于 socat / 本地 TCP 代理）。只有反向模式才真正使用 SSH。README 里「Uses SSH tunneling for secure port forwarding」这句对正向模式不成立，迭代时不要被误导。

另外一个 README 里宣称但**代码中完全不存在**的功能：Chrome DevTools Inspector 调试。全仓库只有 `electron/main.js:267` 开发模式下打开 Electron 自带 DevTools 这一处，没有 `9222` 之类的远程调试端口、没有 Inspector 相关逻辑。

### 技术栈

| 层 | 选型 |
| --- | --- |
| 壳 | Electron 28（CommonJS，`package.json` 无 `"type": "module"`） |
| 主进程 | Node `net` / `child_process` / `fs`，`ssh2@1`，`electron-store@8` |
| 渲染层 | React 18 + Vite 5 |
| UI 组件 | antd 5（`Table/Form/Card/Modal/Tag/message/Popconfirm/Select`）+ Tailwind 3（`important: true`、`preflight: false`、`darkMode: class`） |
| 国际化 | i18next + react-i18next，zh / en 两份词条 |
| 打包 | electron-builder 24，GitHub Actions 三平台构建 + 自动发 Release |

依赖分层有个小别扭：`antd` 被放在 `devDependencies`（`package.json:38`），但它被 `src/index.css` 直接 import 进了渲染层产物。能跑通是因为 Vite 在构建期把 antd 打进了 `dist/`，但语义上它应该是 `dependencies`。

---

## 2. 目录结构与文件职责

```
TunnelProxy/
├─ electron/
│  ├─ main.js          # 主进程全部逻辑：窗口、托盘、IPC、转发服务、持久化（877 行，单文件）
│  └─ preload.js       # 通过 contextBridge 暴露 window.electron.ipcRenderer
├─ src/
│  ├─ index.jsx        # 真正的渲染入口（index.html 引用的是它）
│  ├─ index.js         # ❌ 死文件：React 17 的 ReactDOM.render 写法，且没 import './i18n'
│  ├─ App.jsx          # 唯一页面组件：表单 + 规则表格 + 编辑弹窗（627 行，单组件）
│  ├─ i18n.js          # i18next 初始化，语言取 localStorage.language，默认 zh
│  ├─ index.css        # antd reset + Tailwind 指令 + 大量 antd 样式覆写
│  ├─ locales/{zh,en}.js  # 各 53 条词条
│  └─ assets/icons/    # 多尺寸图标（含 icon.ico / icon.icns），打包时作为 extraResources 输出到 resources/icons
├─ resources/icons/    # 仅 16x16.png、32x32.png，开发期托盘图标的兜底路径
├─ index.html          # Vite 入口，含主题初始化脚本（dark class）
├─ vite.config.js      # Vite + vite-plugin-electron（main/preload 产物到 dist-electron/）
├─ package.json        # 脚本 + electron-builder 配置（"build" 字段）
├─ electron-builder.json5  # ❗第二份打包配置，与 package.json 的 "build" 内容冲突，见 7.5
├─ .github/workflows/release.yml  # 三平台构建并发布 Release
├─ TRAY_FEATURES.md    # 托盘功能说明（仅文档）
├─ README.md / README-zh.md
├─ update.bat          # 一键 git add/commit/push，提交信息固定 'debug-workflow'
└─ test-build.js       # ❌ 空文件（1 字节）
```

一句话总结职责划分：**所有业务逻辑都在 `electron/main.js`，所有 UI 都在 `src/App.jsx`**，两者通过 IPC 通信。没有状态管理库、没有路由、没有测试。

---

## 3. 开发与构建

### 3.1 npm scripts

| 命令 | 实际内容 | 说明 |
| --- | --- | --- |
| `yarn dev` | `vite --mode development` | ✅ 唯一可用的开发命令。Vite 启动 dev server(5173) 并由 vite-plugin-electron 拉起 Electron |
| `yarn build` | `vite build` | 产出 `dist/`（渲染层）+ `dist-electron/`（main、preload） |
| `yarn start` | `electron-vite dev` | ❌ **不可用**：依赖里没有 `electron-vite`，也没有 `electron.vite.config.js` |
| `yarn preview` | `vite preview` | 只预览渲染层，没有 Electron 壳 |
| `yarn pack` | `electron-builder --dir` | 免安装目录版 |
| `yarn dist` | `vite build && electron-builder` | 当前平台安装包 |
| `yarn build:win` / `:linux` / `:mac` / `build:all` | 对应平台打包 | `build:win` = `npm run build && electron-builder --win --x64` |

> `build:win` 内部用的是 `npm run build`，仓库里同时存在 `yarn.lock`（`.yarnrc.yml` 指定 `nodeLinker: node-modules`）——混用包管理器会带来依赖树不一致的风险，建议统一为 yarn。

### 3.2 产物路径与图标约定

- 渲染层：`dist/index.html` → 主进程用 `loadFile(path.join(__dirname, '../dist/index.html'))` 加载（`electron/main.js:270`）。
- 主进程/preload：`dist-electron/main.js`、`dist-electron/preload.js`（`package.json` 的 `main` 指向前者）。
- 运行时资源：`getResourcePath()`（`electron/main.js:61`）统一处理——开发期从 `src/assets/` 找、找不到再退到 `resources/`；打包后从 `process.resourcesPath` 找，即需要 `resources/icons/*` 存在。
- **本地打包前置条件**：`build/icon.ico` 不存在时 electron-builder 只会警告并用默认图标；CI 里专门有一段从 `src/assets/icons/icon.ico` 复制过去的步骤（`release.yml:37-61`）。本地要出正确图标就自己先复制一份到 `build/`（注意 `build` 在 .gitignore 里）。
- 数据文件：`app.setPath('userData', appData + '/port-forwarder')`（`electron/main.js:44`），所以规则文件是 `%APPDATA%/port-forwarder/port-forwarding-rules.json`。调试「规则不干净」的问题时直接删这个文件即可。

### 3.3 CI（.github/workflows/release.yml）

push 到 main（忽略 md/gitignore/LICENSE）或手动触发 → Windows / Linux / macOS 三平台并行构建 → 全部成功后用 `package.json` 的 version 打 tag 并创建 Release（tag 已存在则跳过）。

- Windows job 额外做了资源校验：`win-unpacked/resources/icons/{icon.ico,32x32.png,16x16.png}` 必须存在且非空，否则失败。这三张图正是 `package.json` 里 `extraResources` 从 `src/assets/icons` 复制过去的。
- **发版流程 = 改 `package.json` 的 `version` → push 到 main**。tag 是 CI 自动打的。

---

## 4. 进程模型与 IPC 契约

```
┌────────────────────────── Electron 主进程 (electron/main.js) ──────────────────────────┐
│  状态：forwardingServers: Map<id, net.Server>   sshClients: Map<id, ssh2.Client>       │
│  持久化：electron-store → forwardings: Rule[]                                          │
│                 ▲ ipcMain.on / handle                 │ event.reply                     │
└─────────────────┼─────────────────────────────────────┼───────────────────────────────┘
                  │                                     ▼
      preload.js  contextBridge → window.electron.ipcRenderer
                  │                                     │
┌─────────────────┴─────────────────────────────────────┴───────────────────────────────┐
│  React 渲染层（App.jsx）：全量规则列表 = 单一数据源，靠事件推送刷新                    │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 渲染层 → 主进程

| 通道 | 方式 | 参数 | 主进程行为 |
| --- | --- | --- | --- |
| `start-forwarding` | `send` | `{remoteHost, remotePort, localPort}` | 建/补规则（id 由主进程算）→ `net.createServer().listen(localPort,'0.0.0.0')` |
| `start-reverse-ssh` | `send` | `{sshHost, sshPort, sshUser, sshPassword, authType, keyPath, remoteBindHost, remotePort, localPort, id?}` | 建/补规则 → ssh2 连接 → `forwardIn` |
| `stop-forwarding` | `send` | `id` | destroy 客户端、`server.close()`、规则置 `stopped` |
| `stop-reverse-ssh` | `send` | `id` | `client.end()`、规则置 `stopped` |
| `delete-forwarding` | `send` | `id` | 从 store 移除 + 关掉对应 server/client |
| `edit-forwarding` | `send` | `{oldId, newRule}` | 用 `newRule` **整体替换**（`{...newRule}`，不合并）并关掉旧连接 |
| `get-forwarding-rules` | `invoke` | — | 返回全部规则数组（渲染层首屏加载用） |

### 4.2 主进程 → 渲染层（事件推送）

| 通道 | 载荷 | 触发时机 |
| --- | --- | --- |
| `forwarding-status` | `{id, status, error?}` | 启动成功/失败、连接错误、停止、SSH 断开 |
| `forwarding-rules-updated` | `Rule[]` | 任何写 store 的地方（启动成功、server error、停止、删除、编辑） |

> 关键点：`forwarding-rules-updated` 是**全量数组**，渲染层直接 `setForwardings(rules)`；`forwarding-status` 是**单条 patch**，渲染层按 id merge（`App.jsx:131`）。新增状态变更时，两条通道的分工要保持一致。
>
> ⚠️ 主进程在「应用启动自动恢复规则」时是以 `event = null` 调用的（`electron/main.js:339-363`），此时 `updateStatus` 不会 reply——所以**启动阶段的重连状态变化不会推给界面**，界面只会显示 store 里存的旧状态。这是已知的行为缺口，见 7.2。

### 4.3 preload 暴露面

`preload.js` 暴露的是**通用**的 `send / on / invoke / removeAllListeners`，而不是按业务收敛的 API（例如 `startForwarding(params)`）。加上 `webPreferences.nodeIntegration: true`（`electron/main.js:214`），渲染层一旦被注入脚本就等于拿到完整 Node 能力。当前 UI 不加载任何远端内容，风险可控，但新增「打开外部网页/加载远端资源」类功能前应先收窄这里。

`ipcRenderer.on` 的封装返回**取消订阅函数**，渲染层 useEffect 的清理依赖它（`App.jsx:50`、`App.jsx:139`）——改 preload 时不要破坏这个返回值。

---

## 5. 数据模型与持久化

`store.get('forwardings')` 是一个数组，元素为下面两种形态之一。

### 5.1 type = `forward`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `` `${remoteHost}:${remotePort}->${localPort}` `` |
| `type` | string | `'forward'`（编辑后可能丢失此字段，见 7.3） |
| `remoteHost` / `remotePort` / `localPort` | string \| number | 端口来自 antd `Input type="number"`，**是字符串**，主进程用 `parseInt` 转换 |
| `status` | `'stopped' \| 'running' \| 'error'` | |
| `error` | string \| null | 运行期错误信息 |
| `createdAt` | ISO string | 仅新建时写入（编辑后丢失） |

### 5.2 type = `reverse-ssh`

| 字段 | 说明 |
| --- | --- |
| `id` | `` `${sshHost}:${remotePort}<-${localPort}` ``（注意箭头方向与 forward 相反） |
| `sshHost` / `sshPort` / `sshUser` / `sshPassword` | SSH 连接信息 |
| `authType` | `'password'`（UI 只会传这个）；`'key'` 主进程支持但界面没有入口 |
| `keyPath` | 私钥绝对路径，仅 `authType='key'` 时使用 |
| `remoteBindHost` | 远端监听地址。UI 固定写死 `'127.0.0.1'`，主进程默认 `'0.0.0.0'` |
| `remotePort` / `localPort` / `status` / `error` / `createdAt` | 同上 |

> 🔐 **SSH 密码是本文件明文存储的**（`port-forwarding-rules.json` 未加密）。任何「导出规则 / 分享规则 / 云同步」类新功能都必须先处理这一点，否则等于把凭据打出去。

### 5.3 状态机

```
stopped ──start-forwarding / start-reverse-ssh──▶ running ──stop-*──▶ stopped
   ▲                                                 │
   └──────────────stop-* / delete────────────────────┴──▶ error（端口占用、连接失败、认证失败…）
```

`error` 状态的规则**只能停止或删除，不能直接重新启动**（`App.jsx:293` 的逻辑：非 running 就显示「启动」按钮，所以其实可以点——但主进程 `forwardingServers` / `sshClients` 里可能还残留旧对象，导致重启被 `has(id)` 提前 return，见 7.4）。

---

## 6. 关键流程

### 6.1 正向转发（start-forwarding）

1. `startForwarding()`（`electron/main.js:395`）用参数拼 id，store 里没有就补一条 `status:'stopped'` 的规则。
2. `forwardingServers.has(id)` 就 return（幂等保护）。
3. `net.createServer` 中每个本地连接都新建一条到 `remoteHost:remotePort` 的 outbound（`timeout: 5000`），双向 `pipe`；任一方向 close/error 都 `cleanup()` 同时销毁两端。
4. `server.listen(localPort, '0.0.0.0')` 成功后 store 置 `running`，并通过 `forwarding-status` + `forwarding-rules-updated` 回复。
5. 监听失败（典型 `EADDRINUSE`）→ store 置 `error` + 回复错误信息。

⚠️ 监听地址硬编码 `0.0.0.0`（`electron/main.js:497`），意味着**同一局域网内任何人都能访问你的本地转发端口**。如果后续要做「仅本机」，这里要改成可配置。

### 6.2 反向 SSH（start-reverse-ssh）

1. `startReverseSSH()`（`electron/main.js:537`）解构参数，id 优先用入参 `id`（编辑后的规则靠它保持一致）。
2. 根据 `authType` 组装 `connConfig`：`password` 用 `sshPassword`；`key` 读 `keyPath` 文件（先 `fs.existsSync`）；两者都不满足 → 直接置 `error`：「缺少认证信息」（`electron/main.js:670`）。
3. `conn.on('ready')` → `conn.forwardIn(remoteBindHost, remotePort)`；失败通常意味着服务端 `AllowTcpForwarding no` 或端口被占用/无权限。
4. `conn.on('tcp connection')` → `accept()` 拿到流，再 `net.createConnection('127.0.0.1', localPort)`，双向 pipe。**本地服务没起来不会报错，只是每个连接立即断开**——排查时容易误判。
5. `keepaliveInterval: 60000 / keepaliveCountMax: 3`；`error`/`end` 时置 `error`/`stopped` 并清理 Map。

### 6.3 应用启动自动恢复

`app.whenReady()`（`electron/main.js:317`）顺序：清缓存 → 建托盘 → 建窗口 → 遍历 store，**把 `status === 'running'` 的规则重新拉起**。

`rule.type || 'forward'` 是兼容老数据的分支（早期版本没有 type 字段）。因为调用时 `event = null`，恢复结果不回传界面（见 4.2 的缺口）。

### 6.4 编辑规则（最容易踩坑的一条链路）

渲染层 `handleEditSubmit`（`App.jsx:163`）→ 计算 `newId` → 查重 → 若正在运行先 `stop-*` → `edit-forwarding`。

主进程只是 `{...newRule}` 覆盖，因此：
- `status` 被强制成 `stopped`（即使原来在运行，也符合「编辑即停止」的预期）；
- `createdAt`、`error` 被丢掉；
- **正向规则编辑后 `type` 字段消失**（`App.jsx:187-193` 的 newRule 没写 type）；
- **反向规则只能改 host/port，改不了用户名、密码、密钥、远端绑定地址**（`App.jsx:170-182` 从旧记录继承）。

新增「可编辑字段」时，`handleEdit`（回填）、`handleEditSubmit`（提交）、编辑弹窗表单三处要同步改。

### 6.5 托盘与窗口生命周期

- 关闭窗口 ≠ 退出：`close` 事件被拦截改成 `hide()`，并首次弹出气泡提示（`electron/main.js:240`）。
- `window-all-closed` 不做任何事 → 常驻托盘（macOS/Windows/Linux 一致）。
- 托盘菜单：显示主窗口 / 隐藏到托盘 / 转发规则管理 / 关于 / 退出程序；Windows 下单击图标即切换显示。
- 「关于」用 `webContents.executeJavaScript` 里 `require('../package.json').version` 取版本号（`electron/main.js:145`）——这段代码在渲染上下文执行，相对路径解析不可靠，建议改为 `app.getVersion()` 后拼接。这是重构点，不是紧急 bug。
- 退出：`before-quit` 里销毁托盘、关闭所有 server 与 SSH client（`electron/main.js:848`）。

### 6.6 国际化

- `App.jsx` 用 `t('中文 key 风格')`，key 本身是英文短语；词条在 `src/locales/{zh,en}.js` 的 `translation` 下。
- 语言持久化在 `localStorage.language`，切换在顶栏 Select（`App.jsx:354`）。
- 主进程的托盘菜单、对话框文案是**硬编码中文**，不受语言切换影响（托盘菜单在 6.5 中构建，未接 i18n）。要做多语言托盘需要新增 IPC 或启动时读取语言偏好。

---

## 7. 已知问题清单（迭代前先读）

### 7.1 功能缺陷

| # | 问题 | 位置 | 说明 |
| --- | --- | --- | --- |
| 1 | 添加规则后模式选择器与实际提交模式不一致 | `App.jsx:394-399`、`App.jsx:95` | `form.resetFields()` 会把 `type` 字段重置为挂载时的 `initialValue`（`'forward'`），但 `mode` state 仍是 `'reverse-ssh'`，于是下拉显示「正向转发」、表单却仍是 SSH 布局，且提交走 reverse 分支。**每次添加完规则都会复现。** |
| 2 | 表单校验前端与后端不一致 | `App.jsx:441-470` | 端口是 `Input type="number"`，没有 1~65535 范围校验，也没有「本地端口是否已被其它规则占用」的检查（重复时只能靠 `EADDRINUSE` 报错） |
| 3 | 添加/启动/停止/删除的成功提示是"预支"的 | `App.jsx:96,111,121,242` | 这些是 fire-and-forget 的 `send`，`message.success` 在真实结果返回前就弹了。真实结果只体现在表格状态列 |
| 4 | 4 个错误提示 key 缺词条 | `App.jsx:99,115,125,245` 用 `Add failed` / `Stop failed` / `Delete failed` / `Start failed` | `locales/{zh,en}.js` 里都没有，i18next 回退成显示 key 本身（英文原文），弹窗文案突兀 |
| 5 | Popconfirm 的 `okText` 用了 `t('OK')` | `App.jsx:324` | 同样缺词条，中文界面会显示 "OK"（可接受但不算规范） |
| 6 | 反向隧道指向的本地服务未启动时无提示 | `electron/main.js:616` | `net.createConnection('127.0.0.1', localPort)` 失败只打 console，界面看不到原因，排查成本高 |

### 7.2 状态同步缺口

主进程自动恢复（6.3）时 `event = null`，`forwarding-status` 不会推送。界面首屏读 store 拿到的可能仍是 `running`，而实际连接已经失败。修法：把「恢复完成」的结果通过已有的 `mainWindow.webContents.send` 广播，或让恢复也走一个持久的 webContents 引用（注意 `event.reply` 依赖发起方，恢复流程没有发起方）。

### 7.3 数据完整性

- `edit-forwarding` 的 `{...newRule}` 整体替换会丢 `createdAt` / `error`，正向规则还会丢 `type`（靠 `rule.type || 'forward'` 兜底才没出问题）。
- 删除规则时用的是 `filter`，没有二次确认兜底（UI 有 Popconfirm，主进程没有校验）。

### 7.4 资源清理不彻底

`server.on('error')`（`electron/main.js:479`）和 `conn.on('error')`（`electron/main.js:644`）只把状态写成 `error`：
- 正向：失败的 server 已被塞进 `forwardingServers`（`set` 在 `listen()` 之后立即执行），Map 里留着僵尸对象，再次启动会被 `has(id)` 提前 return；
- 反向：`sshClients.delete(id)` 有做，但 `reverseSshProcesses` 是死变量（见 7.6）；
- 结果：处于 `error` 的规则点「启动」可能无声无效。建议在 error 分支里统一 `Map.delete(id)`。

### 7.5 打包配置重复且互相矛盾（重要）

仓库里**同时存在两份 electron-builder 配置**：`package.json` 的 `"build"` 字段和根目录的 `electron-builder.json5`。electron-builder 会自动探测 `electron-builder.json5`，所以存在「哪一份生效」的歧义，而两者的关键字段是冲突的：

| 字段 | package.json → build | electron-builder.json5 |
| --- | --- | --- |
| `files` | `dist/**/*`、`dist-electron/**/*`、`node_modules/**/*` | `dist-electron`、`dist` |
| `extraResources` | 有（`src/assets/icons` → `resources/icons`，`build/*.png` → 资源根） | ❌ 完全没有 |
| Windows target | nsis，x64 + arm64 | nsis，仅 x64 |
| `requestedExecutionLevel` | `asInvoker` | `requireAdministrator` |
| `asar` | 未声明 | `true` |
| Linux / macOS | 有完整 target 列表 | ❌ 没有 |

两者不一致的后果很直接：主进程 `getResourcePath` 打包后依赖 `resources/icons/*`，而这份资源只有 `package.json` 的 `extraResources` 提供；CI 的构建后校验（`release.yml:76-93`）也断言这三个图标文件必须存在。也就是说**必须有 extraResources 生效，打包才算成功**。

**建议**：以 `electron-builder.json5` 为准合并成一份（把 `extraResources`、多平台 target、`requestedExecutionLevel` 一次性对齐并明确取舍），删掉 `package.json` 里的 `build` 字段。这是迭代前优先清理的技术债——否则改打包行为时会出现「改了没生效」的幽灵问题。

> 顺带一提：`update.bat` 的提交信息固定为 `'debug-workflow'`，且它会在任何改动下 `git add .`——发版前请手动确认提交内容，别用它做正式提交。

### 7.6 死代码

| 位置 | 内容 |
| --- | --- |
| `electron/main.js:4` | `const { spawn } = require('child_process')` 从未使用（早期用 `ssh -R` 子进程实现的残留） |
| `electron/main.js:57` | `const reverseSshProcesses = new Map()` 从未被读写 |
| `src/index.js` | React 17 写法的死入口，`index.html` 引用的是 `index.jsx` |
| `test-build.js` | 空文件 |
| `src/locales/*.js` | 已定义但界面未使用：`Remote Host user@host example`、`Example`、`Connection error`、`Stop error`、`Type`、`Key`、`Agent`、`Private Key Path (optional)`、`Remote Bind Host`（后四个是密钥认证/远端绑定功能预留的词条） |

---

## 8. 迭代配方：要改什么就动哪里

### 8.1 给规则增加一个字段（最常做的改动）

以「增加 `localBindHost`」为例，**按顺序全部改完才不会有漏**：

1. `src/locales/zh.js` + `en.js`：加文案 key（保持两份同步）。
2. `src/App.jsx` 表单：加 `Form.Item name="localBindHost"`（注意 `mode === 'reverse-ssh'` 时是否显示）。
3. `src/App.jsx:handleSubmit`：把字段塞进 `send('start-forwarding' | 'start-reverse-ssh', {...})`。
4. `src/App.jsx:handleStart`：**从规则记录回填**（否则「启动」会丢字段）。
5. `src/App.jsx:handleEdit` + `handleEditSubmit` + 编辑弹窗：回填、提交、以及「反向规则继承旧字段」的分支（`App.jsx:170-182`）。
6. `electron/main.js` 对应 `startForwarding` / `startReverseSSH` 参数解构 + 落库对象字段。
7. `electron/main.js:339-363` 启动恢复分支：把新字段透传进去（最容易漏的一处）。
8. 若字段影响 UI 展示，补 `columns` 定义（`App.jsx:254`）。

### 8.2 在界面开放密钥认证

后端已经完整支持，只差 UI：主进程 `authType === 'key'` 分支（`electron/main.js:667`）会 `fs.readFileSync(keyPath)`。
需要做：表单加「认证方式」Select（password / key）+ 条件渲染的 `keyPath` 输入；`handleSubmit` 传 `authType` / `keyPath`；编辑弹窗允许改；词条已有（`Key`、`Private Key Path (optional)`）。注意 `ssh2` 的 `privateKey` 支持带 passphrase 的 key（需要额外 `passphrase` 字段），要一并设计。
`Agent` 词条也在，但主进程没有 `agent: 'pageant'|'ssh-agent'` 配置——如果要支持 SSH Agent，得在 `connConfig` 里加 `agent` 并向 `ssh2` 传 `agent`（Windows 用 Pageant 需 `agent: 'pageant'`）。

### 8.3 开放远端绑定地址（支持 GatewayPorts 外网访问）

当前 UI 写死 `remoteBindHost: '127.0.0.1'`（`App.jsx:80/178/229`），所以 README 里提到的 `GatewayPorts yes` 场景在界面上**根本走不到**。
改法：加一个「远端绑定主机」输入（默认 `127.0.0.1`，可填 `0.0.0.0`），按 8.1 的清单贯穿。词条 `Remote Bind Host` 已存在。

### 8.4 新增一个 IPC 通道的检查清单

1. `electron/main.js`：`ipcMain.on(...)`（单向）或 `ipcMain.handle(...)`（需要返回值）。
2. 所有状态写入后，**同时**发 `forwarding-status`（单条 patch）和 `forwarding-rules-updated`（全量数组）——渲染层的两个 useEffect 分别依赖它们。
3. 若在渲染层发起，用 `safeReply(event, ...)` 而不是直接 `event.reply`（防止窗口销毁后抛异常）。
4. 用 `try/catch` 包住并把失败也回复给界面，否则界面会永远停在旧状态。
5. 渲染层：`window.electron.ipcRenderer.send/invoke`；若需要接收，用 `on()` 并**在 useEffect 里调用返回的 unsubscribe**。
6. preload 无需改动（它是通用转发）。

### 8.5 新增 i18n 词条

1. `zh.js` 和 `en.js` 同时加（key 用英文短语，与现有风格一致）。
2. 代码里 `t('English key')` 引用。
3. 主进程（托盘/对话框）文案目前无法通过 i18n 切换，需要走 IPC 或在主进程内读 `localStorage` 等价的偏好存储——新建功能时注意这个边界。

### 8.6 发布新版本

1. 合并 7.5 的打包配置（先做一次，避免后续踩坑）。
2. 改 `package.json` 的 `version`。
3. push 到 main → CI 三平台构建 → 自动打 tag `v{version}` + Release。
4. 本地出安装包：确保 `build/icon.ico` 存在，然后 `yarn build:win`。

---

## 9. 文档债务（README 与代码的差异）

| README 宣称 | 代码实际 |
| --- | --- |
| 支持 Chrome DevTools Inspector 实时调试 | ❌ 无任何实现（仅开发模式打开 Electron DevTools） |
| 「多种认证方式：密码和密钥」 | 后端有，UI 只有密码输入框 |
| 「使用 SSH 隧道保证安全」 | 只对 reverse-ssh 成立；forward 是明文 TCP 代理 |
| `GatewayPorts yes` 可用于外网访问 | UI 写死 `127.0.0.1`，走不到该场景 |
| 规则持久化 + 重启恢复 | ✅ 成立，但恢复结果不回推界面（7.2） |
| 托盘常驻、多规则并存 | ✅ 成立（见 TRAY_FEATURES.md） |

迭代时建议：**要么补实现，要么改文案**，不要长期让 README 承诺未被实现的能力。

---

## 10. 建议的迭代顺序

**第一优先（改动小、收益大、防踩坑）**
1. 合并两份 electron-builder 配置（7.5）。
2. 修 `App.jsx` 模式选择器与 `mode` state 脱节的问题（7.1-1），顺手去掉 `Form.Item name="type"` 的冗余绑定，直接用 `Select value={mode}`。
3. 补 4 个错误提示词条 + `OK`（7.1-4/5），并把「预支成功提示」改成依据 `forwarding-status` 的结果提示（7.1-3）。
4. error 分支统一清理 Map 中的僵尸对象（7.4）。

**第二优先（补齐已有能力）**
5. UI 开放密钥认证（8.2）与远端绑定地址（8.3）。
6. 端口范围校验 + 本地端口占用检查（7.1-2）。
7. 打开「仅本机监听」选项，替换硬编码的 `0.0.0.0`（6.1）。

**第三优先（结构性）**
8. 拆分 `electron/main.js`（转发引擎 / SSH 引擎 / store / IPC / 托盘分文件），`App.jsx` 拆出 `RuleForm`、`RuleTable`、`EditModal`。
9. 引入主进程状态推送的统一出口（解决 7.2，并为将来的通知/日志面板打基础）。
10. 凭据加密存储（若要做导出/同步功能，必须先做）。
11. 补最小可用测试：主进程的 `startForwarding` / `startReverseSSH` 可脱离 Electron 单测（把 `store` 与 `safeReply` 作为依赖注入）。

---

## 附录 A：IPC 通道速查

```
# 渲染层 → 主进程（send，单向）
start-forwarding      {remoteHost, remotePort, localPort}
start-reverse-ssh     {sshHost, sshPort, sshUser, sshPassword, authType, keyPath, remoteBindHost, remotePort, localPort, id?}
stop-forwarding       id
stop-reverse-ssh      id
delete-forwarding     id
edit-forwarding       {oldId, newRule}

# 渲染层 → 主进程（invoke，有返回）
get-forwarding-rules  → Rule[]

# 主进程 → 渲染层（事件）
forwarding-status        {id, status, error?}
forwarding-rules-updated Rule[]
```

## 附录 B：常见故障对照

| 现象 | 排查方向 |
| --- | --- |
| 规则点了启动没反应 / 状态仍是 error | 端口被占用（`EADDRINUSE`）；或 7.4 的僵尸 Map 对象导致提前 return；确认端口未被其它程序占用 |
| 反向规则报「端口转发失败」 | 服务端 `AllowTcpForwarding` 是否为 yes；`remotePort` 是否已被占用；`remoteBindHost=0.0.0.0` 时服务端是否允许（需 `GatewayPorts yes`，且部分系统权限不足） |
| 反向规则报「缺少认证信息」 | `authType='key'` 但 `keyPath` 不存在/不可读；或密码为空 |
| 隧道建好了但访问不通 | reverse 模式下本地服务必须监听在 `127.0.0.1:localPort`（隧道固定回连本机回环地址） |
| 打包后托盘图标不显示 | `resources/icons/32x32.png` 是否存在（依赖 extraResources，见 7.5） |
| 规则数据脏了 | 删除 `%APPDATA%/port-forwarder/port-forwarding-rules.json` |
