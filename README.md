# Marco AI Team

Runtime locale multi-agent a zero costi variabili.

## Versione corrente
3.3.16

## Email/Event Loop V1 (base staging 3.3.15)

Zero costi variabili e zero dipendenze aggiunte: Node.js built-in, Gmail dell'utente,
nessun fallback a servizi a consumo. Codex Plus, Google AI Plus e Ollama restano
nei percorsi esistenti. Nessuna email viene inviata automaticamente agli agenti.

Nel cockpit Email/Event salva il Client ID di un client OAuth desktop Google
configurato dall'utente, quindi scegli Connetti Gmail. L'autorizzazione richiede
esclusivamente Gmail readonly, usa PKCE S256 e state monouso; il callback e un
listener separato su 127.0.0.1 con porta dinamica e durata massima di tre minuti.
La API principale resta su 127.0.0.1:3210. Non inserire password, OTP o app-password.
Un eventuale clientSecret richiesto dal client desktop deve essere configurato
manualmente solo nel file locale protetto data/email-event/config.json; non
esiste un endpoint o campo UI per il secret. Non inserirlo in note, history,
Drive o GitHub. config.json, tokens.json e pending.json restano sotto data/.
Scritture sensibili temp+rename; su Windows vengono applicate ACL per l'utente
corrente, con errore controllato se la protezione non riesce. L'updater preserva data/.

Configura la cartella Drive tramite Remote: EmailEvent/state.json deriva da
remoteConfig.folder e resta separato da Remote/. Il file contiene eventi,
journal delle transizioni, stato ultimo sync e cursore della finestra temporale.
Una singola scrittura atomica aggiorna l'intero snapshot autorevole. La corruzione
del file blocca le operazioni senza sostituire silenziosamente lo stato.

Sincronizza ora recupera al massimo 25 messaggi degli ultimi 14 giorni, solo
metadati: nessun body, allegato, invio, modifica label o Calendar. Oggetto troncato
a 200 caratteri, mittente pseudonimizzato tramite hash; rendering UI come testo.
Dedup primaria Gmail message ID; in assenza usa hash dei metadati di identita
normalizzati prima del troncamento (limite 64 KiB per header). Senza Message-ID
affidabile conserva record separati. Rediscovery conserva stato, nota e timestamp.
Header duplicati, eccessivi o record malformati sono isolati. Il fallback A9
garantisce due eventi con Message-ID differenti dopo il carattere 200.

Reviewed, Ignora e Processed aggiornano esclusivamente lo snapshot Drive e una
nota opzionale di massimo 1000 caratteri. I campi email e le note sono input
non attendibile. Nessuna copia dei segreti OAuth nel journal o nei log tecnici.
Timeout Google 10 secondi, risposte limitate a 1 MiB, massimo tre tentativi con
backoff 100/200 ms per rete, 429 e 5xx. Nessun polling Gmail automatico.

API locali: GET /api/email/status, GET /api/email/events; POST /api/email/config
(solo clientId), /oauth/start, /sync (oggetto vuoto), /event (eventId, status,
nota opzionale). Il callback GET /oauth/callback esiste solo sul listener dedicato.
POST JSON UTF-8, massimo 128 KiB, schema stretto e policy Origin/cross-site
esistente. GET stato restituisce solo configurazione non sensibile e contatori.

Test permanenti senza accesso a data reale:

```
node --check server.js
node server.js --email-event-test
node server.js --work-v2-test
```

La validazione staging esegue entrambe le suite. E1-E20 e A9, HTTP su porta
effimera, storage in memoria e dodici adversarial mirati; nessuna credenziale
reale, chiamata live Google o nuova dipendenza. LIVE_GMAIL_TESTED=false.
Limiti V1: finestra recente limitata, non archivio completo; usare una sola
istanza scrivente, evitare scritture concorrenti dello stesso snapshot da altri
PC Drive. Riconnettere Gmail dopo cambio client o revoca. La protezione ACL e
l'OAuth reale richiedono verifica nell'ambiente utente. Non sono stati eseguiti
Apply, Publish, restart o push. Per rispettare il divieto di accesso fuori dallo
staging, la provenienza completa dalla base installata non e stata verificata;
i sei file critici corrispondono agli hash 3.3.15 forniti.

## Agenti
- Generale
- Agente Lavoro
- Agente Sviluppo

