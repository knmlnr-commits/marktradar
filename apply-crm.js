// Stap 4b: bouw crm-objects per gematchte instelling + producten + toevoegenVoorstel + salesGap.
// Output: crm-injection.json met alle injecties klaar voor stap 4c.

const fs = require('fs');
const TODAY = '2026-04-29';

const parsed = JSON.parse(fs.readFileSync('pipedrive-export/parsed.json', 'utf8'));
const matches = JSON.parse(fs.readFileSync('pipedrive-export/matches.json', 'utf8'));

const html = fs.readFileSync('marktradar.html', 'utf8');
const m = html.match(/const DATA = \{[\s\S]*?\nDATA\.meta\.totalLeveranciers = DATA\.leveranciers\.length;/);
const DATA = eval('(function(){' + m[0] + ';return DATA;})()');

const orgsById = {};
parsed.orgs.forEach(o => { orgsById[o.id] = o; });

// Bij dubbele matches: pak org met meeste data (deals + contacten + email volume)
function richness(o){
  return (o.deals.length * 3) + (o.contacten.length) + (o.leads.length) + (parseInt(o.header['Email volume']||'0')/10);
}

const matchByInst = {}; // instId -> chosen orgId
matches.matches.forEach(m => {
  const cur = matchByInst[m.instId];
  if(!cur || richness(orgsById[m.orgId]) > richness(orgsById[cur.orgId])){
    matchByInst[m.instId] = m;
  }
});

// Helper: parse "YYYY-MM-DD" dates safely
function pdDate(s){
  if(!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}
function intOr(v, d){ const n = parseInt(v); return isNaN(n) ? d : n; }
function floatOr(v, d){ const n = parseFloat(v); return isNaN(n) ? d : n; }

function determineCrmStatus(deals, leads){
  const open = deals.filter(d => d.Status === 'Open');
  const won = deals.filter(d => d.Status === 'Gewonnen');
  const lost = deals.filter(d => d.Status === 'Verloren');
  if(won.length > 0) return 'actieve-klant';
  if(open.some(d => /^(Beheer|Deal gesloten)$/.test(d.Stadium))) return 'actieve-klant';
  if(open.some(d => /Hot Prospect|Offerte gestuurd|Prospect: voorstel gedaan/.test(d.Stadium))) return 'warm-prospect';
  if(open.some(d => /Qualified|Gekwalificeerd|Contact opgenomen|Afspraak gepland|Lead: afspraak gemaakt/.test(d.Stadium))) return 'warm-lead';
  if(open.some(d => /Suspect: Contact opgenomen|On Hold/.test(d.Stadium))) return 'koel-prospect';
  if(lost.length > 0 && open.length === 0) return 'verloren';
  if(leads.length >= 1 && deals.length === 0) return 'lead-onbewerkt';
  return 'geen-pipeline';
}

function daysAgo(date){
  if(!date) return Infinity;
  const d = new Date(date), t = new Date(TODAY);
  return Math.floor((t - d) / 86400000);
}

function determineEngagement(org, deals){
  let score = 0;
  const lastAct = pdDate(org.header['Laatste activiteit']);
  const ago = daysAgo(lastAct);
  if(ago < 30) score += 40;
  else if(ago < 90) score += 20;
  const emailVol = intOr(org.header['Email volume'], 0);
  if(emailVol > 10) score += 20;
  if(deals.some(d => d.Status === 'Open' && /Hot Prospect|Offerte gestuurd|onderhandelen/.test(d.Stadium))) score += 20;
  return Math.min(100, Math.max(0, score));
}

function dmuRolFromFunctie(functie){
  const f = String(functie || '').toLowerCase();
  if(/specialist ouderengeneeskunde|verpleegkundig specialist/.test(f)) return null; // -> specialisten
  if(/raad van bestuur|rvb|bestuurder|directie/.test(f)) return 'decider';
  if(/manager behandeling|hoofd behandel|directeur zorg/.test(f)) return 'champion';
  if(/kwaliteit|manager zorg/.test(f)) return 'influencer';
  if(/cio|manager it|manager digitalisering|manager ict/.test(f)) return 'influencer';
  if(/inkoop|directiesecretaris|p&o|hr adviseur/.test(f)) return 'gatekeeper';
  return null;
}

const crmInjection = {}; // instId -> crm object
const dmuPromotion = {}; // instId -> [dmu records]
const specPromotion = {}; // instId -> [specialisten records]

for(const instId of Object.keys(matchByInst)){
  const match = matchByInst[instId];
  const org = orgsById[match.orgId];

  const deals = org.deals.map(d => ({
    id: d.dealId || null,
    titel: d.titel || null,
    pijplijn: (d.Pijplijn || '').replace(/^['@]+/, '@'),
    stadium: d.Stadium || null,
    status: d.Status || null,
    labels: (d.Labels || '').split(',').map(s => s.trim()).filter(Boolean),
    waarde: floatOr(d['Waarde EUR'], 0),
    mrr: floatOr(d.MRR, 0),
    arr: floatOr(d.ARR, 0),
    eigenaar: d.Eigenaar || null,
    aangemaakt: pdDate(d.Aangemaakt),
    bijgewerkt: pdDate(d.Bijgewerkt),
    verwachteSluiting: pdDate(d['Verwachte sluiting']),
    redenVerlies: d['Reden verlies'] || null,
    regionaalVerband: d['Regionaal verband'] || null
  }));

  const leads = org.leads.map(l => ({
    id: null,
    titel: l.titel || null,
    bekeken: l.Bekeken || null,
    eigenaar: l.Eigenaar || null,
    bron: l.Bron || null,
    aangemaakt: pdDate(l.Aangemaakt)
  }));

  const contacten = org.contacten.map(c => ({
    naam: c.naam || null,
    functie: c.functie || null,
    email: c.email || null,
    telefoonWerk: c['tel-werk'] || null,
    telefoonMobiel: c['tel-mobiel'] || null,
    eigenaar: c.Eigenaar || null,
    laatsteActiviteit: pdDate(c['Laatste activiteit']),
    emailVolume: intOr(c['Email volume'], 0)
  }));

  const notities = org.notities.map(n => {
    const text = String(n.tekst || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      datum: n.datum || null,
      gebruiker: n.gebruiker || null,
      contactNaam: n.contact || null,
      dealTitel: n.deal || null,
      tekst: text.length > 500 ? text.slice(0, 497) + '...' : text
    };
  });

  const activiteiten = org.activiteiten.map(a => ({
    datum: a.datum || null,
    type: a.type || null,
    onderwerp: a.onderwerp || null,
    beschrijving: (a.beschrijving || '').slice(0, 300)
  }));

  const bestanden = org.bestanden;
  const types = { offerte: 0, overeenkomst: 0, brochure: 0, anders: 0 };
  bestanden.forEach(b => {
    const n = (b.bestand || '').toLowerCase();
    if(/offerte/.test(n)) types.offerte++;
    else if(/overeenkomst|contract/.test(n)) types.overeenkomst++;
    else if(/brochure/.test(n)) types.brochure++;
    else types.anders++;
  });
  const sorted = bestanden.slice().sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
  const bijlagenSamenvatting = {
    aantal: bestanden.length,
    laatsteUpload: sorted[0]?.datum || null,
    types,
    laatsteBestand: sorted[0]?.bestand || null
  };

  const crmStatus = determineCrmStatus(deals, leads);
  const engagement = determineEngagement(org, deals);

  crmInjection[instId] = {
    pipedriveOrgId: org.id,
    bron: 'pipedrive',
    geimporteerd: TODAY,
    matchKwaliteit: match.kwaliteit,
    accountOwner: org.header['Eigenaar'] || null,
    openDeals: intOr(org.header['Open deals'], 0),
    gewonnenDeals: intOr(org.header['Gewonnen deals'], 0),
    verlorenDeals: intOr(org.header['Verloren deals'], 0),
    emailVolume: intOr(org.header['Email volume'], 0),
    laatsteActiviteit: pdDate(org.header['Laatste activiteit']),
    volgendeActiviteit: pdDate(org.header['Volgende activiteit']),
    deals, leads, contacten, notities, activiteiten,
    bijlagenSamenvatting,
    crmStatus, engagement
  };

  // DMU/spec promotion - check both functie veld en naam-suffix tussen haakjes
  for(const c of contacten){
    if(!c.naam) continue;
    const detectStr = (c.functie || '') + ' ' + (c.naam || '');
    // Strip functie-suffix uit naam voor display
    const cleanName = (c.naam || '').replace(/\s*\([^)]+\)\s*$/, '').trim();
    if(/specialist ouderengeneeskunde|verpleegkundig specialist/i.test(detectStr)){
      (specPromotion[instId] = specPromotion[instId] || []).push({
        naam: cleanName,
        rol: 'SO',
        vakgebied: null,
        bron: 'pipedrive',
        bronType: 'pipedrive',
        geverifieerd: TODAY,
        vertrouwen: 'hoog'
      });
    } else {
      const rol = dmuRolFromFunctie(detectStr);
      if(rol){
        // Pak functie uit naam-suffix als c.functie leeg
        let functie = c.functie || '';
        if(!functie){
          const m = (c.naam || '').match(/\(([^)]+)\)\s*$/);
          if(m) functie = m[1];
        }
        (dmuPromotion[instId] = dmuPromotion[instId] || []).push({
          naam: cleanName,
          functie,
          rol,
          linkedin: null,
          email: c.email,
          telefoon: c.telefoonWerk || c.telefoonMobiel,
          bron: 'pipedrive',
          bronType: 'pipedrive',
          geverifieerd: TODAY,
          vertrouwen: 'hoog',
          notitie: null
        });
      }
    }
  }
}

// PRODUCTEN
const producten = parsed.products.map(p => ({
  id: p.productcode,
  productcode: p.productcode,
  naam: p.naam,
  categorie: p.categorie || null,
  prijs: typeof p.prijs === 'number' ? p.prijs : 0,
  eenheid: 'EUR',
  frequentie: p.frequentie || null,
  eenheidType: p.eenheid || null,
  beschrijving: p.beschrijving || null
}));

// TOEVOEGEN-VOORSTEL: unmatched orgs met VVT-waarschijnlijkheid
const toevoegenVoorstel = [];
for(const um of matches.unmatched){
  const org = orgsById[um.orgId];
  let score = 0;
  const reasons = [];
  const naam = org.naam.toLowerCase();
  if(/zorggroep|thuiszorg|verpleeg|zorgcentrum|stichting/.test(naam)){ score += 30; reasons.push('VVT-naam patroon'); }
  if(org.deals.length > 0){ score += 40; reasons.push(`${org.deals.length} deal(s)`); }
  if(org.contacten.some(c => /raad van bestuur|rvb|bestuurder|specialist ouderengeneeskunde|so/i.test(c.functie || ''))){ score += 30; reasons.push('contact met RvB/SO functie'); }
  if(/zorgverzekering|gemeente|ministerie|kvk/.test(naam)){ score -= 50; reasons.push('niet-VVT context'); }
  if(score >= 30){
    toevoegenVoorstel.push({
      pipedriveOrgId: org.id,
      naam: org.naam,
      score,
      redenen: reasons,
      snelleSamenvatting: `${org.deals.length} deals, ${org.contacten.length} contacten, eigenaar ${org.header['Eigenaar'] || '-'}`
    });
  }
}
toevoegenVoorstel.sort((a, b) => b.score - a.score);

// SALES-GAP: instellingen zonder pipedrive-match
const matchedInstIds = new Set(Object.keys(matchByInst));
const salesGap = [];
for(const i of DATA.instellingen){
  if(!matchedInstIds.has(i.id)){
    salesGap.push({
      instellingId: i.id,
      naam: i.naam,
      gericallStatus: i.gericallStatus,
      leadLens: i.leadLens,
      leadScore: i.leadScore || 0,
      reden: 'geen pipedrive-aanwezigheid'
    });
  }
}
salesGap.sort((a, b) => b.leadScore - a.leadScore);

// MATCHING DIAGNOSE
const matchingDiagnose = {
  importDatum: TODAY,
  bron: 'pipedrive',
  totaalOrgs: parsed.orgs.length,
  zekereMatches: matches.matches.filter(m => m.kwaliteit === 'zeker').length,
  kandidaatMatches: matches.matches.filter(m => m.kwaliteit === 'kandidaat').length,
  unmatched: matches.unmatched.length,
  uniqueInstellingenMatched: Object.keys(matchByInst).length,
  totalInstellingen: DATA.instellingen.length,
  dubbel: matches.dubbel.map(d => ({
    instId: d.instId,
    instNaam: DATA.instellingen.find(i => i.id === d.instId)?.naam || '?',
    pipedriveOrgIds: d.orgIds,
    gekozen: matchByInst[d.instId]?.orgId
  }))
};

const out = {
  crmInjection,
  dmuPromotion,
  specPromotion,
  producten,
  toevoegenVoorstel,
  salesGap,
  matchingDiagnose
};

fs.writeFileSync('pipedrive-export/crm-injection.json', JSON.stringify(out, null, 2));

console.log(`crm-injection.json geschreven`);
console.log(`  ${Object.keys(crmInjection).length} instellingen verrijkt`);
console.log(`  ${Object.values(dmuPromotion).reduce((s,a)=>s+a.length,0)} DMU-promoties`);
console.log(`  ${Object.values(specPromotion).reduce((s,a)=>s+a.length,0)} specialisten-promoties`);
console.log(`  ${producten.length} producten`);
console.log(`  ${toevoegenVoorstel.length} toevoeg-voorstellen`);
console.log(`  ${salesGap.length} sales-gap records`);
