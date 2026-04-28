# IMPORT_CONTACTS_PROMPT

Prompt voor Claude (web of Code) om een XLS met contacten te mappen op de
64 bestaande instellingen in MarktRadar en daar JSON-output van te maken
die je via **Contacten importeren** in het portaal kunt plakken.

## Werkwijze

1. Open Claude (web of Code).
2. Plak onderstaande prompt.
3. Vervang `{{INSTELLING_LIJST_HIER}}` met de actuele lijst (kopieer in het
   portaal via knop *Mapping-prompt kopiëren* in de Contacten-importeren-modal;
   die heeft de lijst al ingebakken).
4. Vervang `{{PLAK_XLS_INHOUD_HIER}}` met de tabel uit je XLS (kolommen:
   instelling-naam of -code, contactpersoon, functie, email, telefoon,
   eventueel LinkedIn).
5. Claude geeft een JSON-blok terug.
6. Plak dat JSON-blok in MarktRadar > Contacten importeren > textarea,
   klik **Preview** om de mapping te valideren, en daarna **Importeren**.

## Prompt-tekst

```
Ik heb een XLS met contacten en wil deze mappen op de instellingen in onze MarktRadar.

INSTRUCTIE
Voor elke rij in de XLS, geef de best-passende instelling.id terug uit de lijst onderaan,
plus een gestructureerd contact-record. Output als één JSON-object zoals onderaan.

REGELS
- Als de XLS-rij geen duidelijke match heeft (vertrouwen < middel), zet "instellingId": null
  en leg uit waarom in "notitie".
- Map de functietitel op rol:
    "Voorzitter RvB" / "CEO" / "Bestuurder" -> decider
    "Lid RvB" / "Manager Behandeling" / "Hoofd Behandelzaken" -> champion
    "Kwaliteitsmanager" / "CIO" / "Manager IT" -> influencer
    "Inkoopmanager" / "Bestuurssecretaris" -> gatekeeper
- Vertrouwen-rating:
    hoog   = exacte naam-match instelling, bevestigde functietitel
    middel = gedeeltelijke match of via afkorting
    laag   = onzeker, mogelijk verkeerde instelling
- bronType: "xls-import" tenzij je extra bron weet.
- Email/telefoon overnemen uit XLS, ook prive-nummers (we gaan ervan uit dat
  alle contacten zakelijk zijn en B2B-correspondentie toestemming hebben).
- geverifieerd: vandaag (YYYY-MM-DD).

INSTELLING-LIJST (id, naam, hoofdvestiging)
{{INSTELLING_LIJST_HIER}}

XLS-DATA
{{PLAK_XLS_INHOUD_HIER}}

OUTPUT-FORMAT
{
  "contacten": [
    {
      "instellingId": "<id of null>",
      "naam": "Voornaam Achternaam",
      "functie": "exacte functietitel uit XLS",
      "rol": "decider|champion|influencer|gatekeeper|blocker",
      "email": "...",
      "telefoon": "+31...",
      "linkedin": "<URL of null>",
      "bron": "<URL of null>",
      "bronType": "xls-import",
      "vertrouwen": "hoog|middel|laag",
      "geverifieerd": "YYYY-MM-DD",
      "notitie": "<context, mismatch-reden, of null>"
    }
  ]
}

Filter records met "instellingId": null uit het uiteindelijke import-bestand of
verwerk ze handmatig.
```

## Tips voor mapping-kwaliteit

- **Naam-matching is fuzzy**: "Carint" of "Carintreggeland Twente" matcht op
  `carintreggeland`. Geef Claude in twijfelgevallen liever een lage
  vertrouwen-rating dan dat hij gokt.
- **Holdings/concerns**: een rij met "Espria" heeft geen directe match (Espria
  is geen aparte instelling), maar wel `evean` en `icare` zijn dochters. Laat
  Claude een keuze maken op basis van vestigingsplaats of functie, en zet
  vertrouwen op `middel`.
- **Locatie-namen vs. concern-naam**: als de XLS alleen locatienaam vermeldt
  (bv. "De Eik Hellevoetsluis"), kan Claude dit terugleiden naar `careyn-zhe`
  via de beschikbare context. Geef hiervoor `vertrouwen: middel` en gebruik de
  `notitie` om de afleiding vast te leggen.

## Privacy / AVG

Importeer alleen contactgegevens die je rechtmatig hebt verkregen (gerechtvaardigd
B2B-belang of expliciete toestemming). De portal slaat per record een
`geverifieerd`-datum op zodat je na 24 maanden automatisch een herbevestigings-
trigger kunt opzetten. Verwijder records bij verzoek tot inzage of vergetelheid
via de Contacten-modal of door de KV-key handmatig te legen.
