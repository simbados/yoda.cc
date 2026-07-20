/**
 * Generates a self-contained HTML dependency report.
 *
 * All CSS is inlined so the output file has no external dependencies and can be
 * opened directly in a browser or attached to a PR / email. The visual design
 * mirrors web/index.html (same dark theme, same color classes).
 *
 * Multi-ecosystem support: the report renders one `<section>` per ecosystem
 * (npm → python → go), each with its own header, summary, and sortable table.
 * A single embedded sort script handles all sections by reading
 * `data-section="<id>"` attributes from the `<thead>` rows.
 */

import { randomBytes } from 'node:crypto';
import { sortedResults, ECOSYSTEM_ORDER, purlEcosystem } from './formatter.js';
import { groupByDomain } from './nonStandardSources.js';

/** Maps a depsview ecosystem label to the socket.dev URL slug for "(link)" anchors. */
const SOCKET_URL_SLUG = { npm: 'npm', python: 'pypi', go: 'go', rust: 'cargo' };

/**
 * Escapes a string for safe insertion into HTML text content or attribute values
 * (both double- and single-quoted). Encodes & < > " ' so the string cannot
 * break out of any syntactic context it is placed into.
 * Encoding order: & first so subsequent replacements don't double-encode.
 * @param {string|number|null|undefined} value
 * @returns {string}
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/**
 * Returns the number of whole days between an ISO date string and today.
 * Returns Infinity for missing or "unknown" dates so they never match a recency
 * threshold.
 * @param {string|null|undefined} dateStr
 * @returns {number}
 */
function daysSince(dateStr) {
  if (!dateStr || dateStr === 'unknown') return Infinity;
  const ms = Date.now() - new Date(dateStr).getTime();
  if (isNaN(ms)) return Infinity;
  return Math.floor(ms / 86_400_000);
}

/**
 * Maps a supply chain score (0–1) to display text and a CSS class name.
 * Returns null className when score is unavailable so callers can render a neutral dash.
 * @param {number|null} score
 * @returns {{ text: string, className: string|null }}
 */
function scoreDisplay(score) {
  if (score == null) return { text: '–', className: null };
  const pct = Math.round(score * 100);
  const className = score >= 0.8 ? 'score-good' : score >= 0.5 ? 'score-warn' : 'score-bad';
  return { text: `${pct}%`, className };
}

/**
 * Returns the socket.dev package URL for a given package name and ecosystem slug.
 * Returns null when socketSlug is falsy so callers can fall back to plain text.
 * @param {string} name
 * @param {string|null} socketSlug - the socket.dev URL slug (`npm`, `pypi`, `go`)
 * @returns {string|null}
 */
function socketPackageUrl(name, socketSlug) {
  if (!socketSlug) return null;
  const encoded = encodeURIComponent(name).replace(/%40/g, '@').replace(/%2F/gi, '/');
  return `https://socket.dev/${socketSlug}/package/${encoded}`;
}

/**
 * Formats a monthly download count as a locale string with thousand separators,
 * or returns "–" when the value is null.
 * @param {number|null} count
 * @returns {string}
 */
function formatDownloads(count) {
  return count !== null ? count.toLocaleString('en-US') : '–';
}

