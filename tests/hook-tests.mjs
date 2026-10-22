#!/usr/bin/env node
// 定向测试：用合成 hook 事件喂给真实脚本，检查提示内容与日志。
// 所有路径重定向到临时目录，不碰真实的 log / state / notes / hooks.json。
//
// 用法：
//   node tests/hook-tests.mjs                       # 测上一层的 skill-usage-hook.mjs
//   HOOK_UNDER_TEST=/path/to/skill-usage-hook.mjs node tests/hook-tests.mjs
//
// 在 Windows 上实测（Node 24）；macOS / Linux 的路径形态也可跑，但未实机验证。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOK = process.env.HOOK_UNDER_TEST || path.join(here, '..', 'skill-usage-hook.mjs');
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'suh-'));
const spaceRoot = path.join(tmp, 'my skills');
const semiRoot = path.join(tmp, 'semi;dir');
const outsideRoot = path.join(tmp, 'somewhere');

function makeSkill(dir, name, desc) {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\nmetadata:\n  short-description: ${desc}\ndescription: ${desc}\n---\n\nbody\n`);
  return path.join(d, 'SKILL.md');
}

makeSkill(spaceRoot, 'spaced-skill', '带空格的技能目录');
const innerSpaceSkill = makeSkill(spaceRoot, 'inner space skill', '技能目录名里带空格');
makeSkill(semiRoot, 'semi-skill', '分号技能');
makeSkill(outsideRoot, 'outside-skill', '仓库里正在编写的技能');

const cfgPath = path.join(tmp, 'config.json');
const logPath = path.join(tmp, 'log.jsonl');
const statePath = path.join(tmp, 'state.json');
const notesPath = path.join(tmp, 'notes.json');
fs.writeFileSync(notesPath, JSON.stringify({ tools: { list_artifacts: '列出本会话关联的 PR / 工作树' }, skills: { 'spaced-skill': '空格技能中文说明' } }));
fs.writeFileSync(
  cfgPath,
  JSON.stringify({ style: 'emoji', log: logPath, state: statePath, notes: notesPath, autoNotes: path.join(tmp, 'auto.json'), scanRoots: [spaceRoot, semiRoot] }),
);

const env = { ...process.env, CODEX_SKILL_USAGE_CONFIG: cfgPath };

function run(event, extraEnv) {
  if (fs.existsSync(logPath)) fs.rmSync(logPath);
  const res = spawnSync(process.execPath, ['--no-warnings', HOOK], {
    input: JSON.stringify(event),
    env: extraEnv ? { ...env, ...extraEnv } : env,
    encoding: 'utf8',
  });
  const raw = (res.stdout || '').trim();
  let message = '';
  if (raw) {
    try {
      message = JSON.parse(raw).systemMessage || '';
    } catch {
      message = `<无法解析: ${raw}>`;
    }
  }
  const log = fs.existsSync(logPath)
    ? fs
        .readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { message, log, stderr: (res.stderr || '').trim() };
}

const cmdEvent = (command, tool = 'exec_command') => ({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: { command }, cwd: tmp, session_id: 'test', turn_id: 'test' });

let failures = 0;
let skipped = 0;
function check(name, got, want) {
  const ok = typeof want === 'function' ? want(got) : got.includes(want);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n      got: ${String(got).replace(/\n/g, ' / ')}`);
}
function skip(name, why) {
  skipped++;
  console.log(`SKIP  ${name}  (${why})`);
}

const spaced = path.join(spaceRoot, 'spaced-skill', 'SKILL.md');
const semi = path.join(semiRoot, 'semi-skill', 'SKILL.md');
const outside = path.join(outsideRoot, 'outside-skill', 'SKILL.md');

// --- 常规：已装技能（扫描根下）------------------------------------------------
check('已装技能：裸路径读 SKILL.md', run(cmdEvent(`Get-Content ${spaced}`)).message, 'spaced-skill');
check('已装技能：带引号且路径含空格', run(cmdEvent(`Get-Content "${spaced}"`)).message, 'spaced-skill');
check('已装技能：技能目录名里带空格', run(cmdEvent(`Get-Content "${innerSpaceSkill}"`)).message, 'inner space skill');
check('已装技能：引号内含分号', run(cmdEvent(`Get-Content "${semi}"`)).message, 'semi-skill');
check('已装技能：Read 工具', run({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: spaced }, cwd: tmp }).message, 'spaced-skill');

