import Database from "better-sqlite3";
import { existsSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
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
  generatedAt: string;
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
  const empty: DashboardData = { facts: [], authors: [], tagIndex: [], tagCooccurrence: {}, generatedAt: new Date().toISOString() };

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
  if (existsSync(intDir)) {
    for (const file of readdirSync(intDir).filter(f => f.startsWith("interactions-") && f.endsWith(".db"))) {
      const db = new Database(join(intDir, file), { readonly: true });
      const rows = db.prepare(
        "SELECT fact_id, surface_count, last_surfaced_at, explicit_score FROM interactions"
      ).all() as { fact_id: string; surface_count: number; last_surfaced_at: string; explicit_score: number }[];
      db.close();
      for (const row of rows) {
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

  return { facts, authors, tagIndex, tagCooccurrence, generatedAt: new Date().toISOString() };
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

function cardHtml(f: DashboardFact): string {
  const tagsHtml = f.tags.map(t =>
    `<span class="tag${t.startsWith("category:") ? " cat" : ""}" data-tag="${esc(t)}">${esc(t)}</span>`
  ).join("");
  return `<div class="card" data-id="${esc(f.id)}">
<div class="card-body">${esc(f.content)}</div>
<div class="tags">${tagsHtml}</div>
<div class="card-meta">
  <span class="c-author" data-author="${esc(f.author)}">@${esc(f.author)}</span>
  ${f.project ? `<span class="c-project">${esc(f.project)}</span>` : ""}
  <span class="c-trust">trust: ${f.trust.toFixed(2)}</span>
  <span class="c-surf">${f.surface_count} surfaces</span>
</div>
<div class="card-detail">
  <div class="detail-row"><span class="dl">Added</span><span class="dv">${fmtDate(f.created_at)}</span></div>
  <div class="detail-row"><span class="dl">Last surfaced</span><span class="dv">${fmtDate(f.last_surfaced_at)}</span></div>
  <div class="detail-row"><span class="dl">Rejects</span><span class="dv">${f.reject_count}</span></div>
  <div class="rcmd" data-rid="${esc(f.id)}">team-memory reject ${esc(f.id)}</div>
</div>
</div>`;
}

function renderHtml(data: DashboardData): string {
  const json = JSON.stringify(data).replace(/<\/script>/gi, "<\\/script>");
  const generatedAt = new Date(data.generatedAt).toLocaleString();
  const sortedByTrust = [...data.facts].sort((a, b) => b.trust - a.trust);

  // New Relic design tokens
  // --nr-green:   #00AC69   (brand primary)
  // --nr-bg:      #1D252C   (platform background)
  // --nr-surface: #293038   (card / panel surface)
  // --nr-border:  #3D4F61   (subtle border)
  // --nr-text:    #E3EDFC   (primary text)
  // --nr-muted:   #8FADC7   (secondary / muted text)
  // --nr-blue:    #009BEF   (link / project accent)
  // --nr-yellow:  #FFD23D   (category tag)
  // --nr-red:     #DF2D24   (reject / error)
  const css = `
@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600;700&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Open Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1D252C;color:#E3EDFC}
#nav{background:#0E1419;border-bottom:2px solid #00AC69;padding:0 24px;display:flex;align-items:center;gap:20px;height:54px;position:sticky;top:0;z-index:10}
.nav-brand{color:#fff;font-weight:700;font-size:15px;display:flex;align-items:center;gap:8px}
.nav-brand::before{content:'';display:inline-block;width:20px;height:20px;background:#00AC69;border-radius:3px}
.nav-link{color:#8FADC7;text-decoration:none;font-size:14px;padding:4px 0;border-bottom:2px solid transparent;cursor:pointer;transition:color .15s}
.nav-link:hover{color:#E3EDFC}
.nav-link.active{color:#00AC69;border-bottom-color:#00AC69}
.nav-meta{margin-left:auto;color:#8FADC7;font-size:12px}
#app{max-width:1140px;margin:0 auto;padding:24px}
.view{display:none}.view.active{display:block}
.stats{display:flex;gap:14px;margin-bottom:24px;flex-wrap:wrap}
.stat{background:#293038;border:1px solid #3D4F61;border-radius:6px;padding:14px 22px;border-left:3px solid #00AC69}
.stat-val{font-size:26px;font-weight:700;color:#fff}.stat-lbl{font-size:12px;color:#8FADC7;margin-top:2px;text-transform:uppercase;letter-spacing:.04em}
.controls{display:flex;gap:10px;margin-bottom:18px;flex-wrap:wrap}
.search-box{flex:1;min-width:180px;padding:8px 12px;border:1px solid #3D4F61;border-radius:4px;font-size:14px;background:#293038;color:#E3EDFC}
.search-box::placeholder{color:#8FADC7}
.search-box:focus{outline:none;border-color:#00AC69;box-shadow:0 0 0 2px rgba(0,172,105,.2)}
.ctl-select{padding:8px 12px;border:1px solid #3D4F61;border-radius:4px;font-size:14px;background:#293038;color:#E3EDFC}
.ctl-select:focus{outline:none;border-color:#00AC69}
.fact-list{display:flex;flex-direction:column;gap:8px}
.card{background:#293038;border:1px solid #3D4F61;border-radius:6px;padding:14px 16px;cursor:pointer;transition:border-color .15s,box-shadow .15s}
.card:hover{border-color:#00AC69;box-shadow:0 2px 12px rgba(0,172,105,.12)}
.card.open{border-color:#00AC69;border-left:3px solid #00AC69}
.card-body{font-size:15px;font-weight:500;line-height:1.6;color:#E3EDFC}
.card-meta{display:flex;gap:14px;margin-top:8px;align-items:center;flex-wrap:wrap}
.c-author{font-size:12px;color:#8FADC7;cursor:pointer}.c-author:hover{color:#00AC69;text-decoration:underline}
.c-project{font-size:12px;background:rgba(0,155,239,.15);color:#009BEF;padding:2px 8px;border-radius:3px;border:1px solid rgba(0,155,239,.3)}
.c-trust{font-size:12px;color:#8FADC7}.c-surf{font-size:12px;color:#8FADC7}
.tags{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
.tag{font-size:12px;padding:2px 9px;border-radius:3px;cursor:pointer;border:1px solid #3D4F61;color:#8FADC7;background:#1D252C;transition:all .15s}
.tag:hover{background:#00AC69;color:#fff;border-color:#00AC69}
.tag.cat{background:rgba(255,210,61,.1);border-color:rgba(255,210,61,.4);color:#FFD23D}
.tag.cat:hover{background:#FFD23D;color:#1D252C;border-color:#FFD23D}
.card-detail{margin-top:12px;border-top:1px solid #3D4F61;padding-top:12px;display:none}
.card.open .card-detail{display:block}
.detail-row{display:flex;gap:8px;font-size:13px;margin-top:5px}
.dl{color:#8FADC7;min-width:110px}.dv{color:#E3EDFC}
.rcmd{font-family:'Courier New',monospace;font-size:13px;background:#1D252C;color:#00AC69;padding:7px 12px;border-radius:4px;border:1px solid #3D4F61;cursor:pointer;display:inline-block;margin-top:10px;user-select:all;transition:all .15s}
.rcmd:hover{background:#0E1419;border-color:#DF2D24;color:#DF2D24}
.rcmd.ok{background:rgba(0,172,105,.15);border-color:#00AC69;color:#00AC69}
.members-layout{display:flex;gap:20px}
.msidebar{width:200px;flex-shrink:0}
.mlist{background:#293038;border:1px solid #3D4F61;border-radius:6px;overflow:hidden}
.mitem{padding:11px 14px;border-bottom:1px solid #3D4F61;cursor:pointer;font-size:14px;display:flex;justify-content:space-between;color:#E3EDFC;transition:background .15s}
.mitem:last-child{border-bottom:none}
.mitem:hover,.mitem.sel{background:#1D252C;border-left:3px solid #00AC69;padding-left:11px}
.mcnt{color:#8FADC7;font-size:12px}
.mcontent{flex:1}
.tabs{display:flex;border-bottom:1px solid #3D4F61;margin-bottom:18px}
.tab{padding:8px 18px;font-size:14px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;color:#8FADC7;transition:color .15s}
.tab:hover{color:#E3EDFC}
.tab.active{color:#00AC69;border-bottom-color:#00AC69;font-weight:600}
.tag-grid{display:flex;flex-wrap:wrap;gap:10px}
.tgi{display:flex;align-items:center;gap:8px;background:#293038;border:1px solid #3D4F61;border-radius:6px;padding:10px 14px;cursor:pointer;transition:all .15s}
.tgi:hover{border-color:#00AC69;box-shadow:0 2px 8px rgba(0,172,105,.15)}
.tgn{font-size:14px;font-weight:500;color:#E3EDFC}
.tgc{font-size:12px;background:#1D252C;color:#8FADC7;padding:2px 8px;border-radius:10px;border:1px solid #3D4F61}
.tv-header{display:flex;align-items:center;gap:12px;margin-bottom:18px}
.back{font-size:13px;color:#00AC69;cursor:pointer;text-decoration:none}
.back:hover{text-decoration:underline}
.rel-tags{margin-top:22px;padding:16px;background:#293038;border:1px solid #3D4F61;border-radius:6px}
.rel-lbl{font-size:12px;color:#8FADC7;margin-bottom:10px;text-transform:uppercase;letter-spacing:.04em}
.empty{color:#8FADC7;font-size:14px;padding:48px;text-align:center}
h2{font-size:18px;font-weight:600;margin-bottom:14px;color:#fff}
`;

  const memberSections = data.authors.map(a => {
    const authored = [...data.facts].filter(f => f.author === a).sort((x, y) => y.trust - x.trust);
    return `<div class="member-profile" id="mp-${esc(a)}" style="display:none">
<h2>@${esc(a)}</h2>
<div class="tabs">
  <div class="tab active" data-mtab="authored" data-mauthor="${esc(a)}">Authored (${authored.length})</div>
  <div class="tab" data-mtab="activity" data-mauthor="${esc(a)}">Activity</div>
</div>
<div class="fact-list" id="mfl-${esc(a)}">${authored.map(cardHtml).join("") || '<div class="empty">No facts yet.</div>'}</div>
</div>`;
  }).join("");

  const tagSections = data.tagIndex.map(({ tag }) => {
    const tf = [...data.facts].filter(f => f.tags.includes(tag)).sort((a, b) => b.trust - a.trust);
    const rel = (data.tagCooccurrence[tag] ?? []).map(t =>
      `<span class="tag" data-tag="${esc(t)}">${esc(t)}</span>`
    ).join("");
    return `<div class="tag-detail" id="td-${esc(tag)}" style="display:none">
<div class="tv-header"><span class="back" data-backtag>← All Tags</span>
<h2>${esc(tag)} <span style="font-weight:400;color:#8FADC7;font-size:16px">${tf.length} facts</span></h2></div>
<div class="fact-list">${tf.map(cardHtml).join("") || '<div class="empty">No facts with this tag.</div>'}</div>
${rel ? `<div class="rel-tags"><div class="rel-lbl">Related tags</div><div class="tags">${rel}</div></div>` : ""}
</div>`;
  }).join("");

  const js = `
(function(){
var d=JSON.parse(document.getElementById('__data__').textContent);
var facts=d.facts,authors=d.authors,tagIndex=d.tagIndex,tagCooc=d.tagCooccurrence;

function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function fmtDate(s){return s?new Date(s).toLocaleDateString():'—'}

function cardHtml(f){
  var tagsH=f.tags.map(function(t){return'<span class="tag'+(t.startsWith('category:')?'  cat':'')+'" data-tag="'+esc(t)+'">'+esc(t)+'</span>'}).join('');
  return '<div class="card" data-id="'+esc(f.id)+'">'+
    '<div class="card-body">'+esc(f.content)+'</div>'+
    '<div class="tags">'+tagsH+'</div>'+
    '<div class="card-meta">'+
      '<span class="c-author" data-author="'+esc(f.author)+'">@'+esc(f.author)+'</span>'+
      (f.project?'<span class="c-project">'+esc(f.project)+'</span>':'')+
      '<span class="c-trust">trust: '+f.trust.toFixed(2)+'</span>'+
      '<span class="c-surf">'+f.surface_count+' surfaces</span>'+
    '</div>'+
    '<div class="card-detail">'+
      '<div class="detail-row"><span class="dl">Added</span><span class="dv">'+fmtDate(f.created_at)+'</span></div>'+
      '<div class="detail-row"><span class="dl">Last surfaced</span><span class="dv">'+fmtDate(f.last_surfaced_at)+'</span></div>'+
      '<div class="detail-row"><span class="dl">Rejects</span><span class="dv">'+f.reject_count+'</span></div>'+
      '<div class="rcmd" data-rid="'+esc(f.id)+'">team-memory reject '+esc(f.id)+'</div>'+
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

function filtered(arr,q,proj){
  return arr.filter(function(f){
    var mq=!q||f.content.toLowerCase().indexOf(q.toLowerCase())>-1||f.tags.some(function(t){return t.toLowerCase().indexOf(q.toLowerCase())>-1});
    var mp=!proj||f.project===proj;
    return mq&&mp;
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
  var pool=tab==='authored'
    ?facts.filter(function(f){return f.author===author})
    :sorted(facts,'surfaces').slice(0,20);
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
    fl.innerHTML=sorted(authored,'trust').map(cardHtml).join('')||'<div class="empty">No facts yet.</div>';
  } else {
    var top=sorted(facts,'surfaces').slice(0,20);
    fl.innerHTML=top.map(cardHtml).join('')||'<div class="empty">No activity yet.</div>';
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

document.addEventListener('click',function(e){
  var tg=e.target.closest('[data-tag]');
  if(tg){e.stopPropagation();showView('tags');showTagDetail(tg.dataset.tag);return;}
  var bt=e.target.closest('[data-backtag]');
  if(bt){showTagIndex();return;}
  var au=e.target.closest('.c-author');
  if(au){e.stopPropagation();showView('members');showMember(au.dataset.author);return;}
  var mi=e.target.closest('.mitem');
  if(mi){showMember(mi.dataset.author);return;}
  var mt=e.target.closest('[data-mtab]');
  if(mt){switchTab(mt.dataset.mtab,mt.dataset.mauthor);return;}
  var rc=e.target.closest('.rcmd');
  if(rc){e.stopPropagation();
    var cmd='team-memory reject '+rc.dataset.rid;
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
    return `<div class="mitem" data-author="${esc(a)}"><span>${esc(a)}</span><span class="mcnt">${cnt}</span></div>`;
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
  <span class="nav-brand">team-memory</span>
  <a class="nav-link active" data-view="team" href="#team">Team View</a>
  <a class="nav-link" data-view="members" href="#members">Members</a>
  <a class="nav-link" data-view="tags" href="#tags">Tags</a>
  <span class="nav-meta">Generated ${esc(generatedAt)}</span>
</nav>
<div id="app">
  <div class="view active" id="view-team">
    <div class="stats">
      <div class="stat"><div class="stat-val">${data.facts.length}</div><div class="stat-lbl">Total Facts</div></div>
      <div class="stat"><div class="stat-val">${data.authors.length}</div><div class="stat-lbl">Contributors</div></div>
      <div class="stat"><div class="stat-val">${data.tagIndex.length}</div><div class="stat-lbl">Tags</div></div>
    </div>
    <div class="controls">
      <input class="search-box" id="tsearch" placeholder="Search facts..." type="text">
      <select class="ctl-select" id="tproj"><option value="">All projects</option>${projOpts}</select>
      <select class="ctl-select" id="tsort"><option value="trust">Sort: Trust</option><option value="date">Sort: Date</option><option value="surfaces">Sort: Surfaces</option></select>
    </div>
    <div class="fact-list" id="tlist">${sortedByTrust.map(cardHtml).join("")}</div>
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
  writeFileSync(input.outputPath, html, "utf-8");

  if (input.openBrowser !== false) {
    const opener = process.platform === "darwin" ? "open" : "xdg-open";
    try { execSync(`${opener} "${input.outputPath}"`, { stdio: "ignore" }); } catch { /* ignore */ }
  }

  return { outputPath: input.outputPath, factCount: data.facts.length, authorCount: data.authors.length };
}
