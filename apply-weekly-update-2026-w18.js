// Wekelijkse signal-update voor 2026-04-30 (week 18).
// - Vervangt DATA.signalen (max 30, nieuw eerst).
// - Update directie[] voor Envida (nieuwe RvB feb 2026).
// - Voegt snapshot toe (2026-04-30).
// - Bumpt naar v1.14.0 Okul.

const fs = require('fs');
const html = fs.readFileSync('marktradar.html', 'utf8');
const m = html.match(/const DATA = \{[\s\S]*?\nDATA\.meta\.totalLeveranciers = DATA\.leveranciers\.length;/);
if(!m){ throw new Error('DATA-blok niet gevonden'); }
const dataCode = m[0];
const DATA = eval('(function(){' + dataCode + ';return DATA;})()');

const TODAY = '2026-04-30';

// ---- Nieuwe signalen (april 2026) ----
const fresh = [
  {
    id: 'SIG-2026-010',
    datum: '2026-04-23',
    urgentie: 'middel',
    type: 'cao',
    instellingId: null,
    headline: 'CAO VVT 2026-2027 onderhandelingen gestart (sector-breed)',
    summary: 'CNV/FNV en ActiZ zijn formeel begonnen aan de onderhandelingen voor de nieuwe CAO VVT 2026-2027. Belangrijke thema\'s: ANW-toeslagen, werkdruk, scholingsbudget en zelfroostering. Uitkomst raakt alle 64 instellingen — let op de volgende ronde half mei.',
    bron: 'CNV',
    bronUrl: 'https://www.cnv.nl/zorg-en-welzijn/zorg/cao-verpleeg-verzorgingshuizen-en-thuiszorg/nieuws/cao-onderhandelingen-vvt-van-start-2026-04-23/',
  },
  {
    id: 'SIG-2026-011',
    datum: '2026-04-14',
    urgentie: 'middel',
    type: 'standaard',
    instellingId: 'novicare-west',
    headline: 'Novicare + Verenso publiceren urgentie-classificatiemodel SO',
    summary: 'Novicare en Verenso hebben gezamenlijk een urgentie-classificatiemodel gepubliceerd voor responsetijden van specialisten ouderengeneeskunde. Geeft kaders voor ANW-bereikbaarheid — relevant voor positionering van GeriCall-diensten.',
    bron: 'Novicare',
    bronUrl: 'https://www.novicare.nl/',
  },
  {
    id: 'SIG-2026-012',
    datum: '2026-04-20',
    urgentie: 'hoog',
    type: 'aanbesteding',
    instellingId: 'frankelandgroep',
    headline: 'Frankelandgroep stopt aanbesteding HavenVeste',
    summary: 'De Frankelandgroep heeft de aanbesteding voor het bouwplan HavenVeste in Schiedam stopgezet — op verzoek van aannemers. Streefdatum hervatting: 1 november. Mogelijk vrijgekomen budget en heroriëntatie op support-diensten in 2026.',
    bron: 'Frankelandgroep',
    bronUrl: 'https://frankelandgroep.nl/nieuws/aanbesteding-havenveste-uitgesteld',
  },
  {
    id: 'SIG-2026-013',
    datum: '2026-02-15',
    urgentie: 'hoog',
    type: 'management',
    instellingId: 'envida',
    headline: 'Envida nieuwe Raad van Bestuur: Milenka van Kempen-Vanderheijden + Petra Lamberts',
    summary: 'Envida transformeert naar een tweekoppige RvB. Milenka van Kempen-Vanderheijden (MHA) en Petra Lamberts (sinds 2021 Director Strategy & Governance, drijvende kracht achter Delta Plan Ouderenzorg Maastricht-Heuvelland) volgen Roger Ruijters op die met pensioen gaat. Nieuw bestuur betekent kans op scherpe heroriëntatie op ANW.',
    bron: 'Envida',
    bronUrl: 'https://www.envida.nl/nieuws/met-vertrouwen-vooruit-envida-verwelkomt-twee-nieuwe-bestuurders',
  },
  {
    id: 'SIG-2026-014',
    datum: '2026-04-20',
    urgentie: 'middel',
    type: 'sector',
    instellingId: null,
    headline: 'Sector-breed: tekort specialisten ouderengeneeskunde groeit, pleidooi voor regionale samenwerking',
    summary: 'Verenso en ANBO-PCOB waarschuwen opnieuw voor groeiend tekort aan specialisten ouderengeneeskunde. Opleidingsplekken worden niet volledig benut; instroom blijft achter bij de vraag. Aanbeveling: regionale netwerkzorg met taakherschikking — past 1-op-1 op GeriCall-aanbod.',
    bron: 'Verenso / ANBO-PCOB',
    bronUrl: 'https://anbo-pcob.nl/nieuws/nieuwsberichten/zorgen-om-groeiend-tekort-aan-specialisten-ouderengeneeskunde/',
  },
  {
    id: 'SIG-2026-015',
    datum: '2026-04-12',
    urgentie: 'middel',
    type: 'management',
    instellingId: 'cordaan',
    headline: 'Cordaan benoemt Douwe van Riet als tweede bestuurder',
    summary: 'Cordaan heeft Douwe van Riet benoemd als nieuw lid Raad van Bestuur naast voorzitter Ronald Schmidt. Van Riet brengt expertise in ouderenzorg en GGZ. Nieuwe portefeuilleverdeling kan een entry-moment betekenen.',
    bron: 'Cordaan',
    bronUrl: 'https://www.cordaan.nl/algemeen/verhalen/douwe-van-riet-nieuwe-bestuurder-cordaan/',
  },
  {
    id: 'SIG-2026-016',
    datum: '2026-04-08',
    urgentie: 'hoog',
    type: 'management',
    instellingId: 'kwadrantgroep',
    headline: 'KwadrantGroep benoemt nieuwe voorzitter Raad van Bestuur',
    summary: 'KwadrantGroep heeft een nieuwe voorzitter Raad van Bestuur benoemd voor de transformatieopgave van de zorg in Friesland. Bestaande GeriForce-samenwerking blijft op tafel; korte lijntjes leggen met nieuwe voorzitter is prioriteit.',
    bron: 'RTV NOF',
    bronUrl: 'https://www.rtvnof.nl/kwadrantgroep-benoemt-nieuwe-voorzitter-raad-bestuur/356479/',
  },
];

// ---- Behouden bestaande signalen vanaf 2025-09 ----
const keepDateMin = '2025-09-01';
const kept = DATA.signalen.filter(s => s.datum >= keepDateMin);

// Combineer + sort + cap op 30
DATA.signalen = [...fresh, ...kept]
  .sort((a, b) => b.datum.localeCompare(a.datum))
  .slice(0, 30);

// ---- Update Envida directie ----
const envida = DATA.instellingen.find(i => i.id === 'envida');
if(envida){
  envida.directie = [
    { naam: 'Milenka van Kempen-Vanderheijden', functie: 'Voorzitter RvB', sinds: '2026-02-15', recent: true },
    { naam: 'Petra Lamberts', functie: 'Lid RvB', sinds: '2026-02-15', recent: true },
  ];
}

// ---- Update Cordaan directie ----
const cordaan = DATA.instellingen.find(i => i.id === 'cordaan');
if(cordaan){
  cordaan.directie = [
    { naam: 'Ronald Schmidt', functie: 'Voorzitter RvB', sinds: '2023-01-01', recent: false },
    { naam: 'Douwe van Riet', functie: 'Lid RvB', sinds: '2026-04-12', recent: true },
  ];
}

// ---- Conservatieve score-aanpassingen op basis van nieuwe signalen ----
// Envida: nieuwe RvB → expansion + acquisitie momentum
if(envida && envida.scores){
  envida.scores.acquisitie = Math.min(100, (envida.scores.acquisitie || 0) + 5);
  envida.scores.expansion  = Math.min(100, (envida.scores.expansion  || 0) + 5);
}
// Frankelandgroep: aanbesteding gestopt → consolidatie + (mogelijk vrijgekomen budget elders)
const frank = DATA.instellingen.find(i => i.id === 'frankelandgroep');
if(frank && frank.scores){
  frank.scores.consolidatie = Math.min(100, (frank.scores.consolidatie || 0) + 4);
}
// Novicare-west: nieuwe Verenso-norm → expansion
const novi = DATA.instellingen.find(i => i.id === 'novicare-west');
if(novi && novi.scores){
  novi.scores.expansion = Math.min(100, (novi.scores.expansion || 0) + 3);
}
// KwadrantGroep: bestuurswissel → acquisitie momentum (klantgesprek met nieuwe voorzitter)
const kwadrant = DATA.instellingen.find(i => i.id === 'kwadrantgroep');
if(kwadrant && kwadrant.scores){
  kwadrant.scores.expansion = Math.min(100, (kwadrant.scores.expansion || 0) + 4);
}
// Cordaan: nieuwe bestuurder → acquisitie momentum
if(cordaan && cordaan.scores){
  cordaan.scores.acquisitie = Math.min(100, (cordaan.scores.acquisitie || 0) + 3);
}

// ---- Snapshot toevoegen voor 2026-04-30 ----
DATA.snapshots = DATA.snapshots || [];
const snapshotInstellingen = {};
DATA.instellingen.forEach(i => {
  snapshotInstellingen[i.id] = {
    leadScore: i.leadScore || 0,
    scores: { ...(i.scores || {}) },
  };
});
DATA.snapshots.push({
  date: TODAY,
  week: 18,
  version: '1.14.0',
  codename: 'Okul',
  instellingen: snapshotInstellingen,
});

// ---- Meta bump ----
DATA.meta.version = '1.14.0';
DATA.meta.codename = 'Okul';
DATA.meta.promptVersion = '1.14.0';
DATA.meta.lastUpdated = TODAY;
DATA.meta.weekNumber = 18;
DATA.meta.releaseHistory = DATA.meta.releaseHistory || [];
DATA.meta.releaseHistory.push({
  version: '1.14.0',
  codename: 'Okul',
  date: TODAY,
  note: `Wekelijkse signal-update WK18 2026: ${fresh.length} verse signalen (CAO-VVT, Novicare/Verenso urgentiemodel, Frankelandgroep aanbesteding-stop, Envida nieuwe RvB, sector-tekort SO, Cordaan + KwadrantGroep bestuurswissels). Directie-update voor Envida + Cordaan. Conservatieve score-correcties (+3 tot +5) voor instellingen met nieuwe sterke signalen. Snapshot toegevoegd voor 2026-04-30.`,
});

// ---- Schrijf nieuwe DATA terug ----
const newDataCode = 'const DATA = ' + JSON.stringify(DATA, null, 2) + ';\n' +
  'DATA.meta.totalInstellingen = DATA.instellingen.length;\n' +
  'DATA.meta.totalSignalen = DATA.signalen.length;\n' +
  'DATA.meta.totalLeveranciers = DATA.leveranciers.length;';
const newHtml = html.replace(dataCode, newDataCode);
fs.writeFileSync('marktradar.html', newHtml);

console.log('OK weekly update toegepast');
console.log(`  ${fresh.length} verse signalen toegevoegd`);
console.log(`  ${DATA.signalen.length} totaal in DATA.signalen`);
console.log(`  Snapshots: ${DATA.snapshots.length}`);
console.log(`  Versie: ${DATA.meta.version} ${DATA.meta.codename}, week ${DATA.meta.weekNumber}, ${DATA.meta.lastUpdated}`);
