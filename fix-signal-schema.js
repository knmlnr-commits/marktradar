// Hernoem bron/bronUrl → source/sourceUrl voor de 7 nieuwe april-signalen
// zodat ze het bestaande schema volgen. Voeg instellingNaam toe waar mogelijk.
const fs = require('fs');
const html = fs.readFileSync('marktradar.html', 'utf8');
const m = html.match(/const DATA = \{[\s\S]*?\nDATA\.meta\.totalLeveranciers = DATA\.leveranciers\.length;/);
const code = m[0];
const DATA = eval('(function(){' + code + ';return DATA;})()');

let renamed = 0;
DATA.signalen.forEach(s => {
  if(s.bron !== undefined && s.source === undefined){ s.source = s.bron; delete s.bron; renamed++; }
  if(s.bronUrl !== undefined && s.sourceUrl === undefined){ s.sourceUrl = s.bronUrl; delete s.bronUrl; }
  // Voeg instellingNaam toe voor consistentie met oud schema
  if(s.instellingId && !s.instellingNaam){
    const inst = DATA.instellingen.find(i => i.id === s.instellingId);
    if(inst) s.instellingNaam = inst.naam;
  }
});

const newCode = 'const DATA = ' + JSON.stringify(DATA, null, 2) + ';\n' +
  'DATA.meta.totalInstellingen = DATA.instellingen.length;\n' +
  'DATA.meta.totalSignalen = DATA.signalen.length;\n' +
  'DATA.meta.totalLeveranciers = DATA.leveranciers.length;';
fs.writeFileSync('marktradar.html', html.replace(code, newCode));
console.log('Renamed bron→source op', renamed, 'signalen');