## Agente Sviluppo
L'Agente Sviluppo usa Codex CLI autenticato con ChatGPT Plus.

Flusso sicuro:
1. crea una copia di staging dei soli file applicativi;
2. Codex modifica lo staging, mai `data/`;
3. il sistema valida sintassi JS e script UI;
4. mostra file modificati e versione proposta;
5. `Applica modifiche` crea backup e riavvia;
6. `Pubblica su GitHub` clona il repository, genera `latest.json`, committa e fa push.

Codex non riceve la cartella `data/` nello staging.

## Aggiornamenti
L'app legge `latest.json` da:
`MarcoAnyWhere/Marco-AI-Team`

Prima di applicare una release:
- verifica SHA-256;
- crea backup locale;
- non aggiorna mai `data/`;
- riavvia automaticamente.

## Primo collegamento GitHub
Eseguire una sola volta `setup-github.cmd`.

Al primo push Git Credential Manager può aprire il browser per autorizzare GitHub.

## Dati esclusi
- `data/`
- `.backups/`
- `.dev-work/`
- `.update/`

## Motori
- Codex CLI / ChatGPT Plus
- Antigravity CLI / Google AI Plus
- Ollama locale (`qwen3:1.7b`)

Nessun fallback pay-per-use.


## Hotfix 3.3.1
L'Agente Sviluppo avvia Codex CLI esplicitamente con:
- sandbox `workspace-write`
- approval policy `never`

Lo staging resta separato dalla cartella `data/`.


## Hotfix 3.3.2
Compatibilità con la versione Codex CLI installata localmente:
- `--sandbox workspace-write` resta attivo;
- rimosso `--ask-for-approval never`, non supportato dalla CLI locale;
- l'Agente Sviluppo opera comunque esclusivamente nella copia di staging.


## Ricerca Lavoro Live V1

Nell’Agente Lavoro, “🔎 Cerca offerte live” interroga i feed pubblici Arbeitnow (massimo 3 pagine), Jobicy (geo=europe, count=200) e Remotive (una richiesta). Nessuna API key o servizio a consumo. Timeout 15 secondi; un retry per Arbeitnow/Jobicy, nessun retry Remotive per rispettare la singola richiesta. Le fonti falliscono indipendentemente.

POST /api/work/live-search accetta forceRefresh e onlyNew booleani opzionali. Cache per fonte: 60 minuti Arbeitnow/Jobicy e 6 ore Remotive. forceRefresh ignora il TTL. L’app legge il profilo persistente e salva esclusivamente cache.json e seen.json sotto data/jobs/, già esclusa da Git tramite data/. Un’offerta è nuova se URL e identità azienda/ruolo/sede non sono mai comparsi in una ricerca completata. Il filtro UI Solo nuove è locale; l’endpoint può filtrare anche prima della shortlist.

Pre-score deterministico: ruolo 34–40, seniority 0–15, geografia 10–20, remoto 0–5, RAL 4–15 (10 quando non dichiarata), recency 0–5. Default: ruoli e città richiesti; preferenze aggiuntive derivano dai campi espliciti target/roles/posizioni del profilo. Scelta conservativa: remoto con geografia non dichiarata o limitata ad altri paesi non viene considerato automaticamente accessibile dall’Italia. RAL confrontata solo quando annuale ed EUR espliciti; nessuna conversione valutaria o da paga oraria. Offerte sotto 45k escluse solo quando il limite massimo dichiarato (o il solo minimo disponibile) è sotto soglia.

Le migliori 15 passano in una sola chiamata alla Codex CLI esistente con profilo e descrizioni. Output JSON validato. Se Codex/quota non è disponibile, il trace segnala il limite e le card mostrano “pre-score”; le altre offerte mostrano sempre il pre-score. Nessun fallback a pagamento. “Analizza in dettaglio” usa /api/work/live-analyze con ID, recupera il contenuto dalla cache e riusa l’Agente Lavoro senza nuova richiesta al sito dell’offerta. URL originali e attribuzioni conservati; URL normalizzati usati solo per deduplicare.

Verifica nello staging: parsing sintattico server.js e script UI superato; fixture in memoria per fonte fallita, deduplicazione, cache, seen/onlyNew e singola chiamata Codex superate. Nessun accesso alla cartella data durante lo sviluppo. Test reali tentati sui tre endpoint: fetch dal runtime bloccato da errore di rete; Arbeitnow raggiunto tramite strumento web, Jobicy e Remotive non verificabili da questo ambiente. Da completare verifica end-to-end sul PC con rete e Codex CLI autenticata.


