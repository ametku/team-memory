import Database from "better-sqlite3";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { execSync } from "child_process";

export interface DashboardFact {
  id: string;
  content: string;
  project: string;
  tags: string[];
  trust: number;
  author: string;
  created_at: string;
  surface_count: number;
  last_surfaced_at: string | null;
  reject_count: number;
}

export interface DashboardData {
  facts: DashboardFact[];
  authors: string[];
  tagIndex: Array<{ tag: string; count: number }>;
  tagCooccurrence: Record<string, string[]>;
  // authorSurfaces[author][factId] = surface count by that author
  authorSurfaces: Record<string, Record<string, number>>;
  generatedAt: string;
  repoDir: string;
}

export interface DashboardInput {
  repoDir: string;
  indexPath: string;
  outputPath: string;
  openBrowser?: boolean;
}

export interface DashboardResult {
  outputPath: string;
  factCount: number;
  authorCount: number;
}

export function assembleDashboardData(repoDir: string, indexPath: string): DashboardData {
  const empty: DashboardData = { facts: [], authors: [], tagIndex: [], tagCooccurrence: {}, authorSurfaces: {}, generatedAt: new Date().toISOString(), repoDir };

  if (!existsSync(indexPath)) return empty;

  const idx = new Database(indexPath, { readonly: true });
  const indexRows = idx.prepare(
    "SELECT id, content, project, tags, trust FROM facts_view"
  ).all() as { id: string; content: string; project: string; tags: string; trust: number }[];
  idx.close();

  // Author + created_at from facts-*.db files
  const factsDir = join(repoDir, "facts");
  const authorMap = new Map<string, { author: string; created_at: string }>();
  if (existsSync(factsDir)) {
    for (const file of readdirSync(factsDir).filter(f => f.startsWith("facts-") && f.endsWith(".db"))) {
      const author = file.slice("facts-".length, -".db".length);
      const db = new Database(join(factsDir, file), { readonly: true });
      const rows = db.prepare("SELECT id, created_at FROM facts WHERE deleted_at IS NULL").all() as { id: string; created_at: string }[];
      db.close();
      for (const row of rows) authorMap.set(row.id, { author, created_at: row.created_at });
    }
  }

  // Aggregate interactions from interactions-*.db files
  const intDir = join(repoDir, "interactions");
  const intMap = new Map<string, { surface_count: number; last_surfaced_at: string | null; reject_count: number }>();
  const authorSurfaces: Record<string, Record<string, number>> = {};
  if (existsSync(intDir)) {
    for (const file of readdirSync(intDir).filter(f => f.startsWith("interactions-") && f.endsWith(".db"))) {
      const fileAuthor = file.slice("interactions-".length, -".db".length);
      const db = new Database(join(intDir, file), { readonly: true });
      const rows = db.prepare(
        "SELECT fact_id, surface_count, last_surfaced_at, explicit_score FROM interactions"
      ).all() as { fact_id: string; surface_count: number; last_surfaced_at: string; explicit_score: number }[];
      db.close();
      for (const row of rows) {
        // Aggregate totals
        const existing = intMap.get(row.fact_id);
        if (existing) {
          existing.surface_count += row.surface_count;
          if (row.explicit_score < 0) existing.reject_count++;
          if (row.last_surfaced_at > (existing.last_surfaced_at ?? "")) existing.last_surfaced_at = row.last_surfaced_at;
        } else {
          intMap.set(row.fact_id, {
            surface_count: row.surface_count,
            last_surfaced_at: row.last_surfaced_at,
            reject_count: row.explicit_score < 0 ? 1 : 0,
          });
        }
        // Per-author surfaces (for Activity tab)
        if (row.surface_count > 0) {
          authorSurfaces[fileAuthor] ??= {};
          authorSurfaces[fileAuthor][row.fact_id] = (authorSurfaces[fileAuthor][row.fact_id] ?? 0) + row.surface_count;
        }
      }
    }
  }

  const facts: DashboardFact[] = indexRows.map(row => {
    const authorInfo = authorMap.get(row.id);
    const intInfo = intMap.get(row.id);
    const tags: string[] = row.tags ? JSON.parse(row.tags) : [];
    return {
      id: row.id,
      content: row.content,
      project: row.project || "",
      tags,
      trust: row.trust,
      author: authorInfo?.author ?? "unknown",
      created_at: authorInfo?.created_at ?? "",
      surface_count: intInfo?.surface_count ?? 0,
      last_surfaced_at: intInfo?.last_surfaced_at ?? null,
      reject_count: intInfo?.reject_count ?? 0,
    };
  });

  // Tag index
  const tagCountMap = new Map<string, number>();
  for (const fact of facts) {
    for (const tag of fact.tags) tagCountMap.set(tag, (tagCountMap.get(tag) ?? 0) + 1);
  }
  const tagIndex = Array.from(tagCountMap.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  // Tag co-occurrence
  const coCount: Record<string, Record<string, number>> = {};
  for (const fact of facts) {
    for (let i = 0; i < fact.tags.length; i++) {
      for (let j = 0; j < fact.tags.length; j++) {
        if (i === j) continue;
        const a = fact.tags[i], b = fact.tags[j];
        coCount[a] ??= {};
        coCount[a][b] = (coCount[a][b] ?? 0) + 1;
      }
    }
  }
  const tagCooccurrence: Record<string, string[]> = {};
  for (const [tag, related] of Object.entries(coCount)) {
    tagCooccurrence[tag] = Object.entries(related).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
  }

  const authors = [...new Set(facts.map(f => f.author))].filter(a => a !== "unknown");

  return { facts, authors, tagIndex, tagCooccurrence, authorSurfaces, generatedAt: new Date().toISOString(), repoDir };
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function rejectCmd(factId: string, _repoDir: string): string {
  return `team-memory reject ${factId}`;
}

function catFromTags(tags: string[]): string {
  const t = tags.find(t => t.startsWith("category:"));
  return t ? t.slice("category:".length) : "";
}

function kwTags(tags: string[]): string[] {
  return tags.filter(t => !t.startsWith("category:"));
}

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return `hsl(${h % 360},55%,45%)`;
}

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map(p => p[0] ?? "").join("").toUpperCase() || "?";
}

