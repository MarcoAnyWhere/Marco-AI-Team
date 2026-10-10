const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const VERSION = "3.3.4";
const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3210);
const PUBLIC = path.join(ROOT, "public");
const HISTORY = path.join(ROOT, "data", "history.jsonl");
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen3:1.7b";
const AGENTS_DIR = path.join(ROOT, "data", "agents");
const WORK_PROFILE_FILE = path.join(AGENTS_DIR, "work.json");
const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/MarcoAnyWhere/Marco-AI-Team/main/latest.json";
const DEV_DIR = path.join(ROOT, ".dev-work");
const GITHUB_REPO = "MarcoAnyWhere/Marco-AI-Team";
const GITHUB_CLONE_URL = "https://github.com/MarcoAnyWhere/Marco-AI-Team.git";
const DEV_FILES = ["server.js","updater.js","public/index.html","start.cmd","stop.cmd","setup-local-model.cmd","setup-github.cmd","README.md",".gitignore"];

const SYSTEM_CONTEXT = `CONTESTO REALE DI MARCO AI TEAM:
- Codex CLI è autenticato con ChatGPT Plus; non stiamo usando OpenAI API a consumo.
- Antigravity CLI è autenticato con Google AI Plus; non stiamo usando Gemini API a consumo.
- Ollama gira localmente sul PC.
- Vincolo: ZERO COSTI VARIABILI. Nessun fallback automatico verso API o servizi pay-per-use.
- Se una quota cloud non è disponibile, usa un altro motore incluso oppure segnala il limite.
- Ragiona su questo ambiente reale, non sostituirlo con una generica architettura API.`;

fs.mkdirSync(path.dirname(HISTORY), { recursive: true });

function run(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(exe, args, {
      cwd: opts.cwd || ROOT,
      shell: false,
      windowsHide: true,
      env: process.env
    });

    let out = "";
    let err = "";
    const timeoutMs = opts.timeout || 240000;

    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      reject(new Error(`Timeout dopo ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve({ out: out.trim(), err: err.trim() });
      else reject(new Error((err || out || `Processo terminato con codice ${code}`).trim()));
    });

    if (opts.input) p.stdin.write(opts.input);
    p.stdin.end();
  });
}

function codexJsPath() {
  if (process.platform !== "win32" || !process.env.APPDATA) return null;
  const p = path.join(
    process.env.APPDATA,
    "npm",
    "node_modules",
    "@openai",
    "codex",
    "bin",
    "codex.js"
  );
  return fs.existsSync(p) ? p : null;
}

async function runCodex(prompt, timeout = 240000) {
  const tmp = path.join(os.tmpdir(), `marco-ai-${crypto.randomUUID()}.txt`);
  try {
    const js = codexJsPath();
    if (js) {
      await run(process.execPath, [js, "exec", "--output-last-message", tmp, "-"], {
        input: prompt,
        timeout
      });
    } else {
      await run(process.platform === "win32" ? "codex.cmd" : "codex",
        ["exec", "--output-last-message", tmp, "-"], {
          input: prompt,
          timeout
        }
      );
    }

    if (!fs.existsSync(tmp)) throw new Error("Codex non ha prodotto il messaggio finale.");
    const result = fs.readFileSync(tmp, "utf8").trim();
    if (!result) throw new Error("Codex ha prodotto un output vuoto.");
    return result;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}


async function runCodexInDir(prompt, cwd, timeout = 420000) {
  const tmp = path.join(os.tmpdir(), `marco-ai-dev-${crypto.randomUUID()}.txt`);
  try {
    const js = codexJsPath();
    if (js) {
      await run(process.execPath, [
        js, "exec",
        "--sandbox", "workspace-write",
        "--output-last-message", tmp,
        "-"
      ], {
        input: prompt,
        timeout,
        cwd
      });
    } else {
      await run(process.platform === "win32" ? "codex.cmd" : "codex",
        [
          "exec",
          "--sandbox", "workspace-write",
          "--output-last-message", tmp,
          "-"
        ], {
          input: prompt,
          timeout,
          cwd
        }
      );
    }

    if (!fs.existsSync(tmp)) throw new Error("Codex Dev non ha prodotto il messaggio finale.");
    const result = fs.readFileSync(tmp, "utf8").trim();
    if (!result) throw new Error("Codex Dev ha prodotto un output vuoto.");
    return result;
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
  }
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function nextPatchVersion(v) {
  const p = String(v).split(".").map(n => Number(n) || 0);
  while (p.length < 3) p.push(0);
  p[2] += 1;
  return p.slice(0,3).join(".");
}

function copyAppFiles(fromRoot, toRoot) {
  fs.mkdirSync(toRoot, { recursive: true });
  for (const rel of DEV_FILES) {
    const src = path.join(fromRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(toRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function changedDevFiles(stage) {
  const changed = [];
  for (const rel of DEV_FILES) {
    const a = path.join(ROOT, rel);
    const b = path.join(stage, rel);
    if (!fs.existsSync(b)) continue;
    if (!fs.existsSync(a) || sha256File(a) !== sha256File(b)) changed.push(rel);
  }
  return changed;
}

function forceStageVersion(stage, newVersion) {
  const sp = path.join(stage, "server.js");
  let ss = fs.readFileSync(sp, "utf8");
  ss = ss.replace(/const VERSION = "[^"]+";/, `const VERSION = "${newVersion}";`);
  fs.writeFileSync(sp, ss, "utf8");

  const startp = path.join(stage, "start.cmd");
  if (fs.existsSync(startp)) {
    let x = fs.readFileSync(startp, "utf8");
    x = x.replace(/v\d+\.\d+\.\d+/g, `v${newVersion}`);
    fs.writeFileSync(startp, x, "utf8");
  }

  const readmep = path.join(stage, "README.md");
  if (fs.existsSync(readmep)) {
    let x = fs.readFileSync(readmep, "utf8");
    x = x.replace(/## Versione corrente\s*\r?\n\d+\.\d+\.\d+/, `## Versione corrente\n${newVersion}`);
    fs.writeFileSync(readmep, x, "utf8");
  }
}

async function validateDevStage(stage) {
  for (const rel of ["server.js", "updater.js"]) {
    const f = path.join(stage, rel);
    if (fs.existsSync(f)) {
      await run(process.execPath, ["--check", f], { cwd: stage, timeout: 30000 });
    }
  }

  const htmlFile = path.join(stage, "public", "index.html");
  if (fs.existsSync(htmlFile)) {
    const html = fs.readFileSync(htmlFile, "utf8");
    const match = html.match(/<script>([\s\S]*?)<\/script>/i);
    if (!match) throw new Error("public/index.html non contiene uno script valido.");
    // Parse only; do not execute DOM-dependent code.
    new Function(match[1]);
  }

  const required = ["server.js","public/index.html","start.cmd","updater.js"];
  for (const rel of required) {
    if (!fs.existsSync(path.join(stage, rel))) throw new Error(`File fondamentale mancante nello staging: ${rel}`);
  }
}

function buildManifestFromRoot(version) {
  const files = [];
  for (const rel of DEV_FILES) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) continue;
    files.push({
      path: rel,
      sha256: sha256File(p),
      url: `https://raw.githubusercontent.com/${GITHUB_REPO}/main/${rel}`
    });
  }
  return {
    version,
    notes: `Marco AI Team v${version} pubblicata dall'Agente Sviluppo locale.`,
    files
  };
}

