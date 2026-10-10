# Marco AI Team

Runtime locale multi-agent a zero costi variabili.

## Versione corrente
3.3.11

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


## v3.3.11 — Prerequisito per autostart

La whitelist `DEV_FILES` include preventivamente `background-launcher.js`, `setup-autostart.cmd` e `disable-autostart.cmd`. I file assenti vengono ignorati da staging, rilevamento modifiche, copia e manifest di pubblicazione. Questa patch non crea questi file e non implementa autostart Windows.

Applicare e riavviare la 3.3.11 prima di preparare la successiva 3.3.12: il server corrente usa la propria whitelist per rilevare e applicare i file dello staging. L’autostart completo andrà implementato nella 3.3.12. Nessun fallback pay-per-use introdotto.
