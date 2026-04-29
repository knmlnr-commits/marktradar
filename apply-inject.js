// Stap 4c: inject de crm-data in DATA-blok van marktradar.html.

const fs = require('fs');
const inj = JSON.parse(fs.readFileSync('pipedrive-export/crm-injection.json', 'utf8'));

const html = fs.readFileSync('marktradar.html', 'utf8');
const m = html.match(/const DATA = \{[\s\S]*?\nDATA\.meta\.totalLeveranciers = DATA\.leveranciers\.length;/);
if(!m){ throw new Error('DATA block niet gevonden'); }
const dataCode = m[0];
const DATA = eval('(function(){' + dataCode + ';return DATA;})()');

// 1) Inject crm-objects per instelling
let verrijkt = 0;
for(const inst of DATA.instellingen){
  const crm = inj.crmInjection[inst.id];
  if(crm){
    inst.crm = crm;
    verrijkt++;
  }
}

// 2) DMU-promotie: voeg toe aan dmu[] als (naam,functie) niet bestaat
let dmuToegevoegd = 0;
for(const instId of Object.keys(inj.dmuPromotion)){
  const inst = DATA.instellingen.find(i => i.id === instId);
  if(!inst) continue;
  if(!inst.dmu) inst.dmu = [];
  for(const newDmu of inj.dmuPromotion[instId]){
    const exists = inst.dmu.some(d =>
      (d.naam || '').toLowerCase().trim() === newDmu.naam.toLowerCase().trim()
    );
    if(!exists){
      inst.dmu.push(newDmu);
      dmuToegevoegd++;
    } else if(newDmu.email){
      // Bestaand record: vul email aan als ontbrekend
      const existing = inst.dmu.find(d => (d.naam || '').toLowerCase().trim() === newDmu.naam.toLowerCase().trim());
      if(existing && !existing.email){
        existing.email = newDmu.email;
        existing.geverifieerd = newDmu.geverifieerd;
        existing.notitie = (existing.notitie ? existing.notitie + '; ' : '') + 'email aangevuld vanuit pipedrive ' + newDmu.geverifieerd;
      }
    }
  }
}

// 3) Specialisten-promotie
let specToegevoegd = 0;
for(const instId of Object.keys(inj.specPromotion)){
  const inst = DATA.instellingen.find(i => i.id === instId);
  if(!inst) continue;
  if(!inst.specialisten) inst.specialisten = [];
  for(const newSpec of inj.specPromotion[instId]){
    const exists = inst.specialisten.some(s =>
      (s.naam || '').toLowerCase().trim() === newSpec.naam.toLowerCase().trim()
    );
    if(!exists){
      inst.specialisten.push(newSpec);
      specToegevoegd++;
    }
  }
}

// 4) Top-level: producten + toevoegenVoorstel + salesGap + matchingDiagnose
DATA.producten = inj.producten;
DATA.toevoegenVoorstel = inj.toevoegenVoorstel;
DATA.salesGap = inj.salesGap;
DATA.matchingDiagnose = inj.matchingDiagnose;

// 5) Statusverschillen voor review
const statusverschillen = [];
for(const inst of DATA.instellingen){
  if(!inst.crm) continue;
  const crmS = inst.crm.crmStatus;
  const gcS = inst.gericallStatus;
  if(crmS === 'actieve-klant' && gcS !== 'klant'){
    statusverschillen.push({ instId: inst.id, naam: inst.naam, crmStatus: crmS, gericallStatus: gcS });
  } else if(crmS === 'verloren' && gcS === 'klant'){
    statusverschillen.push({ instId: inst.id, naam: inst.naam, crmStatus: crmS, gericallStatus: gcS });
  }
}
DATA.matchingDiagnose.statusverschillen = statusverschillen;

// 6) Bump version
const TODAY = '2026-04-29';
DATA.meta.version = '1.11.0';
DATA.meta.codename = 'Lesath';
DATA.meta.promptVersion = '1.11.0';
DATA.meta.lastUpdated = TODAY;
const isoWeek = (() => {
  const d = new Date(TODAY);
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
})();
DATA.meta.weekNumber = isoWeek;
DATA.meta.releaseHistory = DATA.meta.releaseHistory || [];
DATA.meta.releaseHistory.push({
  version: '1.11.0',
  codename: 'Lesath',
  date: TODAY,
  note: `PipeDrive CRM-import: ${verrijkt} instellingen verrijkt met deals/contacten/notities; ${inj.toevoegenVoorstel.length} toevoeg-voorstellen voor curatie; ${inj.salesGap.length} sales-gap geidentificeerd; ${inj.producten.length} producten geimporteerd; ${dmuToegevoegd} contacten gepromoveerd naar DMU.`
});
DATA.meta.crmImport = {
  bron: 'pipedrive',
  importDatum: TODAY,
  aantalGematcht: verrijkt,
  aantalKandidaat: 0,
  aantalToevoegVoorstel: inj.toevoegenVoorstel.length,
  aantalSalesGap: inj.salesGap.length
};

// 7) Schrijf nieuwe DATA terug
const newDataCode = 'const DATA = ' + JSON.stringify(DATA, null, 2) + ';\n' +
  'DATA.meta.totalInstellingen = DATA.instellingen.length;\n' +
  'DATA.meta.totalSignalen = DATA.signalen.length;\n' +
  'DATA.meta.totalLeveranciers = DATA.leveranciers.length;';
const newHtml = html.replace(dataCode, newDataCode);
fs.writeFileSync('marktradar.html', newHtml);

console.log(`OK injectie compleet`);
console.log(`  ${verrijkt} instellingen verrijkt met crm-object`);
console.log(`  ${dmuToegevoegd} DMU-records toegevoegd`);
console.log(`  ${specToegevoegd} specialisten toegevoegd`);
console.log(`  ${DATA.producten.length} producten in DATA.producten`);
console.log(`  ${DATA.toevoegenVoorstel.length} toevoeg-voorstellen`);
console.log(`  ${DATA.salesGap.length} sales-gap records`);
console.log(`  ${statusverschillen.length} statusverschillen voor review`);
console.log(`  versie: ${DATA.meta.version} ${DATA.meta.codename}`);