// --- 读取了 SKILL.md，但不能确认是已装技能 ------------------------------------
{
  const r = run(cmdEvent(`Get-Content ${outside}`));
  check('未确认：提示不冒充技能调用', r.message, (m) => m.includes('outside-skill') && !m.includes('🎯'));
  check('未确认：日志 kind=skill-read', JSON.stringify(r.log), (s) => s.includes('"skill-read"'));
}

// --- 不该算「读了技能」的写法 --------------------------------------------------
check('搜索 SKILL.md 不算', run(cmdEvent(`rg -n ponytail ${spaceRoot}`)).message, (m) => m === '');
check('列目录不算', run(cmdEvent(`Get-ChildItem ${spaced}`)).message, (m) => m === '');
check('复制不算', run(cmdEvent(`Copy-Item ${spaced} ${path.join(tmp, 'x.md')}`)).message, (m) => m === '');
check('apply_patch 补丁内容不算', run({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { input: `*** Begin Patch\n*** Update File: a.md\n@@\n Get-Content ${spaced}\n*** End Patch` }, cwd: tmp }).message, (m) => m === '');
check('Write 工具内容不算', run({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(tmp, 'a.sh'), content: `cat ${spaced}` }, cwd: tmp }).message, (m) => m === '');

// --- 工具名不能猜类别 ---------------------------------------------------------
check('裸名未知工具标未知', run({ hook_event_name: 'PreToolUse', tool_name: 'frobnicate_widget', tool_input: {}, cwd: tmp }).message, (m) => m.includes('frobnicate_widget') && !m.includes('PLUGIN') && !m.includes('🎯'));
check('名字里带 skill 也不能猜成技能', run({ hook_event_name: 'PreToolUse', tool_name: 'skill_helper_xyz', tool_input: {}, cwd: tmp }).message, (m) => !m.includes('🎯 SKILL'));
check('字典里登记过的裸名工具 = 插件工具', run({ hook_event_name: 'PreToolUse', tool_name: 'list_artifacts', tool_input: {}, cwd: tmp }).message, (m) => m.includes('PLUGIN TOOL') && m.includes('list_artifacts'));
check('MCP 工具', run({ hook_event_name: 'PreToolUse', tool_name: 'mcp__code_review__fetch_pr', tool_input: {}, cwd: tmp }).message, 'code_review/fetch_pr');
check('Codex 内置工具不上报', run({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { command: 'git status' }, cwd: tmp }).message, (m) => m === '');

// --- 外壳包装的读命令（pwsh -Command / bash -lc / cmd /c） --------------------
check('pwsh -Command 内层读', run(cmdEvent(`pwsh -NoProfile -Command "Get-Content '${spaced}'"`)).message, 'spaced-skill');
check('bash -lc 内层读', run(cmdEvent(`bash -lc "cat '${semi}'"`)).message, 'semi-skill');
check('cmd /c 内层读', run(cmdEvent(`cmd /c type "${spaced}"`)).message, 'spaced-skill');
check('外壳里的非读命令不算', run(cmdEvent('pwsh -NoProfile -Command "npm test"')).message, (m) => m === '');

// --- 说明默认每次都显示（v3.2） ----------------------------------------------
{
  fs.rmSync(statePath, { force: true });
  const first = run(cmdEvent(`Get-Content "${spaced}"`)).message;
  let sixth = first;
  for (let i = 0; i < 5; i++) sixth = run(cmdEvent(`Get-Content "${spaced}"`)).message;
  check('第 1 次带说明', first, '空格技能中文说明');
  check('第 6 次仍带说明（不再限前 3 次）', sixth, '空格技能中文说明');
  check('每次都显示：提示逐字相同', sixth, (m) => m === first);
  check('每次都显示：默认不写 state 文件', fs.existsSync(statePath) ? '写入了 state' : '无 state 文件', '无 state 文件');

  // 说明来自自动索引（不在手写字典里）时，同样每次都带
  run({ hook_event_name: 'SessionStart', source: 'startup', cwd: tmp });
  let autoLast = '';
  for (let i = 0; i < 4; i++) autoLast = run(cmdEvent(`Get-Content "${semi}"`)).message;
  check('自动索引来的说明也每次都带', autoLast, '分号技能');

  // MCP 命中：没有说明也要每次都出名字
  let mcpLast = '';
  for (let i = 0; i < 4; i++) mcpLast = run({ hook_event_name: 'PreToolUse', tool_name: 'mcp__code_review__fetch_pr', tool_input: {}, cwd: tmp }).message;
  check('MCP 每次调用都显示', mcpLast, 'code_review/fetch_pr');
}

