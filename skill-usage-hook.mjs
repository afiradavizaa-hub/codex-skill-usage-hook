#!/usr/bin/env node
// ============================================================================
// Codex hook (v3.2) — 在会话里显示、并在本地记录「这次工具调用用到了哪个 skill /
// 插件 / MCP」，同时自动索引本机新装的 skill、插件与 MCP 服务器（无需手工登记）。
//
// stdin  : Codex hook 事件 JSON（PreToolUse / SessionStart）
// stdout : {"systemMessage":"..."} —— 只进界面/事件流，永不返回 additionalContext，
//          所以模型 token 开销恒为 0。
//
// 准确性口径（v3 收紧）
//   * 读到 SKILL.md ≠ 一定在用技能：只有在能确认它是「本机已装技能」（路径落在扫描根下，
//     或名字出现在自动索引里）时才报 🎯 SKILL；复核 / 编写别人仓库里的 SKILL.md 只报
//     📄 SKILL.md（未确认），不进技能统计。
//   * 裸名工具不按名字猜类别：只有手写字典里登记过的名字才算已确认的插件工具，
//     其余一律标 ❔ UNKNOWN。
//   * 补丁 / 写文件工具的内容不算命令，里面的 SKILL.md 不会被误判成「读了技能」。
//
// 显示口径（v3.2）
//   * 每次实际调用都显示说明，不再有「只有前 3 次带说明」这回事；noteLimit 默认
//     无限大 = 每次调用都显示。只有把它设成有限数才回到旧配额行为，那时才会读写
//     skill-usage.state.json；默认路径完全不碰 state 文件（也不产生额外磁盘写）。
//
// 开销：约 35 ms/次工具调用，其中 ~32 ms 是 node 进程启动，脚本逻辑 2–3 ms。
//       只有真的读到 SKILL.md、或命中 MCP/插件工具时才碰磁盘；注册表只在
//       SessionStart（以及极少数「读到没索引过的技能」时）扫描一次。
//
// 自动发现（v2 的重点）
//   * skill  : 扫 <CODEX_HOME>/skills 与各插件目录，读 SKILL.md 的
//              metadata.short-description / description 作为说明；
//   * plugin : 扫 <CODEX_HOME>/plugins/cache，读 .codex-plugin/plugin.json 的
//              interface.shortDescription / description；
//   * MCP    : 读 plugin.json 里 mcpServers 指向的 .mcp.json，把 server 名映射到
//              所属插件的说明（如 code-review、codex_app、cua_repl）。
//   结果写进 skill-usage.notes.auto.json（生成物，可删）；手写字典
//   skill-usage.notes.json 永远优先，只用来覆盖成更好的中文文案。
//
// 命令行
//   node skill-usage-hook.mjs --check              打印设置、路径、发现的问题
//   node skill-usage-hook.mjs --discover           列出已索引的 skill/插件/MCP
//   node skill-usage-hook.mjs --discover --write   重新生成自动索引文件
//   node skill-usage-hook.mjs --stats              汇总 skill-usage.jsonl
//
// 设置优先级：环境变量 CODEX_SKILL_USAGE_* > skill-usage.config.json > 内置默认值。
// 环境变量名 = CODEX_SKILL_USAGE_ + 键名的大写下划线形式（noteLimit -> NOTE_LIMIT）。
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOOK_VERSION = 3.2;
const HOME = os.homedir();
const CODEX_HOME = (process.env.CODEX_HOME || '').trim() || path.join(HOME, '.codex');

const DEFAULT_CONFIG = path.join(CODEX_HOME, 'skill-usage.config.json');
const DEFAULT_NOTES = path.join(CODEX_HOME, 'skill-usage.notes.json');
const DEFAULT_AUTO = path.join(CODEX_HOME, 'skill-usage.notes.auto.json');
const DEFAULT_LOG = path.join(CODEX_HOME, 'skill-usage.jsonl');
const DEFAULT_STATE = path.join(CODEX_HOME, 'skill-usage.state.json');

const BASE_MAX_BYTES = 2 * 1024 * 1024;
// 说明默认每次都显示 = 无限大。想恢复「同一个名字在一个项目里只带前 N 次」就把
// noteLimit 设成有限数（那时启用计数状态）。0 = 从不显示说明。
const BASE_NOTE_LIMIT = Infinity;
const BASE_MAX_PROJECTS = 200;
const BASE_MAX_NOTE_CHARS = 80;
const BASE_IGNORE_SERVERS = ['node_repl', 'cua_repl', 'tools', 'codex_app'];

// 索引扫描的安全阀：目录深度与条目数上限，避免插件目录异常变大时拖慢会话启动。
const SCAN_MAX_DEPTH = 6;
const SCAN_MAX_ENTRIES = 4000;
const SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'assets', 'scripts', 'tests', 'test',
  'bin', 'tmp', 'coverage', '.venv', 'vendor', '__pycache__',
  'references', 'examples', 'templates', 'fixtures', 'samples', 'docs', 'images',
]);

