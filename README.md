# pi-web-desktop（Pi Agent）

把 [pi-web](https://github.com/agegr/pi-web)（pi 编程智能体的网页界面，npm 包 **`@agegr/pi-web`**）打包成一个**开箱即用的桌面应用**：
双击即用，没有浏览器、没有地址栏、没有常驻终端窗口，**目标机器无需预装任何运行时**。

它不只是「pi-web 套壳」——而是一台**电池全含的 AI 工作站**：内置 Node 与 Python 两套运行时、13 个默认扩展、一套 OKF 知识库技能（编译 / 查询 / 检查 / 可视化）和 PPT 生成技能 `ppt-master`，拷到空电脑双击即可使用。

**核心特性**
- 🧳 **内置 Node + Python 运行时** —— 目标机器无需 Node/npm/Python，拷到空电脑双击即用。
- ⚡ **就地运行，首启秒开** —— 直接从（可写的）安装目录跑 pi-web，不做首启复制。
- 🔄 **运行时自更新** —— App 内「检查更新」直接装 `@agegr/pi-web@latest`（npm 包自带预构建 `.next`，免编译），独立更新 pi-web + pi-coding-agent，**无需重新发版、不碰外壳代码**。安装走 **staging + 校验通过才原子换入**，更新失败/断网/中途被杀都不会损坏正在用的运行时。
- 🩺 **启动自检与自愈** —— 每次启动先验证运行时的原生模块是否真的能加载；发现是安装被中断留下的残缺文件，自动按锁定版本重装修复（不趁机升级），而不是让用户对着 `server not ready in time` 干瞪眼。
- 🧩 **默认扩展随装** —— 13 个 pi 扩展每次启动从仓库同步进 `~/.pi/agent/extensions/`，仓库为唯一真源。
- 📚 **默认技能随装** —— OKF 知识库技能 + `ppt-master` 演示文稿生成，每次启动同步进 `~/.pi/agent/skills/`，所有工作目录可用。
- 🐍 **零依赖 Python 技能** —— 内置 Python 让 Python 技能「装完即用、离线零 pip」；环境守卫强制用户项目走干净的 `.venv`。
- 🪟 **原生窗口** —— 内嵌 Next.js 服务隐藏运行在随机 `127.0.0.1` 端口，关窗即停。

## 目录结构

```
pi-web-desktop/
├── electron/
│   ├── main.js         # 主进程:解析运行时、起内置 node 服务、开窗、检查更新、同步扩展/技能、注入 Python 环境、退出清理
│   ├── updater.js      # npm 层:用内置 npm 查询版本 / 装到指定目录(installInto)
│   ├── runtime-guard.js # 运行时完整性:启动校验、staging 安装、原子换入、崩溃恢复
│   ├── preload.js      # 最小安全桥(contextIsolation 开启)—— 自定义能力的暴露入口
│   ├── features/       # dashboard / subagents / dsh(交给官方桌面端) / pi-model-import 等外壳后端逻辑
│   ├── launcher.html + launcher-preload.js   # 启动选择器(开 Pi Agent 还是 DeepSeek Harness)
│   ├── loading.html / updating.html / healing.html / error.html
│   └── ui/             # ★ 自定义能力的前端页面(可选,见「开发约束」)
├── vendor/node/        # 内置 Node.js 运行时(node.exe + npm) → resources/node            ← 构建输入(npm run seed:node)
├── vendor/python/      # 内置 Python(python-build-standalone + ppt-master 依赖预装) → resources/python ← 构建输入(npm run seed:python)
├── runtime-seed/       # @agegr/pi-web 的 npm 生产安装(含 .next) → resources/runtime-seed          ← 构建输入(npm run seed)
├── extensions-seed/    # 默认随装的 13 个 pi 扩展(.ts 源码已入库;node_modules 为构建输入) → resources/extensions-seed
├── skills-seed/        # 默认随装的技能(wiki 系列 OKF + ppt-master,源码已入库) → resources/skills-seed
├── scripts/            # seed-node.ps1(供给 vendor/node,内含沿用下来的版本下限)
│                       # + seed-python.ps1 + vendor-python-requirements.txt(供给 vendor/python)
│                       # + test-runtime-guard.js(运行时守卫 / 版本比较回归测试,npm run test:guard)
├── build/              # 三套应用图标的 SVG 源 + 生成脚本(_make_icons.js)与产物(png/ico)
├── electron-builder.yml
└── package.json
```

> **构建输入 vs 入库源码**:`vendor/`、`runtime-seed/`、`extensions-seed/node_modules` 都体积大、已 gitignore,需按[下文](#从零准备构建输入)重新准备。本地若存在 `pi-web/` 目录,那是已退役的 fork 工作副本(`cking000bigdemon/pi-web`,曾发布为 `@cking000/pi-web`),桌面端已回归上游包,不再是构建输入。
> **已纳入版本库**:`extensions-seed/` 的 13 个 `.ts` 扩展源码 + `manifest.json`(扩展目录清单)、`skills-seed/` 全部技能源码(含 `ppt-master` 的模板/脚本)、`scripts/` 供给脚本——这些是产品源码,直接随仓库走。

## 应用身份与图标

应用叫 **Pi Dsh**（`productName`，`package.json` 和 `electron-builder.yml` 各一份——前者决定 dev 模式的 `userData`，后者决定打包产物）。`appId` 保持 `com.agegr.piwebdesktop` **不变**，这样新安装包是就地升级，而不是并排装两份。

> **名字必须匹配 `/^[-_+0-9a-zA-Z .]+$/`。** electron-builder 只在 `productName` 满足这个正则时拿它当安装目录名，否则回退用 package.json 的 `name`，NSIS 的 `instFilesPre` 发现 `$INSTDIR` 里不含那个串就再追加一层。中途用过的 `Pi&Dsh` 就是这么装进 `D:\Program Files\Pi&Dsh\pi-web-desktop\` 的（`&` 不在白名单里）。顺带 `&` 在 `cmd` 里还是命令分隔符，exe 路径不加引号就断。

三套图标，`build/_make_icons.js` 从 SVG 一次生成全部 PNG + ICO（借 pi runtime 的 sharp，外壳不新增依赖；ICO 是手搓的 PNG-compressed 格式，sharp 没有 ico 编码器）：

| 资源 | 用在哪 | 长什么样 |
|---|---|---|
| `icon.*` | 应用身份：exe / 安装包 / 快捷方式 / 启动选择器窗口 | 左右对分——左边奶白底黑 Pi，右边深灰底白鲸 |
| `icon-pi.*` | pi-web 窗口 + 扩展管理子窗口 | 原来的 Pi 图标，未改 |
| `icon-dsh.*` | 交给官方桌面端构建用（`win.icon`）| 深灰底白鲸 |

**为什么窗口图标和应用图标不同**：Windows 任务栏显示的是**窗口**的图标，不是 exe 的。所以选 Pi 时任务栏是纯 Pi 标；选 dsh 时本进程已经退出，任务栏上那个是官方端自己的窗口——上游没给它设图标（构建日志原话 `default Electron icon is used`），所以我们在构建它时用 `icon-dsh.ico` 补上，否则它会顶着 Electron 默认的原子图标。只有启动选择器戴合成图标，因为那一刻还没选身份。

**关于配色**：Harness 的品牌是**单色**的，不是 DeepSeek 模型那个蓝。它自己的 `favicon.svg` 里写得很清楚——`@media(prefers-color-scheme:light){fill:#000}` / `dark{fill:#fff}`，品牌蓝只是给不认媒体查询的 Safari 兜底。所以两个图标里的鲸鱼都是白色配深灰底，没有用蓝色。深色面比纯黑提亮了一档并加了一圈 16% 白描边，否则近黑 tile 在深色任务栏上会整个融进背景、只剩一条悬空的鲸鱼。tile 占画布 92%（原来只有 81%），任务栏本身还会再加内边距，留白太多会比邻座应用矮一圈。

> **改名的副作用**：Electron 的 `userData` 路径来自 `productName`，本外壳先后叫过 `Pi Agent` → `Pi&Dsh` → `Pi Dsh`，`%APPDATA%` 下的目录也跟着换了两次。`main.js` 的 `migrateLegacyUserData()` 在启动时一次性搬运本外壳自己的几个小 JSON（`launch-preference` / `extensions-state` / `theme-state` / `dsh-model-import` / `dsh-app-location`），Chromium 自己的目录和 `runtime/` 一律不搬（前者带绝对路径且由 Electron 重建，后者最大 1GB 且按需重新种）。**`dsh-model-import.json` 是必须搬的那个**：丢了它，导入过的提供方会静默失去 `PI_DSH_KEY_*` 注入，表现为认证失败而不是任何指向病因的报错。来源目录按**从新到旧**（`Pi&Dsh` → `Pi Agent`）逐个找，每个文件取第一个找到的——中间那个名字下可能存着最初那个目录没有的状态。搬完写一个 `.migrated-user-data` 标记，不会重复搬。


## 启动选择器

应用**先问你开哪个运行时**，再做任何运行时工作——这正是它排在最前面的理由：最终去 dsh 的那次启动，不该先把 pi-web 的种子拷贝、完整性校验、扩展/技能同步、`next start` 全跑一遍。

- 两块 Metro 磁贴，各自显示磁盘上真实的版本号；`1` / `2` 选，`Enter` 确认，`Esc` 退出（什么都没起，直接退出）。
- 勾「记住选择」后不再询问；`App → 启动时打开` 的单选组随时改回「每次询问」或换默认。偏好存 `userData/launch-preference.json`。
- `PI_DESKTOP_LAUNCH=pi|dsh|ask` 可覆盖（快捷方式、自动化用）。
- 选了一个之后，另一个仍可从 `App` 菜单打开，两者并存。

> 关掉启动器与目标窗口出现之间有一个瞬间的「零窗口」，`window-all-closed` 在这期间必须**不**退出应用——`launchInProgress` 就是干这个的。

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

## DeepSeek Harness（交给官方桌面端）

菜单 `App → DeepSeek Harness`（或启动器的第 2 块磁贴）打开 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 官方桌面端。**本项目不再内置 dsh 运行时，也不再自己套它的 Web UI。**

原来的做法是把 `@deepseek-ai/dsh` 当第二个运行时种子随装（`runtime-seed-dsh/`，约 270MB），起 `dsh web --host 127.0.0.1 --port <n>`，再拿一个 BrowserWindow 指过去。上游现在自带 Electron 应用（`@deepseek-ai/dsh-desktop`），而它**不是**同一个 Web 服务的另一层壳，是替代品：

- **不开监听端口**。内置 Node 子进程 + framed byte pipes + `dsh-app://` 协议承载 Fetch 流量和前端资源——外壳这边那套空闲端口 / 就绪探测 / launch token，在对面没有对应物。
- **独占 `$DSH_HOME/profiles/desktop`**，自带 pnpm store，以及 staging → 健康检查 → 激活 → 回滚的整条事务路径。它的 bundles 前两项被校验死为 `dsh-base` + `dsh-web-app`，插件只收 `registry.npmjs.org` 上的注册表包。
- **版本与它携带的 dsh 锁死**（"a dsh upgrade is a Desktop release"），更新由它自己负责。

再并一个自组的 dsh 在旁边，等于两个外壳抢同一个 `$DSH_HOME`、同一个产品两套更新故事。所以 dsh 这条路径现在只做一件事：找到那个应用、带上环境把它拉起来、然后本进程退出。实现全部在 `electron/features/dsh.js`。

**查找顺序**（`resolveApp()`，越靠前越明确）：

1. 环境变量 `PI_DESKTOP_DSH_APP`（给 exe 或给它所在目录都行）
2. 上次通过「选择位置…」记住的路径（存 `userData/dsh-app-location.json`）
3. `resources/dsh-app/DeepSeek Harness.exe`——随本安装包分发的副本，**默认不打包**
4. `%LOCALAPPDATA%\Programs\DeepSeek Harness\`
5. `%ProgramFiles%\DeepSeek Harness\`

都找不到时弹框列出以上位置，并给一个「选择位置…」让你手动指定，选定后记住。

> **上游目前没有发布 Windows 安装包。** 截至 `dsh-v0.1.5-rc.1`，GitHub release 的 assets 全为空，`@deepseek-ai/dsh-desktop` 是 `private: true` 不上 npm，它自己的更新源 `https://download.deepseek.com/_/harness/desktop/stable/win-x64/` 也 404（根域是通的）。所以现阶段要用它，得从 deepseek-harness 检出里自行构建——构建步骤和四个坑（陈旧 `lib/` 产物、GNU tar 吃不下盘符、强制硬件签名、签名中止导致 `resources/runtime/node/` 只拷一半）记在项目记忆 `building-upstream-dsh-desktop-on-windows` 里。产物 `win-unpacked` 约 723MB，首次运行还会往 `$DSH_HOME` 写约 425MB——这就是上面第 3 条那个槽位默认不打包的原因（要打开，把 `electron-builder.yml` 里对应那段解注释）。

**拉起时注入两样东西**：`DSH_HOME`（默认 `~/.dsh`，与终端 `dsh` 共用），以及下一节那套 `PI_DSH_KEY_*` 凭据环境变量。子进程 `detached` + `unref()`，因为外壳的活到此为止——启动器选 dsh 后本进程随即退出，而**退出不会带走 DeepSeek Harness**：它有自己的单实例锁和生命周期，关掉 Pi Agent 不该杀掉你正在用的会话。

> 菜单里**没有**「检查 DeepSeek Harness 更新…」了：上游把 Electron 外壳和它携带的 dsh 绑成一个发布单元，从这里提供更新只会让两者错位。

### 从 Pi 导入模型配置

菜单 `App → 从 Pi 导入模型配置…`。可行的原因是 dsh 的主力适配器 `@deepseek-ai/dsh-llm-pi-ai` 依赖 **`@earendil-works/pi-ai`**——和 pi 是同一个模型层库，字段语义一一对应。

映射：`baseUrl → baseURL`、`thinkingLevelMap → reasoningEfforts`、`api`/`input`/`contextWindow`/`maxTokens` 同名，写进 `$DSH_HOME/settings.yaml` 的 `llm-pi-ai.providers`（其余段落原样保留，改写前自动备份成 `settings.yaml.bak-<时间戳>`）。

**密钥不落 dsh 的盘**：settings 里只写 `apiKeyEnv: PI_DSH_KEY_<PROVIDER>`，真正的 key 在每次由本外壳拉起 DeepSeek Harness 时从 pi 的 `models.json` 现读、经子进程环境注入——dsh 的 credentials-local 把「继承的进程环境」排在自己的托管 store 之上，所以生效且不会写进 `$DSH_HOME/.credentials.yaml`。在 pi 里轮换密钥后无需重新导入。

三类东西**导不过去**，导入前的确认框会逐条列出：

- `cost` 定价信息——dsh 的 `PiAiModelProfile` 没有这个字段。
- `compat.supportsDeveloperRole` / `supportsStore` / `requiresReasoningContentOnAssistantMessages`——dsh 只暴露 `thinkingFormat` 和 `supportsReasoningEffort`，其余回退到 pi-ai 按 baseURL 的自动探测，私有网关有猜错的可能。
- `auth.json` 里的**目录型**提供方凭据（如 deepseek）——dsh 自带原生 DeepSeek 适配器，且给目录里没有的 id 造一条无 `api`/`baseURL` 的路由会被 dsh 判为不可服务。这类只做提示，请在 dsh 的设置→模型里直接填。（0.1.5 起这种坏路由只保留诊断、不再拖垮整个命名空间，但仍然不会工作。）

> 另外 pi 用 `null` 表示"该思考档位不支持"，而 dsh 认为「声明了就是支持」且除 `off` 外必须给出线上拼写。导入时会把这些 `null` 档位**丢掉**而不是照搬——照搬会让整条路由被拒。

## 内置的扩展与技能

仓库的 `extensions-seed/` 与 `skills-seed/` 是这些能力的**发布源**；每次启动同步进 `~/.pi/agent/`，仓库外的其它扩展/技能一律不动。

两者的覆盖策略**不同**：

- **技能**：仍是「仓库赢」——受管技能目录内容不同即覆盖（**别在 `~/.pi/agent/skills/` 手改受管技能**）。
- **扩展**：**用户赢**。首次启动让用户勾选装哪些；此后只在文件**仍与我们写下去时一模一样**（未被用户改过）时才随应用升级刷新。你在 `~/.pi/agent/extensions/` 里改过的扩展**永远不会被自动覆盖**，只会在「扩展管理」里标成「有新版可用」，由你决定是否点「恢复内置版本」（会先把你的版本备份成 `<名>.ts.userbak.<时间戳>`）。

### 扩展的选择性安装（`extensions-seed/` → `~/.pi/agent/extensions/`）

`extensions-seed/manifest.json` 是受管扩展集合的**唯一真源**（id / 文件名 / 中文名 / 说明 / 是否默认勾选 / npm 依赖），驱动选择器 UI 与启动同步；`main.js` 里不再硬编码文件清单。

| 场景 | 行为 |
|---|---|
| 首次启动（没有选择记录） | 弹出选择器并**阻塞**到用户确认，服务按选中的集合启动；关掉窗口＝这次啥也不装，下次启动再问 |
| 菜单 `App → 扩展管理…` | 同一个窗口，可随时改勾选；应用后询问是否重启内嵌服务（或自行在 pi 里 `/reload`） |
| 取消勾选 | **不删除**，重命名成 `<名>.ts.disabled`（pi 自己的停用约定，dashboard 也认这个）；重新勾回来时恢复的是**你那份**，不是内置版 |
| 已装且未被改动 + 应用带来新版 | 静默升级 |
| 已装且**被你改过** | 原样保留，仅标记「有新版可用」 |
| 手动删掉某个已勾选的扩展 | 下次启动补装（想彻底不要就在选择器里取消勾选） |
| 新版本新增的默认扩展 | 自动装上（纯新增文件，不会覆盖任何东西） |
| 依赖 `node_modules` | 只在**有选中的扩展声明依赖**时才部署（目前只有 `mcp-bridge` 需要 `@modelcontextprotocol/client`，约 15MB），缺失或 lockfile 变化时刷新 |
| 某个扩展从 manifest 里**移除**（退役） | 应用不再管它，但**也不会删**已经部署的那份——它会继续被 pi 加载。退役必须配一次手动清理，见下 |

> [!WARNING]
> **从 0.3.0 升级上来需要手动停用三个已退役扩展。** `agents-md-injector`、`claude-md-injector` 被 `context-file-injector` 取代，`variflight-web-search` 被 `web_search_tools` 取代；它们已从 `extensions-seed/` 和 manifest 里删除，但 `extensions-manager` 从不删除已部署的文件，所以老机器上旧文件仍会激活，和新扩展**同时**跑：目录上下文会被重复注入，`perplexity_*` 三个工具会被重复注册。
> 升级后请到 `~/.pi/agent/extensions/` 把这三个 `.ts` 改名成 `.ts.disabled`（pi 自己的停用约定），或直接删掉：
>
> ```
> agents-md-injector.ts      -> agents-md-injector.ts.disabled
> claude-md-injector.ts      -> claude-md-injector.ts.disabled
> variflight-web-search.ts   -> variflight-web-search.ts.disabled
> ```
>
> 它们已不在 manifest 里，所以「扩展管理」窗口里看不到，只能手动改名。

判定「改没改过」用的是**忽略换行符**的内容哈希（`core.autocrlf` 会把种子检出成 CRLF，纯换行差异不能算用户改动）。选择与部署记录写在 `userData/extensions-state.json`，`~/.pi` 里不留任何附加文件。实现见 `electron/features/extensions-manager.js`（策略注释在文件头）、`electron/extensions-picker.html`、`electron/extensions-preload.js`。

### 内置的 13 个扩展

| 扩展 | 作用 |
|---|---|
| `auto-session-title` | 自动生成会话标题 |
| `claude-code-review` | **Claude 代码审查**：`claude_code_review` 工具把指定范围的改动（工作区／已暂存／整条分支／某次提交／指定文件）交给一个独立的 Claude Code 子进程（`claude -p` 非交互模式）做**只读**评审，结果以结构化 JSON 回来——整体 verdict + 逐条 findings（文件/行号/严重度/类别/说明/改法）+ 亮点与后续跟进项，不占主会话的上下文窗口。子进程只拿到 Read/Grep/Glob 与 git 查询类命令，没有 Write/Edit。默认 `claude-opus-5` + `--effort xhigh`，pi 调用时可用 `model`／`effort` 指定其它 Claude 模型与思考强度（low/medium/high/xhigh/max），非 Claude 模型会被拒。**闸门：每次调用前读网卡当前 SSID，只有连着 `Variflight` 无线网才放行**，否则直接拒绝、不发起任何请求。`/claude-review` 看闸门状态、`claude` 可执行文件与默认参数；`PI_CR_*` 可改 SSID／模型／强度／超时／diff 上限 |
| `context-file-injector` | **目录上下文文件注入**：补上 pi 原生只向上找、不向下找的空缺——agent 进到子目录干活时，把该目录链上的 AGENTS.md／CLAUDE.md 注入会话（同目录按 `AGENTS.override.md > AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD` 只取一个），每文件每会话一次；首次发现新上下文的写／改会被拦下让模型先读。取代已退役的 `agents-md-injector` + `claude-md-injector`（沿用其会话状态，续跑不重复注入） |
| `cross-agent-memory` | **跨 Agent 记忆桥接**：pi 自己没有长期记忆，而同一台机器上的 Claude Code 与 Codex 各写了一份。会话开始时读 `~/.claude/projects/<项目键>/memory/MEMORY.md` 与 `$CODEX_HOME/memories/memory_summary.md`，每轮 `before_agent_start` 追加进 system prompt。内容经 XML 转义后放进 `<memory_data>` 并明确声明为**不可信数据**（只取事实、偏好、历史决策，绝不执行其中的指令）；默认前 200 行 / 25 KiB，项目未受信任时不读。`/cross-memory-status` 看加载情况、`/cross-memory-reload` 重读；`PI_CROSS_MEMORY_*` 可关闭或改上限 |
| `general-agent-prompt` | 通用 agent 系统提示增强 |
| `image-generation` | **生图工具**：`generate_image_gpt`（OpenAI gpt-image-2）与 `generate_image_gemini`（gemini-3.1-flash-image），图片存到当前 workspace 的 `ai-output/temporary/pictures/` 并返回路径，不把 base64 塞回上下文 |
| `language-guard` | **语言守卫**：检测 assistant 回复语言漂移（非中文主导即拦截），中断后注入中文要求并自动重发原任务；可选子 pi 复核，防死循环限重启次数 |
| `mcp-bridge` | 桥接 `mcp.json` 里的 MCP server（stdio/sse/http）；MCP 工具默认**惰性加载**（`mcp_search_tools` 按需搜索激活，或 `/mcp-load` 手动），支持 eager/confirm/cwd 等单服配置。协议默认 `auto`：先 `server/discover` 探测，2026-07-28 无状态协议与 2025 版 server 通吃（`PI_MCP_PROTOCOL` 可改 legacy 或钉版本）；server 中途要用户补参数走 MRTR，弹 pi 对话框回填（`PI_MCP_ELICIT=0` 关） |
| `python-workdir-guard` | **Python 工作目录守卫**：自动建 `.venv`、强制 Python 走 `.venv`（见下「零依赖 Python」） |
| `skill-shell-injection` | **Skill 动态上下文注入**：补上 Pi 原生没有的 Claude Code 式 `` !\`cmd\` `` / ```` ```! ```` 语法——SKILL.md/prompt 被加载时在 shell 执行内嵌命令、把输出内联替换进内容；钩 `read` 自动生效，另提供 `/skillx <name>` 直调 |
| `vision-fallback` | **多模态图片输入回退**：当前模型不支持读图而用户又发了图时，本轮自动 `setModel` 切到支持图片的模型，`agent_settled` 后切回原模型与思考级别 |
| `web-search-tools` | **联网搜索**（四个互补工具，按成本分级，文件名 `web_search_tools.ts`）：`web_search`（免费，CPA 网关 Responses API + 内置 web_search，流式接收，返回带来源的结论）、`perplexity_search`（$0.005/次，结构化 ranked results）、`perplexity_pro_search`（$0.008/次 + token 费，Sonar Pro 多步深度检索）、`perplexity_async_sonar`（真异步 `/v1/async/sonar`，默认 `sonar-deep-research`，可跑十几分钟）；后两个每次调用前都要用户点确认。取代已退役的 `variflight-web-search`（首个工具由 `variflight_web_search` 更名为 `web_search`） |
| `windows-encoding-guard` | **Windows 编码陷阱守卫**：`write`／`edit` 落盘前先重建「将要写入的完整内容」再做静态检查，两类致命项直接拦截——用 `[Console]::In` 读 stdin（按控制台 ANSI 代码页即 GBK 解码，中文用户名路径会吃掉 JSON 转义），以及剔除注释后的可执行代码里出现非 ASCII 但文件没有 UTF-8 BOM（powershell.exe 5.1 会按 GBK 读 BOM-less 的 `.ps1`）。其余为告警并注入下一轮。`/windows-encoding-audit [路径]` 可对单文件或整个目录递归体检；`PI_WINDOWS_ENCODING_GUARD=0` 关闭 |

运行时 `@earendil-works/pi-coding-agent` 由 pi 注入扩展加载器，**不打包**；唯一需打包的依赖是 `@modelcontextprotocol/client`（MCP SDK v2，mcp-bridge 用），由 `npm run seed:extensions` 准备。

### 默认技能（`skills-seed/` → `~/.pi/agent/skills/`）

pi 自动发现 `~/.pi/agent/skills/` 下的技能，因此它们在**每个工作目录**都可用。`ensureBundledSkills()` 用每技能的 `.seed-version` 签名（`路径|大小|mtime` 的 md5，仅 stat 不读文件体）做快速跳过——内容没变就整跳过同步，避免 `ppt-master` 的上万文件每次启动深度比对。

**OKF 知识库技能**（纯 Python 标准库，无 pip 依赖；把工作区文档编译成可移植的 [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) 知识库）：

| 技能 | 作用 |
|---|---|
| `wiki-init` | 在工作区自举 `okf.config.json` + 空 bundle 骨架（先跑这个） |
| `wiki-compile` | 扫描源文档 → 抽取概念 → 写概念文章 + 索引 + 术语表 |
| `wiki-query` | 两跳索引导航 + 概念文章合成带引用的回答 |
| `wiki-lint` | 一致性 / 新鲜度 / 覆盖度 / 关联 / 空白 / 尺寸 六类体检 |
| `okf-visualizer` | 把知识库渲染成单文件、离线、自包含的 HTML 关系图谱 |

> 两个方言由 `okf.config.json` 切换：`okf-pure`（默认，标准 markdown 链接，给任意编辑器/智能体用）与 `obsidian`（wikilink / callout / Dataview）。

**`ppt-master`**（演示文稿生成）：把源文档（PDF/DOCX/URL/Markdown）通过多角色流水线生成高质量 SVG 页面并导出 PPTX。依赖较重（python-pptx / PyMuPDF / svglib / Pillow / numpy …），已**预装在内置 Python**，跑 `$PI_BUNDLED_PYTHON` 离线即用、零 pip。配图默认占位模式（无 API Key 也能出整套 deck）。

### 零依赖 Python（守卫 + 内置 Python + ppt-master）

让打包后的 app 跑 Python 技能做到「装完即用、离线零依赖」，靠三件套咬合：

1. **内置 Python**（`vendor/python`）——可重定位的 python-build-standalone，ppt-master 依赖已预装。
2. **`main.js` 注入**——把它前置到 pi 服务进程的 `PATH`，并设三个 `PI_PY_GUARD_*` / `PI_BUNDLED_PYTHON` 环境变量。
3. **`python-workdir-guard` 守卫**——
   - 用内置 Python 创建项目 `.venv`（**无需系统 Python**）；
   - 放行内置解释器 `$PI_BUNDLED_PYTHON`，让 `ppt-master` 直接用它（重依赖现成）；
   - **用户自己的项目 Python 代码仍被强制走干净的 `.venv`**（方案 B：技能依赖留在内置 Python 的 base，不污染项目 venv）。

### 仪表盘 Sub-agents 模块读的是什么（`electron/features/subagents.js`）

底栏「Sub-agents」磁贴显示**正在运行 / 本次完成**的子代理，点开是运行列表（可中止）与最近记录。两代子代理留下的痕迹完全不同，模块把两者读出来合并显示：

| | **内置子代理**（pi-web ≥ 0.9.0，`Agent` / `get_subagent_result` / `steer_subagent`） | **`pi-subagents` npm 包**（旧，装了才读） |
|---|---|---|
| 运行形态 | Next.js 服务**进程内**的 AgentSession，**没有子进程** | spawn 子 `pi` 进程 |
| 「正在运行」来源 | `GET /api/agent/running` 的 `runningSessionIds` ∩ 子代理会话文件 | 进程表里从服务 pid 派生的 `pi-coding-agent/dist/cli.js` |
| 名称 / 任务 | 会话 JSONL 第二条 `customType:"pi-web:subagent"`（profile、description、task、前台/后台、父会话） | 提示词临时文件名 / async `status.json` |
| 结束状态 | 末尾 `customType:"pi-web:subagent-result"`（completed / failed / aborted）；有元数据无结果且不在运行中 = **中断**（服务重启把它切掉了） | `~/.pi/agent/run-history.jsonl` |
| 中止 | `POST /api/agent/<id> {type:"abort"}`（就是 pi-web 自己的 Stop，记为 aborted 并通知父会话），前面先 `GET` 确认还活着——对没有活 wrapper 的会话 POST 会让 pi-web **把它拉起来** | `taskkill /T` 整棵进程树（pi-subagents 的优雅中断在 Windows 上 ENOSYS） |

- 开关状态从 `~/.pi/agent/agents/settings.json` 的 `builtInEnabled` 读（缺省/坏文件按关闭，与 pi-web 一致），关着时弹层直接提示去「设置 → Agents」开启，而不是显示一个空列表。
- 中止请求的会话 id **只接受**当前扫描仍判定为子代理会话的那些，所以渲染层拿不到能中止主对话的口子；pid 同样要在新鲜的进程快照里仍是我们服务之下的 pi 进程。
- 进程枚举（Windows 上是一次 PowerShell CIM 查询）只在 `pi-subagents` 确实安装时（`settings.json` 的 `packages` 或 `~/.pi/agent/npm/node_modules`）才跑；只用内置子代理的机器完全不碰进程表。
- 元数据入口只扫 **mtime ≥ 本次启动**的会话文件：运行中的文件每条消息都会被改写，结束时又追加结果条目，所以这是「正在运行或本次结束」的精确前置过滤，不会把整个会话库读一遍。

### 子智能体跑的是内置 pi（`PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT`，仅旧 `pi-subagents` 包相关）

`pi-subagents` 起子智能体的方式是 **spawn 一个子 `pi` 进程**，而它找 pi 的顺序是：`PI_SUBAGENT_PI_BINARY` → 显式 package root → 探 `process.argv[1]` → 从自身安装位置 `import.meta.resolve`。桌面端两条自动路径**都会落空**：服务进程的 `argv[1]` 是 next 的 bin（不在 pi-coding-agent 目录下），而 `pi-subagents` 装在 `~/.pi/agent/npm`，那里的 `@earendil-works/` 是空的——桌面端从不往那儿 npm install pi。于是 `getPiSpawnCommand()` 兜底成裸 `"pi"`，**走 PATH 上全局安装的那个 pi**（本机实测：父进程 0.84.0，子智能体却是全局的 0.81.1），空电脑上则直接没有。

所以 `main.js` 启动服务时注入：

```
PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = <runtimeDir>/node_modules/@earendil-works/pi-coding-agent
```

`pi-subagents` 收到后自己会 `realpath` + 校验 `package.json.name`（`resolveExplicitPiPackageRoot`），校验不过就当没设——所以我们这边也先校验一次，不合格只记日志、不导出，让 PATH 兜底逻辑原样保留。命中后子智能体的启动命令变成 `<内置 node.exe> <内置 cli.js> …`：与父进程同版本 pi、同 node，继承同一份配置与模型认证，不依赖全局 pi / Node / npm。用 `runtimeDir()` 取值，所以运行时是就地跑还是被复制到 `%APPDATA%\Pi Agent\runtime` 都对。启动日志里的 `piPackageRoot=` 可核对，`(unresolved)` 就表示又退回 PATH 了。

**自带的两个扩展也吃这个变量**：`auto-session-title`（起标题）和 `language-guard`（子 pi 复核）同样要 spawn 子 pi，原本也是裸 `"pi"` 走 PATH，同一个坑。两者现在共用同一条解析：环境变量在 → `process.execPath` + `<root>/dist/cli.js`；不在 → **原样回退到 PATH**，所以在终端里直接跑 `pi`（没有这个变量）时行为与改动前完全一致，扩展照常可用。`language-guard` 的 `LANG_GUARD_SUBPI_CMD` 若显式设了则优先级最高，`/lang-guard` 面板新增「复核用 pi」一行，起不来时第一眼就能看出走的是内置还是 PATH。

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

# 2b. 默认扩展的共享依赖(13 个 .ts 扩展源码已入库;此步只装它们的 node_modules)
npm run seed:extensions

# 3. 内置 Node 运行时(win-x64) —— 全自动
#    版本下限 22.19 由脚本强制(历史原因见脚本注释:当年为内置的 dsh 抬的,现已无强制需求但保留)
npm run seed:node

# 4. 内置 Python(win-x64,ppt-master 依赖预装,~340MB) —— 全自动
npm run seed:python
```

> `skills-seed/` 全部技能源码（含 `ppt-master`）已入库，**无需额外准备**。
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
- `PI_DESKTOP_DSH_APP` —— 指定 DeepSeek Harness 官方桌面端的位置（`DeepSeek Harness.exe` 或它所在目录）。优先于其它查找位置。
- `PI_DESKTOP_DSH_HOME` —— 指定 DeepSeek Harness 的 `$DSH_HOME`（默认 `DSH_HOME`，再默认 `~/.dsh`）。
- `PI_DESKTOP_LAUNCH=pi|dsh|ask` —— 跳过（或强制显示）启动选择器。

**开发默认扩展**：改 `extensions-seed/*.ts` 后 `npm start`。注意扩展同步现在是**非破坏性**的——只有 `~/.pi/agent/extensions/` 里那份仍与上次部署时一模一样（你没手改过）才会被刷新；否则你的版本被保留，只在「扩展管理」里标「有新版可用」。**开发时更省事的做法**：直接在 `~/.pi/agent/extensions/` 里改（不会再被启动覆盖了），改完再拷回 `extensions-seed/` 入库；或者在扩展管理里点「恢复内置版本」强制拉取仓库版（会先备份你的改动）。
新增一个扩展：把 `.ts` 放进 `extensions-seed/` **并在 `extensions-seed/manifest.json` 里登记**（未登记的文件不会被部署，也不出现在选择器里）；`default: true` 的新扩展会在用户升级后自动装上。新增/变更 npm 依赖则改 `extensions-seed/package.json` + 在 manifest 对应条目的 `deps` 里声明，然后跑 `npm run seed:extensions`。
**开发默认技能**：改 `skills-seed/<skill>/`，`npm start` 启动时按 `.seed-version` 签名同步进 `~/.pi/agent/skills/`（文件 mtime 变即重新部署）；Python 技能用 `$PI_BUNDLED_PYTHON` 调用脚本，新增重依赖请加进 `scripts/vendor-python-requirements.txt` 并 `npm run seed:python` 重供给。

## 打包安装程序

确保图标产物已生成（`node build/_make_icons.js`），且 `vendor/node`（`npm run seed:node`）、`vendor/python`（`npm run seed:python`）、`runtime-seed`、`extensions-seed`（其 `node_modules` 跑 `npm run seed:extensions` 准备）已就绪，然后：

```bash
npm run dist        # 生成 dist/Pi Agent Setup x.x.x.exe (NSIS)
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
| **本仓库 pi-web-desktop** | Electron 外壳：窗口、内置运行时、自更新、dashboard、IPC、默认扩展/技能、自定义能力 | 在 `electron/`、`extensions-seed/`、`skills-seed/` 改 → 重新打包安装程序 |

**两条铁律：**

1. **pi-web 的任何修改不在本仓库做**——通用改动给上游 [agegr/pi-web](https://github.com/agegr/pi-web) 提 PR，合并发版后由 `runtime-seed` / 自更新吃到。**绝不在本仓库或 `runtime-seed` 里直接改 pi-web 源码 / `.next`**——那会被下一次 `npm install @agegr/pi-web@latest` 冲掉。
2. **pi-web 和 pi-coding-agent 只从上游 npm 获取**：
   - pi-web = 上游 **`@agegr/pi-web`**；
   - pi-coding-agent = 上游 **`@earendil-works/pi-coding-agent`**（作为 pi-web 的依赖随之安装，**不 fork、不改**）。
   - 本仓库不 vendoring、不内联它们的源码；`runtime-seed` 只是这两个 npm 包的一次生产安装。

> **历史注**：2026-06~07 期间桌面端曾消费自有 fork `@cking000/pi-web`（Metro 磁贴皮肤 + 若干修复，仓库 [cking000bigdemon/pi-web](https://github.com/cking000bigdemon/pi-web)）。fork 的两个功能性修复（扩展工具丢失、slash 命令面板）先后被上游 0.6.18 / 0.7.0 吸收后，2026-07-21 桌面端回归上游包，fork 退役（仅 DMIT 健康助手部署仍在用）。

### 分层与红线

```
你拥有、随便改 ─┐  electron/ · extensions-seed/ · skills-seed/ · scripts/        ← 本仓库
                │
pi-web 的功能  ─┤  给上游 agegr/pi-web 提 PR → 上游发版 @agegr/pi-web
                │
内置运行时     ─┤  resources/node · resources/python
                │
只读、不在此改 ─┘  resources/runtime-seed = @agegr/pi-web(npm 包) · ~/.pi 数据目录
```

- ✅ **本仓库允许**：在 `electron/` 下加能力（Node 全权限）、加 IPC、加 preload API、加 UI；在 `extensions-seed/` 加默认扩展、`skills-seed/` 加默认技能。
- ✅ **pi-web 的改动**：给上游提 PR，合并发版后这里通过升级 npm 包吃到。
- ❌ **禁止**：在本仓库 / `runtime-seed` 里改 pi-web 源码或编译产物；fork、修改或内联 `@earendil-works/pi-coding-agent`。
- 需要"后端能力"且不属于 pi-web 网页层时，放在 **Electron main 里用 IPC 暴露**（等价于你自己的后端）。

### 外壳层新能力三件套

1. **数据访问** —— 放 `electron/features/<name>.js`。取数优先**直接读 `~/.pi`**（稳定），或用内置 node `spawn` 运行时里的 `pi` CLI 兜底。
2. **暴露通道** —— `ipcMain.handle("<域>:<动作>", …)` + `preload.js` 里 `contextBridge.exposeInMainWorld("piDesktop", { … })`。pi-web 本体不受影响。
3. **展示界面** —— 三选一（按耦合度）：菜单 + 独立窗口（推荐，零耦合）/ preload 注入悬浮入口（体验一体，依赖注入点）/ 托盘 · 全局快捷键（轻量触发）。

### 升级安全

- 你的 `electron/`、`extensions-seed/`、`skills-seed/` 全在外壳层，自更新只换 `runtime-seed`，**碰不到**。
- pi-web 的修复/功能走上游 PR；上游发版后 `npm run seed`（打包）或应用内「检查更新」（已装机器）即可跟进。

---

## 已知取舍

- **安装包体积**：内置 Node + Python + 运行时种子 + 技能（含 ppt-master 图标库），约 **500MB+**；换来空电脑「装完即用、零依赖」。
- **只读目录安装首启较慢**（复制运行时种子，仅第一次）；可写目录安装则秒开。
- **`ppt-master` 首次部署**约十几秒（上万文件），之后靠 `.seed-version` 签名秒级跳过。
- **Python 仅 Windows x64**（与 `vendor/node` 一致）；mac/linux 暂未捆绑 Python。
- **自更新粒度**是 pi-web 这一层；Electron 外壳（含扩展/技能/内置运行时）更新仍需重新发安装包。
- **定制受限**：不再持有 fork，pi-web 层的改动需上游接受 PR 才能获得（换来零同步维护成本；历史 Metro 定制版存于 `cking000bigdemon/pi-web`，已退役）。
