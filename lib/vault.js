// 「工作区」：把工作台卡片接到 note 仓库上，契约固定，格式对不上就报错，不静默空着：
//   速记卡片 → 设置里指定的 Markdown 文件段落（默认 0-raw/1-workspace/0-workspace.md 的 ## todo）
//   roadmap / 近期规划 → 设置里的路线图文件（默认同上）
//   每天的时间块 / TODO / 总结 → 设置里的日报目录（归档目录按同规则找）
// 三个路径都在「设置 → 工作台」里改，置空即关闭。
import {readdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join, normalize, sep} from 'node:path';

const MAX_SECTION = 120;
// 仓库视图的数据源：默认按下面这套目录结构，可在「设置 → 工作台」里改；置空即关闭，
// 关闭后这些接口只回 `not-configured`，不碰任何路径。
export const REPO_DEFAULTS = {file: '0-raw/1-workspace/0-workspace.md', dailyDir: '1-log/0-daily', archiveDir: '1-log/2-archive/daily'};
// 没设过（undefined/null）用默认值；显式清空（''）表示关闭，逃逸的路径按关闭处理。
const pickPath = (raw, fallback) => (raw === undefined || raw === null ? fallback : insideWorkspace(raw) ?? '');

// 速记默认绑定到工作区里那份笔记的 `## todo`；把路径清空就退回卡片自己的存储。
export const NOTES_DEFAULTS = {file: '0-raw/1-workspace/0-workspace.md', section: 'todo'};

// 设置里给的路径必须留在工作区内：拒绝绝对路径和 `..` 逃逸。
const insideWorkspace = value => {
  const text = String(value ?? '').trim();
  if (!text || isAbsolute(text)) return null;
  const path = normalize(text);
  return path === '..' || path.startsWith(`..${sep}`) ? null : path;
};

export const notesLayout = prefs => ({
  file: pickPath(prefs?.noteFile, NOTES_DEFAULTS.file),
  section: String(prefs?.noteSection ?? '').trim().slice(0, MAX_SECTION) || NOTES_DEFAULTS.section,
});

export const repoLayout = prefs => ({
  file: pickPath(prefs?.repoFile, REPO_DEFAULTS.file),
  dailyDir: pickPath(prefs?.repoDailyDir, REPO_DEFAULTS.dailyDir),
  archiveDir: pickPath(prefs?.repoArchiveDir, REPO_DEFAULTS.archiveDir),
});

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const CHECK = /^([ \t]*)- \[([ xX])\]\s?(.*)$/;
const HEAD = /^##\s+/;
const TIME = /^(\d{1,2}:\d{2})\s*[-–~至]\s*(\d{1,2}:\d{2})\s*(.*)$/;
const PLACEHOLDER = /^(x{1,3}|今天做什么)$/i;
// 可回写的文件：配置的 roadmap 文件、日报目录（含归档目录）下的 Markdown，别的路径一律拒绝。
const writable = (rel, paths) => {
  if (paths.file && rel === paths.file) return true;
  return [paths.dailyDir, paths.archiveDir].some(dir => dir && rel.startsWith(`${dir}/`) && rel.endsWith('.md'));
};

const pad = n => String(n).padStart(2, '0');
const toMin = s => {
  const [h, m] = String(s).split(':').map(Number);
  return h * 60 + m;
};
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const mmdd = d => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const mondayOf = d => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));

export const dayStamp = (ms = Date.now()) => {
  const d = new Date(ms);
  return {date: iso(d), weekday: WEEKDAYS[d.getDay()]};
};

export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return {year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 86400000 + 1) / 7)};
}