function trustBarWidth(trust: number): number {
  return Math.min(Math.max((trust / 5) * 100, 4), 100);
}

function cardHtml(f: DashboardFact, repoDir: string): string {
  const cat = catFromTags(f.tags);
  const kws = kwTags(f.tags);
  const kwHtml = kws.map(t => `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`).join("");
  const catLabel = cat ? `<span class="cat-pill">${esc(cat)}</span>` : "";
  const projBadge = f.project ? `<span class="proj-badge" data-tag="project:${esc(f.project)}">${esc(f.project)}</span>` : "";
  const trustW = trustBarWidth(f.trust);
  const av = `<span class="avatar" style="background:${avatarColor(f.author)}">${esc(initials(f.author))}</span>`;
  const rc = rejectCmd(f.id, repoDir);
  return `<div class="card cat-${esc(cat)}" data-id="${esc(f.id)}" data-cat="${esc(cat)}">
<div class="trust-bar" style="width:${trustW}%"></div>
<div class="card-main">
  <div class="card-header">${catLabel}${projBadge}</div>
  <div class="card-body">${esc(f.content)}</div>
  <div class="card-footer">
    <span class="author-chip" data-author="${esc(f.author)}">${av}<span class="author-name">${esc(f.author)}</span></span>
    <span class="surf-count">${f.surface_count} surfaces</span>
    <span class="trust-label">trust ${f.trust.toFixed(2)}</span>
  </div>
</div>
<div class="card-detail">
  ${kwHtml ? `<div class="kw-tags">${kwHtml}</div>` : ""}
  <div class="meta-grid">
    <div class="mg"><span class="ml">Added</span><span class="mv">${fmtDate(f.created_at)}</span></div>
    <div class="mg"><span class="ml">Last surfaced</span><span class="mv">${fmtDate(f.last_surfaced_at)}</span></div>
    <div class="mg"><span class="ml">Rejects</span><span class="mv">${f.reject_count}</span></div>
    <div class="mg"><span class="ml">ID</span><span class="mv">${esc(f.id)}</span></div>
  </div>
  <div class="rcmd" data-rid="${esc(f.id)}" data-repodir="${esc(repoDir)}">${esc(rc)}</div>
</div>
</div>`;
}