/** Inline CSS block shared by every generated report. */
const REPORT_CSS = `
:root {
  --bg: #0f172a;
  --surface: #1e293b;
  --border: #334155;
  --text: #f1f5f9;
  --muted: #94a3b8;
  --accent: #818cf8;
  --red: #fca5a5;
  --green: #4ade80;
}
* { box-sizing: border-box; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  margin: 0;
  padding: 2rem 1.5rem;
  line-height: 1.6;
}
main { max-width: 1200px; margin: 0 auto; }
h1 {
  font-size: 1.75rem;
  font-weight: 700;
  margin: 0 0 0.25rem;
  background: linear-gradient(90deg, #c4b5fd 0%, #a855f7 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
h2.section-title {
  font-size: 1.1rem;
  font-weight: 600;
  margin: 0 0 0.5rem;
  text-transform: lowercase;
  color: var(--accent);
  letter-spacing: 0.02em;
}
.report-meta { color: var(--muted); font-size: 0.85rem; margin: 0.25rem 0 2rem; }
.section { margin-bottom: 2.5rem; }
.section:last-child { margin-bottom: 0; }
.summary { color: var(--muted); font-size: 0.88rem; margin: 0 0 0.75rem; }
.note-warning {
  color: #fcd34d;
  background: rgba(146, 64, 14, 0.2);
  border-left: 3px solid #92400e;
  border-radius: 0 6px 6px 0;
  padding: 0.5rem 0.85rem;
  margin: 0 0 0.85rem;
  font-size: 0.85rem;
}
.table-scroll {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
  background: var(--surface);
}
thead tr { border-bottom: 2px solid var(--border); }
th {
  text-align: left;
  padding: 0.65rem 0.9rem;
  font-weight: 600;
  white-space: nowrap;
  color: var(--muted);
}
th[data-col] { cursor: pointer; user-select: none; }
th[data-col]:hover { color: var(--text); }
th.th-sort-desc::after { content: ' ▼'; font-size: 0.75em; opacity: 0.8; }
th.th-sort-asc::after  { content: ' ▲'; font-size: 0.75em; opacity: 0.8; }
td { padding: 0.55rem 0.9rem; border-bottom: 1px solid var(--border); }
tbody tr:last-child td { border-bottom: none; }
tbody tr:hover td { background: #273548; }
.age-new    { color: var(--red);  font-weight: 500; }
.age-orange { color: #fb923c;    font-weight: 500; }
.age-fresh  { color: #fcd34d;    font-weight: 500; }
.row-error td { color: var(--muted); font-style: italic; }
table a { color: var(--accent); text-decoration: none; }
table a:hover { text-decoration: underline; }
.score-good { color: var(--green); font-weight: 500; }
.score-warn { color: #fcd34d; font-weight: 500; }
.score-bad  { color: var(--red); font-weight: 500; }
.error-banner {
  background: rgba(146, 64, 14, 0.2);
  border-left: 3px solid #92400e;
  color: #fcd34d;
  padding: 0.5rem 0.85rem;
  border-radius: 0 6px 6px 0;
}
details.nonstd { margin-top: 0.75rem; border: 1px solid var(--border); border-radius: 6px; overflow: hidden; }
details.nonstd > summary { padding: 0.5rem 0.85rem; cursor: pointer; font-size: 0.82rem; color: var(--muted); user-select: none; list-style: none; }
details.nonstd > summary::-webkit-details-marker { display: none; }
details.nonstd > summary::before { content: '▸'; font-size: 1.2em; margin-right: 0.35rem; vertical-align: -0.05em; }
details.nonstd[open] > summary::before { content: '▾'; }
details.nonstd > summary:hover { color: var(--text); }
.nonstd-body { padding: 0.5rem 0.85rem 0.75rem; border-top: 1px solid var(--border); }
.nonstd-warn { color: #fbbf24; font-size: 0.82rem; margin: 0.2rem 0; }
.nonstd-info { color: var(--muted); font-size: 0.82rem; margin: 0.2rem 0; }
.nonstd-indent { padding-left: 1.25rem; }
`.trim();

/**
 * Builds one section block: heading + summary + table (or error banner when
 * the orchestrator captured an error for the ecosystem).
 *
 * @param {string} ecosystem        - 'npm' | 'python' | 'go'
 * @param {object} section          - section from orchestrator
 * @param {boolean} showHeader      - emit a `<h2>` section title above the table
 * @param {Map<string,number>|null} socketScores
 * @param {boolean} downloadStats
 * @returns {{ html: string, scriptCfg: object|null }} HTML + the per-section
 *   config object embedded into the sort script (null when section is an error).
 */
