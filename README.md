# Marco AI Team

Runtime locale multi-agent a zero costi variabili.

## Versione corrente
3.3.0

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
