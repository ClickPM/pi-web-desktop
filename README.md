# pi-web-desktop（Pi）

把 [pi-web](https://github.com/agegr/pi-web)（pi 编程智能体的网页界面，npm 包 **`@agegr/pi-web`**）打包成一个**开箱即用的桌面应用**：
双击即用，没有浏览器、没有地址栏、没有常驻终端窗口，**目标机器无需预装任何运行时**。

它不只是「pi-web 套壳」——而是一台**电池全含的 AI 工作站**：内置 Node 与 Python 两套运行时，拷到空电脑双击即可使用。

**核心特性**
- 🧳 **内置 Node + Python 运行时** —— 目标机器无需 Node/npm/Python，拷到空电脑双击即用。
- ⚡ **就地运行，首启秒开** —— 直接从（可写的）安装目录跑 pi-web，不做首启复制。
- 🔄 **运行时自更新** —— App 内「检查更新」直接装 `@agegr/pi-web@latest`（npm 包自带预构建 `.next`，免编译），独立更新 pi-web + pi-coding-agent，**无需重新发版、不碰外壳代码**。安装走 **staging + 校验通过才原子换入**，更新失败/断网/中途被杀都不会损坏正在用的运行时。
- 🩺 **启动自检与自愈** —— 每次启动先验证运行时的原生模块是否真的能加载；发现是安装被中断留下的残缺文件，自动按锁定版本重装修复（不趁机升级），而不是让用户对着 `server not ready in time` 干瞪眼。
- 🐍 **零依赖 Python 环境** —— 内置 Python 支持离线工具与脚本；环境守卫强制用户项目走干净的 `.venv`。
- 🪟 **原生窗口** —— 内嵌 Next.js 服务隐藏运行在随机 `127.0.0.1` 端口，关窗即停。

## 目录结构

```
pi-web-desktop/
├── electron/
│   ├── main.js         # 主进程:解析运行时、起内置 node 服务、开窗、检查更新、注入 Python 环境、退出清理
│   ├── updater.js      # npm 层:用内置 npm 查询版本 / 装到指定目录(installInto)
│   ├── runtime-guard.js # 运行时完整性:启动校验、staging 安装、原子换入、崩溃恢复
│   ├── preload.js      # 最小安全桥(contextIsolation 开启)—— 自定义能力的暴露入口
│   ├── features/       # directory-picker / native-theme 等外壳后端逻辑
│   ├── loading.html / updating.html / healing.html / error.html
│   └── ui/             # ★ 自定义能力的前端页面(可选,见「开发约束」)
├── vendor/node/        # 内置 Node.js 运行时(node.exe + npm) → resources/node            ← 构建输入(npm run seed:node)
├── vendor/python/      # 内置 Python(python-build-standalone) → resources/python        ← 构建输入(npm run seed:python)
├── runtime-seed/       # @agegr/pi-web 的 npm 生产安装(含 .next) → resources/runtime-seed ← 构建输入(npm run seed)
├── scripts/            # seed-node.ps1(供给 vendor/node)
│                       # + seed-python.ps1 + vendor-python-requirements.txt(供给 vendor/python)
│                       # + test-runtime-guard.js(运行时守卫 / 版本比较回归测试,npm run test:guard)
├── build/              # 应用图标的 SVG 源 + 生成脚本(_make_icons.js)与产物(png/ico)
├── electron-builder.yml
└── package.json
```

> **构建输入 vs 入库源码**:`vendor/`、`runtime-seed/` 都体积大、已 gitignore,需按[下文](#从零准备构建输入)重新准备。本地若存在 `pi-web/` 目录,那是已退役的 fork 工作副本(`cking000bigdemon/pi-web`,曾发布为 `@cking000/pi-web`),桌面端已回归上游包,不再是构建输入。

## 应用身份与图标

应用叫 **Pi**（`productName`，`package.json` 和 `electron-builder.yml` 各一份——前者决定 dev 模式的 `userData`，后者决定打包产物）。`appId` 保持 `com.agegr.piwebdesktop` **不变**，这样新安装包是就地升级，而不是并排装两份。

> **名字必须匹配 `/^[-_+0-9a-zA-Z .]+$/`。** electron-builder 只在 `productName` 满足这个正则时拿它当安装目录名，否则回退用 package.json 的 `name`，NSIS 的 `instFilesPre` 发现 `$INSTDIR` 里不含那个串就再追加一层。

图标由 `build/_make_icons.js` 从 SVG 一次生成全部 PNG + ICO（借 pi runtime 的 sharp，外壳不新增依赖；ICO 是 hand-rolled PNG-compressed 格式，sharp 没有 ico 编码器）：

| 资源 | 用在哪 | 长什么样 |
|---|---|---|
| `icon.*` | 应用身份：exe / 安装包 / 快捷方式 / 窗口图标 | 奶白底色的精致几何 Pi 标志 |

> **升级数据迁移**：Electron 的 `userData` 路径来自 `productName`。若用户从历史测试版本（`Pi Agent`、`Pi Dsh` 或 `Pi&Dsh`）升级过来，`main.js` 的 `migrateLegacyUserData()` 在启动时会一次性自动搬运扩展状态（`extensions-state.json`）与主题偏好（`theme-state.json`），实现无感平滑升级。

## 运行架构

1. **解析运行时目录**（`runtimeDir()`）：
   - 安装目录里的 `resources/runtime-seed` **可写** → **就地运行**（默认，秒开，无复制）；
   - 只读（如装到 `C:\Program Files`）→ 回退：用 **robocopy**（长路径安全）把种子复制到 `%APPDATA%/pi-web-desktop/runtime`，写 `.seeded` 标记（只复制一次）。
2. **运行时完整性预检**（`runtime-guard.js`，在启动服务之前）：
   - 先用 swap 日志把**上次中断的原子切换**收敛掉（完成向前 or 回滚，绝不会留下"运行时目录不存在"）；
   - 再校验运行时是否真的能用：结构文件（`next` CLI / `.next/BUILD_ID` / react）、**本平台**原生模块能否 `require`（在内置 node 的**子进程**里探测——主进程 require 既会因 ABI 不同而失配，也会锁住 DLL 导致后续切换失败）、以及 `node_modules` 里有没有 npm 的 `.<包名>-<随机>` 临时目录（安装被中断的指纹）；
   - 判定为**可修复**（文件截断/缺失）→ 自动走下面第 6 步同一条原子安装路径重装**当前锁定版本**（不趁机升级）；判定为环境问题（ABI 不符、缺系统 DLL）→ 直接报错，不做无意义的重装循环。
3. **同步默认扩展与技能**（启动时，非阻塞、失败不挡启动）：
   - 扩展：**首次启动弹选择器**让用户勾选装哪些，之后每次启动做**非破坏性同步**（不覆盖用户改过的文件），见下「内置的扩展与技能」；
   - `ensureBundledSkills()` 把技能同步进 `~/.pi/agent/skills/`（见下「内置的扩展与技能」）。
4. **注入 Python 环境**：spawn pi 服务时，把 `vendor/python` 前置到 `PATH` 并设 `PI_BUNDLED_PYTHON` / `PI_PY_GUARD_PYTHON` / `PI_PY_GUARD_BUNDLED_PYTHON`，供环境守卫与 `ppt-master` 使用。
5. **启动服务**：用 `resources/node/node.exe` 跑 `next start`，绑定 `127.0.0.1` 随机空闲端口，隐藏窗口、无控制台。
6. **加载窗口**：轮询服务就绪后 `loadURL` 到该端口。
7. **检查更新**（菜单 `App → 检查更新…`，或启动后自动静默检查）：用内置 npm `view` 对比版本，有新版则**原子安装**：
   - 装进兄弟目录 `.runtime-seed.staging`（同卷，保证 rename 是原子移动），**期间旧服务照常运行**；
   - 用与第 2 步**完全相同**的校验做验收，不通过就丢弃 staging，线上运行时**一字节不动**；
   - 通过后才停服务 → `rename` 换入（失败自动回滚）→ 重启服务并刷新窗口。
   - 自愈与更新共用**同一把锁**，不会并发；刚自愈过 2 分钟内会跳过这次自动检查，避免让用户连等两次安装。
8. **退出**：`taskkill /T`（Windows）结束服务进程树，不留僵尸进程。

> 第 2、7 步的机制由 `electron/runtime-guard.js` 实现，回归测试 `npm run test:guard`。
> 背景：早先"就地 `npm install`"被中断过两次，把正在使用的 `@next/swc-*.node` 写成了截断文件（PE 头合法、尾部缺失），Windows 拒绝加载 → `next.config.ts` 加载失败 → 服务起不来，用户只看到无从下手的 `server not ready in time`。

数据目录沿用 pi 的 `~/.pi/agent`（会话、`models.json`、模型凭证），与终端 `pi`、全局 `pi-web` 共享。

## 安装注意（首启是否秒开取决于安装目录）

| 装到哪 | 可写? | 首启 |
|---|---|---|
| **默认位置** `%LOCALAPPDATA%\Programs\pi-web`，或任意用户可写目录（如 `D:\Apps\pi-web`） | 是 | **就地运行，秒开** |
| `C:\Program Files\...`（无管理员权限时只读） | 否 | 回退复制运行时种子到 AppData，**首次约 1–2 分钟**（仅第一次，之后秒开） |

> 安装时**保持默认目录**即可秒开。装到 Program Files 不是坏掉，只是首启被迫做一次复制。
> `ppt-master` 首次部署约上万文件（含图标库）到 `~/.pi/agent/skills/`，约十几秒，仅第一次；之后靠 `.seed-version` 签名秒级跳过。

## 目标机器需要装什么?

- **不需要 Node / npm / Python**（已全部内置）。
- 需要在 App 内配置一个**模型提供商的 API Key**（侧边栏 Models / 登录面板）才能真正对话；空机器首次没有任何凭证。
- `ppt-master` 的 **AI 配图**需要 provider key（默认占位模式，无 key 也能出 deck；要真配图，复制技能内 `.env.example` 到 `~/.ppt-master/.env` 填 key）。
- 更新功能、首次模型调用、联网取数需要**联网**。
- 仅 **Windows x64**（内置运行时为 win-x64）；未签名，SmartScreen 提示「未知发布者」点「仍要运行」。

## 从零准备构建输入

```powershell
# 1. 安装 Electron 壳依赖
npm install

# 2. 运行时种子(@agegr/pi-web 生产安装,含预构建 .next)
mkdir runtime-seed; cd runtime-seed; npm init -y
npm install @agegr/pi-web@latest --omit=dev --registry=https://registry.npmmirror.com
cd ..

# 3. 内置 Node 运行时(win-x64) —— 全自动
npm run seed:node

# 4. 内置 Python(win-x64) —— 全自动
npm run seed:python
```

> 之后日常只需 `npm run seed` 把运行时种子升到最新发布版再打包。

## 开发 / 运行

```bash
npm start
```

开发态直接就地从项目里的 `runtime-seed` 运行，**秒开**；关窗自动结束后台服务。
排障：主进程把关键步骤写到 `%TEMP%/pi-web-desktop-debug.log`（看 `ensureBundledExtensions/Skills done`、`startOrRestartServer returned ok`）。

可选环境变量：
- `PI_WEB_REGISTRY` —— 自更新使用的 npm registry（默认 `https://registry.npmmirror.com`）。
- `PI_WEB_AUTO_UPDATE_CHECK=0` —— 关闭启动后的自动检查更新。
- `PI_CODING_AGENT_DIR` —— 指定 pi 会话数据目录（默认 `~/.pi/agent`）。

**开发默认扩展**：改 `extensions-seed/*.ts` 后 `npm start`。注意扩展同步现在是**非破坏性**的——只有 `~/.pi/agent/extensions/` 里那份仍与上次部署时一模一样（你没手改过）才会被刷新；否则你的版本被保留，只在「扩展管理」里标「有新版可用」。**开发时更省事的做法**：直接在 `~/.pi/agent/extensions/` 里改（不会再被启动覆盖了），改完再拷回 `extensions-seed/` 入库；或者在扩展管理里点「恢复内置版本」强制拉取仓库版（会先备份你的改动）。
新增一个扩展：把 `.ts` 放进 `extensions-seed/` **并在 `extensions-seed/manifest.json` 里登记**（未登记的文件不会被部署，也不出现在选择器里）；`default: true` 的新扩展会在用户升级后自动装上。新增/变更 npm 依赖则改 `extensions-seed/package.json` + 在 manifest 对应条目的 `deps` 里声明，然后跑 `npm run seed:extensions`。
**开发默认技能**：改 `skills-seed/<skill>/`，`npm start` 启动时按 `.seed-version` 签名同步进 `~/.pi/agent/skills/`（文件 mtime 变即重新部署）；Python 技能用 `$PI_BUNDLED_PYTHON` 调用脚本，新增重依赖请加进 `scripts/vendor-python-requirements.txt` 并 `npm run seed:python` 重供给。

## 打包安装程序

确保图标产物已生成（`node build/_make_icons.js`），且 `vendor/node`（`npm run seed:node`）、`vendor/python`（`npm run seed:python`）、`runtime-seed` 已就绪，然后：

```bash
npm run dist        # 生成 dist/Pi Setup x.x.x.exe (NSIS)
npm run dist:dir    # 仅生成解包目录(调试更快)
```

> 国内首次打包会从 npmmirror 拉 electron / nsis 二进制（`.npmrc` 已配镜像）。
> 若遇 winCodeSign「无法创建符号链接」，是 Windows 软链权限问题——预先手动解压其缓存即可。

---

## 开发约束（加新能力必读）

> **本仓库只开发 Electron 外壳层。pi-web 和 pi-coding-agent 一律以上游 npm 包形式获取，本仓库不包含、不修改它们的源码。**

职责严格分离：

| 归属 | 职责 | 改动流向 |
|---|---|---|
| **上游 [agegr/pi-web](https://github.com/agegr/pi-web)** | pi-web 网页端本身的功能/页面/接口 | 需要改 pi-web 时给上游提 PR → 上游合并发版 → 本项目 `runtime-seed` / 自更新从 npm 拉到 |
| **本仓库 pi-web-desktop** | Electron 外壳：窗口、内置运行时、自更新、IPC、自定义能力 | 在 `electron/` 改 → 重新打包安装程序 |

**两条铁律：**

1. **pi-web 的任何修改不在本仓库做**——通用改动给上游 [agegr/pi-web](https://github.com/agegr/pi-web) 提 PR，合并发版后由 `runtime-seed` / 自更新吃到。**绝不在本仓库或 `runtime-seed` 里直接改 pi-web 源码 / `.next`**——那会被下一次 `npm install @agegr/pi-web@latest` 冲掉。
2. **pi-web 和 pi-coding-agent 只从上游 npm 获取**：
   - pi-web = 上游 **`@agegr/pi-web`**；
   - pi-coding-agent = 上游 **`@earendil-works/pi-coding-agent`**（作为 pi-web 的依赖随之安装，**不 fork、不改**）。
   - 本仓库不 vendoring、不内联它们的源码；`runtime-seed` 只是这两个 npm 包的一次生产安装。

> **历史注**：2026-06~07 期间桌面端曾消费自有 fork `@cking000/pi-web`（Metro 磁贴皮肤 + 若干修复，仓库 [cking000bigdemon/pi-web](https://github.com/cking000bigdemon/pi-web)）。fork 的两个功能性修复（扩展工具丢失、slash 命令面板）先后被上游 0.6.18 / 0.7.0 吸收后，2026-07-21 桌面端回归上游包，fork 退役（仅 DMIT 健康助手部署仍在用）。

### 分层与红线

```
你拥有、随便改 ─┐  electron/ · scripts/                                  ← 本仓库
                │
pi-web 的功能  ─┤  给上游 agegr/pi-web 提 PR → 上游发版 @agegr/pi-web
                │
内置运行时     ─┤  resources/node · resources/python
                │
只读、不在此改 ─┘  resources/runtime-seed = @agegr/pi-web(npm 包) · ~/.pi 数据目录
```

- ✅ **本仓库允许**：在 `electron/` 下加能力（Node 全权限）、加 IPC、加 preload API、加 UI。
- ✅ **pi-web 的改动**：给上游提 PR，合并发版后这里通过升级 npm 包吃到。
- ❌ **禁止**：在本仓库 / `runtime-seed` 里改 pi-web 源码或编译产物；fork、修改或内联 `@earendil-works/pi-coding-agent`。
- 需要"后端能力"且不属于 pi-web 网页层时，放在 **Electron main 里用 IPC 暴露**（等价于你自己的后端）。

### 外壳层新能力三件套

1. **数据访问** —— 放 `electron/features/<name>.js`。取数优先**直接读 `~/.pi`**（稳定），或用内置 node `spawn` 运行时里的 `pi` CLI 兜底。
2. **暴露通道** —— `ipcMain.handle("<域>:<动作>", …)` + `preload.js` 里 `contextBridge.exposeInMainWorld("piDesktop", { … })`。pi-web 本体不受影响。
3. **展示界面** —— 三选一（按耦合度）：菜单 + 独立窗口（推荐，零耦合）/ preload 注入悬浮入口（体验一体，依赖注入点）/ 托盘 · 全局快捷键（轻量触发）。

### 升级安全

- 你的 `electron/` 全在外壳层，自更新只换 `runtime-seed`，**碰不到**。
- pi-web 的修复/功能走上游 PR；上游发版后 `npm run seed`（打包）或应用内「检查更新」（已装机器）即可跟进。

---

## 已知取舍

- **安装包体积**：内置 Node + Python + 运行时种子，约 **360MB**；换来空电脑「装完即用、零依赖」。
- **只读目录安装首启较慢**（复制运行时种子，仅第一次）；可写目录安装则秒开。
- **Python 仅 Windows x64**（与 `vendor/node` 一致）；mac/linux 暂未捆绑 Python。
- **自更新粒度**是 pi-web 这一层；Electron 外壳（含内置运行时）更新仍需重新发安装包。
- **定制受限**：不再持有 fork，pi-web 层的改动需上游接受 PR 才能获得（换来零同步维护成本；历史 Metro 定制版存于 `cking000bigdemon/pi-web`，已退役）。
