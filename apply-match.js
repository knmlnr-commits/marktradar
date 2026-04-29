// Stap 4a: match PipeDrive-orgs aan MarktRadar instellingen.
// Output: matches.json met { matches:[{orgId,instId,naam,score,kwaliteit}], unmatched:[orgs] }

const fs = require('fs');

function normalize(s){
  return String(s||'')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s){
  return new Set(normalize(s).split(' ').filter(t => t.length >= 2));
}

function tokenSetRatio(a, b){
  const ta = tokens(a), tb = tokens(b);
  if(ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  ta.forEach(t => { if(tb.has(t)) inter++; });
  // Jaccard-style + boost when one is subset
  const minSize = Math.min(ta.size, tb.size);
  const subsetRatio = inter / minSize;
  const union = ta.size + tb.size - inter;
  const jaccard = inter / union;
  return Math.round(Math.max(jaccard, subsetRatio) * 100);
}

function exactNorm(a, b){
  return normalize(a) === normalize(b) ? 100 : 0;
}

function bestMatch(orgName, instellingen){
  let best = { score: 0, instId: null, naam: null };
  for(const i of instellingen){
    const score = Math.max(exactNorm(orgName, i.naam), tokenSetRatio(orgName, i.naam));
    if(score > best.score){ best = { score, instId: i.id, naam: i.naam }; }
  }
  return best;
}

// Lees DATA uit marktradar.html
const html = fs.readFileSync('marktradar.html', 'utf8');
const m = html.match(/const DATA = \{[\s\S]*?\nDATA\.meta\.totalLeveranciers = DATA\.leveranciers\.length;/);
const DATA = eval('(function(){' + m[0] + ';return DATA;})()');
const instellingen = DATA.instellingen.map(i => ({ id: i.id, naam: i.naam }));

const parsed = JSON.parse(fs.readFileSync('pipedrive-export/parsed.json', 'utf8'));
const matches = [];
const unmatched = [];

for(const org of parsed.orgs){
  const m = bestMatch(org.naam, instellingen);
  if(m.score >= 95){
    matches.push({ orgId: org.id, orgNaam: org.naam, instId: m.instId, instNaam: m.naam, score: m.score, kwaliteit: 'zeker' });
  } else if(m.score >= 85){
    matches.push({ orgId: org.id, orgNaam: org.naam, instId: m.instId, instNaam: m.naam, score: m.score, kwaliteit: 'kandidaat' });
  } else {
    unmatched.push({ orgId: org.id, orgNaam: org.naam, bestKandidaat: m.naam, bestScore: m.score });
  }
}

// Multiple PipeDrive-orgs kunnen op dezelfde instelling mappen (bv duplicates)
// Houd ze allemaal bij in een instId -> [orgIds] mapping voor inspectie
const byInst = {};
matches.forEach(m => { (byInst[m.instId] = byInst[m.instId] || []).push(m.orgId); });
const dubbel = Object.entries(byInst).filter(([_, ids]) => ids.length > 1).map(([instId, orgIds]) => ({ instId, orgIds }));

const out = { matches, unmatched, dubbel, instellingenMatched: Object.keys(byInst).length, totaalInstellingen: instellingen.length };
fs.writeFileSync('pipedrive-export/matches.json', JSON.stringify(out, null, 2));

console.log(`Matched: ${matches.length} orgs (zeker: ${matches.filter(m=>m.kwaliteit==='zeker').length}, kandidaat: ${matches.filter(m=>m.kwaliteit==='kandidaat').length})`);
console.log(`Unmatched: ${unmatched.length} orgs`);
console.log(`Unique instellingen met match: ${Object.keys(byInst).length} / ${instellingen.length}`);
console.log(`Dubbele match-paren (meerdere orgs -> 1 instelling): ${dubbel.length}`);
