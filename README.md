# Marco AI Team

Runtime locale multi-agent a zero costi variabili.

## Versione corrente
3.2.1

## Aggiornamenti
Dalla v3.2.1 l'app controlla `latest.json` in questo repository, verifica SHA-256 dei file, crea un backup locale e si aggiorna senza sovrascrivere i dati personali.

## Dati esclusi dagli aggiornamenti
- `data/agents/`
- `data/history.jsonl`
- qualsiasi file locale sotto `data/`

## Motori
- Codex CLI autenticato con ChatGPT Plus
- Antigravity CLI autenticato con Google AI Plus
- Ollama locale (`qwen3:1.7b`)

Nessun fallback pay-per-use.


## Primo collegamento GitHub

Eseguire una sola volta `setup-github.cmd`.

Lo script:
- clona `MarcoAnyWhere/Marco-AI-Team`;
- copia solo i file applicativi;
- non carica `data/`;
- crea un commit;
- esegue il push su `main`.

Al primo push Git Credential Manager può aprire il browser per l'autenticazione GitHub.

Dopo questo bootstrap, `start.cmd` può controllare `latest.json` direttamente dal repository pubblico.