// Codex 自带的函数工具：不是插件，不该被上报。这只是「抑制 Codex 自身管道」的名单，
// 新出现的插件工具依然会被自动识别（无需在这里登记）。
const BASE_IGNORE_TOOLS = [
  'bash', 'exec_command', 'write_stdin', 'apply_patch', 'edit', 'write',
  'read', 'read_file', 'view_file', 'glob', 'grep',
  'js', 'js_reset', 'js_add_node_module_dir', 'view_image',
  'update_plan', 'request_user_input', 'web_search',
  // 枚举 / 记账类工具：它们只用来发现有什么，本身不是「在用」。
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'get_goal', 'create_goal', 'update_goal',
  'spawn_agent', 'wait_agent', 'send_message', 'followup_task',
  'interrupt_agent', 'list_agents',
];

// 读 SKILL.md 才算「用了这个技能」，而且必须是「读命令 + SKILL.md 作为路径参数」：
// rg / Select-String 搜索、Copy-Item 复制、把路径写进 patch 内容都不算。
const READ_VERBS = new Set([
  'get-content', 'gc', 'cat', 'type', 'more', 'less', 'head', 'tail', 'bat',
  'nl', 'sed', 'od',
]);
const READ_ONLY_TOOLS = new Set([
  'read', 'read_file', 'readfile', 'read_text_file', 'view_file', 'get_file',
]);

// 把读命令藏在开关后面的外壳：`pwsh -Command "Get-Content …"`、`bash -lc "cat …"`、
// `cmd /c type …`。剥掉外壳再分析里面那层（最多两层）。
const SHELL_WRAPPERS = new Set(['pwsh', 'powershell', 'sh', 'bash', 'zsh', 'dash', 'ksh', 'cmd']);

// 输入是「文件内容 / 补丁文本」的工具：它们不是命令，内容里出现的 SKILL.md 只是被
// 写入的文本，不能算这次读到了技能（旧版会把补丁里的一行 Get-Content … 当成技能调用）。
const CONTENT_TOOLS = new Set([
  'apply_patch', 'edit', 'write', 'write_file', 'create_file', 'multiedit',
  'str_replace', 'str_replace_editor', 'notebook_edit', 'patch', 'save_file',
]);

// 故意做得醒目：这是用户唯一能在会话里看到的东西（Codex 会加 warning: 前缀）。
const STYLES = {
  emoji: {
    skill: '🎯 SKILL', 'plugin-skill': '🧩 PLUGIN SKILL', 'skill-read': '📄 SKILL.md',
    mcp: '🔌 PLUGIN MCP', tool: '🔌 PLUGIN TOOL', unknown: '❔ UNKNOWN', session: '⚙️ HOOK',
  },
  plain: {
    skill: '>>> SKILL', 'plugin-skill': '>>> PLUGIN SKILL', 'skill-read': '>>> READ SKILL.md',
    mcp: '>>> PLUGIN MCP', tool: '>>> PLUGIN TOOL', unknown: '>>> UNKNOWN', session: '>>> HOOK',
  },
  zh: {
    skill: '【技能】', 'plugin-skill': '【插件技能】', 'skill-read': '【读 SKILL.md】',
    mcp: '【插件调用】', tool: '【插件工具】', unknown: '【未识别】', session: '【自检】',
  },
};

// 运行期收集的「软错误」：配置写坏、目录不可写等。以前这些是静默回退的，
// 现在会在 SessionStart 那一行里报出来。
const problems = [];

function addProblem(message) {
  if (!problems.includes(message)) problems.push(message);
}

// ------------------------------------------------------------------ 小工具

function parseJsonFile(target, label, required) {
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''); // 兼容 UTF-8 BOM
  } catch (err) {
    if (required && err && err.code !== 'ENOENT') addProblem(`${label} 读取失败: ${err.message}`);
    return undefined;
  }
  try {
    const value = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      addProblem(`${label} 顶层必须是 JSON 对象，已按空处理`);
      return undefined;
    }
    return value;
  } catch (err) {
    addProblem(`${label} 不是合法 JSON（${err.message}），已按空处理`);
    return undefined;
  }
}

function expandHome(target) {
  if (target === '~') return HOME;
  if (target.startsWith('~/') || target.startsWith('~\\')) return path.join(HOME, target.slice(2));
  return target;
}

function envName(key) {
  return 'CODEX_SKILL_USAGE_' + key.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase();
}