function renderHtml(data: DashboardData): string {
  const json = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");
  const generatedAt = new Date(data.generatedAt).toLocaleString();
  const repoDir = data.repoDir;
  const sortedByTrust = [...data.facts].sort((a, b) => b.trust - a.trust);

  const css = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0f1a;color:#f1f5f9;font-size:15px;line-height:1.6}
#nav{background:#060b13;border-bottom:1px solid #1e293b;padding:0 28px;display:flex;align-items:center;gap:24px;height:56px;position:sticky;top:0;z-index:10}
.nav-brand{color:#f1f5f9;font-weight:700;font-size:16px;display:flex;align-items:center;gap:10px;letter-spacing:-.02em}
.nav-brand-icon{width:24px;height:24px;background:linear-gradient(135deg,#0ea5e9,#8b5cf6);border-radius:6px;flex-shrink:0}
.nav-link{color:#475569;text-decoration:none;font-size:14px;padding:6px 0;border-bottom:2px solid transparent;cursor:pointer;transition:all .15s;font-weight:500}
.nav-link:hover{color:#f1f5f9}
.nav-link.active{color:#0ea5e9;border-bottom-color:#0ea5e9}
.nav-meta{margin-left:auto;color:#1e293b;font-size:11px;font-family:monospace;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#app{max-width:1200px;margin:0 auto;padding:28px 24px}
.view{display:none}.view.active{display:block}
.stats{display:flex;gap:16px;margin-bottom:28px;flex-wrap:wrap}
.stat{background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:18px 26px;flex:1;min-width:130px;position:relative;overflow:hidden}
.stat::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,#0ea5e9,#8b5cf6)}
.stat-val{font-size:30px;font-weight:700;color:#f1f5f9;letter-spacing:-.04em}
.stat-lbl{font-size:11px;color:#475569;margin-top:4px;text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.controls{display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap;align-items:center}
.search-box{flex:1;min-width:200px;padding:9px 14px;border:1px solid #1e293b;border-radius:8px;font-size:14px;background:#0f172a;color:#f1f5f9;transition:border-color .15s}
.search-box::placeholder{color:#334155}
.search-box:focus{outline:none;border-color:#0ea5e9;box-shadow:0 0 0 3px rgba(14,165,233,.12)}
.ctl-select{padding:9px 14px;border:1px solid #1e293b;border-radius:8px;font-size:14px;background:#0f172a;color:#f1f5f9}
.ctl-select:focus{outline:none;border-color:#0ea5e9}
.cat-filters{display:flex;gap:8px;margin-bottom:18px;flex-wrap:wrap}
.cf{padding:5px 14px;border-radius:20px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid #1e293b;background:transparent;color:#475569;transition:all .15s;letter-spacing:.02em}
.cf:hover{border-color:#0ea5e9;color:#0ea5e9}
.cf.active{background:#0ea5e9;border-color:#0ea5e9;color:#fff}
.cf[data-cat="gotcha"].active{background:#ef4444;border-color:#ef4444}
.cf[data-cat="convention"].active{background:#14b8a6;border-color:#14b8a6}
.cf[data-cat="tool"].active{background:#6366f1;border-color:#6366f1}
.cf[data-cat="workaround"].active{background:#f59e0b;border-color:#f59e0b}
.cf[data-cat="decision"].active{background:#8b5cf6;border-color:#8b5cf6}
.fact-list{display:flex;flex-direction:column;gap:10px}
.card{background:#0f172a;border:1px solid #1e293b;border-radius:12px;overflow:hidden;cursor:pointer;transition:border-color .2s,box-shadow .2s}
.card:hover{border-color:#0ea5e9;box-shadow:0 0 0 1px #0ea5e9,0 4px 24px rgba(14,165,233,.1)}
.card.open{border-color:#0ea5e9}
.trust-bar{height:3px;background:linear-gradient(90deg,#0ea5e9,#8b5cf6);border-radius:3px 3px 0 0}
.card-main{padding:16px 20px}
.card-header{display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap}
.cat-pill{font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;letter-spacing:.05em;text-transform:uppercase}
.cat-gotcha .cat-pill{background:rgba(239,68,68,.15);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
.cat-convention .cat-pill{background:rgba(20,184,166,.15);color:#14b8a6;border:1px solid rgba(20,184,166,.3)}
.cat-tool .cat-pill{background:rgba(99,102,241,.15);color:#818cf8;border:1px solid rgba(99,102,241,.3)}
.cat-workaround .cat-pill{background:rgba(245,158,11,.15);color:#fbbf24;border:1px solid rgba(245,158,11,.3)}
.cat-decision .cat-pill{background:rgba(139,92,246,.15);color:#a78bfa;border:1px solid rgba(139,92,246,.3)}
.card:not([class*="cat-"]) .cat-pill,.cat- .cat-pill{background:rgba(100,116,139,.15);color:#94a3b8;border:1px solid rgba(100,116,139,.3)}
.proj-badge{font-size:11px;padding:3px 10px;border-radius:12px;background:rgba(14,165,233,.08);color:#0ea5e9;border:1px solid rgba(14,165,233,.2);cursor:pointer}
.proj-badge:hover{background:rgba(14,165,233,.18)}
.card-body{font-size:15px;font-weight:500;line-height:1.65;color:#e2e8f0;margin-bottom:14px}
.card-footer{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.author-chip{display:flex;align-items:center;gap:7px;cursor:pointer}
.avatar{width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:#fff;flex-shrink:0}
.author-name{font-size:12px;color:#475569;font-weight:500}
.author-chip:hover .author-name{color:#0ea5e9}
.surf-count{font-size:12px;color:#334155;margin-left:auto}
.trust-label{font-size:12px;color:#1e293b}
.card-detail{border-top:1px solid #1e293b;padding:14px 20px;display:none;background:#080e19}
.card.open .card-detail{display:block}
.kw-tags{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px}
.tag{font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer;border:1px solid #1e293b;color:#64748b;background:#0f172a;transition:all .15s}
.tag:hover{border-color:#0ea5e9;color:#0ea5e9}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.mg{font-size:13px}
.ml{color:#334155;display:block;font-size:10px;text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px;font-weight:600}
.mv{color:#64748b}
.rcmd{font-family:'SFMono-Regular',Consolas,monospace;font-size:12px;background:#060b13;color:#0ea5e9;padding:9px 14px;border-radius:6px;border:1px solid #1e293b;cursor:pointer;display:block;user-select:all;transition:all .15s;word-break:break-all;line-height:1.5}
.rcmd:hover{border-color:#ef4444;color:#ef4444}
.rcmd.ok{border-color:#14b8a6;color:#14b8a6}
.members-layout{display:flex;gap:20px}
.msidebar{width:210px;flex-shrink:0}
.mlist{background:#0f172a;border:1px solid #1e293b;border-radius:10px;overflow:hidden}
.mitem{padding:12px 16px;border-bottom:1px solid #1e293b;cursor:pointer;font-size:14px;display:flex;align-items:center;gap:10px;color:#f1f5f9;transition:background .15s}
.mitem:last-child{border-bottom:none}
.mitem:hover,.mitem.sel{background:#141d2e;border-left:3px solid #0ea5e9;padding-left:13px}
.mcnt{color:#334155;font-size:12px;margin-left:auto}
.mcontent{flex:1}
.tabs{display:flex;border-bottom:1px solid #1e293b;margin-bottom:18px}
.tab{padding:8px 20px;font-size:14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;color:#475569;transition:color .15s;font-weight:500}
.tab:hover{color:#f1f5f9}
.tab.active{color:#0ea5e9;border-bottom-color:#0ea5e9;font-weight:600}
.tag-grid{display:flex;flex-wrap:wrap;gap:10px}
.tgi{display:flex;align-items:center;gap:8px;background:#0f172a;border:1px solid #1e293b;border-radius:8px;padding:10px 16px;cursor:pointer;transition:all .15s}
.tgi:hover{border-color:#0ea5e9;box-shadow:0 0 0 1px #0ea5e9}
.tgn{font-size:14px;font-weight:500;color:#e2e8f0}
.tgc{font-size:12px;background:#141d2e;color:#475569;padding:2px 8px;border-radius:10px;border:1px solid #1e293b}
.tv-header{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.back{font-size:13px;color:#0ea5e9;cursor:pointer}
.back:hover{text-decoration:underline}
.rel-tags{margin-top:22px;padding:16px;background:#0f172a;border:1px solid #1e293b;border-radius:8px}
.rel-lbl{font-size:11px;color:#334155;margin-bottom:10px;text-transform:uppercase;letter-spacing:.07em;font-weight:600}
.empty{color:#334155;font-size:14px;padding:48px;text-align:center}
h2{font-size:18px;font-weight:700;margin-bottom:16px;color:#f1f5f9;letter-spacing:-.02em}
@keyframes fadeSlideIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.card{animation:fadeSlideIn .18s ease both}
.view{transition:opacity .15s ease}
.view:not(.active){opacity:0;pointer-events:none}
.view.active{opacity:1}
.trust-bar{transition:width .4s cubic-bezier(.4,0,.2,1)}
.filter-count{font-size:13px;color:#475569;margin-left:4px}
.sync-dot{width:7px;height:7px;border-radius:50%;background:#14b8a6;display:inline-block;margin-right:6px;animation:pulse 2s ease-in-out infinite}
.sync-stale .sync-dot{background:#f59e0b}
.nav-sync{display:flex;align-items:center;font-size:12px;color:#334155;margin-left:auto}
`;

  const catCounts: Record<string, number> = {};
  for (const f of data.facts) {
    const c = catFromTags(f.tags);
    if (c) catCounts[c] = (catCounts[c] ?? 0) + 1;
  }
  const catOrder = ["gotcha", "convention", "tool", "workaround", "decision"];
  const catPills = catOrder
    .filter(c => catCounts[c])
    .map(c => `<button class="cf" data-cat="${esc(c)}">${esc(c)} <span style="opacity:.6">${catCounts[c]}</span></button>`)
    .join("");

  const memberSections = data.authors.map(a => {
    const authored = [...data.facts].filter(f => f.author === a).sort((x, y) => y.trust - x.trust);
    const av = `<span class="avatar" style="background:${avatarColor(a)};width:28px;height:28px;font-size:11px">${esc(initials(a))}</span>`;
    return `<div class="member-profile" id="mp-${esc(a)}" style="display:none">
<h2 style="display:flex;align-items:center;gap:10px">${av}${esc(a)}</h2>
<div class="tabs">
  <div class="tab active" data-mtab="authored" data-mauthor="${esc(a)}">Authored (${authored.length})</div>
  <div class="tab" data-mtab="activity" data-mauthor="${esc(a)}">Activity</div>
</div>
<div class="fact-list" id="mfl-${esc(a)}">${authored.map(f => cardHtml(f, repoDir)).join("") || '<div class="empty">No facts yet.</div>'}</div>
</div>`;
  }).join("");

  const tagSections = data.tagIndex.map(({ tag }) => {
    const tf = [...data.facts].filter(f => f.tags.includes(tag)).sort((a, b) => b.trust - a.trust);
    const rel = (data.tagCooccurrence[tag] ?? []).map(t =>
      `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`
    ).join("");
    return `<div class="tag-detail" id="td-${esc(tag)}" style="display:none">
<div class="tv-header"><span class="back" data-backtag>← All Tags</span>
<h2>${esc(tag)} <span style="font-weight:400;color:#475569;font-size:16px">${tf.length} facts</span></h2></div>
<div class="fact-list">${tf.map(f => cardHtml(f, repoDir)).join("") || '<div class="empty">No facts with this tag.</div>'}</div>
${rel ? `<div class="rel-tags"><div class="rel-lbl">Related tags</div><div class="tags">${rel}</div></div>` : ""}
</div>`;
  }).join("");

  const js = `
(function(){
var d=JSON.parse(document.getElementById('__data__').textContent);
var facts=d.facts,authors=d.authors,tagIndex=d.tagIndex,tagCooc=d.tagCooccurrence,repoDir=d.repoDir,authorSurfaces=d.authorSurfaces||{};
var generatedAt=new Date(d.generatedAt);

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmtDate(s){return s?new Date(s).toLocaleDateString():'—'}

function relTime(iso){
  if(!iso)return'—';
  var diff=Date.now()-new Date(iso).getTime();
  var m=Math.floor(diff/60000);
  if(m<1)return'just now';
  if(m<60)return m+'m ago';
  var h=Math.floor(m/60);
  if(h<24)return h+'h ago';
  var day=Math.floor(h/24);
  if(day<7)return day+'d ago';
  if(day<30)return Math.floor(day/7)+'w ago';
  return Math.floor(day/30)+'mo ago';
}

// Live "synced X ago" nav indicator
function updateSyncLabel(){
  var el=document.getElementById('sync-label');
  var nav=document.getElementById('nav-sync');
  if(!el)return;
  var diff=Date.now()-generatedAt.getTime();
  var mins=Math.floor(diff/60000);
  el.textContent=mins<1?'synced just now':'synced '+relTime(d.generatedAt);
  if(nav)nav.className='nav-sync'+(mins>30?' sync-stale':'');
}
updateSyncLabel();
setInterval(updateSyncLabel,30000);

function rejectCmd(id){return'team-memory reject '+id}

function catFromTags(tags){var t=tags.find(function(t){return t.startsWith('category:')});return t?t.slice(9):''}
function kwTags(tags){return tags.filter(function(t){return!t.startsWith('category:')})}
function avatarColor(n){var h=0;for(var i=0;i<n.length;i++)h=(h*31+n.charCodeAt(i))&0xffff;return'hsl('+(h%360)+',55%,45%)'}
function initials(n){return n.split(/\s+/).slice(0,2).map(function(p){return p[0]||''}).join('').toUpperCase()||'?'}
function trustW(t){return Math.min(Math.max(t/5*100,4),100)}

function cardHtml(f){
  var cat=catFromTags(f.tags);
  var kws=kwTags(f.tags);
  var kwH=kws.map(function(t){return'<span class="tag" data-tag="'+esc(t)+'">'+esc(t)+'</span>'}).join('');
  var catPill=cat?'<span class="cat-pill">'+esc(cat)+'</span>':'';
  var projB=f.project?'<span class="proj-badge" data-tag="project:'+esc(f.project)+'">'+esc(f.project)+'</span>':'';
  var av='<span class="avatar" style="background:'+avatarColor(f.author)+';width:24px;height:24px;font-size:9px">'+esc(initials(f.author))+'</span>';
  var rc=rejectCmd(f.id);
  return '<div class="card cat-'+esc(cat)+'" data-id="'+esc(f.id)+'" data-cat="'+esc(cat)+'">'+
    '<div class="trust-bar" style="width:'+trustW(f.trust)+'%"></div>'+
    '<div class="card-main">'+
      '<div class="card-header">'+catPill+projB+'</div>'+
      '<div class="card-body">'+esc(f.content)+'</div>'+
      '<div class="card-footer">'+
        '<span class="author-chip" data-author="'+esc(f.author)+'">'+av+'<span class="author-name">'+esc(f.author)+'</span></span>'+
        '<span class="surf-count">'+f.surface_count+' surfaces</span>'+
        '<span class="trust-label">trust '+f.trust.toFixed(2)+'</span>'+
      '</div>'+
    '</div>'+
    '<div class="card-detail">'+
      (kwH?'<div class="kw-tags">'+kwH+'</div>':'')+
      '<div class="meta-grid">'+
        '<div class="mg"><span class="ml">Added</span><span class="mv" title="'+fmtDate(f.created_at)+'">'+relTime(f.created_at)+'</span></div>'+
        '<div class="mg"><span class="ml">Last surfaced</span><span class="mv" title="'+fmtDate(f.last_surfaced_at)+'">'+relTime(f.last_surfaced_at)+'</span></div>'+
        '<div class="mg"><span class="ml">Rejects</span><span class="mv">'+f.reject_count+'</span></div>'+
        '<div class="mg"><span class="ml">ID</span><span class="mv">'+esc(f.id)+'</span></div>'+
      '</div>'+
      '<div class="rcmd" data-rid="'+esc(f.id)+'">'+esc(rc)+'</div>'+
    '</div>'+
  '</div>';
}

function sorted(arr,by){
  return arr.slice().sort(function(a,b){
    if(by==='trust')return b.trust-a.trust;
    if(by==='surfaces')return b.surface_count-a.surface_count;
    if(by==='date')return (b.created_at||'').localeCompare(a.created_at||'');
    return 0;
  });
}

var activeCat='';

function filtered(arr,q,proj){
  return arr.filter(function(f){
    var mq=!q||f.content.toLowerCase().indexOf(q.toLowerCase())>-1||f.tags.some(function(t){return t.toLowerCase().indexOf(q.toLowerCase())>-1});
    var mp=!proj||f.project===proj;
    var mc=!activeCat||catFromTags(f.tags)===activeCat;
    return mq&&mp&&mc;
  });
}

function showView(v){
  document.querySelectorAll('.view').forEach(function(el){el.classList.remove('active')});
  document.querySelectorAll('.nav-link').forEach(function(el){el.classList.remove('active')});
  var el=document.getElementById('view-'+v);if(el)el.classList.add('active');
  var lk=document.querySelector('[data-view="'+v+'"]');if(lk)lk.classList.add('active');
}

function updateTeamList(){
  var q=document.getElementById('tsearch').value;
  var p=document.getElementById('tproj').value;
  var s=document.getElementById('tsort').value;
  var res=sorted(filtered(facts,q,p),s);
  document.getElementById('tlist').innerHTML=res.map(cardHtml).join('')||'<div class="empty">No facts match.</div>';
  var fc=document.getElementById('filter-count');
  if(fc){
    var total=facts.length;
    fc.textContent=(res.length<total)?('Showing '+res.length+' of '+total):'';
  }
}

function updateTagGrid(){
  var q=document.getElementById('tagsearch').value.toLowerCase();
  document.querySelectorAll('#tgrid .tgi').forEach(function(el){
    var name=el.querySelector('.tgn').textContent.toLowerCase();
    el.style.display=(!q||name.indexOf(q)>-1)?'':'none';
  });
}

function updateMemberList(){
  var q=document.getElementById('msearch').value;
  var selItem=document.querySelector('.mitem.sel');
  if(!selItem)return;
  var author=selItem.dataset.author;
  var activeTab=document.querySelector('[data-mtab].active');
  var tab=activeTab?activeTab.dataset.mtab:'authored';
  var fl=document.getElementById('mfl-'+author);
  if(!fl)return;
  var mySurfaces=authorSurfaces[author]||{};
  var pool=tab==='authored'
    ?facts.filter(function(f){return f.author===author})
    :facts.filter(function(f){return(mySurfaces[f.id]||0)>0}).sort(function(a,b){return(mySurfaces[b.id]||0)-(mySurfaces[a.id]||0)});
  var res=q?pool.filter(function(f){
    return f.content.toLowerCase().indexOf(q.toLowerCase())>-1||
           f.tags.some(function(t){return t.toLowerCase().indexOf(q.toLowerCase())>-1});
  }):pool;
  fl.innerHTML=(tab==='authored'?sorted(res,'trust'):res).map(cardHtml).join('')||
    '<div class="empty">No facts match.</div>';
}

function showMember(author){
  document.querySelectorAll('.member-profile').forEach(function(el){el.style.display='none'});
  document.querySelectorAll('.mitem').forEach(function(m){m.classList.toggle('sel',m.dataset.author===author)});
  var el=document.getElementById('mp-'+author);if(el)el.style.display='block';
  var ms=document.getElementById('msearch');if(ms)ms.value='';
}

function showTagDetail(tag){
  document.getElementById('tag-search-row').style.display='none';
  document.getElementById('tgrid').style.display='none';
  document.querySelectorAll('.tag-detail').forEach(function(el){el.style.display='none'});
  var el=document.getElementById('td-'+tag);if(el)el.style.display='block';
}

function showTagIndex(){
  document.getElementById('tag-search-row').style.display='';
  document.getElementById('tgrid').style.display='';
  document.querySelectorAll('.tag-detail').forEach(function(el){el.style.display='none'});
}

function switchTab(tab,author){
  document.querySelectorAll('[data-mtab]').forEach(function(t){t.classList.toggle('active',t.dataset.mtab===tab)});
  var ms=document.getElementById('msearch');if(ms)ms.value='';
  var fl=document.getElementById('mfl-'+author);
  if(!fl)return;
  if(tab==='authored'){
    var authored=facts.filter(function(f){return f.author===author});
    fl.innerHTML=sorted(authored,'trust').map(cardHtml).join('')||'<div class="empty">No facts authored yet.</div>';
  } else {
    // Activity = facts this author personally surfaced, sorted by their own surface count
    var mySurfaces=authorSurfaces[author]||{};
    var surfaced=facts.filter(function(f){return(mySurfaces[f.id]||0)>0});
    surfaced.sort(function(a,b){return(mySurfaces[b.id]||0)-(mySurfaces[a.id]||0)});
    fl.innerHTML=surfaced.slice(0,30).map(cardHtml).join('')||
      '<div class="empty">No surfaced facts yet — facts appear here as Claude injects them into your sessions.</div>';
  }
}

// show first member on load
if(authors.length)showMember(authors[0]);

document.querySelectorAll('.nav-link').forEach(function(lk){
  lk.addEventListener('click',function(e){e.preventDefault();showView(lk.dataset.view)});
});
document.getElementById('tsearch').addEventListener('input',updateTeamList);
document.getElementById('tproj').addEventListener('change',updateTeamList);
document.getElementById('tsort').addEventListener('change',updateTeamList);
document.getElementById('tagsearch').addEventListener('input',updateTagGrid);
document.getElementById('msearch').addEventListener('input',updateMemberList);

// Category filter pills
document.querySelectorAll('.cf').forEach(function(btn){
  btn.addEventListener('click',function(){
    var cat=btn.dataset.cat;
    if(activeCat===cat){activeCat='';document.querySelectorAll('.cf').forEach(function(b){b.classList.remove('active')});btn.classList.add('active')&&false;}
    else{activeCat=cat;document.querySelectorAll('.cf').forEach(function(b){b.classList.toggle('active',b.dataset.cat===cat||(!cat&&b.dataset.cat===''))});}
    document.querySelectorAll('.cf').forEach(function(b){b.classList.toggle('active',b.dataset.cat===activeCat)});
    updateTeamList();
  });
});

document.addEventListener('click',function(e){
  var tg=e.target.closest('[data-tag]');
  if(tg){e.stopPropagation();showView('tags');showTagDetail(tg.dataset.tag);return;}
  var bt=e.target.closest('[data-backtag]');
  if(bt){showTagIndex();return;}
  var au=e.target.closest('.author-chip');
  if(au){e.stopPropagation();showView('members');showMember(au.dataset.author);return;}
  var mi=e.target.closest('.mitem');
  if(mi){showMember(mi.dataset.author);return;}
  var mt=e.target.closest('[data-mtab]');
  if(mt){switchTab(mt.dataset.mtab,mt.dataset.mauthor);return;}
  var rc=e.target.closest('.rcmd');
  if(rc){e.stopPropagation();
    var cmd=rejectCmd(rc.dataset.rid);
    navigator.clipboard&&navigator.clipboard.writeText(cmd).then(function(){
      rc.classList.add('ok');rc.textContent='✓ Copied!';
      setTimeout(function(){rc.classList.remove('ok');rc.textContent=cmd},1500);
    });
    return;}
  var cd=e.target.closest('.card');
  if(cd){cd.classList.toggle('open');return;}
});

var h=location.hash.slice(1);
if(h==='members'||h==='tags')showView(h);
})();
`;

  const projects = [...new Set(data.facts.map(f => f.project).filter(Boolean))];
  const projOpts = projects.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("");
  const memberItems = data.authors.map(a => {
    const cnt = data.facts.filter(f => f.author === a).length;
    const av = `<span class="avatar" style="background:${avatarColor(a)}">${esc(initials(a))}</span>`;
    return `<div class="mitem" data-author="${esc(a)}">${av}<span>${esc(a)}</span><span class="mcnt">${cnt}</span></div>`;
  }).join("");
  const tagGridItems = data.tagIndex.map(({ tag, count }) =>
    `<div class="tgi" data-tag="${esc(tag)}"><span class="tgn">${esc(tag)}</span><span class="tgc">${count}</span></div>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Team Memory Dashboard</title>
<style>${css}</style>
</head>
<body>
<nav id="nav">
  <span class="nav-brand"><span class="nav-brand-icon"></span>team-memory</span>
  <a class="nav-link active" data-view="team" href="#team">Team View</a>
  <a class="nav-link" data-view="members" href="#members">Members</a>
  <a class="nav-link" data-view="tags" href="#tags">Tags</a>
  <span class="nav-sync" id="nav-sync"><span class="sync-dot"></span><span id="sync-label">synced just now</span></span>
</nav>
<div id="app">
  <div class="view active" id="view-team">
    <div class="stats">
      <div class="stat"><div class="stat-val">${data.facts.length}</div><div class="stat-lbl">Total Facts</div></div>
      <div class="stat"><div class="stat-val">${data.authors.length}</div><div class="stat-lbl">Contributors</div></div>
      <div class="stat"><div class="stat-val">${data.tagIndex.filter(t => !t.tag.startsWith("category:")).length}</div><div class="stat-lbl">Keywords</div></div>
      <div class="stat"><div class="stat-val">${esc(generatedAt.split(",")[0])}</div><div class="stat-lbl">Generated</div></div>
    </div>
    <div class="controls">
      <input class="search-box" id="tsearch" placeholder="Search facts, tags, projects..." type="text">
      <select class="ctl-select" id="tproj"><option value="">All projects</option>${projOpts}</select>
      <select class="ctl-select" id="tsort"><option value="trust">Sort: Trust</option><option value="date">Sort: Date</option><option value="surfaces">Sort: Surfaces</option></select>
    </div>
    <div class="cat-filters">
      <button class="cf active" data-cat="">All <span style="opacity:.6">${data.facts.length}</span></button>
      ${catPills}
      <span class="filter-count" id="filter-count"></span>
    </div>
    <div class="fact-list" id="tlist">${sortedByTrust.map(f => cardHtml(f, repoDir)).join("")}</div>
  </div>
  <div class="view" id="view-members">
    <div class="members-layout">
      <div class="msidebar"><div class="mlist">${memberItems}</div></div>
      <div class="mcontent" id="mcontent">
        <div class="controls" style="margin-bottom:16px">
          <input class="search-box" id="msearch" placeholder="Search this member's facts..." type="text">
        </div>
        ${memberSections}
      </div>
    </div>
  </div>
  <div class="view" id="view-tags">
    <div class="controls" id="tag-search-row" style="margin-bottom:16px">
      <input class="search-box" id="tagsearch" placeholder="Search tags..." type="text">
    </div>
    <h2>Tag Index</h2>
    <div class="tag-grid" id="tgrid">${tagGridItems}</div>
    <div id="tag-details">${tagSections}</div>
  </div>
</div>
<script id="__data__" type="application/json">${json}</script>
<script>${js}</script>
</body>
</html>`;
}

export function generateDashboard(input: DashboardInput): DashboardResult {
  const data = assembleDashboardData(input.repoDir, input.indexPath);
  const html = renderHtml(data);
  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(input.outputPath, html, "utf-8");

  if (input.openBrowser !== false) {
    const opener = process.platform === "darwin" ? "open"
                 : process.platform === "win32"   ? "start"
                 : "xdg-open";
    try { execSync(`${opener} "${input.outputPath}"`, { stdio: "ignore" }); } catch { /* ignore */ }
  }

  return { outputPath: input.outputPath, factCount: data.facts.length, authorCount: data.authors.length };
}
