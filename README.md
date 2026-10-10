# Marco AI Team

Runtime locale multi-agent a zero costi variabili.

## Versione corrente
3.3.8

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
