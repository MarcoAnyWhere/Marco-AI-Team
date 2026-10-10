const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const [root, staging, parentPid, oldVersion] = process.argv.slice(2);
if (!root || !staging) process.exit(2);

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function alive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}
function safe(rel) {
  const x = String(rel || "").replace(/\\/g, "/");
  return x && !x.startsWith("/") && !x.includes("../") &&
    x !== "data" && !x.startsWith("data/") &&
    x !== ".git" && !x.startsWith(".git/") &&
    !x.startsWith(".backups/") && !x.startsWith(".update/");
}

(async () => {
  try {
    for (let i = 0; i < 40 && alive(parentPid); i++) await sleep(250);
    await sleep(400);

    const manifest = JSON.parse(fs.readFileSync(path.join(staging, "manifest.json"), "utf8"));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = path.join(root, ".backups", `${stamp}-v${oldVersion}-to-v${manifest.version}`);
    fs.mkdirSync(backup, { recursive: true });

    for (const f of manifest.files) {
      if (!safe(f.path)) throw new Error(`Percorso non consentito: ${f.path}`);
      const src = path.join(staging, f.path);
      const dest = path.join(root, f.path);
      if (!fs.existsSync(src)) throw new Error(`File staged mancante: ${f.path}`);
      if (fs.existsSync(dest)) {
        const b = path.join(backup, f.path);
        fs.mkdirSync(path.dirname(b), { recursive: true });
        fs.copyFileSync(dest, b);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }

    fs.writeFileSync(path.join(root, ".last-update.json"), JSON.stringify({
      from: oldVersion, to: manifest.version, at: new Date().toISOString(), backup
    }, null, 2));

    fs.rmSync(path.join(root, ".update"), { recursive: true, force: true });

    if (process.platform === "win32") {
      const p = spawn("cmd.exe", ["/c", "start", "\"Marco AI Team\"", "start.cmd"], {
        cwd: root, detached: true, windowsHide: true, stdio: "ignore"
      });
      p.unref();
    } else {
      const p = spawn("node", ["server.js"], { cwd: root, detached: true, stdio: "ignore" });
      p.unref();
    }
  } catch (e) {
    try { fs.writeFileSync(path.join(root, ".update-error.txt"), `${new Date().toISOString()}\n${e.stack || e.message}\n`); } catch {}
    process.exit(1);
  }
})();