function renderSection(ecosystem, section, showHeader, socketScores, downloadStats) {
  const sectionId = `sec-${ecosystem}`;
  const headerHtml = showHeader
    ? `<h2 class="section-title">${escapeHtml(ecosystem)}</h2>`
    : '';

  if (section.error) {
    return {
      html: `<section class="section" data-section="${escapeHtml(sectionId)}">
  ${headerHtml}
  <p class="error-banner">${escapeHtml(section.error)}</p>
</section>`,
      scriptCfg: null,
    };
  }

  const rows = sortedResults(
    section.results,
    socketScores ?? new Map(),
    { ecosystem }
  );
  const total = rows.length;

  const showFirst  = ecosystem !== 'go';
  // Rust (crates.io 90-day figure) and npm (api.npmjs.org last-month figure)
  // always show downloads via cheap bulk fetches; Python only when
  // --download-stats was passed.
  const showDl     = ecosystem === 'rust' || ecosystem === 'npm' || (downloadStats && ecosystem === 'python');
  const dlLabel    = ecosystem === 'rust' ? 'Downloads (90d)' : 'Downloads/mo';
  const showSocket = socketScores != null;
  const socketSlug = SOCKET_URL_SLUG[ecosystem] ?? null;

  // Summary line
  let summaryText;
  if (section.directNames && section.directNames.size > 0) {
    const directCount = rows.filter(r => section.directNames.has(r.name.toLowerCase().replace(/[-_.]+/g, '-'))).length;
    const transitiveCount = total - directCount;
    summaryText = `${total} package${total !== 1 ? 's' : ''} total (${directCount} direct, ${transitiveCount} transitive)`;
  } else {
    summaryText = `${total} package${total !== 1 ? 's' : ''} total`;
  }
  if (section.source) summaryText += ` · from ${section.source}`;

  // Header columns
  const colDefs = [['Package', 'name'], ['Version', 'version'], ['Released', 'released']];
  if (showFirst)  colDefs.push(['First Release', 'firstReleased']);
  colDefs.push(['Releases', 'releases']);
  if (showDl)     colDefs.push([dlLabel, 'downloadsLastMonth']);
  if (showSocket) colDefs.push(['Supply Chain', 'supplyChain']);

  const headerCellsHtml = colDefs.map(([label, col]) =>
    `<th data-col="${escapeHtml(col)}"${col === 'released' ? ' class="th-sort-desc"' : ''}>${escapeHtml(label)}</th>`
  ).join('');

  const cfg = { showFirst, showDl, showSocket, socketSlug };
  // tbody is intentionally empty — all rows are rendered client-side by the
  // embedded sort script using DOM methods so no user data touches HTML strings.

  const privateCount = section.privateCount ?? 0;
  const privateNote = privateCount > 0
    ? `${privateCount} private package${privateCount === 1 ? '' : 's'} skipped (not on public registry).`
    : null;
  const noteHtml = [section.note, privateNote]
    .filter(Boolean)
    .map(n => `<p class="note-warning">${escapeHtml(n)}</p>`)
    .join('\n');

  // Convert private packages to [{domain, names}] server-side so the embedded
  // script receives structured data rather than raw URLs.
  const byDomain = groupByDomain(section.privatePkgs ?? []);
  const privatePkgsByDomain = [...byDomain.entries()].map(([domain, names]) => ({ domain, names }));

  const html = `<section class="section" data-section="${escapeHtml(sectionId)}">
  ${headerHtml}
  <p class="summary">${escapeHtml(summaryText)}</p>
  ${noteHtml}
  <div class="table-scroll">
    <table data-section="${escapeHtml(sectionId)}">
      <thead><tr>${headerCellsHtml}</tr></thead>
      <tbody></tbody>
    </table>
  </div>
  <div class="nonstd-slot" data-section="${escapeHtml(sectionId)}"></div>
</section>`;

  return {
    html,
    scriptCfg: {
      id: sectionId,
      rows,
      ...cfg,
      dangerousDeps: section.dangerousDeps ?? [],
      privatePkgsByDomain,
    },
  };
}

/**
 * Builds the inline JavaScript that wires up click-to-sort on every section.
 * The script reads an embedded JSON config (one entry per section) and tracks
 * sort state per section. Strings going into innerHTML are HTML-escaped.
 *
 * @param {string} scriptDataJson - already-safe JSON string (< > encoded as < >)
 * @returns {string} JavaScript source (no surrounding <script> tags)
 */
