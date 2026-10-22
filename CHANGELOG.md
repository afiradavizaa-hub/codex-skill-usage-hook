# 改动历史

## v3.2 — 2026-10-14

说明文字不再限量（默认每次都显示）：

1. **每次实际调用都带说明**：去掉「同一个名字在一个项目里只有前 3 次带说明」的默认行为，
   第 1 次和第 100 次显示的内容完全一样。改动只在 `formatNotice()` 的取说明分支：
   `noteLimit` 默认改成无限大（`BASE_NOTE_LIMIT = Infinity`），把原来的 `seen < limit`
   判断保留下来，只在配额是有限数时才计数。
2. **默认不再读写 `skill-usage.state.json`**：无限配额时连 state 文件都不加载（`tracked=false`），
   省掉每次提示的一次磁盘写；有限 `noteLimit` 时行为与以前完全一致（含按项目剪枝、null 防护），
   想回到旧配额行为填个有限数即可，`0` 仍是「从不显示说明」。
3. `--check` 的 `noteLimit` 一栏在默认状态下显示「每次（无上限）」；版本号 `HOOK_VERSION`
   由 3 改为 3.2（会出现在启动自检行与日志的 `v` 字段里）。
4. 识别口径、显示格式、日志与 `--stats` 统计、SessionStart 行为都未改动——启动自检行仍然
   只在会话启动时出现一次，不会变成每次调用都重复。
5. 测试从 28 项加到 38 项：同一技能连打 6 次都要带说明、提示逐字相同、默认不生成 state 文件、
   自动索引来的说明同样每次带、MCP 每次显示、有限 `noteLimit`（N 次后只剩名字）与 `noteLimit=0`
   的旧行为仍在、坏 state 剪枝仍在。

## v3.1 — 2026-10-14

发布前审查（第二次）修掉 3 处真实缺陷 + 补齐仓库：

1. `run-skill-usage-hook.cmd` 里第一优先写死了 `C:\Users\<作者>\tools\node\node.exe`——换台机器必然静默失效。
   改成只按「PATH → Codex 自带 cua_node → 常见安装位置」查找（作者机器上 node 本来就在 PATH，行为不变）。
2. 外壳包装的读命令识别不到：`pwsh -Command "Get-Content '…\SKILL.md'"`、`bash -lc "cat …"`、`cmd /c type …`。
   现在会剥掉外壳（最多两层）再看里面那层命令，同时容忍被引号包住的命令名。
3. 补丁 / 写文件工具的输入（可能几百 KB）会被拼成一个大字符串再丢弃：现在直接跳过拼接；顺带给
   `pruneProjects()` 加了 null 值防护——手改坏的 state 文件以前会让 hook 在写盘前抛掉，连提示都发不出来。

仓库补齐：`install.ps1`（装/卸、合并 hooks.json、备份、自检）、`run-skill-usage-hook.sh`（macOS/Linux 启动器，未实机验证）、
`tests/hook-tests.mjs`（28 项，可移植）、`hooks.json.example`、`skill-usage.config.json.example`、
`skill-usage.notes.json.example`、`LICENSE`、`.gitignore`、本文件。

## v3 — 2026-10-12

准确性收紧 + 索引补漏（9 处）：

1. **读 SKILL.md ≠ 用了技能**：只有能确认是本机已装技能（路径在扫描根下 / 名字在索引里）才报 🎯 `SKILL`，
   其余报 📄 `SKILL.md`（日志 `kind=skill-read`），不再冒充技能调用。
2. **裸名工具不再按名字猜类别**：删掉「名字含 skill 就当技能」的启发式；字典里登记过的算插件工具，其余标 ❔ `UNKNOWN`。
3. **补丁 / 写文件内容不再当命令**：`apply_patch` / `Write` 等内容里的 `SKILL.md` 以前会被误判成「读了技能」。
4. **解析边界**：带引号、含空格的路径能正确取到技能名；引号内的 `&&`、`;`、`|` 不再被当命令分隔符；
   补上 PowerShell 反引号转义。只做这一层，没有引入 shell 解析器或第三方依赖。
5. **索引漏项**：以前跳过所有点目录，`~/.codex/skills/.system/` 整层没被索引；
   另外把 Codex 也当技能根的 `~/.agents/skills/` 加为默认扫描根。索引 28 → 40 技能。
6. **省 I/O**：手写字典与扫描根列表改为进程内只读一次。
7. 启动器里已被写坏成 `?` 的注释换成英文（逻辑未改）。

## v2 — 2026-10-12

1. 新增自动索引（扫 `skills/` 与 `plugins/cache/`，读 SKILL.md front-matter、`plugin.json`、`.mcp.json`），
   新装的 skill / 插件 / MCP 自动收录，手写字典退化为「只负责换中文」。
2. 新增 SessionStart 自检行 + 运行期问题上报（配置写坏、日志写不进去不再是静默的）。
3. node 查找改为启动器多级回退（指定路径 → PATH → Codex 自带 cua_node → 常见安装位置），找不到就静默退出。
4. 修 `noteLimit` 计数：以前没写进字典的名字会每次都去读 SKILL.md。
5. 去掉重复的 `.live` / `.staged` 配置副本；清掉指向已不存在 hook 的陈旧信任记录。
6. 新增 `--check` / `--discover` / `--stats`。
7. 索引只扫「已装」目录，不做全盘扫描（`marketplaces/` 会让启动慢 1.7 秒）。

## v1 — 2026-10-12

首个可用版本：单个 Node 脚本 + PreToolUse hook，识别「读了 SKILL.md / 命中 MCP 工具」并提示 + 写日志；
说明文字来自手写字典；日志自带轮转；按项目隔离「前 N 次才带说明」的计数。
已知问题：hooks.json 里写死 node 绝对路径、无自检、四份配置副本、会把路径尾巴当成技能名。