function toList(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

// ------------------------------------------------------------------- 设置

const configPath = expandHome((process.env.CODEX_SKILL_USAGE_CONFIG || '').trim() || DEFAULT_CONFIG);
const settingsFile = parseJsonFile(configPath, 'skill-usage.config.json', true) || {};

function rawSetting(key) {
  const fromEnv = process.env[envName(key)];
  if (fromEnv !== undefined && fromEnv !== '') return String(fromEnv);
  const fromFile = settingsFile[key];
  if (fromFile === undefined || fromFile === null) return undefined;
  return Array.isArray(fromFile) ? fromFile.join(',') : String(fromFile);
}

function flag(key, fallback) {
  const value = rawSetting(key);
  if (value === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function text(key, fallback) {
  const value = rawSetting(key);
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function num(key, fallback) {
  const value = rawSetting(key);
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function notesPath() {
  return expandHome(text('notes', DEFAULT_NOTES));
}

function autoNotesPath() {
  return expandHome(text('autoNotes', DEFAULT_AUTO));
}

function logPath() {
  return expandHome(text('log', DEFAULT_LOG));
}

function statePath() {
  return expandHome(text('state', DEFAULT_STATE));
}

function isIgnoredServer(server) {
  const included = new Set(toList(text('includeServers', '')));
  if (included.has(server)) return false;
  return BASE_IGNORE_SERVERS.includes(server);
}

function isIgnoredTool(name) {
  const lower = name.toLowerCase();
  const extra = toList(text('ignoreTools', '')).map((v) => v.toLowerCase());
  return extra.includes(lower) || BASE_IGNORE_TOOLS.includes(lower);
}

// -------------------------------------------------------------------- 日志

// 自带轮转：超过上限时当前文件改名 .1、另起一个，磁盘占用封顶 2x 上限。
function rotateIfNeeded(target, incomingBytes) {
  const max = num('maxBytes', BASE_MAX_BYTES);
  if (!Number.isFinite(max) || max <= 0) return;
  let size = 0;
  try {
    size = fs.statSync(target).size;
  } catch {
    return; // 还没有日志文件
  }
  if (size + incomingBytes <= max) return;
  try {
    fs.rmSync(target + '.1', { force: true });
    fs.renameSync(target, target + '.1');
  } catch {
    // 轮转失败就继续追加，宁可超一点也不要丢记录
  }
}

function append(records) {
  const target = logPath();
  if (target.toLowerCase() === 'off' || records.length === 0) return;
  const lines = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    rotateIfNeeded(target, Buffer.byteLength(lines));
    fs.appendFileSync(target, lines);
  } catch (err) {
    addProblem(`日志写入失败: ${err.message}`);
  }
}

function writeJsonAtomic(target, value) {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    addProblem(`写入 ${path.basename(target)} 失败: ${err.message}`);
    return false;
  }
}

// ------------------------------------------------------------------- 说明
// 尾部那句「这是什么」的取用顺序：
//   1. 手写字典 notes.json（skills / plugins / mcp / tools 四个桶）
//   2. 自动索引 notes.auto.json（由 plugin.json / SKILL.md 生成）
//   3. 现场读这次命中的 SKILL.md front-matter

function lookupNote(dict, name) {
  if (!name || !dict) return '';
  const slash = name.indexOf('/');
  const head = slash > 0 ? name.slice(0, slash) : '';
  const tail = slash > 0 ? name.slice(slash + 1) : '';
  // 从最具体到最粗略：完整名 -> 工具/技能名 -> 插件/server 名
  for (const key of [name, tail, head]) {
    if (!key) continue;
    for (const bucket of ['skills', 'plugins', 'mcp', 'tools']) {
      const hit = dict[bucket] && dict[bucket][key];
      if (typeof hit === 'string' && hit.trim()) return hit.trim();
    }
  }
  return '';
}

function trimNote(value) {
  const limit = Math.max(20, Math.floor(num('maxNoteChars', BASE_MAX_NOTE_CHARS)));
  const oneLine = String(value).replace(/\s+/g, ' ').trim();
  const stop = oneLine.search(/[.。；;]\s|\s—\s/);
  const first = stop > 8 ? oneLine.slice(0, stop) : oneLine;
  return first.length > limit ? first.slice(0, limit - 1) + '…' : first;
}

// 解析 YAML front-matter 里的 metadata.short-description 与 description。
function frontMatterNote(file, { short = false } = {}) {
  if (!file) return '';
  let body;
  try {
    body = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return '';
  }
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(body);
  if (!block) return '';
  const lines = block[1].split(/\r?\n/);
  const readValue = (startIndex, indent) => {
    const parts = [];
    for (let j = startIndex; j < lines.length; j++) {
      if (lines[j].trim() === '' || !new RegExp(`^\\s{${indent + 1},}`).test(lines[j])) break;
      parts.push(lines[j].trim());
    }
    return parts.join(' ');
  };
  let inline = '';
  let nested = '';
  for (let i = 0; i < lines.length; i++) {
    const top = /^description:\s*(.*)$/.exec(lines[i]);
    if (top) {
      const value = top[1].trim();
      inline = value === '' || /^[>|][-+]?$/.test(value) ? readValue(i + 1, 0) : value;
      continue;
    }
    const shortHit = /^\s+short-description:\s*(.*)$/.exec(lines[i]);
    if (shortHit) {
      const value = shortHit[1].trim();
      const indent = /^(\s+)/.exec(lines[i])[1].length;
      nested = value === '' || /^[>|][-+]?$/.test(value) ? readValue(i + 1, indent) : value;
    }
  }
  const picked = short && nested ? nested : inline || nested;
  return picked ? trimNote(picked.replace(/^["']|["']$/g, '')) : '';
}

function manifestNote(manifest) {
  const iface = manifest.interface;
  const candidates = [iface && iface.shortDescription, manifest.description, iface && iface.longDescription];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) return trimNote(value);
  }
  return '';
}

// --------------------------------------------------------------- 自动索引
// 只在 SessionStart（和「读到没索引过的技能」时）执行；结果落在 notes.auto.json。
// 只扫「已装」的两处：skills/ 与 plugins/cache/。marketplaces/ 是可选目录
// （本机 1415 个目录、314 个 SKILL.md），扫它会拖慢会话启动，因此默认不看；
// 需要时用配置项 scanRoots 加回来。

let rootsCache;

function scanRoots() {
  if (rootsCache) return rootsCache;
  const roots = [
    path.join(CODEX_HOME, 'skills'),
    path.join(CODEX_HOME, 'plugins', 'cache'),
    // Codex 也把这里当技能根（本机列出的技能根之一，放的是 hyperframes-* 等）。
    path.join(HOME, '.agents', 'skills'),
    ...toList(text('scanRoots', '')).map(expandHome),
  ];
  const seen = new Set();
  const usable = [];
  for (const root of roots) {
    const key = root.toLowerCase();
    if (!root || seen.has(key)) continue;
    seen.add(key);
    try {
      if (fs.statSync(root).isDirectory()) usable.push(root);
    } catch {
      // 不存在的扫描根直接跳过：市场被移除是正常事
    }
  }
  rootsCache = usable;
  return usable;
}

function scanRegistry() {
  const skills = {};
  const plugins = {};
  const mcp = {};
  let visited = 0;
  let truncated = false;

  const walk = (dir, depth) => {
    if (truncated || depth > SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    visited += entries.length;
    if (visited > SCAN_MAX_ENTRIES) {
      truncated = true;
      return;
    }
    const names = new Set(entries.map((entry) => entry.name));

    // 插件根：.codex-plugin/plugin.json 给出插件名、说明，以及它提供的 MCP 服务器
    if (names.has('.codex-plugin')) {
      const manifest = parseJsonFile(path.join(dir, '.codex-plugin', 'plugin.json'), 'plugin.json');
      if (manifest) {
        const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : path.basename(dir);
        const note = manifestNote(manifest);
        if (note && !plugins[name]) plugins[name] = note;
        // mcpServers 一般是 "./.mcp.json"，也可能直接内联
        const ref = manifest.mcpServers;
        const sources = [];
        if (typeof ref === 'string' && ref.trim()) sources.push(path.resolve(dir, ref.trim()));
        else if (ref && typeof ref === 'object') sources.push(ref);
        for (const source of sources) {
          const parsed = typeof source === 'string' ? parseJsonFile(source, path.basename(source)) : source;
          const servers = parsed && parsed.mcpServers;
          if (!servers || typeof servers !== 'object') continue;
          for (const serverName of Object.keys(servers)) {
            if (note && !mcp[serverName]) mcp[serverName] = note;
          }
        }
      }
    }

    // 技能目录：SKILL.md 所在目录名就是技能名；技能不再嵌套，故不再往下走
    if (names.has('SKILL.md')) {
      const skill = path.basename(dir);
      const file = path.join(dir, 'SKILL.md');
      if (skill && skill !== '.codex-plugin') {
        if (!skills[skill]) {
          const note = frontMatterNote(file, { short: true });
          if (note) skills[skill] = note;
        }
      }
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // 点目录默认不进（.git / .venv 之类），两个例外：插件根 .codex-plugin，
      // 以及 Codex 自带的系统技能目录 .system（imagegen / openai-docs / skill-* 在里面）。
      if (entry.name.startsWith('.') && entry.name !== '.codex-plugin' && entry.name !== '.system') continue;
      if (SCAN_SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  };

  const roots = scanRoots();
  for (const root of roots) walk(root, 0);

  return {
    generatedAt: new Date().toISOString(),
    hookVersion: HOOK_VERSION,
    roots,
    truncated,
    skills,
    plugins,
    mcp,
  };
}

let autoCache; // undefined = 还没读；null = 不存在；对象 = 已读

function loadAutoNotes() {
  if (autoCache !== undefined) return autoCache;
  autoCache = parseJsonFile(autoNotesPath(), path.basename(autoNotesPath())) || null;
  return autoCache;
}

let autoRefreshed = false;

function autoNotesAge() {
  try {
    return Date.now() - fs.statSync(autoNotesPath()).mtimeMs;
  } catch {
    return Infinity;
  }
}

// 技能/插件刚装好、还没被索引时现场补扫一次；只有命中路径位于扫描根下才会触发，
// 因此读别的仓库里的 SKILL.md 不会反复扫描。
function refreshAutoNotes(force) {
  if (autoRefreshed && !force) return loadAutoNotes();
  if (!force && autoNotesAge() < 60_000) {
    autoRefreshed = true;
    return loadAutoNotes();
  }
  autoRefreshed = true;
  const registry = scanRegistry();
  writeJsonAtomic(autoNotesPath(), registry);
  autoCache = registry;
  return registry;
}

function isUnderScanRoots(file) {
  const target = path.resolve(file).toLowerCase();
  return scanRoots().some((root) => target.startsWith(path.resolve(root).toLowerCase() + path.sep));
}

let notesCache; // 手写字典只读一次（以前每次提示都要读一遍）

function loadNotes() {
  if (notesCache !== undefined) return notesCache;
  notesCache = parseJsonFile(notesPath(), path.basename(notesPath())) || null;
  return notesCache;
}

// 「这个 SKILL.md 属于本机已装技能」的两条证据（任一成立即可）：
//   1) 解析出的路径落在扫描根下（~/.codex/skills、~/.codex/plugins/cache、~/.agents/skills…）；
//   2) SKILL.md 的父目录名 / 所属插件名出现在自动索引里（经软链或别的路径写法进来时）。
// 都不成立（例如在读某个仓库里正在编写 / 复核的 SKILL.md）就只能报「读取了 SKILL.md」。
function isInstalledSkill(file, name, plugin, cwd) {
  const resolved = resolveToken(file, cwd);
  if (resolved && isUnderScanRoots(resolved)) return true;
  const registry = loadAutoNotes();
  if (!registry) return false;
  return [name, plugin]
    .filter(Boolean)
    .map((value) => value.toLowerCase())
    .some((key) => (registry.skills && registry.skills[key]) || (registry.plugins && registry.plugins[key]));
}

let knownToolNames;

// 裸名工具（非 mcp__ 形式）不按名字猜类别：只有手写字典 tools / plugins / mcp 桶里
// 登记过的名字才算「已确认的插件工具」，其余一律标成未识别。
function isKnownToolName(tool) {
  if (knownToolNames === undefined) {
    knownToolNames = new Set();
    const dict = loadNotes();
    if (dict) {
      for (const bucket of ['tools', 'plugins', 'mcp']) {
        for (const key of Object.keys(dict[bucket] || {})) knownToolNames.add(key.toLowerCase());
      }
    }
  }
  return knownToolNames.has(tool.toLowerCase());
}

// ---------------------------------------------------------------- 计数状态
// 只有把 noteLimit 设成有限数时才用得上：那时「同一个名字在一个项目里只有前 N 次
// 带说明」，计数按会话工作目录隔离。默认（无限）不读也不写这个文件。

let stateCache;

function loadState() {
  if (stateCache !== undefined) return stateCache;
  const parsed = parseJsonFile(statePath(), path.basename(statePath())) || {};
  if (!parsed.projects || typeof parsed.projects !== 'object') parsed.projects = {};
  stateCache = parsed;
  return stateCache;
}

function projectEntry(key) {
  const projects = loadState().projects;
  let entry = projects[key];
  if (!entry || typeof entry !== 'object') entry = { seen: '', names: {} };
  if (!entry.names || typeof entry.names !== 'object') entry.names = {};
  projects[key] = entry;
  return entry;
}

function pruneProjects(projects) {
  const keys = Object.keys(projects);
  if (keys.length <= BASE_MAX_PROJECTS) return projects;
  // 手改坏的 state 里可能有 null 值：取 seen 时要挡住，否则整个 hook 会在写盘前抛掉，
  // 连提示都发不出来。
  const seenOf = (key) => {
    const entry = projects[key];
    return entry && typeof entry === 'object' ? String(entry.seen || '') : '';
  };
  keys.sort((a, b) => seenOf(b).localeCompare(seenOf(a)));
  const keep = {};
  for (const key of keys.slice(0, BASE_MAX_PROJECTS)) keep[key] = projects[key];
  return keep;
}

function saveState() {
  if (stateCache === undefined) return;
  stateCache.projects = pruneProjects(stateCache.projects);
  writeJsonAtomic(statePath(), stateCache);
}

function projectKey(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) return '(unknown)';
  return cwd.trim().replace(/[\\/]+$/, '').toLowerCase();
}

// -------------------------------------------------------------------- 提示

function shortenHome(target) {
  if (!target) return '';
  return target.toLowerCase().startsWith(HOME.toLowerCase()) ? '~' + target.slice(HOME.length) : target;
}

// 命令行里出现的 SKILL.md 可能是相对路径或 ~ 开头，也可能来自技能别名
// （形如 r0/ponytail/SKILL.md）。这里尽量把它变成真实路径，读 front-matter
// 和判断「是否在扫描根下」才有意义。
function resolveToken(file, cwd) {
  if (!file) return '';
  const expanded = expandHome(file);
  if (path.isAbsolute(expanded)) return expanded;
  return cwd ? path.resolve(cwd, expanded) : expanded;
}

function styleFor() {
  return STYLES[text('style', 'emoji')] || STYLES.emoji;
}

// noteLimit 默认无限大（每次调用都带说明）；只有显式配了有限数才启用配额计数。
function noteLimitSetting() {
  const value = Math.floor(num('noteLimit', BASE_NOTE_LIMIT));
  return Number.isFinite(value) ? value : Infinity;
}

function formatNotice(found, ctx) {
  const style = styleFor();
  const verbose = flag('verbose', false);
  const limit = noteLimitSetting();
  const tracked = Number.isFinite(limit); // 默认每次显示：不计数，也就不碰 state 文件
  const withNotes = flag('note', true) && limit > 0;
  const dict = withNotes ? loadNotes() || {} : null;
  const auto = withNotes ? loadAutoNotes() : null;
  const project = withNotes && tracked ? projectEntry(ctx.project) : null;
  let dirty = false;

  const lines = found.map((entry) => {
    const head = `${style[entry.kind] || entry.kind} ▸ ${entry.name}`;
    let note = '';
    if (withNotes) {
      // 只有有限配额才会出现「超过配额」：那时第 N+1 次起连字典/SKILL.md 都不再读，
      // 只剩名字。默认无限配额，所以每次都要取说明。
      // 计数在「查过」时就 +1，否则没写进字典的名字会每次都去读 SKILL.md。
      const key = entry.kind + '=' + entry.name;
      const seen = tracked ? Number(project.names[key]) || 0 : 0;
      if (seen < limit) {
        note = lookupNote(dict, entry.name) || lookupNote(auto, entry.name);
        const file = resolveToken(entry.file, ctx.cwd);
        if (!note && file) {
          if (isUnderScanRoots(file) && autoNotesAge() > 60_000) {
            refreshAutoNotes(false); // 现场补扫：刚装好的技能
            note = lookupNote(loadAutoNotes(), entry.name);
          }
          if (!note) note = frontMatterNote(file, { short: true });
        }
        if (tracked) {
          project.names[key] = seen + 1;
          dirty = true;
        }
      }
    }
    let line = note ? `${head}  —  ${note}` : head;
    if (verbose && entry.file) line += `   ${shortenHome(entry.file)}`;
    return line;
  });

  if (dirty) {
    project.seen = new Date().toISOString();
    saveState();
  }
  return lines.join('\n');
}

function sessionNotice() {
  const registry = refreshAutoNotes(true);
  const style = styleFor();
  const head = `${style.session} ▸ skill-usage v${HOOK_VERSION}`;
  if (problems.length) return `${head}  —  ⚠️ ${problems.slice(0, 3).join('；')}`;
  if (registry.truncated) return `${head}  —  ⚠️ 索引超过 ${SCAN_MAX_ENTRIES} 条目已截断（可调 scanRoots）`;
  const skills = Object.keys(registry.skills).length;
  const plugins = Object.keys(registry.plugins).length;
  const servers = Object.keys(registry.mcp).length;
  return `${head}  —  已索引 ${skills} 技能 / ${plugins} 插件 / ${servers} MCP；新装的会自动收录`;
}

// ------------------------------------------------------------------ 识别

function commandString(value, depth = 0) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && depth < 3) return value.map((v) => commandString(v, depth + 1)).join(' ');
  if (value && typeof value === 'object') return Object.values(value).map((v) => commandString(v, depth + 1)).join(' ');
  return '';
}

// `VAR=value cmd` / `$env:VAR="value"; cmd` 会藏住真正的命令头
function stripAssignments(segment) {
  let rest = segment.trim();
  for (let i = 0; i < 32; i++) {
    const hit = /^(?:\$env:[A-Za-z_]\w*|[A-Za-z_]\w*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s;|&]+)\s*/.exec(rest);
    if (!hit) break;
    rest = rest.slice(hit[0].length);
  }
  return rest;
}

function headCommand(segment) {
  const word = /^\S+/.exec(stripAssignments(segment));
  if (!word) return '';
  const base = word[0].split(/[\\/]/).pop() || '';
  // 命令可能被引号包着（`"C:\…\Get-Content.exe" x` / `pwsh -c "Get-Content …"`）
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, '').replace(/^["']|["']$/g, '');
}

// 按 shell 分隔符切段，但引号内的分隔符不算分隔符
// （`Get-Content "C:\a;b\SKILL.md"` 是一段）。只做这一层，不引入完整 shell 解析器。
function splitSegments(text_) {
  const out = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < text_.length; i++) {
    const ch = text_[i];
    if (quote) {
      current += ch;
      if (ch === '`' && quote === '"') {
        if (i + 1 < text_.length) current += text_[++i]; // PowerShell 反引号转义
      } else if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '&' || ch === '\r' || ch === '\n') {
      out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

function collectSkillFiles(text_, into) {
  // 引号里的目标整体看（路径可以带空格），裸 token 仍按空白切。
  for (const hit of text_.matchAll(/"[^"\r\n]*SKILL\.md"|'[^'\r\n]*SKILL\.md'|[^\s"'\r\n]*SKILL\.md/gi)) {
    let token = hit[0];
    if (token[0] === '"' || token[0] === "'") token = token.slice(1, -1); // 去掉外层引号
    if (!token || token.startsWith('-') || /[*?]/.test(token)) continue; // 参数或通配符，不是具体文件
    into.add(token);
  }
}

function skillFilesRead(cmd, tool) {
  const name = (tool || '').toLowerCase();
  // 补丁 / 写文件工具的输入是内容而不是命令：里面的 SKILL.md 只是被写入的文本。
  if (CONTENT_TOOLS.has(name)) return [];
  const files = new Set();
  if (READ_ONLY_TOOLS.has(name)) {
    collectSkillFiles(cmd, files);
    return [...files];
  }
  collectReadTargets(cmd, files, 2);
  return [...files];
}

// 剥掉 `pwsh -Command "…"` 这类外壳，留下里面那层命令
function unwrapShell(segment) {
  let inner = stripAssignments(segment)
    .replace(/^\S+/, '') // 可执行名
    .replace(/^\s*(?:--?[A-Za-z][A-Za-z-]*\s+|\/[A-Za-z]\s+)*/, ''); // 开关（-Command / -lc / /c …）
  if (inner.length > 1 && (inner[0] === '"' || inner[0] === "'") && inner.endsWith(inner[0])) {
    inner = inner.slice(1, -1); // 去掉包住整条内层命令的引号
  }
  return inner;
}

function collectReadTargets(text_, into, depth) {
  for (const segment of splitSegments(text_)) {
    const head = headCommand(segment);
    if (READ_VERBS.has(head)) {
      collectSkillFiles(segment, into);
      continue;
    }
    if (depth > 0 && SHELL_WRAPPERS.has(head)) collectReadTargets(unwrapShell(segment), into, depth - 1);
  }
}

// 技能名 = SKILL.md 的父目录名。插件名要在路径里找「插件根」：
//   1) <home>/.codex/plugins/cache/<市场>/<插件>/<版本>/skills/<技能>/SKILL.md
//   2) <市场源>/<市场>/<插件>/<版本>/skills/<技能>/SKILL.md
//   3) <...>/plugins/<插件>/skills/<技能>/SKILL.md
// 只有路径里确实出现 plugins / marketplaces / bundled-marketplaces 标记时才算插件技能。
const PLUGIN_MARKERS = ['plugins', 'marketplaces', 'bundled-marketplaces'];

function skillFromFile(file) {
  const parts = file.split(/[\\/]/).filter(Boolean);
  const skill = parts.length >= 2 ? parts[parts.length - 2] : '';
  const result = { name: skill && !/^skill\.md$/i.test(skill) ? skill : '', plugin: '' };
  if (!result.name) return result;

  // 取「最靠后」的那个标记：路径里可能嵌套两层 plugins（例如
  // ...\plugins\openai-primary-runtime\plugins\documents\skills\documents\SKILL.md），
  // 靠后的那个才贴着真正的插件名。
  let markerIndex = -1;
  for (let i = parts.length - 1; i > 0; i--) {
    if (PLUGIN_MARKERS.includes(parts[i].toLowerCase())) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex < 0) return result;

  // 取「标记之后、技能目录之前」的段，去掉 cache / skills / 标记词本身：
  //   [cache, 市场, 插件, 版本] -> 插件；[插件] -> 插件
  const between = parts
    .slice(markerIndex + 1, parts.length - 2)
    .filter((part) => {
      const lower = part.toLowerCase();
      return lower !== 'cache' && lower !== 'skills' && !PLUGIN_MARKERS.includes(lower);
    });
  if (between.length >= 2) result.plugin = between[1];
  else if (between.length === 1 && !/^v?\d/.test(between[0])) result.plugin = between[0];
  return result;
}

function detect(event) {
  const tool = typeof event.tool_name === 'string' ? event.tool_name : '';
  // 补丁 / 写文件工具的输入是内容（可能几百 KB）：既不必拼成大字符串，也别在里面找 SKILL.md。
  const cmd = CONTENT_TOOLS.has(tool.toLowerCase()) ? '' : commandString(event.tool_input?.command ?? event.tool_input ?? '');
  const cwd = typeof event.cwd === 'string' ? event.cwd : '';
  const found = [];
  const seen = new Set();
  const add = (kind, name, file) => {
    if (!name) return;
    const key = kind + '=' + name;
    if (seen.has(key)) return;
    seen.add(key);
    found.push(file ? { kind, name, file } : { kind, name });
  };

  // 1) 读命令 + SKILL.md 路径参数 => 这次读取了这个 SKILL.md。
  //    只有能确认它是本机已装技能才报成技能调用；确认不了就报「读取了 SKILL.md」，
  //    因为复核 / 编写别人仓库里的 SKILL.md 也会走到这里，那不算「用了这个技能」。
  for (const file of skillFilesRead(cmd, tool)) {
    const { name, plugin } = skillFromFile(file);
    const label = plugin && name ? `${plugin}/${name}` : name || plugin;
    if (!label) continue;
    const kind = plugin ? 'plugin-skill' : 'skill';
    if (isInstalledSkill(file, name, plugin, cwd)) add(kind, label, file);
    else add('skill-read', label, file);
  }

  // 2) mcp__ 前缀 => 经典 MCP 工具
  if (tool.startsWith('mcp__')) {
    const rest = tool.slice('mcp__'.length);
    const sep = rest.lastIndexOf('__');
    if (sep > 0) {
      const server = rest.slice(0, sep);
      if (!isIgnoredServer(server)) add('mcp', `${server}/${rest.slice(sep + 2)}`);
    } else if (!isIgnoredServer(rest)) {
      add('mcp', rest);
    }
  } else if (tool && !isIgnoredTool(tool)) {
    // 3) 裸名工具：某些桌面端版本这样暴露插件工具（如 list_artifacts / automation_update）。
    //    不靠名字猜它是不是 skill / 插件：字典里登记过才算插件工具，否则只标未识别。
    add(isKnownToolName(tool) ? 'tool' : 'unknown', tool);
  }

  return { tool, found };
}

// ------------------------------------------------------------------ 主流程

function readEvent() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return undefined;
  }
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

// 必须用 fs.writeSync：process.exit() 可能把 stdout 缓冲里的内容丢掉。
function emit(payload) {
  try {
    fs.writeSync(1, Buffer.from(JSON.stringify(payload) + '\n'));
  } catch {
    // 提示发不出去也不该影响工具调用
  }
}

function runHook(event) {
  const kind = typeof event.hook_event_name === 'string' ? event.hook_event_name : '';

  if (kind === 'SessionStart') {
    if (flag('debug', false)) {
      append([{ ts: new Date().toISOString(), v: HOOK_VERSION, kind: 'session-start', source: event.source ?? null, cwd: event.cwd ?? null }]);
    }
    if (flag('notify', true) && flag('notifyStart', true)) emit({ systemMessage: sessionNotice() });
    return;
  }

  const { tool, found } = detect(event);

  // debug: 记录每个工具名（含被忽略的），用来确认本机工具的真实命名
  if (flag('debug', false) && tool) {
    append([{ ts: new Date().toISOString(), v: HOOK_VERSION, kind: 'tool-name', name: tool, tool }]);
  }

  if (found.length === 0) return;

  if (logPath().toLowerCase() !== 'off') {
    const ts = new Date().toISOString();
    append(
      found.map((entry) => ({
        ts,
        v: HOOK_VERSION,
        kind: entry.kind,
        name: entry.name,
        file: entry.file ? shortenHome(entry.file) : null,
        tool,
        turn: event.turn_id ?? null,
        session: event.session_id ?? null,
        cwd: event.cwd ?? null,
      })),
    );
  }

  if (flag('notify', true)) {
    const body = formatNotice(found, { project: projectKey(event.cwd), cwd: event.cwd });
    // 运行期出的问题（配置写坏、日志写不进去）就在当次提示里说出来，
    // 否则它们会安静地一直存在，直到某天你发现提示里的说明没了。
    emit({ systemMessage: problems.length ? `${body}\n⚠️ ${problems.slice(0, 2).join('；')}` : body });
  }
}

// ------------------------------------------------------------- 命令行模式

// 和 hook 的提示一样，命令行输出也走 fs.writeSync：process.exit() 可能把
// process.stdout.write 还没落地的内容丢掉（尤其是被管道/重定向的时候）。
function say(text_) {
  try {
    fs.writeSync(1, Buffer.from(text_ + '\n'));
  } catch {
    // 输出失败不值得报错
  }
}

function cmdCheck() {
  const stateFile = statePath();
  const probe = path.join(path.dirname(stateFile), `.skill-usage-write-test-${process.pid}`);
  let writable = 'ok';
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'x');
    fs.rmSync(probe, { force: true });
  } catch (err) {
    writable = `失败: ${err.message}`;
  }
  const logFile = logPath();
  const limitShown = noteLimitSetting();
  const lines = [
    `codex_home      ${CODEX_HOME}`,
    `hook_version    v${HOOK_VERSION}`,
    `config          ${configPath}${fs.existsSync(configPath) ? '' : '  (不存在，用内置默认值)'}`,
    `notes(手写)     ${notesPath()}${fs.existsSync(notesPath()) ? '' : '  (不存在)'}`,
    `notes(自动)     ${autoNotesPath()}${fs.existsSync(autoNotesPath()) ? `  ${Math.round(autoNotesAge() / 1000)}s 前生成` : '  (未生成，会话启动时会生成)'}`,
    `log             ${logFile}${logFile.toLowerCase() === 'off' ? '' : fs.existsSync(logFile) ? `  ${fs.statSync(logFile).size} B` : '  (不存在)'}`,
    `state           ${stateFile}`,
    `style           ${text('style', 'emoji')}  notify=${flag('notify', true)}  notifyStart=${flag('notifyStart', true)}  verbose=${flag('verbose', false)}  noteLimit=${Number.isFinite(limitShown) ? limitShown : '每次（无上限）'}`,
    `scan_roots      ${scanRoots().join(' | ') || '(无)'}`,
    `writable        ${writable}`,
  ];
  if (problems.length) lines.push(...problems.map((p) => `problem         ${p}`));
  return lines.join('\n');
}

function cmdDiscover(write) {
  const registry = write ? refreshAutoNotes(true) : loadAutoNotes() || refreshAutoNotes(true);
  const lines = [`扫描根: ${registry.roots.join(' | ') || '(无)'}`, `生成时间: ${registry.generatedAt}${registry.truncated ? ' (已截断)' : ''}`];
  for (const bucket of ['skills', 'plugins', 'mcp']) {
    const items = Object.entries(registry[bucket] || {});
    lines.push('', `[${bucket}] ${items.length} 项`);
    for (const [name, note] of items.sort((a, b) => a[0].localeCompare(b[0]))) lines.push(`  ${name.padEnd(28)} ${note}`);
  }
  if (write) lines.push('', `已写入 ${autoNotesPath()}`);
  return lines.join('\n');
}

function cmdStats() {
  const target = logPath();
  if (target.toLowerCase() === 'off') return '日志已关闭（log=off）';
  let rows;
  try {
    rows = fs
      .readFileSync(target, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((row) => row && row.kind && row.kind !== 'tool-name');
  } catch (err) {
    return `读不到日志 ${target}: ${err.message}`;
  }
  if (rows.length === 0) return `${target} 里还没有记录`;
  const counts = new Map();
  for (const row of rows) {
    const key = `${row.kind} ${row.name}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const out = [`共 ${rows.length} 条记录，${rows[0].ts} ~ ${rows[rows.length - 1].ts}`, ''];
  for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    out.push(String(count).padStart(5) + '  ' + key);
  }
  return out.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    say('用法: skill-usage-hook.mjs [--check] [--discover [--write]] [--stats]\n不带参数时按 hook 运行，从 stdin 读事件 JSON。');
    return;
  }
  if (args.includes('--check')) {
    say(cmdCheck());
    return;
  }
  if (args.includes('--discover')) {
    say(cmdDiscover(args.includes('--write')));
    return;
  }
  if (args.includes('--stats')) {
    say(cmdStats());
    return;
  }
  const event = readEvent();
  if (event && typeof event === 'object') runHook(event);
}

// hook 崩溃绝不能影响工具调用：任何意外都安静退出（只有 debug 时才写 stderr）。
try {
  main();
} catch (err) {
  if (flag('debug', false)) {
    try {
      fs.writeSync(2, Buffer.from(`skill-usage hook error: ${(err && err.stack) || err}\n`));
    } catch {
      // 连 stderr 都写不出去就彻底放弃
    }
  }
}
process.exit(0);