async function publishCurrentVersion() {
  const pub = path.join(os.tmpdir(), `marco-ai-publish-${crypto.randomUUID()}`);
  try {
    await run("git", ["clone", GITHUB_CLONE_URL, pub], { cwd: os.tmpdir(), timeout: 120000 });

    copyAppFiles(ROOT, pub);
    const manifest = buildManifestFromRoot(VERSION);
    fs.writeFileSync(path.join(pub, "latest.json"), JSON.stringify(manifest, null, 2), "utf8");

    await run("git", ["config", "user.name", "MarcoAnyWhere"], { cwd: pub, timeout: 30000 });
    await run("git", ["config", "user.email", "MarcoAnyWhere@users.noreply.github.com"], { cwd: pub, timeout: 30000 });
    await run("git", ["add", "-A"], { cwd: pub, timeout: 30000 });

    const status = await run("git", ["status", "--porcelain"], { cwd: pub, timeout: 30000 });
    if (!status.out.trim()) {
      return { published: false, message: `GitHub è già allineato alla v${VERSION}.` };
    }

    await run("git", ["commit", "-m", `Marco AI Team v${VERSION}`], { cwd: pub, timeout: 60000 });
    await run("git", ["push", "origin", "main"], { cwd: pub, timeout: 180000 });

    return { published: true, message: `Marco AI Team v${VERSION} pubblicata su GitHub.` };
  } finally {
    try { fs.rmSync(pub, { recursive: true, force: true }); } catch {}
  }
}

