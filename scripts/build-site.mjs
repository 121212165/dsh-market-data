/**
 * M4: generate the GitHub Pages site from data/index.json.
 *
 * The page is fully static and self-contained: index.json is embedded at build
 * time, so "合入后 index.json 与页面同步" is a build invariant, not a runtime
 * fetch. A sha256 of the exact source bytes is stamped into the HTML for the
 * verification harness to compare. No framework, no CDN, no network at runtime.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = join(ROOT, 'data', 'index.json');
const OUT = join(ROOT, 'site', 'index.html');

/** Tolerate the two index shapes the data layer has used (schema / schemaVersion). */
export function normalizeIndex(raw) {
  return {
    schemaVersion: raw.schemaVersion ?? raw.schema ?? 1,
    generatedAt: raw.generatedAt ?? '',
    source: raw.source ?? 'dsh-market-data',
    plugins: Array.isArray(raw.plugins) ? raw.plugins : [],
    groups: Array.isArray(raw.groups) ? raw.groups : [],
  };
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const INSTALL = (id) => `/market install ${id}`;

function groupCard(group, pluginById) {
  const members = (group.members || []).map((id) => {
    const p = pluginById.get(id);
    return `<li><code>${esc(id)}</code>${p ? `<span class="sub">${esc(p.oneLiner)}</span>` : ''}</li>`;
  }).join('');
  const why = (group.why || []).map((line) => `<li>${esc(line)}</li>`).join('');
  const verify = (group.verify || []).map((line) => `<li>${esc(line)}</li>`).join('');
  const badge = group.curator === 'editor' ? '<span class="badge editor">编辑精选</span>' : '<span class="badge">社区投稿</span>';
  const cmd = INSTALL(group.id);
  return `<article class="card" data-group="${esc(group.id)}">
    <div class="card-top">
      <h3>${esc(group.name)}</h3>${badge}
    </div>
    <p class="lead">${esc(group.oneLiner)}</p>
    <div class="members"><h4>成员（安装顺序）</h4><ol>${members}</ol></div>
    <details><summary>为什么这组（真实握手契约）</summary><ul>${why}</ul></details>
    <details><summary>装完怎么验</summary><ul>${verify}</ul></details>
    <div class="card-foot">
      <code class="cmd">${esc(cmd)}</code>
      <button type="button" data-copy-install="${esc(cmd)}">复制安装命令</button>
      <span class="copied" aria-live="polite"></span>
    </div>
  </article>`;
}

function pluginRow(p) {
  return `<tr data-plugin="${esc(p.id)}">
    <td><code>${esc(p.id)}</code><div class="sub">${esc(p.name)} · ${esc(p.oneLiner)}</div></td>
    <td>${esc(p.category)}</td>
    <td>${esc((p.entries || []).join(' '))}</td>
    <td><a href="https://github.com/${esc(p.repo)}" rel="noopener">${esc(p.repo)}</a><div class="sub">${esc(p.license)} · 核于 ${esc(p.verifiedAt)}</div></td>
  </tr>`;
}

export function renderHtml(rawIndex, { sourceSha256 = '', builtAt = '' } = {}) {
  const index = normalizeIndex(rawIndex);
  const pluginById = new Map(index.plugins.map((p) => [p.id, p]));
  const groups = index.groups
    .slice()
    .sort((a, b) => (a.curator === b.curator ? 0 : a.curator === 'editor' ? -1 : 1));
  const dataJson = JSON.stringify(index).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN" data-index-sha256="${esc(sourceSha256)}" data-built-at="${esc(builtAt)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 插件市集</title>
<style>
:root{color-scheme:light dark;--bg:#f7f8fa;--fg:#1b1b1f;--muted:#5b5b66;--card:#fff;--line:#e3e5ea;--accent:#1d6fe0;--chip:#eef3fb;--ok:#0a7d3f}
@media(prefers-color-scheme:dark){:root{--bg:#1b1b1f;--fg:#f2f3f5;--muted:#a9aab2;--card:#232328;--line:#35353c;--accent:#7db2ff;--chip:#262b34;--ok:#5cdb95}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:28px 20px 64px}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:baseline;justify-content:space-between;margin-bottom:8px}
h1{font-size:26px;margin:0}h2{font-size:19px;margin:36px 0 12px}h3{font-size:16px;margin:0}h4{font-size:12px;margin:14px 0 6px;color:var(--muted);font-weight:600}
.tag{color:var(--muted);font-size:13px}
.stamp{font-size:12px;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:4px 10px;background:var(--card)}
.stamp.stale{color:#b26a00}.intro{color:var(--muted);margin:4px 0 20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;min-width:0;display:flex;flex-direction:column;gap:8px}
.card-top{display:flex;align-items:center;gap:8px;justify-content:space-between}
.lead{margin:0;color:var(--muted)}
.badge{font-size:11px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;white-space:nowrap;color:var(--muted)}
.badge.editor{border-color:var(--accent);color:var(--accent);background:var(--chip)}
.members ol{margin:0;padding-left:20px}.members li{margin:4px 0;overflow-wrap:anywhere}
.sub{display:block;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
details{border-top:1px solid var(--line);padding-top:8px}
summary{cursor:pointer;font-size:13px;color:var(--accent)}
details ul{margin:8px 0 0;padding-left:20px;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.card-foot{margin-top:auto;display:flex;flex-wrap:wrap;align-items:center;gap:8px;border-top:1px solid var(--line);padding-top:10px}
.cmd{font-size:12px;background:var(--chip);border-radius:6px;padding:5px 8px;overflow-wrap:anywhere;flex:1 1 auto}
button{font:inherit;font-size:12px;border:1px solid var(--accent);color:var(--accent);background:transparent;border-radius:6px;padding:5px 10px;cursor:pointer}
button:hover{background:var(--chip)}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.copied{font-size:12px;color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
th{color:var(--muted);font-size:12px}code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
a{color:var(--accent)}
footer{margin-top:44px;color:var(--muted);font-size:12px;border-top:1px solid var(--line);padding-top:14px}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>DSH 插件市集</h1>
    <span class="stamp" id="generated-at" data-generated-at="${esc(index.generatedAt)}">数据生成于 ${esc(index.generatedAt || '未知')}</span>
  </header>
  <p class="intro">选组 → 在 dsh 里运行安装命令 → 装完按「怎么验」自检。本站只读、不需要账号；安装只能发生在 dsh 会话内。</p>

  <h2>编辑精选与社区组（${groups.length}）</h2>
  <div class="grid" id="groups">
    ${groups.map((g) => groupCard(g, pluginById)).join('\n    ')}
  </div>

  <h2>全部插件（${index.plugins.length}）</h2>
  <table><thead><tr><th>插件 / 说明</th><th>分类</th><th>入口</th><th>仓库</th></tr></thead>
  <tbody>${index.plugins.map(pluginRow).join('\n  ')}</tbody></table>

  <footer>数据来自 <code>dsh-market-data/data/index.json</code>（嵌入构建，sha256 <code>${esc(sourceSha256.slice(0, 12))}</code>）。票数 / 投稿等写操作见 dsh 内 <code>/market</code>。</footer>
</div>
<script id="market-data" type="application/json">${dataJson}</script>
<script>
(function () {
  var data = JSON.parse(document.getElementById('market-data').textContent);
  var stamp = document.getElementById('generated-at');
  var t = Date.parse(data.generatedAt);
  if (Number.isFinite(t) && Date.now() - t > 24 * 3600 * 1000) {
    stamp.classList.add('stale');
    stamp.textContent = '快照 · 数据生成于 ' + data.generatedAt + '（超过 24h）';
  }
  document.addEventListener('click', function (ev) {
    var btn = ev.target.closest('[data-copy-install]');
    if (!btn) return;
    var cmd = btn.getAttribute('data-copy-install');
    var done = function () {
      var s = btn.parentNode.querySelector('.copied');
      if (s) s.textContent = '已复制';
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd).then(done, function () {
        var ta = document.createElement('textarea');
        ta.value = cmd; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
        document.body.removeChild(ta);
      });
    }
  });
})();
</script>
</body>
</html>`;
}

export function buildSite({ indexFile = INDEX, outFile = OUT } = {}) {
  const raw = readFileSync(indexFile, 'utf8');
  const sha256 = createHash('sha256').update(raw).digest('hex');
  // Deterministic: builtAt is derived from the source stamp, so rebuilding from
  // the same index.json is byte-identical (proves index→page sync in CI).
  const parsed = JSON.parse(raw);
  const html = renderHtml(parsed, { sourceSha256: sha256, builtAt: parsed.generatedAt ?? '' });
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, html, 'utf8');
  return { outFile, sha256, bytes: Buffer.byteLength(html, 'utf8') };
}

const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === invoked) {
  const r = buildSite();
  console.log(`build-site: ${r.outFile} (${r.bytes} bytes, index sha256 ${r.sha256.slice(0, 12)})`);
}
