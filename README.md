# skill-usage-hook

一个 Codex hook：在会话里显示、并在本地记录**每次工具调用用到了哪个 skill / 插件 / MCP**，
顺带在会话启动时索引本机新装的 skill / 插件（不用手工登记）。

**English**: a Codex hook that notices and logs which skill / plugin / MCP each tool call uses.
Zero model-token cost (it only returns `systemMessage`), no network, no daemon, ~35 ms per call.
Windows is the tested platform; macOS/Linux can run the same script through `run-skill-usage-hook.sh`.

```
⚙️ HOOK ▸ skill-usage v3.2  —  已索引 40 技能 / 18 插件 / 3 MCP；新装的会自动收录
🔌 PLUGIN MCP ▸ code-review/review_pr  —  代码审查：PR 评论、CI 失败排查
🎯 SKILL ▸ ponytail  —  懒人资深工程师模式：最小改动，回复一屏读完
🧩 PLUGIN SKILL ▸ latex/latex-compile  —  LaTeX 编译与 TeX Live 环境
🔌 PLUGIN TOOL ▸ list_artifacts  —  列出本会话关联的 PR / 工作树
📄 SKILL.md ▸ some-skill  —  读到了 SKILL.md，但确认不了是本机已装技能
❔ UNKNOWN ▸ frobnicate_widget  —  裸名工具，来源不明确
```

第一行只在会话启动时出现一次（用来确认 hook 真的在跑，出问题也在这里报）；其余行每次「真的用到」才出现，
而且**每一次都带尾部那句说明**（v3.2 起不再有「前三次才带」的限制）。
Codex 会给 `systemMessage` 加 `warning:` 前缀，那是它的显示方式，不是错误。

## 要求

- Node.js **16+**（实测 Node 24；找不到 node 时启动器会静默退出，绝不弄坏工具调用）
- 支持 hooks 的 Codex（本机实测 `codex 0.162.0-alpha`，Windows）
- 平台：Windows 已实机验证；macOS / Linux 用 `run-skill-usage-hook.sh`，**未实机验证**

## 安装（Windows）

```powershell
# 在本仓库目录里
powershell -ExecutionPolicy Bypass -File install.ps1
```

脚本会：