async function executeDev(task) {
  fs.mkdirSync(DEV_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const stage = path.join(DEV_DIR, id);
  copyAppFiles(ROOT, stage);

  const prompt = `${SYSTEM_CONTEXT}

SEI L'AGENTE SVILUPPO DI MARCO AI TEAM.

Stai lavorando in una COPIA DI STAGING dell'applicazione. Puoi modificare i file presenti nella directory corrente.

OBIETTIVO:
${task}

VINCOLI OBBLIGATORI:
- Modifica SOLO i file applicativi presenti nello staging.
- NON accedere, creare o modificare dati personali, cartella data, credenziali, token, password o file fuori dalla directory corrente.
- NON usare API a pagamento né introdurre servizi pay-per-use.
- Mantieni compatibilità Windows e runtime locale.
- Non fare git push, non pubblicare release e non modificare repository remoti: la pubblicazione è gestita separatamente.
- Non eliminare le funzioni esistenti se non strettamente necessario.
- Mantieni il principio zero costi variabili.
- Se la richiesta è ambigua, scegli l'implementazione più conservativa e documenta l'assunzione.
- Esegui controlli sintattici ragionevoli prima di concludere.

Alla fine restituisci un riepilogo conciso:
1. cosa hai cambiato;
2. file modificati;
3. test eseguiti;
4. eventuali rischi residui.`;

  const codexSummary = await runCodexInDir(prompt, stage);
  let changed = changedDevFiles(stage);

  if (!changed.length) {
    fs.rmSync(stage, { recursive: true, force: true });
    return {
      route: "dev-codex",
      final: `Codex non ha prodotto modifiche applicative.\n\n${codexSummary}`,
      trace: [{ agent: "Agente Sviluppo · Codex", status: "ok", result: codexSummary }]
    };
  }

  const nextVersion = nextPatchVersion(VERSION);
  forceStageVersion(stage, nextVersion);
  await validateDevStage(stage);
  changed = changedDevFiles(stage);

  const trace = [
    { agent: "Agente Sviluppo · Codex", status: "ok", result: `Sandbox: workspace-write · policy approvazioni: predefinita CLI\n\n${codexSummary}` },
    { agent: "Validatore locale", status: "ok", result: `Syntax check superato. File modificati: ${changed.join(", ")}. Versione proposta: v${nextVersion}.` }
  ];

  return {
    route: "dev-codex",
    final: `${codexSummary}\n\nModifiche pronte nello staging. Versione proposta: v${nextVersion}.\nFile: ${changed.join(", ")}.\n\nUsa “Applica modifiche” per creare il backup, installarle e riavviare.`,
    trace,
    devId: id,
    changedFiles: changed,
    nextVersion
  };
}

function prepareDevApply(devId) {
  const stage = path.join(DEV_DIR, String(devId || ""));
  if (!devId || !stage.startsWith(DEV_DIR) || !fs.existsSync(stage)) {
    throw new Error("Staging sviluppo non trovato.");
  }

  const sp = path.join(stage, "server.js");
  const txt = fs.readFileSync(sp, "utf8");
  const m = txt.match(/const VERSION = "([^"]+)";/);
  if (!m) throw new Error("Versione staging non rilevabile.");
  const newVersion = m[1];
  if (compareVersions(newVersion, VERSION) <= 0) throw new Error("La versione staging non è superiore a quella installata.");

  const changed = changedDevFiles(stage);
  if (!changed.length) throw new Error("Nessuna modifica da applicare.");

  // updater.js is required as the detached runner even when unchanged.
  if (!fs.existsSync(path.join(stage, "updater.js"))) {
    fs.copyFileSync(path.join(ROOT, "updater.js"), path.join(stage, "updater.js"));
  }

  const manifest = {
    version: newVersion,
    notes: "Aggiornamento creato dall'Agente Sviluppo locale.",
    files: changed.map(rel => ({
      path: rel,
      sha256: sha256File(path.join(stage, rel))
    }))
  };
  fs.writeFileSync(path.join(stage, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { stage, newVersion, changed };
}


function agyExe() {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const p = path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe");
    if (fs.existsSync(p)) return p;
  }
  return process.platform === "win32" ? "agy.exe" : "agy";
}

async function runGemini(prompt, timeout = 240000) {
  const strictPrompt = `${SYSTEM_CONTEXT}

RUOLO:
Sei un analista testuale. Devi rispondere usando solo il ragionamento del modello.

REGOLE DI ESECUZIONE:
- NON usare terminale, shell, command, file, web, browser, MCP, subagent o altri tool.
- NON tentare verifiche nell'ambiente locale.
- Restituisci direttamente la tua analisi in italiano.

RICHIESTA:
${prompt}`;

  const r = await run(agyExe(), ["-p", strictPrompt], { timeout });
  const result = (r.out || "").trim();

  if (!result) {
    const diag = (r.err || "").trim();
    throw new Error(diag
      ? `Gemini non ha prodotto risposta. Diagnostica: ${diag}`
      : "Gemini non ha prodotto risposta.");
  }
  return result;
}

function stripAnsi(s) {
  return String(s || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function cleanLocalText(s) {
  let x = stripAnsi(s);
  x = x.replace(/<think>[\s\S]*?<\/think>/gi, "");
  x = x.replace(/<\/?think>/gi, "");
  return x.trim();
}

function ollamaHttp(pathname, method = "GET", payload = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = http.request({
      hostname: "127.0.0.1",
      port: 11434,
      path: pathname,
      method,
      headers: body ? {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body)
      } : {}
    }, res => {
      let data = "";
      res.on("data", d => data += d.toString());
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Ollama HTTP ${res.statusCode}: ${data}`));
        }
        try {
          resolve(JSON.parse(data || "{}"));
        } catch (e) {
          reject(new Error(`Risposta Ollama non valida: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timeout Ollama dopo ${Math.round(timeoutMs / 1000)}s`)));

    if (body) req.write(body);
    req.end();
  });
}

async function runLocal(prompt, timeout = 30000) {
  const j = await ollamaHttp("/api/chat", "POST", {
    model: OLLAMA_MODEL,
    messages: [{ role: "user", content: prompt }],
    stream: false,
    think: false,
    keep_alive: "15m",
    options: {
      temperature: 0.2,
      num_ctx: 2048,
      num_predict: 180
    }
  }, timeout);

  const result = cleanLocalText(j?.message?.content || j?.response || "");
  if (!result) throw new Error("Ollama non ha prodotto output.");
  return result;
}

function routeSmart(task) {
  const t = task.trim();
  const l = t.toLowerCase();

  const panelWords = [
    "confronta", "confronto", "valuta", "valutazione", "strategia",
    "investimento", "decisione importante", "rischi", "pro e contro",
    "vantaggi e svantaggi", "scegli tra", "quale conviene", "raccomandazione"
  ];
  const codexWords = [
    "bug", "debug", "codice", "refactor", "funzione", "script", "errore",
    "implementa", "programma", "architettura software", "powershell", "python",
    "javascript", "node", "sql"
  ];
  const geminiWords = [
    "documento molto lungo", "molti documenti", "video", "multimodale",
    "repository intero", "grande contesto", "analizza questo video"
  ];
  const localWords = [
    "riassumi", "classifica", "estrai", "riformula", "riscrivi",
    "tre punti", "lista breve", "etichetta", "ordina", "categor",
    "normalizza", "rinomina"
  ];

  if (panelWords.some(w => l.includes(w))) {
    return { route: "panel", reason: "Regola software: richiesta comparativa o decisionale." };
  }
  if (codexWords.some(w => l.includes(w))) {
    return { route: "codex", reason: "Regola software: task tecnico o di ragionamento complesso." };
  }
  if (geminiWords.some(w => l.includes(w))) {
    return { route: "gemini", reason: "Regola software: task adatto a contesto ampio o multimodale." };
  }
  if (localWords.some(w => l.includes(w)) && t.length < 900) {
    return { route: "local", reason: "Regola software: task linguistico semplice e breve." };
  }
  if (t.length < 180) {
    return { route: "local", reason: "Regola software: richiesta breve e a basso rischio." };
  }

  return { route: "codex", reason: "Regola software: caso non banale; uso Codex come default prudente." };
}


function readJsonFile(file, fallback={}) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}

function writeJsonFile(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
}


function extractUrls(text) {
  const m = String(text || "").match(/https?:\/\/[^\s<>"']+/g) || [];
  return m.map(x => x.replace(/[),.;]+$/g, ""));
}

function canonicalizeJobUrl(raw) {
  try {
    const u = new URL(raw);
    if (/indeed\./i.test(u.hostname) && u.searchParams.get("jk")) {
      const clean = new URL(`${u.protocol}//${u.hostname}/viewjob`);
      clean.searchParams.set("jk", u.searchParams.get("jk"));
      return clean.toString();
    }
    return u.toString();
  } catch {
    return raw;
  }
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

function htmlToText(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script\b[\s\S]*?<\/script>/gi, "\n")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "\n")
      .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "\n")
      .replace(/<(br|p|div|li|h1|h2|h3|h4|section|article|tr)\b[^>]*>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function collectJobPostingJsonLd(html) {
  const scripts = [...String(html || "").matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  )];
  const found = [];
  function visit(v) {
    if (!v) return;
    if (Array.isArray(v)) return v.forEach(visit);
    if (typeof v !== "object") return;
    if (v["@type"] === "JobPosting" || (Array.isArray(v["@type"]) && v["@type"].includes("JobPosting"))) {
      found.push(v);
    }
    if (v["@graph"]) visit(v["@graph"]);
  }
  for (const s of scripts) {
    try { visit(JSON.parse(decodeHtml(s[1]))); } catch {}
  }
  return found[0] || null;
}

function jobPostingToText(j) {
  if (!j) return "";
  const parts = [];
  if (j.title) parts.push(`Titolo: ${j.title}`);
  if (j.hiringOrganization?.name) parts.push(`Azienda: ${j.hiringOrganization.name}`);
  if (j.employmentType) parts.push(`Contratto: ${Array.isArray(j.employmentType) ? j.employmentType.join(", ") : j.employmentType}`);
  if (j.jobLocationType) parts.push(`Modalità: ${j.jobLocationType}`);

  const locs = Array.isArray(j.jobLocation) ? j.jobLocation : (j.jobLocation ? [j.jobLocation] : []);
  const locText = locs.map(x => {
    const a = x?.address || {};
    return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(", ");
  }).filter(Boolean);
  if (locText.length) parts.push(`Località: ${locText.join(" | ")}`);

  if (j.baseSalary) parts.push(`Retribuzione dichiarata: ${JSON.stringify(j.baseSalary)}`);
  if (j.description) parts.push(`Descrizione:\n${htmlToText(j.description)}`);
  if (j.qualifications) parts.push(`Qualifiche:\n${htmlToText(j.qualifications)}`);
  if (j.responsibilities) parts.push(`Responsabilità:\n${htmlToText(j.responsibilities)}`);

  return parts.join("\n\n").trim();
}

async function fetchJobUrl(rawUrl) {
  const url = canonicalizeJobUrl(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/142 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "it-IT,it;q=0.9,en;q=0.7",
        "Cache-Control": "no-cache"
      }
    });

    const html = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const job = collectJobPostingJsonLd(html);
    let content = jobPostingToText(job);
    if (!content || content.length < 300) content = htmlToText(html);
    content = content.slice(0, 30000).trim();

    const blocked = /captcha|access denied|verify you are human|unusual traffic/i.test(content);
    if (blocked || content.length < 250) throw new Error("pagina bloccata o contenuto insufficiente");

    return { ok: true, canonicalUrl: url, finalUrl: res.url, content };
  } catch (e) {
    return {
      ok: false,
      canonicalUrl: url,
      error: e.name === "AbortError" ? "timeout durante il recupero URL" : e.message
    };
  } finally {
    clearTimeout(timer);
  }
}