## v3.3.9 — Monitor operativo e Remote Control MVP

Il monitor mostra fasi, eventi operativi (massimo 150 per job), heartbeat ogni 9 secondi, file Dev modificati, avanzamento stimato e ETA a intervallo. Non acquisisce stdout delle CLI, ragionamento interno o prompt di sistema. Con storico insufficiente l'ETA è dichiarata non disponibile; altrimenti usa la mediana delle ultime 20 durate per tipo in data/runtime/stats.json. Il progresso è operativo e resta sotto 100 fino al termine.

POST /api/chat e POST /api/work/live-search accettano background:true e restituiscono subito runId. I client precedenti restano compatibili. GET /api/runs/:runId restituisce snapshot e risultato finale; GET /api/runs/:runId/events usa SSE con fallback UI a polling ogni 5 secondi. Nel browser si salva solo il runId in localStorage. I job continuano dopo chiusura o refresh del browser. Un riavvio del processo interrompe i job CLI: vengono segnalati come falliti, senza riesecuzione automatica. Snapshot locali conservati per gli ultimi 100 job, salvo attività ancora in corso. Contengono il risultato finale, quindi restano esclusi da Git insieme a data/.

### Cartella remota locale

Configurare un percorso assoluto dedicato in “Controllo remoto”. Nessun percorso Google Drive è presunto. L'app crea sotto la cartella configurata:

    Remote/
      inbox/
      running/
      completed/
      failed/
      approvals/
      status/

GET/POST /api/remote/config legge/salva data/config/remote.json. Default: enabled:false, folder:"", pollSeconds:10. Disabilitata o senza cartella non esegue scansioni. Se la cartella principale manca segnala warning. Il server rimane su 127.0.0.1; nessun servizio cloud, porta pubblica o costo variabile viene introdotto. È Google Drive Desktop, se configurato dall'utente, a sincronizzare questi file. La cartella sincronizzata deve essere privata: chi può scrivere al suo interno è autorizzato a richiamare le funzioni dell'app.

Esempio inbox/<uuid>.json:

    {"id":"550e8400-e29b-41d4-a716-446655440000","createdAt":"2026-10-10T12:00:00Z","agent":"general","action":"run","mode":"local","prompt":"Riassumi questo testo: ..."}

Allowlist: agent dev/work/general; action run; mode smart/codex/panel/local/gemini. Massimo 32000 caratteri di prompt e 128 KiB per file. Proprietà aggiuntive non ammesse; nessun campo shell, executable, file o data directory. I prompt hanno le stesse facoltà degli agenti già esistenti: non è una sandbox aggiuntiva contro istruzioni malevole. Dev conserva workspace-write e timeout 20 minuti. Elaborazione remota seriale e deduplicazione ID persistente. I file devono essere caricati completamente, preferibilmente tramite rinomina da un nome temporaneo che non termini in .json.

Il risultato finale include richiesta, risposta, trace operativo, versione, devId/nextVersion e file modificati. Dev con staging pronto passa a awaiting_apply. Solo approvals/<id>-apply.json con {"id":"...","action":"apply"} avvia Apply; backup, copia e riavvio restano affidati all'updater esistente. Lo stato diventa applied dopo disponibilità del server e verifica versione. Separatamente approvals/<id>-publish.json con {"id":"...","action":"publish"} autorizza pubblicazione della versione applicata attualmente installata. Nessuna applicazione o pubblicazione automatica. Approvazioni fuori sequenza restano pendenti con warning. Pubblicazione fallita richiede intervento locale, senza retry automatico.

Limiti MVP: nessuna app smartphone inclusa; il protocollo file è pronto per un futuro client. Non riprende processi CLI dopo riavvio e non recupera automaticamente Apply incompleti. Il collegamento a directory dedicate non sostituisce le autorizzazioni Windows/Drive. Non è previsto “Apri cartella”, per mantenere il flusso privo di comandi shell aggiuntivi. Nessuna nuova dipendenza npm o agente.


### Verifiche nello staging v3.3.9