function buildSortScript(scriptDataJson) {
  return `(function(){
var D=${scriptDataJson};
var state={};
D.sections.forEach(function(s){state[s.id]={col:'released',dir:'desc'};});
function daysSince(d){if(!d||d==='unknown')return Infinity;var ms=Date.now()-new Date(d).getTime();return isNaN(ms)?Infinity:Math.floor(ms/86400000);}
function scoreInfo(v){if(v==null||typeof v!=='number')return{text:'\\u2013',cls:''};var p=Math.round(v*100);return{text:p+'%',cls:v>=0.8?'score-good':v>=0.5?'score-warn':'score-bad'};}
function socketUrl(name,slug){if(!slug)return null;var n=encodeURIComponent(name).replace(/%40/g,'@').replace(/%2F/gi,'/');return'https://socket.dev/'+slug+'/package/'+n;}
function buildRowEl(r,cfg){
  var dataCols=3+(cfg.showFirst?1:0)+(cfg.showDl?1:0)+(cfg.showSocket?1:0);
  var tr=document.createElement('tr');
  var nameTd=document.createElement('td');
  var a=document.createElement('a');
  a.href=/^https?:\\/\\//i.test(String(r.link??''))?r.link:'#';
  a.target='_blank';a.rel='noopener noreferrer';a.textContent=r.name;
  nameTd.appendChild(a);tr.appendChild(nameTd);
  if(r.error){
    tr.className='row-error';
    var eTd=document.createElement('td');eTd.colSpan=dataCols;
    eTd.title=String(r.error??'');eTd.textContent=r.version??'error';tr.appendChild(eTd);
    return tr;
  }
  var addTd=function(text,cls){var td=document.createElement('td');td.textContent=String(text??'');if(cls)td.className=cls;tr.appendChild(td);};
  addTd(r.version);
  var ra=daysSince(r.released);
  addTd(r.released,ra<=3?'age-new':ra<=7?'age-orange':ra<=30?'age-fresh':'');
  if(cfg.showFirst){var fa=daysSince(r.firstReleased);addTd(r.firstReleased,fa<=3?'age-new':fa<=7?'age-orange':fa<=30?'age-fresh':'');}
  addTd(String(r.releases));
  if(cfg.showDl)addTd(typeof r.downloadsLastMonth==='number'?r.downloadsLastMonth.toLocaleString('en-US'):'\\u2013');
  if(cfg.showSocket){
    var sc=scoreInfo(r.supplyChain);
    var sTd=document.createElement('td');sTd.textContent=sc.text;if(sc.cls)sTd.className=sc.cls;
    if(r.supplyChain!=null){var su=socketUrl(r.name,cfg.socketSlug);if(su){var lnk=document.createElement('a');lnk.href=su;lnk.target='_blank';lnk.rel='noopener noreferrer';lnk.textContent=' (link)';sTd.appendChild(lnk);}}
    tr.appendChild(sTd);
  }
  return tr;
}
function sortedRows(rows,col,dir){
  var sign=dir==='asc'?1:-1;
  var isDate=col==='released'||col==='firstReleased';
  var isNum=col==='releases'||col==='downloadsLastMonth'||col==='supplyChain';
  return rows.slice().sort(function(a,b){
    var av=a[col],bv=b[col];
    if(isDate){
      var au=!av||av==='unknown',bu=!bv||bv==='unknown';
      if(au&&bu)return a.name.localeCompare(b.name);
      if(au)return 1;if(bu)return-1;
      var c=String(av).localeCompare(String(bv));
      return c!==0?sign*c:a.name.localeCompare(b.name);
    }
    if(isNum){
      var an=av==null,bn=bv==null;
      if(an&&bn)return a.name.localeCompare(b.name);
      if(an)return 1;if(bn)return-1;
      var c=av-bv;
      return c!==0?sign*c:a.name.localeCompare(b.name);
    }
    var c=String(av==null?'':av).localeCompare(String(bv==null?'':bv));
    return c!==0?sign*c:a.name.localeCompare(b.name);
  });
}
function rerender(s){
  var st=state[s.id];
  var rows=sortedRows(s.rows,st.col,st.dir);
  var tbl=document.querySelector('table[data-section="'+s.id+'"]');
  var tbody=tbl.querySelector('tbody');
  var ncols=tbl.querySelectorAll('thead th').length;
  tbody.textContent='';
  if(rows.length){rows.forEach(function(r){tbody.appendChild(buildRowEl(r,s));});}
  else{var tr=document.createElement('tr');var td=document.createElement('td');td.colSpan=ncols;td.textContent='No dependencies found.';tr.appendChild(td);tbody.appendChild(tr);}
  tbl.querySelectorAll('th[data-col]').forEach(function(th){
    th.classList.remove('th-sort-asc','th-sort-desc');
    if(th.dataset.col===st.col)th.classList.add('th-sort-'+st.dir);
  });
}
D.sections.forEach(function(s){
  var tbl=document.querySelector('table[data-section="'+s.id+'"]');
  if(!tbl)return;
  tbl.querySelectorAll('th[data-col]').forEach(function(th){
    th.addEventListener('click',function(){
      var col=th.dataset.col;
      var st=state[s.id];
      if(st.col===col){st.dir=st.dir==='asc'?'desc':'asc';}
      else{st.col=col;st.dir=(col==='name'||col==='version')?'asc':'desc';}
      rerender(s);
    });
  });
});
D.sections.forEach(function(s){rerender(s);});
// Render non-standard sources via DOM only — no user data in HTML strings.
function renderNonstd(slot,danger,priv){
  if(!danger.length&&!priv.length)return;
  var total=danger.length+priv.length;
  var det=document.createElement('details');det.className='nonstd';
  var sum=document.createElement('summary');
  sum.textContent=total+' non-standard source'+(total!==1?'s':'');
  det.appendChild(sum);
  var body=document.createElement('div');body.className='nonstd-body';
  if(danger.length){
    var h=document.createElement('p');h.className='nonstd-warn';
    h.textContent='⚠ Non-registry dependency specs (declared in manifest):';
    body.appendChild(h);
    danger.forEach(function(d){
      var p=document.createElement('p');p.className='nonstd-warn nonstd-indent';
      p.appendChild(document.createTextNode(d.name+' — '));
      var code=document.createElement('code');code.textContent=d.spec;p.appendChild(code);
      p.appendChild(document.createTextNode(' ('+d.reason+')'));
      body.appendChild(p);
    });
  }
  if(priv.length){
    var h2=document.createElement('p');h2.className='nonstd-info';
    h2.textContent='ℹ Non-public registry packages (skipped from resolution):';
    body.appendChild(h2);
    priv.forEach(function(g){
      var p=document.createElement('p');p.className='nonstd-info nonstd-indent';
      var strong=document.createElement('strong');strong.textContent=g.domain;p.appendChild(strong);
      p.appendChild(document.createTextNode(': '+g.names.join(', ')));
      body.appendChild(p);
    });
  }
  det.appendChild(body);slot.appendChild(det);
}
D.sections.forEach(function(s){
  var slot=document.querySelector('.nonstd-slot[data-section="'+s.id+'"]');
  if(slot)renderNonstd(slot,s.dangerousDeps||[],s.privatePkgsByDomain||[]);
});
})();`;
}