function workProfileText() {
  const p = readJsonFile(WORK_PROFILE_FILE, {});
  return JSON.stringify(p, null, 2);
}

function workIntent(task) {
  const l = task.toLowerCase();

  // Explicit multi-offer comparison only. "Valuta" or "analizza" a single role is NOT compare.
  if (
    /(confronta|paragona).*(offert|posizion|ruol)/.test(l) ||
    /(queste|le seguenti|più|diverse).*(offert|posizion)/.test(l) ||
    /(graduatoria|ranking).*(offert|posizion|candidatur)/.test(l) ||
    /(quale|quali).*(offert|posizion).*(meglio|conviene|priorit)/.test(l)
  ) return "compare";

  if (/(lettera|cover letter|motivazionale|presentazione)/.test(l)) return "cover_letter";
  if (/(cv|curriculum|adatta|tailor|ottimizza.*cv)/.test(l)) return "cv";

  if (
    /(analizza|valuta|fit|requisiti|candidatura).*(offert|ruol|posizion|job description)/.test(l) ||
    /(offert|ruol|posizion|job description).*(analizza|valuta|fit|requisiti|candidatura)/.test(l)
  ) return "job_fit";

  if (/(cerca|trova|ricerca).*(offert|lavor|posizion|vacan)/.test(l)) return "live_search";
  return "career";
}

