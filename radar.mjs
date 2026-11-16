// Radar à codes Gil2 – écoute le chat Twitch (lecture seule, anonyme)
// et envoie chaque nouveau code sur ton téléphone via ntfy.
// Aucune dépendance : nécessite Node 22+ (WebSocket intégré).

const CHANNEL   = (process.env.CHANNEL || "gil2_").toLowerCase().replace(/^#/, "");
const TOPIC     = process.env.NTFY_TOPIC;                       // secret GitHub
const NTFY      = process.env.NTFY_SERVER || "https://ntfy.sh";
const MINUTES   = Number(process.env.DURATION_MINUTES || 330);  // durée d'écoute
const SITE      = process.env.SITE_URL || "https://www.gil2-cards.com/";
const KEYWORDS  = (process.env.KEYWORDS || "code, gil2-cards, gil2cards, gil2 cards")
                    .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const EXTRA     = (process.env.EXTRA_USERS || "nightbot, streamelements, moobot, fossabot, wizebot")
                    .toLowerCase().split(",").map(s => s.trim()).filter(Boolean);
const START_PING = (process.env.NOTIFY_START || "true") === "true";

if (!TOPIC) { console.error("❌ Secret NTFY_TOPIC manquant."); process.exit(1); }

// ---------- envoi ntfy ----------
async function push({ title, message, priority = "high", tags = "rotating_light", click = SITE }) {
  try {
    const r = await fetch(`${NTFY}/${encodeURIComponent(TOPIC)}`, {
      method: "POST",
      body: message,
      signal: AbortSignal.timeout(10000),
      headers: {
        "Title": encodeHeader(title),
        "Priority": priority,
        "Tags": tags,
        "Click": click,
      },
    });
    if (!r.ok) console.error("ntfy a répondu", r.status, await r.text());
  } catch (e) { console.error("Échec envoi ntfy :", e.message); }
}
// les en-têtes HTTP n'acceptent pas les accents tels quels → encodage RFC 2047
function encodeHeader(s) {
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

// ---------- détection ----------
const STOP = new Set(["CODE","CODES","PACK","PACKS","GG","GGWP","LOL","MDR","PTDR","OK","LIVE","TWITCH","HTTP","HTTPS","WWW","COM","RLCS","LCQ","COACH","SUB","SUBS","FREE","GIL2","GIL","CARDS","LE","LA","LES","UN","UNE","DES","ET","EST","POUR","SUR","AVEC","DANS","VOICI","NOUVEAU","CHAT","VITE"]);

export function extractCodes(text) {
  const found = [];
  const re = /\bcodes?\b([^\n]{0,60})/gi;
  let m;
  while ((m = re.exec(text))) {
    const toks = m[1].match(/[A-Za-z0-9][A-Za-z0-9_\-]{2,31}/g) || [];
    const afterSep = /^\s*(?:promo\s*)?[:：=>»\-–]/i.test(m[1]);   // « code : xxx »
    for (const [i, c] of toks.slice(0, 5).entries()) {
      // un mot normal (sans chiffre, pas en MAJUSCULES) n'est un code que s'il suit directement « code : »
      if (/^[A-Za-zÀ-ÿ_\-]+$/.test(c) && c !== c.toUpperCase() && !(afterSep && i === 0)) continue;
      const U = c.toUpperCase();
      if (STOP.has(U) || /^GIL2-?CARDS?$/.test(U) || /^(PROMO|EST|IS|CEST|VOICI|NOUVEAU|DISPO|ACTIF|SUR|POUR)$/.test(U)) continue;
      if (/^[a-zà-ÿ]+$/.test(c) && c.length < 6 && !(afterSep && i === 0)) continue; // petit mot français
      found.push(c); break;
    }
  }
  (text.match(/\b[A-Z0-9][A-Z0-9_\-]{3,31}\b/g) || []).forEach(t => {
    if (STOP.has(t) || /^GIL2-?CARDS?$/.test(t)) return;
    if (/^\d+$/.test(t) || !/[A-Z]/.test(t)) return;
    found.push(t);
  });
  return [...new Set(found)];
}

function trusted(user, tags) {
  const badges = tags.badges || "";
  if (/(^|,)(broadcaster|moderator|vip)\//.test(badges)) return true;
  if (tags.mod === "1") return true;
  const u = (user || "").toLowerCase();
  return u === CHANNEL || EXTRA.includes(u);
}

const seen = new Set();
export function analyse(user, text, tags = {}, isAnnouncement = false) {
  if (!trusted(user, tags) && !isAnnouncement) return null;
  console.log(`· ${user}: ${text}`);   // trace des messages de Gil/modos/bots dans les logs
  const original = text;
  const isGil = /(^|,)broadcaster\//.test(tags.badges || "") || (user || "").toLowerCase() === CHANNEL;
  text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ").replace(/\b[\w-]+\.(?:com|fr|gg|tv|be)\b\S*/gi, " "); // on ignore les liens
  const low = text.toLowerCase();
  const hasKw = KEYWORDS.some(k => low.includes(k));
  let codes = extractCodes(text);
  if (!hasKw) codes = codes.filter(c => new RegExp("\\bcodes?\\b[^A-Za-z0-9]{0,12}" + c.replace(/-/g, "\\-"), "i").test(text));
  // Message court qui ressemble à un code posté seul (ex. « GTA6 », 'gta6', « NOEL50 !! »)
  if (isGil && codes.length === 0) {
    const words = text.trim().split(/\s+/).filter(w => /[A-Za-z0-9]/.test(w));
    if (words.length >= 1 && words.length <= 3) {
      for (const w of words) {
        const c = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9_\-]+$/g, "");
        if (c.length < 3 || c.length > 32) continue;
        const U = c.toUpperCase();
        if (STOP.has(U) || /^\d+$/.test(c) || /^\d[vV]\d$/.test(c) || /^\d{1,2}[hH]\d{0,2}$/.test(c)) continue;      // 1v1, 2v2…
        const mixed = /[A-Za-z]/.test(c) && /\d/.test(c);                          // GTA6, noel50
        const caps  = words.length === 1 && c === U && c.length >= 4 && !/(.)\1\1/.test(c); // NOEL (pas MDRRR)
        if (mixed || caps) { codes.push(c); break; }
      }
    }
  }
  const fresh = codes.filter(c => !seen.has(c.toUpperCase()));
  fresh.forEach(c => seen.add(c.toUpperCase()));
  // Tous les messages de Gil lui-même sont transférés, code détecté ou non
  if (isGil) return { user, text: original, codes: fresh.length ? fresh : codes, isGil: true };
  if (fresh.length === 0) return null;   // modos / bots : seulement s'il y a un nouveau code
  return { user, text: original, codes: fresh };
}

async function onHit(hit) {
  const main = hit.codes[0];
  console.log(`🚨 ${new Date().toISOString()} ${hit.user}: ${hit.text}  →  ${hit.codes.join(", ") || "(pas de code isolé)"}`);
  await push({
    title: main ? `Code Gil2 : ${main}` : `Gil2 dans le chat`,
    message: main ? `${main}\n\n${hit.user} : ${hit.text}` : hit.text,
    tags: main ? "rotating_light" : "speech_balloon",
  });
}

// ---------- Twitch IRC ----------
function parseTags(raw) {
  const o = {};
  raw.split(";").forEach(p => { const i = p.indexOf("="); o[p.slice(0, i)] = p.slice(i + 1); });
  return o;
}

let ws, retry = 0, stopping = false, msgCount = 0;
function connect() {
  ws = new WebSocket("wss://irc-ws.chat.twitch.tv:443");
  ws.onopen = () => {
    retry = 0;
    ws.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
    ws.send("PASS SCHMOOPIIE");
    ws.send("NICK justinfan" + Math.floor(10000 + Math.random() * 80000));
    ws.send("JOIN #" + CHANNEL);
    console.log("Connecté, salon #" + CHANNEL);
  };
  ws.onmessage = e => String(e.data).split("\r\n").filter(Boolean).forEach(handleLine);
  ws.onclose = () => {
    if (stopping) return;
    retry++; const wait = Math.min(30, 2 ** retry);
    console.log(`Déconnecté, reconnexion dans ${wait}s`);
    setTimeout(connect, wait * 1000);
  };
  ws.onerror = e => console.error("Erreur WebSocket", e.message || "");
}

function handleLine(line) {
  if (line.startsWith("PING")) { ws.send("PONG :tmi.twitch.tv"); return; }
  let tags = {}, rest = line;
  if (rest.startsWith("@")) { const sp = rest.indexOf(" "); tags = parseTags(rest.slice(1, sp)); rest = rest.slice(sp + 1); }
  const m = rest.match(/^:(\S+?)(?:!\S+)? (\S+) (#\S+)(?: :(.*))?$/);
  if (!m) return;
  const [, prefix, cmd, , text = ""] = m;
  let hit = null;
  if (cmd === "PRIVMSG") {
    msgCount++;
    let t = text; if (t.startsWith("\u0001ACTION ")) t = t.slice(8, -1);
    hit = analyse(tags["display-name"] || prefix.split("!")[0], t, tags, false);
  } else if (cmd === "USERNOTICE" && text) {
    msgCount++;
    hit = analyse(tags["display-name"] || tags.login || "annonce", text, tags, tags["msg-id"] === "announcement");
  }
  if (hit) onHit(hit);
}

// ---------- lancement ----------
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  console.log(`Radar démarré pour ${MINUTES} min sur #${CHANNEL}`);
  if (START_PING) await push({ title: "Radar Gil2 actif", message: `J'écoute le chat de ${CHANNEL} pendant ${Math.round(MINUTES / 60 * 10) / 10} h.`, priority: "min", tags: "satellite" });
  connect();
  setInterval(() => console.log(`… ${msgCount} messages lus`), 10 * 60 * 1000);
  setTimeout(() => {
    stopping = true; try { ws.close(); } catch {}
    console.log(`Fin de l'écoute (${msgCount} messages lus).`);
    process.exit(0);
  }, MINUTES * 60 * 1000);
}