Superati node --check server.js, node --check updater.js e parsing degli script UI con Node VM. Superate 28 verifiche rapide con filesystem in memoria: creazione/eventi/snapshot, SSE e presenza fallback polling, completamento/errore, ETA senza e con storico, limite eventi/statistiche, configurazione disabilitata, cartella assente, comando valido/duplicato/non valido, awaiting_apply, approvazione Apply simulata, riconciliazione versione dopo Apply, confronto versioni, ripristino snapshot, ID non valido, contributi Panel indipendenti e Judge, caricamento ricerca live con feed simulato e fallback pre-score, copia/validazione staging Dev. Nessun dato personale, motore cloud, Apply reale o pubblicazione coinvolto nei test.

Restano da verificare sul PC operativo: rendering UI nel browser, Drive Desktop, esecuzione delle CLI autenticate e riavvio Windows reale. Le fixture verificano il protocollo e la logica senza eseguire queste operazioni.


## v3.3.12 — Prerequisito per autostart

La whitelist `DEV_FILES` include preventivamente `background-launcher.js`, `setup-autostart.cmd` e `disable-autostart.cmd`. I file assenti vengono ignorati da staging, rilevamento modifiche, copia e manifest di pubblicazione. Questa patch non crea questi file e non implementa autostart Windows.

Applicare e riavviare la 3.3.12 prima di preparare la successiva 3.3.12: il server corrente usa la propria whitelist per rilevare e applicare i file dello staging. L’autostart completo andrà implementato nella 3.3.12. Nessun fallback pay-per-use introdotto.

## Avvio automatico Windows
Dalla cartella definitiva dell’app eseguire `setup-autostart.cmd`, senza amministratore. Crea un unico `Marco-AI-Team.vbs` nella Startup personale; ripetere aggiorna lo stesso elemento. Node deve essere nel PATH al setup. Windows Script Host deve essere abilitato: lo script ne verifica la disponibilità prima di configurare Startup.

`disable-autostart.cmd` rimuove solo l’elemento riconosciuto, anche se già assente; non ferma il server. `start.cmd` resta diagnostico e apre il browser se la porta locale è già attiva; `stop.cmd` arresta solo il processo Node identificato tramite percorso assoluto di server.js e porta locale. Processi non identificabili restano attivi.

Il launcher non apre il browser, usa 127.0.0.1:3210 e non arresta istanze esistenti. Apply riavvia tramite lo stesso launcher nascosto. La UI mostra lo stato della configurazione Startup, non garantisce che Windows esegua l’elemento (ad esempio se disabilitato in Gestione attività). Dopo spostamento dell’app o reinstallazione di Node, rieseguire il setup. Nessun servizio o API aggiuntivi.


## v3.3.14 — refresh e DEV autonomo prudente

Staging da installare manualmente (awaiting_apply). Questa preparazione non esegue Apply, restart o Publish.

La pagina riceve la VERSION nel proprio HTML. Ogni 7 secondi, quando visibile, consulta /api/restart-status (no-store): versione uguale = nessun reload; versione diversa = un solo reload per coppia di versioni nella sessione. Offline e focus/visibility sono gestiti senza bloccare i moduli; il Monitor recupera il run persistito. Le pagine v3.3.13 già aperte non possono acquisire codice nuovo prima del primo caricamento della v3.3.14: il flusso Apply locale conserva il suo rilevamento, per un vecchio tab remoto potrebbe servire il primo F5.

Controlla forza no-store/no-cache e timestamp sia verso il backend sia verso latest.json. Il precedente flusso aveva già un timestamp verso GitHub: il dato vecchio osservato non dimostra una cache browser. Mancavano riconciliazione periodica e distinzione fra push confermato e manifest ancora non propagato. Publish aggiorna una revisione operativa, rilevata dal polling della pagina anche per approvazioni Remote. Per due minuti vengono ripetute verifiche limitate del manifest; un manifest precedente viene indicato come propagazione in corso, mai come nuova verifica riuscita della pubblicazione. Se GitHub è offline, note obsolete vengono rimosse e lo stato non verificato è esplicito. Nessun cambio di repository: MarcoAnyWhere/Marco-AI-Team.

### Opt-in Remote DEV

Il comando normale resta invariato. SOLO agent=dev può aggiungere esattamente:

~~~json
{
  "id": "00000000-0000-4000-8000-000000000001",
  "createdAt": "2026-10-10T12:00:00Z",
  "agent": "dev",
  "action": "run",
  "mode": "smart",
  "prompt": "Descrizione della modifica applicativa richiesta",
  "auto": { "pipeline": "safe-v1" }
}
~~~