function workSystemPrompt(task) {
  const intent = workIntent(task);
  const profile = workProfileText();

  return `${SYSTEM_CONTEXT}

AGENTE SPECIALIZZATO: LAVORO / CARRIERA

PROFILO PROFESSIONALE PERSISTENTE:
${profile}

INTENTO RILEVATO: ${intent}

REGOLE:
- Lavora esclusivamente sui fatti presenti nel profilo e nel materiale fornito.
- Non inventare esperienze, RAL, tecnologie, responsabilità, risultati o requisiti dell'offerta.
- Se analizzi un'offerta, separa sempre: fit tecnico, fit manageriale, seniority, sede/logistica, economico, gap, rischio candidatura.
- Se possibile assegna un FIT 0-100 motivato, ma non usarlo come falsa precisione: spiega i driver principali.
- Evidenzia must-have mancanti e quali gap sono realmente penalizzanti.
- Per CV/lettera: valorizza ciò che esiste, non aggiungere competenze mai dichiarate.
- Se la richiesta contiene un URL e trovi una sezione "CONTENUTO VERIFICATO RECUPERATO DALL'URL", usa quel contenuto come fonte primaria dell'offerta.
- Se la richiesta contiene un URL ma NON trovi contenuto recuperato, dichiarare il limite e chiedere il testo; non inventare nulla.
- Se la richiesta dipende da offerte correnti sul web e non sono state fornite fonti aggiornate, dichiaralo. Non fingere una ricerca live.
- Non fare affermazioni sul processo di selezione dell'azienda (ATS, coding test, system design, colloqui) se non sono indicate nell'offerta o in una fonte esplicita.
- Non attribuire a progetti del profilo volumi, criticità, tecnologie o responsabilità non documentate.
- Distingui sempre "documentato", "plausibile/inferibile" e "non dimostrato".
- Italiano, concreto, orientato alla decisione.

RICHIESTA:
${task}`;
}

function workRoute(task, mode) {
  if (mode !== "smart") return mode;
  const intent = workIntent(task);

  if (intent === "compare") return "panel";
  if (intent === "live_search") return "codex";
  if (intent === "job_fit" || intent === "cv" || intent === "cover_letter" || intent === "career") return "codex";
  return "codex";
}