// --- 有限 noteLimit：旧配额行为保留（可回退） ---------------------------------
{
  fs.rmSync(statePath, { force: true });
  const two = { CODEX_SKILL_USAGE_NOTE_LIMIT: '2' };
  check('有限配额：第 1 次带说明', run(cmdEvent(`Get-Content "${spaced}"`), two).message, '空格技能中文说明');
  check('有限配额：第 2 次仍带说明', run(cmdEvent(`Get-Content "${spaced}"`), two).message, '空格技能中文说明');
  check(
    '有限配额：第 3 次只剩名字',
    run(cmdEvent(`Get-Content "${spaced}"`), two).message,
    (m) => m.includes('spaced-skill') && !m.includes('空格技能中文说明'),
  );
  check(
    'noteLimit=0：只显示名字',
    run(cmdEvent(`Get-Content "${spaced}"`), { CODEX_SKILL_USAGE_NOTE_LIMIT: '0' }).message,
    (m) => m.includes('spaced-skill') && !m.includes('空格技能中文说明'),
  );
}

// --- 坏 state：null 项 + 超过 200 个项目仍要能出提示（有限配额下才用 state） ---
{
  const projects = {};
  for (let i = 0; i < 205; i++) projects[`c:\\p${i}`] = { seen: '2026-01-01T00:00:00.000Z', names: {} };
  projects['c:\\broken'] = null;
  fs.writeFileSync(statePath, JSON.stringify({ projects }));
  const quota = { CODEX_SKILL_USAGE_NOTE_LIMIT: '2' };
  check('坏 state 仍能出提示', run(cmdEvent(`Get-Content "${spaced}"`), quota).message, 'spaced-skill');
  check(
    '坏 state 被剪回 200 个项目',
    String(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8')).projects).length),
    '200',
  );
}

// --- 未闭合引号 / 空 stdin ----------------------------------------------------
check('未闭合引号不崩', run(cmdEvent(`Get-Content "${spaced} ; echo 1`)).message, 'spaced-skill');
check('空事件不崩', run({}).message, (m) => m === '');

// --- 真实插件技能（本机装了插件才有这一项） -----------------------------------
{
  const cache = path.join(CODEX_HOME, 'plugins', 'cache');
  let found = null;
  if (fs.existsSync(cache)) {
    for (const market of fs.readdirSync(cache)) {
      for (const plugin of fs.readdirSync(path.join(cache, market))) {
        const base = path.join(cache, market, plugin);
        for (const version of fs.readdirSync(base)) {
          const skills = path.join(base, version, 'skills');
          if (!fs.existsSync(skills)) continue;
          for (const skill of fs.readdirSync(skills)) {
            const file = path.join(skills, skill, 'SKILL.md');
            if (fs.existsSync(file)) { found = { file, plugin, skill }; }
          }
        }
      }
    }
  }
  if (found) {
    check(`真实插件技能（${found.plugin}/${found.skill}）`, run(cmdEvent(`Get-Content "${found.file}"`)).message, (m) => m.includes('PLUGIN SKILL') && m.includes(`${found.plugin}/${found.skill}`));
  } else {
    skip('真实插件技能', '本机 ~/.codex/plugins/cache 里没有插件技能');
  }
}

// --- SessionStart：索引要含本机已装技能 ---------------------------------------
{
  const r = run({ hook_event_name: 'SessionStart', source: 'startup', cwd: tmp });
  check('SessionStart 自检行', r.message, 'skill-usage');
  const auto = JSON.parse(fs.readFileSync(path.join(tmp, 'auto.json'), 'utf8'));
  console.log(`      索引: ${Object.keys(auto.skills).length} 技能 / ${Object.keys(auto.plugins).length} 插件 / ${Object.keys(auto.mcp).length} MCP, truncated=${auto.truncated}`);
  const homeSkills = path.join(CODEX_HOME, 'skills');
  if (fs.existsSync(path.join(homeSkills, 'ponytail', 'SKILL.md'))) {
    check('索引含本机 ~/.codex/skills 里的技能', JSON.stringify(auto.skills), (s) => s.includes('"ponytail"'));
  } else {
    skip('索引含本机技能', '本机没有 ~/.codex/skills/ponytail/SKILL.md');
  }
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}${skipped ? `（跳过 ${skipped} 项）` : ''}（临时目录 ${tmp}）`);
process.exit(failures === 0 ? 0 : 1);
