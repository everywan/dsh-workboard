// 「工作区笔记」：把速记卡片接到工作区里的一个 Markdown 文件段落上，卡片与 Agent 共用同一份正文。
// 默认 0-raw/1-workspace/0-workspace.md 的 ## todo；文件名与段落标题都能在「设置 → 工作台」里改。
import {readFile, rename, stat, writeFile} from 'node:fs/promises';
import {isAbsolute, join, normalize, sep} from 'node:path';

const HEAD = /^##\s+/;
const MAX_SECTION = 120;

// 默认不绑定文件：行为和上游一致，速记仍是卡片自己的存储；配置了才落到工作区文件。
export const NOTES_DEFAULTS = {file: '', section: 'todo'};

// 设置里给的路径必须留在工作区内：拒绝绝对路径和 `..` 逃逸。
const insideWorkspace = value => {
  const text = String(value ?? '').trim();
  if (!text || isAbsolute(text)) return null;
  const path = normalize(text);
  return path === '..' || path.startsWith(`..${sep}`) ? null : path;
};

export const notesLayout = prefs => ({
  file: insideWorkspace(prefs?.noteFile) ?? NOTES_DEFAULTS.file,
  section: String(prefs?.noteSection ?? '').trim().slice(0, MAX_SECTION) || NOTES_DEFAULTS.section,
});

const lines = text => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');

// 某个 `## 标题` 的区间（不含标题行本身）。
function findSection(all, title) {
  const start = all.findIndex(line => line.trim() === `## ${title}`);
  if (start < 0) return null;
  let end = all.length;
  for (let i = start + 1; i < all.length; i++) if (HEAD.test(all[i])) { end = i; break; }
  return {start: start + 1, end};
}

// 正文口径：去掉首尾空行，内部空行与缩进原样保留；读写两边用同一份口径比较。
function sectionText(all, scope) {
  const body = all.slice(scope.start, scope.end);
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  return body.join('\n');
}

export function createVault({root, layout = notesLayout, fallback = null} = {}) {
  const workspace = () => {
    const value = typeof root === 'function' ? root() : root;
    return typeof value === 'string' && isAbsolute(value) ? value : null;
  };
  const config = () => {
    const value = (typeof layout === 'function' ? layout() : layout) ?? {};
    return {file: insideWorkspace(value.file) ?? NOTES_DEFAULTS.file, section: value.section || NOTES_DEFAULTS.section};
  };
  // 没绑定笔记文件（或没配工作区）时退回调用方给的兜底存储，保持上游的速记行为。
  const unbound = (base, file) => !base || !file;

  const section = async ({title} = {}) => {
    const base = workspace();
    const {file, section: configured} = config();
    const name = title || configured;
    if (unbound(base, file)) {
      if (!fallback) return {ok: false, error: 'no-notes-file'};
      const note = await fallback.read();
      return {ok: true, file: '', title: name, text: String(note?.text ?? ''), mtime: Number(note?.updatedAt) || 0};
    }
    const path = join(base, file);
    const info = await stat(path).catch(() => null);
    if (!info?.isFile()) return {ok: false, error: `${file} 不存在`};
    const all = lines(await readFile(path, 'utf8'));
    const scope = findSection(all, name);
    if (!scope) return {ok: false, error: `${file} 里没有 ## ${name}`};
    return {ok: true, file, title: name, text: sectionText(all, scope), mtime: info.mtimeMs};
  };

  const writeSection = async ({title, text = '', expect} = {}) => {
    const base = workspace();
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

  return {section, writeSection};
}