async function executeWork(task, mode) {
  const trace = [];
  const intent = workIntent(task);
  const route = workRoute(task, mode);
  let effectiveTask = task;

  trace.push({
    agent: "Agente Lavoro",
    status: "ok",
    result: `Intento: ${intent}. Profilo professionale locale caricato da data/agents/work.json.`
  });

  const urls = extractUrls(task);
  if (intent === "job_fit" && urls.length) {
    const fetched = await fetchJobUrl(urls[0]);
    if (fetched.ok) {
      trace.push({
        agent: "URL Retriever",
        status: "ok",
        result: `Offerta recuperata da ${fetched.finalUrl || fetched.canonicalUrl}. Contenuto utile: ${fetched.content.length} caratteri.`
      });
      effectiveTask = `${task}

CONTENUTO VERIFICATO RECUPERATO DALL'URL:
Fonte: ${fetched.finalUrl || fetched.canonicalUrl}

${fetched.content}`;
    } else {
      trace.push({
        agent: "URL Retriever",
        status: "error",
        result: `Recupero fallito per ${fetched.canonicalUrl}: ${fetched.error}`
      });
    }
  }

  if (intent === "live_search" && mode === "smart") {
    const msg = `La richiesta richiede una ricerca di offerte live. L'Agente Lavoro V3 ha già profilo, criteri e logica di valutazione, ma la ricerca web autonoma non è ancora collegata in modo affidabile alle CLI locali. Posso comunque analizzare subito link o job description che incolli; il connettore di ricerca live sarà il prossimo modulo da aggiungere.`;
    trace.push({ agent: "Capability gate", status: "ok", result: "Ricerca web live non simulata: nessuna fonte aggiornata disponibile nel runtime locale V3." });
    return { route: "work", final: msg, trace };
  }

  const prompt = workSystemPrompt(effectiveTask);

  if (route === "panel") {
    const [c, g] = await Promise.allSettled([
      runCodex(`${prompt}

RUOLO NEL PANEL:
Sei l'analista principale di carriera. Produci una valutazione rigorosa e operativa.`),
      runGemini(`${prompt}

RUOLO NEL PANEL:
Sei il revisore indipendente. Cerca gap, rischi, assunzioni deboli e alternative.
Vincoli:
- Non inventare processi di selezione, stack, volumi, seniority specifiche o pratiche aziendali non presenti nell'offerta.
- Se fai un'inferenza, etichettala esplicitamente come inferenza.
- Non trasformare "Manager" in prova automatica di people management tecnico.
- Non trasformare una skill elencata nel profilo in prova di uso hands-on pluriennale.`)
    ]);

    let ct="", gt="";
    if (c.status === "fulfilled") {
      ct = c.value;
      trace.push({ agent: "Work Analyst · Codex", status: "ok", result: ct });
    } else {
      trace.push({ agent: "Work Analyst · Codex", status: "error", result: c.reason.message });
    }

    if (g.status === "fulfilled") {
      gt = g.value;
      trace.push({ agent: "Work Reviewer · Gemini", status: "ok", result: gt });
    } else {
      trace.push({ agent: "Work Reviewer · Gemini", status: "error", result: g.reason.message });
    }

    if (!ct || !gt) throw new Error("Panel Lavoro incompleto.");

    const final = await runCodex(`${SYSTEM_CONTEXT}

Sei il Career Judge finale di Marco AI Team.

PROFILO PROFESSIONALE REALE (fonte primaria):
${workProfileText()}

REGOLE DEL JUDGE:
- Il profilo sopra è già disponibile nel prompt: NON tentare di leggerlo dal workspace o dal filesystem.
- Usa il profilo come fonte primaria sui fatti del candidato.
- Se gli analisti affermano qualcosa non supportato dal profilo o dall'offerta, scartalo o etichettalo come inferenza.
- Non inventare processi di selezione, RAL, stack o responsabilità non presenti nelle fonti.
- "Non dimostrato" non equivale a "assente".
- Dai priorità a: seniority, requisiti must-have, sede, RAL, gap critici e azione successiva.

RICHIESTA:
${effectiveTask}

ANALISI CODEX:
${ct}

REVISIONE GEMINI:
${gt}`);
    trace.push({ agent: "Career Judge · Codex", status: "ok", result: final });
    return { route: "work-panel", final, trace };
  }

  if (route === "gemini") {
    const out = await runGemini(prompt);
    trace.push({ agent: "Agente Lavoro · Gemini", status: "ok", result: out });
    return { route: "work-gemini", final: out, trace };
  }

  if (route === "local") {
    const out = await runLocal(`${prompt}

Rispondi molto brevemente.`, 45000);
    trace.push({ agent: `Agente Lavoro · ${OLLAMA_MODEL}`, status: "ok", result: out });
    return { route: "work-local", final: out, trace };
  }

  const out = await runCodex(prompt);
  trace.push({ agent: "Agente Lavoro · Codex", status: "ok", result: out });
  return { route: "work-codex", final: out, trace };
}