Non sono consentiti comandi shell o altre opzioni auto. Stati: developing, validating, reviewing, applying, verifying, publishing, completed; arresti needs_review o publish_failed. Monitor riusa gli eventi operativi esistenti. Dedup per ID e serializzazione Remote restano attivi anche durante la continuazione updater. Manual-dev/general/work senza auto mantengono il flusso precedente.

Validazioni locali: sintassi server/updater/launcher, parsing di tutti gli script UI, file fondamentali e regressioni simulate di sicurezza. Inventario completo con allowlist DEV_FILES: collegamenti, file extra, directory estranee e rimozioni impediscono Apply autonomo. nextVersion deve essere la patch successiva; test e warning critici devono essere vuoti.

Review indipendente tramite Antigravity autenticato con Google AI Plus: esclusivamente testo dei file applicativi allowlisted e report di validazione, senza task personale, data, history o stdout. Variabili token/API/secret/password sono escluse dall'ambiente del reviewer. Il testo viene segmentato per rispettare il limite degli argomenti Windows; ogni segmento deve essere chiaramente approvato, altrimenti stop. JSON rigoroso: decision APPROVE/REJECT/NEEDS_REVIEW, reason breve, criticalWarnings e testsPassed. Nessun fallback API o retry di quota. Source contenente chiavi private o token riconoscibili viene rifiutata. Staging viene sigillato per hash prima della review e confrontato prima di preparare Apply.

L'updater installato (non quello proposto dallo staging) gestisce Apply autonomo: preflight/checksum, backup applicativo, copia, restart nascosto su 127.0.0.1:3210. Verifica VERSION e UUID nuovo esatto, poi smoke non distruttivo su restart-status/remote-state. Una capability effimera, consumata una volta e mai salvata nei report, autorizza esclusivamente Publish sulla nuova istanza. Il server la rimuove dall'ambiente prima di chiamare motori o git. Apply/Publish concorrenti vengono rifiutati durante la pipeline.

Health/smoke falliti: nessun Publish; rollback dai backup se il processo avviato dall'updater è arrestabile e la porta è libera, con verifica della versione ripristinata. Si arresta esclusivamente il child posseduto, mai genericamente node.exe. Se rollback non confermato, needs_review esplicito. Publish fallito/incerto: locale mantenuto, publish_failed, nessun retry infinito. Status/completed/failed includono fasi, esito, file, validazioni e azioni manuali. Una nuova approvazione manuale può recuperare needs_review con devId oppure publish_failed della versione installata; verificare prima GitHub se l'esito del push era incerto. Una continuazione updater senza aggiornamenti per 15 minuti viene segnalata needs_review senza rieseguire il job.

### Verifica ripetibile senza server o dati personali

~~~powershell
node --check server.js
node --check updater.js
node --check background-launcher.js
node -e "const fs=require('fs');const s=fs.readFileSync('server.js','utf8');const a=s.indexOf('async function safetyRegressionChecks() {');const b=s.indexOf('const server = http.createServer',a);eval(s.slice(a,b));safetyRegressionChecks().catch(e=>{console.error(e);process.exitCode=1;});"
~~~

Le regressioni caricano soltanto server.js, updater.js e public/index.html; Apply/restart/review/publish e rollback usano adapter simulati e filesystem in memoria. Non avviare il server dello staging per questi test: il normale avvio usa i dati runtime come nelle versioni precedenti. La suite è anche obbligatoria per ogni futura validazione autonoma e non introduce dipendenze npm.

Limiti: nessuna esecuzione reale di Apply/rollback/Publish o accesso a data durante lo sviluppo di questa release. La review testuale di Antigravity dipende dalla CLI/quota già inclusa; il divieto di tool è nel prompt della CLI, non una nuova sandbox OS. In caso di contesto insufficiente o quota indisponibile si richiede review manuale. I test simulati non sostituiscono il collaudo Windows della prima installazione; modifiche funzionali richiedono test pertinenti oltre alle regressioni comuni. La propagazione CDN GitHub non è controllabile; lo stato distingue conferma push e manifest osservato. Un crash dell'updater o un'interruzione del PC può richiedere recupero manuale dai backup. Zero nuove dipendenze, zero servizi pay-per-use.

## v3.3.15 - Work Agent V2, fix audit 6cffbc39