/**
 * Generates a complete, self-contained HTML dependency report as a string.
 *
 * Renders one `<section>` per ecosystem in fixed order (npm → python → go).
 * Empty/missing ecosystems are skipped. Section headers are emitted only when
 * two or more sections are present.
 *
 * @param {Map<'npm'|'python'|'go', object>} sections  - sections from orchestrator
 * @param {object} [opts]
 * @param {boolean}                 [opts.downloadStats=false]
 * @param {Map<string,number>|null} [opts.socketScores=null]
 * @returns {string} complete HTML document
 */
function generateReport(sections, opts = {}) {
  const { downloadStats = false, socketScores = null } = opts;

  const present = ECOSYSTEM_ORDER.filter(eco => sections.has(eco));
  const showHeader = present.length >= 2;

  const sectionBlocks = [];
  const scriptCfgs = [];
  for (const ecosystem of present) {
    const { html, scriptCfg } = renderSection(
      ecosystem,
      sections.get(ecosystem),
      showHeader,
      socketScores,
      downloadStats
    );
    sectionBlocks.push(html);
    if (scriptCfg) scriptCfgs.push(scriptCfg);
  }

  const ecosystemsText = present.join(', ') || '(none)';
  const metaText = `${ecosystemsText} · generated ${new Date().toISOString().slice(0, 19).replace('T', ' ')} UTC`;

  // Escape </script> sequences inside the JSON so they cannot prematurely close
  // the script block. < / > are valid JSON/JS unicode escapes.
  const scriptData = JSON.stringify({ sections: scriptCfgs })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');

  // CSP nonce: a fresh random value per report so only this exact script block
  // is allowed to run — tighter than 'unsafe-inline'.
  const nonce = randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
  <title>Dependency Report</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <main>
    <h1>Dependency Report</h1>
    <p class="report-meta">${escapeHtml(metaText)}</p>
${sectionBlocks.join('\n')}
  </main>
  <script nonce="${nonce}">${buildSortScript(scriptData)}</script>
</body>
</html>`;
}

export { generateReport };