async function execute(task, mode, agent="general") {
  if (agent === "work") return executeWork(task, mode);
  if (agent === "dev") return executeDev(task);

  const trace = [];
  let route = mode;

  if (mode === "smart") {
    const r = routeSmart(task);
    route = r.route;
    trace.push({ agent: "Router software", status: "ok", result: r.reason });
  }

  if (route === "local") {
    try {
      const out = await runLocal(
        `Rispondi in italiano in modo pratico e conciso. Non mostrare ragionamento interno.

RICHIESTA:
${task}`,
        mode === "smart" ? 30000 : 45000
      );
      trace.push({ agent: `Ollama · ${OLLAMA_MODEL}`, status: "ok", result: out });
      return { route, final: out, trace };
    } catch (e) {
      trace.push({ agent: `Ollama · ${OLLAMA_MODEL}`, status: "error", result: e.message });

      if (mode !== "smart") throw e;

      const out = await runCodex(`${SYSTEM_CONTEXT}

Il motore locale non ha risposto abbastanza rapidamente. Rispondi tu in modo conciso.

RICHIESTA:
${task}`);
      trace.push({ agent: "Fallback · Codex / ChatGPT Plus", status: "ok", result: out });
      return { route: "codex", final: out, trace };
    }
  }

  if (route === "codex") {
    const out = await runCodex(`${SYSTEM_CONTEXT}

Sei il Manager di Marco AI Team. Rispondi in italiano in modo utile e concreto.

RICHIESTA:
${task}`);
    trace.push({ agent: "Codex · ChatGPT Plus", status: "ok", result: out });
    return { route, final: out, trace };
  }

  if (route === "gemini") {
    const out = await runGemini(`Sei l'analista Gemini di Marco AI Team.
Fornisci una risposta indipendente e concreta.

${task}`);
    trace.push({ agent: "Gemini · Google AI Plus", status: "ok", result: out });
    return { route, final: out, trace };
  }

  const codexPrompt = `${SYSTEM_CONTEXT}

Sei l'analista OpenAI del Panel.
Analizza indipendentemente la richiesta con raccomandazione, rischi e assunzioni.
Non trasformare l'ambiente reale in una generica architettura API a consumo.

RICHIESTA:
${task}`;

  const geminiPrompt = `Sei l'analista Google del Panel.
Produci una seconda analisi indipendente: alternative, rischi e punti trascurati.
Considera esplicitamente il vincolo zero costi variabili e l'uso di Antigravity con Google AI Plus.

RICHIESTA:
${task}`;

  const [c, g] = await Promise.allSettled([
    runCodex(codexPrompt),
    runGemini(geminiPrompt)
  ]);

  let ct = "";
  let gt = "";

  if (c.status === "fulfilled") {
    ct = c.value;
    trace.push({ agent: "Codex · ChatGPT Plus", status: "ok", result: ct });
  } else {
    trace.push({ agent: "Codex · ChatGPT Plus", status: "error", result: c.reason.message });
  }

  if (g.status === "fulfilled") {
    gt = g.value;
    trace.push({ agent: "Gemini · Google AI Plus", status: "ok", result: gt });
  } else {
    trace.push({ agent: "Gemini · Google AI Plus", status: "error", result: g.reason.message });
  }

  if (!ct && !gt) throw new Error("Entrambi gli agenti cloud hanno fallito.");
  if (!ct) throw new Error("Panel incompleto: Codex non ha prodotto un contributo.");
  if (!gt) throw new Error("Panel incompleto: Gemini non ha prodotto un contributo.");

  const final = await runCodex(`${SYSTEM_CONTEXT}

Sei il Judge finale di Marco AI Team.
Sintetizza le due analisi in UNA risposta finale concreta.
Non fare una media meccanica: risolvi i disaccordi quando possibile e segnala quelli importanti.
La risposta deve essere una sintesi nuova, coerente con l'ambiente subscription-first e zero-costi.

RICHIESTA ORIGINALE:
${task}

ANALISI CODEX:
${ct}

ANALISI GEMINI:
${gt}`);

  trace.push({ agent: "Judge finale · Codex", status: "ok", result: final });
  return { route, final, trace };
}