Rebuild dai file v3.3.14 presenti in questo staging autonomo. Nessun file di staging precedenti usato. Il vincolo di accesso alla sola directory corrente impedisce il confronto con la base installata esterna: la provenienza non e certificata da questa lavorazione.

Profilo: migrazione additiva all'apertura del profilo o alla ricerca; configurazione V2 sotto `workV2` (minimumRal, preferredRal, locations, boards), conservando i campi V1. Default RAL 45000/50000 solo quando invalidi; localita configurate prevalgono sui default. Esempio boards: `{"Greenhouse":["slug-azienda"],"Lever":["slug-azienda"]}`. Nessun board preconfigurato; Ashby disabilitato. Nessun dato reale migrato durante lo sviluppo.

Archivio persistente `data/jobs/archive.json`: stati new/reviewed/saved/applied/dismissed, note, storico delle modifiche, rediscovery conservativa, rilettura prima del merge atomico. API `GET /api/work/archive`, `POST /api/work/job` con `{id,state,note}`. Cockpit con filtri stato/fonte/localita/testo, contatori distinti, azioni e note. Il ranking locale usa lower-bound esplicito annuale EUR; salario mancante non penalizzato. Codex CLI incluso e opzionale (`useCodex:true`); quota indisponibile mantiene il pre-score locale. Nessuna API pay-per-use.

Il parser usa evidence locali e marker salariali; budget/bonus/altro rumore economico separati. Annualita e valuta devono appartenere alla stessa evidence; qualsiasi periodicita incompatibile blocca l'uso della soglia. Importi negativi invalidi; trattini nei range validi preservati. Feed pubblici con host controllati, board slug validati, redirect rifiutati, timeout 15 secondi, limite complessivo header/body 4 MB.

Mutation Work JSON: application/json, anche con charset; altri Content-Type 415 prima di qualunque mutazione. Origin esterni e sec-fetch-site cross-site rifiutati; Origin assente ammesso. Payload 128 KiB, ID/stato/nota validati; bind ordinario 127.0.0.1:3210.

### Gate target e transizione bootstrap

`node server.js --work-v2-test` esegue tutte le suite target, inclusi jobsRegressionChecks e safetyRegressionChecks 11/11. Usa solo fixture in memoria e un server HTTP effimero su loopback, chiuso alla fine. Non legge/scrive data/** e non chiama motori CLI, API cloud o feed live. `validateDevStage` invoca sempre questa suite sul server del TARGET, oltre a controlli sintattici e parsing della UI, anche quando regression=false. Nessun aggiornamento retroattivo della base v3.3.14.

TARGET_VALIDATEDEVSTAGE_COVERAGE=PASS
BOOTSTRAP_EXTERNAL_GATE_REQUIRED=true

Per questa transizione sono obbligatori, prima di ogni Apply, audit Codex indipendente read-only sullo staging completo e successiva review Gemini. Questi due gate esterni NON sono stati eseguiti dal presente sviluppo. Nessun Apply/Publish/restart eseguito. Il bootstrap non e un difetto di codice del target; non dichiarare acquisita una review assente.

### Risultati offline

parser21 21/21; explicitAnnualEur10 10/10 con minimumRal=48000; A1_A8 8/8; N1_N16 16/16; M1_M4 e multi-marker 6/6. Fixture ricostruite dalla specifica ricevuta: non e stato fornito il corpus originale completo dell'audit, quindi i nomi non certificano identita con quel corpus esterno.

Nuove fixture salariali 117/117: periodicita IT/EN 58/58, negativi 12/12, range Unicode, marker multipli, confini di clausola e rumore economico. Content-Type 20/20 sulle quattro route Work/profilo, con confronto dell'intero store in memoria prima/dopo ogni rifiuto; HTTP/security 12/12. Locations/customRal/archivio/concorrenza/ranking/fallback PASS; Greenhouse e Lever static+mock PASS. safetyRegressionChecks 11/11. LIVE_NETWORK_AVAILABLE=NOT_TESTED: non confondere mock con disponibilita live.

Rischi residui: confronto con base installata non eseguito, corpus originale non disponibile, audit indipendente e review Gemini ancora da eseguire; UI verificata sintatticamente, senza sessione browser visuale. APPLY_READY=false fino alla risoluzione delle verifiche di provenienza/copertura esterna. Zero nuove dipendenze; zero costi variabili; nessun dato personale reale letto o modificato.