// ISO 周的周一（year 是 ISO 周年，不是日历年）。
export function mondayOfIso(year, week) {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const shift = (jan4.getUTCDay() + 6) % 7;
  const first = new Date(jan4.getTime() - shift * 86400000);
  const d = new Date(first.getTime() + (week - 1) * 7 * 86400000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

const lines = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

// 某个 `## 标题` 的区间（不含标题行本身）。
function findSection(all, title) {
  const start = all.findIndex(line => line.trim() === `## ${title}`);
  if (start < 0) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) if (HEAD.test(all[i])) { end = i; break; }
  return {start: start + 1, end};
}

// 某个 section 的正文：去掉首尾空行，内部空行与缩进原样保留；读写两边用同一份口径比较。
function sectionText(all, scope) {
  const body = all.slice(scope.start, scope.end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join('\n');
}

// 把区间里的 `- [ ]` 行按缩进组成一层父子；indent 0 是父，缩进的是上一个父的子。
function tree(all, from, to) {
  const out = [];
  for (let i = from; i < to; i++) {
    const m = CHECK.exec(all[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, '  ').length;
    const item = {text: m[3].trim(), done: m[2] !== ' ', line: i + 1, indent, children: []};
    if (indent === 0) out.push(item);
    else if (out.length) out[out.length - 1].children.push(item);
  }
  return out;
}

async function readText(path) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) return null;
  return {text: await readFile(path, 'utf8'), mtime: info.mtimeMs};
}

// 某天的日报：先找日报目录，再找归档；文件名里的周几写错也能按日期前缀兜住。
async function dailyFile(root, date, weekday, paths) {
  const name = `${date}-周${weekday}.md`;
  const {dailyDir, archiveDir} = paths;
  const direct = dailyDir ? await readText(join(root, dailyDir, name)) : null;
  if (direct) return {path: join(root, dailyDir, name), name, ...direct};
  const archived = archiveDir ? await readText(join(root, archiveDir, date.slice(0, 7), name)) : null;
  if (archived) return {path: join(root, archiveDir, date.slice(0, 7), name), name, ...archived};
  for (const dir of [dailyDir, archiveDir && join(archiveDir, date.slice(0, 7))].filter(Boolean)) {
    const names = (await readdir(join(root, dir)).catch(() => [])).filter(n => n.startsWith(date) && n.endsWith('.md'));
    if (!names.length) continue;
    const loose = await readText(join(root, dir, names.sort()[0]));
    if (loose) return {path: join(root, dir, names[0]), name: names[0], ...loose};
  }
  return {path: '', name, text: null, mtime: 0, missing: true};
}

function dayDetail(text, file) {
  const all = lines(text);
  const scope = findSection(all, 'Day planner');
  const blocks = [];
  if (scope) {
    for (let i = scope.start; i < scope.end; i++) {
      const m = CHECK.exec(all[i]);
      if (!m) continue;
      const t = TIME.exec(m[3].trim());
      if (!t) continue;
      const note = t[3].trim();
      blocks.push({
        text: m[3].trim(), note, done: m[2] !== ' ',
        start: t[1], end: t[2], startMin: toMin(t[1]), endMin: toMin(t[2]),
        placeholder: !note || PLACEHOLDER.test(note), line: i + 1, file,
      });
    }
  }
  const todoScope = findSection(all, 'TODO');
  const todo = todoScope ? tree(all, todoScope.start, todoScope.end).filter(it => !PLACEHOLDER.test(it.text)).map(it => ({...it, file})) : [];
  const notes = [];
  for (const title of ['完成的事情 & 自己的思考', '总结']) {
    const s = findSection(all, title);
    if (!s) continue;
    const body = all.slice(s.start, s.end).map(l => l.trim()).filter(l => l && !PLACEHOLDER.test(l)).join('\n');
    if (body) notes.push({title, text: body});
  }
  return {blocks: blocks.sort((a, b) => a.startMin - b.startMin), todo, notes};
}

function weekReport(all) {
  const scope = findSection(all, 'timeline');
  if (!scope) return [];
  const at = all.findIndex((line, i) => i >= scope.start && i < scope.end && line.trim() === '周报');
  if (at < 0) return [];
  let end = scope.end;
  for (let i = at + 1; i < scope.end; i++) {
    const line = all[i];
    if (!line.trim()) continue;
    if (CHECK.test(line) || /^[ \t]/.test(line)) continue;
    end = i;
    break;
  }
  return tree(all, at + 1, end);
}

function roadmapTree(all) {
  const scope = findSection(all, 'roadmap');
  if (!scope) return [];
  return tree(all, scope.start, scope.end).map(month => {
    const key = /^\d{6}$/.test(month.text) ? `${month.text.slice(0, 4)}-${month.text.slice(4)}` : month.text;
    return {...month, month: key, year: Number(month.text.slice(0, 4)) || 0};
  });
}

export function createVault({root, layout = notesLayout, repo = repoLayout, fallback = null, open, now = Date.now} = {}) {
  const vaultRoot = () => {
    const value = typeof root === 'function' ? root() : root;
    return typeof value === 'string' && isAbsolute(value) ? value : null;
  };
  const relOf = (base, path) => path.slice(base.length + 1);
  const paths = () => (typeof repo === 'function' ? repo() : repo) ?? REPO_DEFAULTS;
  // layout 已经处理过默认值与清空语义，这里只做最后一道校验：不在工作区内的路径按未绑定处理。
  const config = () => {
    const value = (typeof layout === 'function' ? layout() : layout) ?? {};
    return {file: insideWorkspace(value.file) ?? '', section: String(value.section ?? '').trim().slice(0, MAX_SECTION) || NOTES_DEFAULTS.section};
  };
  // 没绑定笔记文件（或没配工作区）时退回调用方给的兜底存储，保持上游的速记行为。
  const unbound = (base, file) => !base || !file;

  // 一周：offset 以「本周」为 0，负数往前翻。
  const week = async ({offset = 0} = {}) => {
    const base = vaultRoot();
    if (!base) return {ok: false, error: 'no-workspace'};
    if (!paths().dailyDir) return {ok: false, error: 'not-configured'};
    const start = addDays(mondayOf(new Date(now())), Number(offset || 0) * 7);
    const errors = [];
    const days = [];
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const file = await dailyFile(base, iso(date), WEEKDAYS[date.getDay()], paths());
      const detail = file.text == null ? {blocks: [], todo: [], notes: []} : dayDetail(file.text, relOf(base, file.path));
      if (file.text == null) errors.push(`${iso(date)} 没有日报`);
      days.push({
        date: iso(date), weekday: WEEKDAYS[date.getDay()], mmdd: mmdd(date),
        name: file.name, rel: file.path ? relOf(base, file.path) : '', mtime: file.mtime,
        missing: Boolean(file.missing), renamed: Boolean(file.renamed),
        ...detail,
      });
    }
    const last = addDays(start, 6);
    const w = isoWeek(start);
    return {
      ok: true, offset: Number(offset || 0), year: w.year, week: w.week,
      monday: iso(start), sunday: iso(last), label: `${mmdd(start)} ~ ${mmdd(last)}`,
      days, errors,
    };
  };

  // roadmap：把 Wxx 换算成真实日期区间，供日历染色。
  const roadmap = async () => {
    const base = vaultRoot();
    if (!base) return {ok: false, error: 'no-workspace'};
    const file = paths().file;
    if (!file) return {ok: false, error: 'not-configured'};
    const source = await readText(join(base, file));
    if (!source) return {ok: false, error: `${file} 不存在`};
    const all = lines(source.text);
    const months = roadmapTree(all);
    const weeks = [];
    const byDate = {};
    for (const month of months) {
      for (const wk of month.children) {
        const hit = /W(\d{1,2})/.exec(wk.text);
        if (!hit) continue;
        const monday = mondayOfIso(month.year, Number(hit[1]));
        const sunday = addDays(monday, 6);
        const items = (wk.children || []).length ? wk.children : [];
        const row = {
          label: months.length > 1 ? `W${hit[1]}` : wk.text,
          month: month.month, monday: iso(monday), sunday: iso(sunday),
          title: wk.text, done: wk.done, line: wk.line, file,
          items: items.map(it => ({...it, file})),
        };
        weeks.push(row);
        for (let i = 0; i < 7; i++) byDate[iso(addDays(monday, i))] = row.label;
      }
    }
    return {ok: true, weeks, byDate, mtime: source.mtime, errors: months.length ? [] : ['## roadmap 里没有月份条目']};
  };

  // 兼容旧卡片：一次性看全部三块。
  const scan = async () => {
    const base = vaultRoot();
    if (!base) return {ok: false, error: 'no-workspace'};
    if (!paths().file && !paths().dailyDir) return {ok: false, error: 'not-configured'};
    const errors = [];
    const file = paths().file;
    const source = file ? await readText(join(base, file)) : null;
    const all = source ? lines(source.text) : [];
    const today = await dailyFile(base, dayStamp(now()).date, dayStamp(now()).weekday, paths());
    const detail = today.text == null ? {blocks: [], todo: [], notes: []} : dayDetail(today.text, today.path ? relOf(base, today.path) : '');
    return {
      ok: true, at: now(), root: base,
      roadmap: {items: source ? roadmapTree(all) : [], mtime: source?.mtime ?? 0},
      near: {todo: source && findSection(all, 'todo') ? tree(all, findSection(all, 'todo').start, findSection(all, 'todo').end) : [], week: source ? weekReport(all) : [], mtime: source?.mtime ?? 0},
      today: {name: today.name, path: today.path, mtime: today.mtime, missing: Boolean(today.missing), changed: Boolean(today.renamed), ...detail},
      errors,
    };
  };

  // 勾选回写：只改那一行的勾选标记，行号或原文对不上就拒绝，避免覆盖 Obsidian 里的编辑。
  const toggle = async ({file, line, expect, done} = {}) => {
    const base = vaultRoot();
    if (!base) throw new Error('no-workspace');
    const rel = String(file ?? '');
    if (!writable(rel, paths())) throw new Error(`不允许写这个文件：${rel}`);
    const at = Number(line);
    if (!(at > 0)) throw new Error('行号无效');
    const path = join(base, rel);
    const text = await readFile(path, 'utf8').catch(() => null);
    if (text == null) throw new Error('文件不存在');
    const all = text.replace(/\r\n?/g, '\n').split('\n');
    const m = CHECK.exec(all[at - 1] ?? '');
    if (!m) throw new Error('这一行不是勾选项');
    if (expect != null && m[3].trim() !== String(expect).trim()) throw new Error('文件已变，请刷新');
    all[at - 1] = `${m[1]}- [${done ? 'x' : ' '}] ${m[3]}`;
    const next = all.join('\n');
    const tmp = `${path}.workboard.tmp`;
    await writeFile(tmp, next, 'utf8');
    await rename(tmp, path);
    const info = await stat(path);
    return {ok: true, mtime: info.mtimeMs};
  };

  // 速记卡片：`## <段落>` 整段正文的读写。写回只替换这一段的正文，其他 section 原样保留；
  // expect 是改动前读到的正文，对不上说明文件被外部（Obsidian）改过，拒绝覆盖。
  // 没绑定文件时走 fallback（卡片自己的存储），绑定后卡片与 Agent 读写同一份正文。
  const readSection = async ({title} = {}) => {
    const base = vaultRoot();
    const {file, section: configured} = config();
    const name = title || configured;
    if (unbound(base, file)) {
      if (!fallback) return {ok: false, error: 'no-notes-file'};
      const note = await fallback.read();
      return {ok: true, file: '', title: name, text: String(note?.text ?? ''), mtime: Number(note?.updatedAt) || 0};
    }
    // 笔记文件可以是工作区里的任意 Markdown（config 里已挡掉绝对路径和 `..` 逃逸），
    // 不像 toggle 那样限定在日报与 roadmap 白名单里。
    const source = await readText(join(base, file));
    if (!source) return {ok: false, error: `${file} 不存在`};
    const all = lines(source.text);
    const scope = findSection(all, name);
    if (!scope) return {ok: false, error: `${file} 里没有 ## ${name}`};
    return {ok: true, file, title: name, text: sectionText(all, scope), mtime: source.mtime};
  };

  const writeSection = async ({title, text = '', expect} = {}) => {
    const base = vaultRoot();
    const {file, section: configured} = config();
    const name = title || configured;
    if (unbound(base, file)) {
      if (!fallback) throw new Error('no-notes-file');
      const note = await fallback.write(String(text));
      return {ok: true, file: '', title: name, text: String(note?.text ?? text), mtime: Number(note?.updatedAt) || 0};
    }
    const path = join(base, file);
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current == null) throw new Error('文件不存在');
    const all = lines(current);
    const scope = findSection(all, name);
    if (!scope) throw new Error(`文件里没有 ## ${name}`);
    if (expect != null && sectionText(all, scope) !== String(expect)) throw new Error('文件已变，请先刷新');
    const body = lines(text);
    while (body.length && !body[0].trim()) body.shift();
    while (body.length && !body[body.length - 1].trim()) body.pop();
    // 只替换这段正文，前后的空行按文件原样保留：内容没改的写回是逐字节一致的。
    const raw = all.slice(scope.start, scope.end);
    let lead = 0;
    while (lead < raw.length && !raw[lead].trim()) lead++;
    let tail = raw.length;
    while (tail > lead && !raw[tail - 1].trim()) tail--;
    const next = [...all.slice(0, scope.start), ...raw.slice(0, lead), ...body, ...raw.slice(tail), ...all.slice(scope.end)].join('\n');
    const tmp = `${path}.workboard.tmp`;
    await writeFile(tmp, next, 'utf8');
    await rename(tmp, path);
    return {ok: true, file, title: name, text: body.join('\n'), mtime: (await stat(path)).mtimeMs};
  };

  // 只开配置里的两处：今日日报、roadmap 源文件；不接收任意路径。
  const openFile = async ({target} = {}) => {
    const base = vaultRoot();
    if (!base) throw new Error('no-workspace');
    if (typeof open !== 'function') throw new Error('opening files is not available');
    const {file, dailyDir} = paths();
    if (target === 'workspace' ? !file : !dailyDir) throw new Error('not-configured');
    const stamp = dayStamp(now());
    const path = target === 'workspace' ? join(base, file)
      : (await dailyFile(base, stamp.date, stamp.weekday, paths())).path || join(base, dailyDir, `${stamp.date}-周${stamp.weekday}.md`);
    return open({path});
  };

  return {scan, week, roadmap, toggle, section: readSection, writeSection, open: openFile};
}