1. 找 node，找不到就报错退出（不会留半成品）；
2. 把 `skill-usage-hook.mjs`、`run-skill-usage-hook.cmd` 复制到 `<CodexHome>\hooks\`（默认 `~\.codex\hooks`）；
3. 合并 `<CodexHome>\hooks.json`：保留你原有的 hook，只替换/追加本 hook 的两条，改前备份成 `hooks.json.bak-<时间戳>`；
4. 跑一次 `--check` 自检并打印下一步。

装到别处：`-CodexHome D:\some\codex`（或者设 `CODEX_HOME`）。卸载：`-Uninstall`。

### 手动安装（任何平台）

1. 把本仓库拷到一个**路径不含空格**的位置（例如 `~/.codex/hooks`）。命令里带空格时，`hooks.json` 得写成 `& "C:\..."` 形式。
2. 照着 `hooks.json.example` 改出一份 `<CodexHome>/hooks.json`，把 `__HOOK_DIR__` 换成第 1 步的绝对路径；
   Linux / macOS 把 `run-skill-usage-hook.cmd` 换成 `run-skill-usage-hook.sh`，并 `chmod +x run-skill-usage-hook.sh`。
3. 重启会话，按下一步处理信任。

## 必须做的一步：信任

Codex 把信任绑在 `hooks.json` 的**内容哈希**上。第一次装完（以及以后每次改 `hooks.json`）重启会话时，
它会提示 hooks 需要确认，选 **Trust all and continue**；CLI 里可以用 `/hooks`。不信任就不会执行。

改 `skill-usage-hook.mjs` / `skill-usage.config.json` / `skill-usage.notes.json` **不需要**重新信任，立即生效。

## 开关

改 `<CodexHome>/skill-usage.config.json`（照 `skill-usage.config.json.example` 复制一份即可），
或者临时用环境变量：名字 = `CODEX_SKILL_USAGE_` + 键名的大写下划线形式（`noteLimit` → `CODEX_SKILL_USAGE_NOTE_LIMIT`）。

| 键 | 默认 | 作用 |
| --- | --- | --- |
| `style` | `emoji` | `emoji` / `plain` / `zh` 三种提示样式 |
| `note` | `true` | 是否显示尾部说明 |
| `notify` | `true` | 关掉就只写日志，不在会话里提示 |
| `notifyStart` | `true` | 关掉就不显示启动那一行 |
| `noteLimit` | 不设（每次都带） | 不设 = 每次调用都带说明；填有限数 N = 同一个名字在一个项目里只带前 N 次（`0` = 从不） |
| `maxNoteChars` | `80` | 说明最大长度 |
| `verbose` | `false` | 提示后附上命中的 SKILL.md 路径 |
| `log` | `~/.codex/skill-usage.jsonl` | 日志路径；改成 `off` 完全不写 |
| `maxBytes` | `2097152` | 日志轮转阈值（超了改名 `.1`，磁盘占用封顶 2×） |
| `notes` / `autoNotes` / `state` | `~/.codex/skill-usage.*.json` | 手写字典 / 自动索引 / 计数文件（只在设了有限 `noteLimit` 时才用） |
| `scanRoots` | 空 | 额外要索引的目录（逗号分隔）；加进来的目录里的 SKILL.md 会被当成已装技能 |
| `includeServers` | `["codex_app"]` | 本来被忽略的内置 MCP server |
| `ignoreTools` | 空 | 额外要静音的裸名工具 |
| `debug` | `false` | 额外记录每个工具名（排查用） |

## 什么才算「用了」skill / 插件

- **读命令 + `SKILL.md` 路径参数**才叫「读了 SKILL.md」：命令段以读命令开头（`Get-Content` / `cat` / `head` / `sed` / `type`…，
  或 Read 类工具），且 `SKILL.md` 是它的路径参数。`rg` / `Select-String` 搜索、`Copy-Item` 复制、`Get-ChildItem` 列目录、
  写进 patch / Write 的内容——一律不算。外壳包装也算：`pwsh -Command "…"`、`bash -lc "…"`、`cmd /c …`。
- 在「读了」之上再分两级：
  - **🎯 `SKILL`**：能确认是本机已装技能（路径落在扫描根下，或名字在自动索引里）。Codex 加载技能的方式就是读它的 `SKILL.md`。
  - **📄 `SKILL.md`**：读到了，但确认不了是已装技能（例如在某个仓库里复核/编写 SKILL.md）。只报「读取」，不冒充技能调用。
- **`mcp__server__tool`** 才算 MCP 调用；裸名工具**不靠名字猜类别**，只有 `skill-usage.notes.json` 里登记过的才算已确认的插件工具，
  其余标 ❔ `UNKNOWN`。Codex 自带的函数工具（`exec_command`、`apply_patch`、`js`、`spawn_agent`…）内置静音。
- 带引号、含空格的路径可以正常识别；引号内的 `&&`、`;`、`|` 不会被当成命令分隔符。

## 自动索引

会话启动时扫三处（都不存在就跳过，不做全盘扫描）：

- `~/.codex/skills/`（含 `.system/` 里的系统技能）
- `~/.codex/plugins/cache/`（读 `.codex-plugin/plugin.json` 与它指向的 `.mcp.json`）
- `~/.agents/skills/`

结果写进 `skill-usage.notes.auto.json`（生成物，可删，会话启动时重建）。说明文案优先级：
手写字典 `skill-usage.notes.json`（可照 `.example` 建） → 自动索引 → 现场读这次命中的 SKILL.md。
会话中途装了新技能，读它的 SKILL.md 时会现场补扫一次（60 秒内不重复）。

## 开销（Windows，Node 24，各 6 次实测）

| 场景 | 耗时 |
| --- | --- |
| 普通工具调用（脚本直接退出） | 35.3 – 36.6 ms |
| 真的读了 SKILL.md（查说明） | 38.3 – 39.9 ms |
| SessionStart（重建索引并写盘） | 47.5 – 50.8 ms |

其中约 32 ms 是 node 进程启动，脚本逻辑 2–3 ms。**模型 token 开销恒为 0**：只回 `systemMessage`，不返回 `additionalContext`。
无常驻进程、无网络请求、空闲开销 0；只有真的识别到 skill / 插件时才写日志（默认每次带说明，也就
不再写计数文件；只有显式设了有限 `noteLimit` 才会用到它）。

## 隐私

全部在本机完成：不联网、不上报、无遥测。日志里只有时间、kind、名字、命中的 SKILL.md 路径（`~` 缩写）、工具名、
会话/回合 ID 和 cwd——路径可能包含你的目录结构，注意别把 `skill-usage.jsonl` 顺手分享出去。

## 已知限制

1. 复核**已装技能**的 SKILL.md 时，提示同样是 🎯 `SKILL`——hook 只看得到命令，分不出「在用它」还是「在审它」。
2. Codex 的 hook 输入里没有「技能被调用」字段（`skill_name` 只存在于插件目录与遥测 schema）。若某个版本直接把 SKILL.md
   注入上下文而没有任何读工具调用，这类调用会漏记。
3. 未加引号且含空格的路径本身在 shell 里就是错的，此时只能报 📄。
4. `$env:VAR\…\SKILL.md` 这类变量路径解析不了，即便已装也只报 📄。
5. 多个 hook 同时向日志追加，Windows 上极端情况可能交叉（没加锁）。
6. 索引每次 SessionStart 都重建（约 15–20 ms + 一次 4 KB 写）；没做目录 mtime 短路，否则「市场里新增插件版本」会被漏掉。
7. `~/.codex/marketplaces/` 默认不扫（可能上千目录）；需要时用 `scanRoots` 加。
8. hook 是**静默失败**的设计：识别不到就不出声。装完先用 `--check` 确认，别靠「没提示」判断它没坏。

## 命令行与排错

```powershell
$hook = "<CodexHome>\hooks\run-skill-usage-hook.cmd"
& $hook --check      # 设置、路径、扫描根、可写性、发现的问题
& $hook --discover   # 列出已索引的 skill / 插件 / MCP 及说明
& $hook --stats      # 汇总使用日志
& $hook --discover --write   # 强制重建索引
```

| 现象 | 先看这里 |
| --- | --- |
| 会话里完全没有提示 | 启动时有没有提示信任 hooks？`--check` 能不能跑？事件名对不对 |
| 有提示但日志没增长 | `log` 是不是 `off`；提示里有没有 `⚠️ 日志写入失败` |
| 提示没有说明文字 | `note` 关了；或显式设了有限 `noteLimit` 且这个名字在本项目已用满 |
| 提示里出现 📄 | 读到的是「确认不了已装」的 SKILL.md；要算已装就把目录加进 `scanRoots` |
| 提示里出现 ❔ | 这个裸名工具没登记。确认是插件工具就写进 `notes.json` 的 `tools` 桶，想静音就加 `ignoreTools` |

## 开发 / 测试

```bash
node --check skill-usage-hook.mjs        # 语法
node tests/hook-tests.mjs                # 38 项定向用例（合成事件喂真实脚本，全部重定向到临时目录）
```

测试覆盖：已装技能的各种写法（引号 / 空格 / 分号 / `&&` / 管道 / 外壳包装 / Read 工具）、未确认读取、
搜索/列目录/复制/补丁/写文件不算、裸名未知工具、MCP 工具、内置工具静音、**说明每次都带（同一技能连打 6 次）**、
有限 `noteLimit` 与 `noteLimit=0` 的旧行为、坏 state、空事件、SessionStart 索引。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
```

日志和计数文件不会被自动删除（你的记录不该被工具偷偷删掉）：

```powershell
Remove-Item "$env:USERPROFILE\.codex\skill-usage.jsonl*", "$env:USERPROFILE\.codex\skill-usage.state.json", "$env:USERPROFILE\.codex\skill-usage.notes.auto.json" -Force
```

## 许可

MIT，见 [LICENSE](LICENSE)。改动历史见 [CHANGELOG.md](CHANGELOG.md)。