async function statusCodex() {
  try {
    const js = codexJsPath();
    const r = js
      ? await run(process.execPath, [js, "--version"], { timeout: 15000 })
      : await run(process.platform === "win32" ? "codex.cmd" : "codex", ["--version"], { timeout: 15000 });
    return { ok: true, detail: r.out || r.err };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function statusGemini() {
  try {
    const r = await run(agyExe(), ["--version"], { timeout: 15000 });
    return { ok: true, detail: r.out || r.err };
  } catch (e) {
    return { ok: false, detail: e.message };
  }
}

async function statusOllama() {
  try {
    const tags = await ollamaHttp("/api/tags", "GET", null, 10000);
    const names = (tags.models || []).map(m => m.name);
    const installed = names.some(n => n === OLLAMA_MODEL || n.startsWith(`${OLLAMA_MODEL}:`));
    return {
      ok: installed,
      detail: installed
        ? `Ollama attivo · modello ${OLLAMA_MODEL}`
        : `Ollama attivo, ma manca ${OLLAMA_MODEL}. Esegui: ollama pull ${OLLAMA_MODEL}`
    };
  } catch (e) {
    return { ok: false, detail: `Ollama non raggiungibile: ${e.message}` };
  }
}


function compareVersions(a, b) {
  const pa = String(a).split(".").map(n => Number(n) || 0);
  const pb = String(b).split(".").map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "Cache-Control": "no-cache" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally { clearTimeout(timer); }
}

async function getUpdateManifest() {
  const text = await fetchText(`${UPDATE_MANIFEST_URL}?t=${Date.now()}`);
  const m = JSON.parse(text);
  if (!m || !m.version || !Array.isArray(m.files)) throw new Error("Manifest aggiornamento non valido.");
  return m;
}

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function safeUpdatePath(rel) {
  const clean = String(rel || "").replace(/\\/g, "/");
  if (!clean || clean.startsWith("/") || clean.includes("../")) return false;
  if (clean === "data" || clean.startsWith("data/")) return false;
  if (clean === ".git" || clean.startsWith(".git/")) return false;
  if (clean.startsWith(".backups/") || clean.startsWith(".update/")) return false;
  return true;
}

async function stageUpdate(manifest) {
  const staging = path.join(ROOT, ".update", manifest.version);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  for (const f of manifest.files) {
    if (!safeUpdatePath(f.path)) throw new Error(`Percorso aggiornamento non consentito: ${f.path}`);
    const url = f.url || `https://raw.githubusercontent.com/MarcoAnyWhere/Marco-AI-Team/main/${f.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    let buf;
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { signal: controller.signal, headers: { "Cache-Control": "no-cache" } });
      if (!res.ok) throw new Error(`HTTP ${res.status} su ${f.path}`);
      buf = Buffer.from(await res.arrayBuffer());
    } finally { clearTimeout(timer); }
    const actual = sha256Buffer(buf);
    if (actual.toLowerCase() !== String(f.sha256).toLowerCase()) throw new Error(`Checksum non valido per ${f.path}`);
    const dest = path.join(staging, f.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  }

  fs.writeFileSync(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return staging;
}

function startDetachedUpdater(staging) {
  const runner = path.join(staging, "updater.js");
  if (!fs.existsSync(runner)) throw new Error("updater.js mancante nell'aggiornamento.");
  const p = spawn(process.execPath, [runner, ROOT, staging, String(process.pid), VERSION], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: "ignore"
  });
  p.unref();
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", d => {
      s += d;
      if (s.length > 2_000_000) reject(new Error("Richiesta troppo grande."));
    });
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

function appendHistory(entry) {
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + "\n", "utf8");
}

function readHistory() {
  try {
    return fs.readFileSync(HISTORY, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-30)
      .reverse()
      .map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/status") {
      const [codex, gemini, ollama] = await Promise.all([
        statusCodex(),
        statusGemini(),
        statusOllama()
      ]);
      return sendJson(res, 200, {
        version: VERSION,
        codex,
        gemini,
        ollama,
        zeroCostMode: true,
        ollamaModel: OLLAMA_MODEL,
        agents: { work: fs.existsSync(WORK_PROFILE_FILE) }
      });
    }

    if (req.method === "GET" && req.url === "/api/update/check") {
      try {
        const manifest = await getUpdateManifest();
        return sendJson(res, 200, {
          ok: true,
          currentVersion: VERSION,
          latestVersion: manifest.version,
          available: compareVersions(manifest.version, VERSION) > 0,
          notes: manifest.notes || ""
        });
      } catch (e) {
        return sendJson(res, 200, { ok: false, currentVersion: VERSION, error: e.message });
      }
    }

    if (req.method === "POST" && req.url === "/api/update/apply") {
      const manifest = await getUpdateManifest();
      if (compareVersions(manifest.version, VERSION) <= 0) {
        return sendJson(res, 200, { ok: true, message: "Nessun aggiornamento disponibile.", currentVersion: VERSION });
      }
      const staging = await stageUpdate(manifest);
      startDetachedUpdater(staging);
      sendJson(res, 200, { ok: true, message: `Aggiornamento a v${manifest.version} preparato. Riavvio in corso.`, latestVersion: manifest.version });
      setTimeout(() => process.exit(0), 900);
      return;
    }

    if (req.method === "POST" && req.url === "/api/dev/apply") {
      const body = JSON.parse(await readBody(req) || "{}");
      const prepared = prepareDevApply(body.devId);
      startDetachedUpdater(prepared.stage);
      sendJson(res, 200, {
        ok: true,
        latestVersion: prepared.newVersion,
        changedFiles: prepared.changed,
        message: `Modifiche applicate. Riavvio verso v${prepared.newVersion} in corso.`
      });
      setTimeout(() => process.exit(0), 900);
      return;
    }

    if (req.method === "POST" && req.url === "/api/dev/publish") {
      const result = await publishCurrentVersion();
      return sendJson(res, 200, { ok: true, version: VERSION, ...result });
    }

    if (req.method === "GET" && req.url === "/api/agents/work") {
      return sendJson(res, 200, readJsonFile(WORK_PROFILE_FILE, {}));
    }

    if (req.method === "POST" && req.url === "/api/agents/work") {
      const body = JSON.parse(await readBody(req) || "{}");
      if (!body || typeof body !== "object") return sendJson(res, 400, { error: "Profilo non valido." });
      writeJsonFile(WORK_PROFILE_FILE, body);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url === "/api/history") {
      return sendJson(res, 200, readHistory());
    }

    if (req.method === "POST" && req.url === "/api/chat") {
      const body = JSON.parse(await readBody(req) || "{}");
      const task = String(body.task || "").trim();
      const mode = String(body.mode || "smart");
      const agent = String(body.agent || "general");

      if (!task) return sendJson(res, 400, { error: "Inserisci una richiesta." });
      if (!["smart", "panel", "codex", "gemini", "local"].includes(mode)) {
        return sendJson(res, 400, { error: "Modalità non valida." });
      }
      if (!["general", "work", "dev"].includes(agent)) {
        return sendJson(res, 400, { error: "Agente non valido." });
      }

      const started = Date.now();
      const result = await execute(task, mode, agent);
      const entry = {
        id: crypto.randomUUID(),
        version: VERSION,
        at: new Date().toISOString(),
        task,
        mode,
        agent,
        route: result.route,
        elapsedMs: Date.now() - started,
        final: result.final,
        trace: result.trace,
        ...(result.devId ? { devId: result.devId, changedFiles: result.changedFiles, nextVersion: result.nextVersion } : {})
      };

      appendHistory(entry);
      return sendJson(res, 200, entry);
    }

    if (req.method !== "GET") {
      res.writeHead(405);
      return res.end("Method not allowed");
    }

    let requested = req.url.split("?")[0];
    if (requested === "/") requested = "/index.html";

    const file = path.resolve(PUBLIC, "." + requested);
    if (!file.startsWith(path.resolve(PUBLIC)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end("Not found");
    }

    res.writeHead(200, {
      "Content-Type": contentType(file),
      "Cache-Control": "no-store"
    });
    res.end(fs.readFileSync(file));
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: e.message || "Errore interno." });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Marco AI Team v${VERSION}`);
  console.log(`http://127.0.0.1:${PORT}`);
  console.log(`Ollama model: ${OLLAMA_MODEL}`);
  console.log("ZERO COSTI VARIABILI");
});
