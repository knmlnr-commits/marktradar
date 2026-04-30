// Restore-script: voeg de oude (pre-2025-09-01) signalen die per ongeluk
// werden uitgefilterd terug aan DATA.signalen, zodat we van 14 weer naar
// 30 (cap) gaan met de nieuwe april-signalen bovenaan.

const fs = require('fs');

function readData(file){
  const html = fs.readFileSync(file, 'utf8');
  const m = html.match(/const DATA = \{[\s\S]*?\nDATA\.meta\.totalLeveranciers = DATA\.leveranciers\.length;/);
  const code = m[0];
  return { html, code, DATA: eval('(function(){' + code + ';return DATA;})()') };
}

const current = readData('marktradar.html');
const baseline = readData('marktradar.backup-20260429-v1.13.0-Naos.html');

// Verzamel signalen-IDs die nu al in current staan
const haveIds = new Set(current.DATA.signalen.map(s => s.id));

// Pak alle baseline-signalen die nog NIET in current zitten en voeg toe
const restore = baseline.DATA.signalen.filter(s => !haveIds.has(s.id));

console.log('Currently in DATA.signalen:', current.DATA.signalen.length);
console.log('To restore from baseline:', restore.length);

// Combineer + sorteer (nieuw eerst) + cap op 30
current.DATA.signalen = [...current.DATA.signalen, ...restore]
  .sort((a, b) => b.datum.localeCompare(a.datum))
  .slice(0, 30);

console.log('After restore:', current.DATA.signalen.length);

// Schrijf terug
const newDataCode = 'const DATA = ' + JSON.stringify(current.DATA, null, 2) + ';\n' +
  'DATA.meta.totalInstellingen = DATA.instellingen.length;\n' +
  'DATA.meta.totalSignalen = DATA.signalen.length;\n' +
  'DATA.meta.totalLeveranciers = DATA.leveranciers.length;';
const newHtml = current.html.replace(current.code, newDataCode);
fs.writeFileSync('marktradar.html', newHtml);
console.log('Schreef terug — totaal nu', current.DATA.signalen.length, 'signalen.');
