// Radar à codes Gil2 – écoute le chat Twitch (lecture seule, anonyme)
// et envoie chaque nouveau code sur ton téléphone via ntfy.
// Aucune dépendance : nécessite Node 22+ (WebSocket intégré).

const CHANNELS  = (process.env.CHANNELS || process.env.CHANNEL || "gil2_, edouardotv")
                    .toLowerCase().split(",").map(s => s.trim().replace(/^#/, "")).filter(Boolean);
// jolis noms pour les notifications
const NAMES = { "gil2_": "Gil2", "edouardotv": "Edouardo" };
const nameOf = ch => NAMES[ch] || ch;
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
// Emotes très courantes (BTTV/7TV/FFZ) qui ne sont pas signalées par Twitch dans le message
["LUL","LULW","KEKW","OMEGALUL","POG","POGU","POGGERS","POGCHAMP","PEPEGA","MONKAS","SADGE","COPIUM","HOPIUM","AYAYA","EZ","EZCLAP","GIGACHAD","CLAP","KAPPA","PEPELAUGH","WIDEPEEPOHAPPY","CATJAM","NOWAY","BASED","MALDING","PEEPOHAPPY","DANSGAME","KEKL"].forEach(e => STOP.add(e));

// Twitch indique les emotes natives/sub dans le tag `emotes` (id:début-fin,...). On les efface du texte.
function stripEmotes(text, emotesTag) {
  if (!emotesTag) return text;
  const chars = Array.from(text);   // indices en points de code, comme Twitch
  emotesTag.split("/").forEach(part => {
    const i = part.indexOf(":"); if (i === -1) return;
    part.slice(i + 1).split(",").forEach(r => {
      const [a, b] = r.split("-").map(Number);
      if (Number.isInteger(a) && Number.isInteger(b)) for (let k = a; k <= b && k < chars.length; k++) chars[k] = " ";
    });
  });
  return chars.join("");
}

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
  return CHANNELS.includes(u) || EXTRA.includes(u);
}

const seen = new Set();
export function analyse(user, text, tags = {}, isAnnouncement = false) {
  if (!trusted(user, tags) && !isAnnouncement) return null;
  console.log(`· ${user}: ${text}`);   // trace des messages de Gil/modos/bots dans les logs
  const original = text;
  const uName = (user || "").toLowerCase();
  // isOwner  = propriétaire du chat en cours (badge streamer) → on transfère TOUS ses messages.
  // isStreamer = Gil ou Edouardo, dans n'importe quel chat → on détecte même un code posté seul,
  //              mais on ne transfère pas son bavardage s'il n'est pas chez lui.
  const isOwner = /(^|,)broadcaster\//.test(tags.badges || "");
  const isStreamer = isOwner || CHANNELS.includes(uName);
  text = stripEmotes(text, tags.emotes);   // on efface les emotes natives/sub signalées par Twitch
  text = text.replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ").replace(/\b[\w-]+\.(?:com|fr|gg|tv|be)\b\S*/gi, " "); // on ignore les liens
  const low = text.toLowerCase();
  const hasKw = KEYWORDS.some(k => low.includes(k));
  let codes = extractCodes(text);
  if (!hasKw) codes = codes.filter(c => new RegExp("\\bcodes?\\b[^A-Za-z0-9]{0,12}" + c.replace(/-/g, "\\-"), "i").test(text));
  // Message court d'un streamer qui ressemble à un ou plusieurs codes bruts
  // Ex. « GTA6 », 'gta6', « NOEL50 !! », « EDOUARDOGOAT / MIAMIGOAT »
  if (isStreamer && codes.length === 0) {
    // on coupe aussi sur / , | pour gérer plusieurs codes dans un même message
    const tokens = text.split(/[\s/,|]+/).filter(w => /[A-Za-z0-9]/.test(w));
    if (tokens.length >= 1 && tokens.length <= 4) {
      for (const w of tokens) {
        const c = w.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9_\-]+$/g, "");
        if (c.length < 3 || c.length > 32) continue;
        const U = c.toUpperCase();
        if (STOP.has(U) || /^\d+$/.test(c) || /^\d[vV]\d$/.test(c) || /^\d{1,2}[hH]\d{0,2}$/.test(c)) continue;      // 1v1, 2v2, 17h…
        const mixed = /[A-Za-z]/.test(c) && /\d/.test(c);               // GTA6, noel50
        const caps  = c === U && c.length >= 4 && !/(.)\1\1/.test(c);   // EDOUARDOGOAT, NOEL (pas MDRRR)
        if (mixed || caps) codes.push(c);                               // on garde TOUS les codes trouvés
      }
    }
  }
  const fresh = codes.filter(c => !seen.has(c.toUpperCase()));
  fresh.forEach(c => seen.add(c.toUpperCase()));
  // Le propriétaire du chat : tous ses messages sont transférés, code détecté ou non
  if (isOwner) return { user, text: original, codes: fresh.length ? fresh : codes, isGil: true };
  if (fresh.length === 0) return null;   // streamers invités / modos / bots : seulement s'il y a un nouveau code
  return { user, text: original, codes: fresh };
}

async function onHit(hit) {
  const codes = hit.codes || [];
  const label = codes.length > 1 ? "Codes" : "Code";
  const joined = codes.join("   ");
  console.log(`🚨 ${new Date().toISOString()} ${hit.user}: ${hit.text}  →  ${codes.join(", ") || "(pas de code isolé)"}`);
  await push({
    title: codes.length ? `🚨 ${label} : ${joined}` : `💬 ${hit.user} dans le chat`,
    message: codes.length ? `${joined}\n\n${hit.user} : ${hit.text}` : `${hit.user} : ${hit.text}`,
    tags: codes.length ? "rotating_light" : "speech_balloon",
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
    CHANNELS.forEach(ch => ws.send("JOIN #" + ch));
    console.log("Connecté, salons : " + CHANNELS.map(c => "#" + c).join(", "));
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

// ---------- qui est en live ? ----------
// Pour une chaîne : true = en live, false = hors ligne, null = impossible de savoir
async function isLiveOne(channel) {
  // 1) API publique utilisée par le site Twitch lui-même
  try {
    const r = await fetch("https://gql.twitch.tv/gql", {
      method: "POST",
      headers: { "Client-Id": "kimne78kx3ncx6brgo4mv6wki5h1ko", "Content-Type": "application/json" },
      body: JSON.stringify({ query: `query{user(login:"${channel}"){stream{id}}}` }),
      signal: AbortSignal.timeout(10000),
    });
    if (r.ok) {
      const j = await r.json();
      if (j?.data?.user !== undefined) return !!j.data.user?.stream;
    }
  } catch {}
  // 2) Secours : decapi.me
  try {
    const r = await fetch(`https://decapi.me/twitch/uptime/${channel}`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) { const t = (await r.text()).toLowerCase(); if (t.includes("offline")) return false; if (/\d/.test(t)) return true; }
  } catch {}
  return null;
}

// Toutes les chaînes : { live: [chaînes en live], known: au moins une réponse obtenue }
async function liveChannels() {
  const live = [];
  let known = false;
  for (const ch of CHANNELS) {
    const s = await isLiveOne(ch);
    if (s !== null) known = true;
    if (s === true) live.push(ch);
  }
  return { live, known };
}

// ---------- lancement ----------
// MODE=auto  : vérifie le live, n'écoute que s'il est en live, s'arrête à la fin du live
// MODE=manual: écoute pendant DURATION_MINUTES quoi qu'il arrive
const MODE = process.env.MODE || "manual";
function stop(reason) {
  stopping = true; try { ws.close(); } catch {}
  console.log(`Fin de l'écoute : ${reason} (${msgCount} messages lus).`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  if (MODE === "auto") {
    // Vérifications planifiées : seulement dans la plage horaire choisie (heure de Bruxelles)
    if (process.env.EVENT === "schedule" && process.env.HOURS) {
      const [from, to] = process.env.HOURS.split("-").map(Number);
      const h = parseInt(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Brussels", hour: "numeric", hourCycle: "h23" }).format(new Date()), 10);
      if (h < from || h >= to) { console.log(`Il est ${h}h à Bruxelles, hors de la plage ${from}h-${to}h : rien à faire.`); process.exit(0); }
    }
    const { live, known } = await liveChannels();
    if (live.length === 0) { console.log(known ? "Personne en live, rien à faire." : "Statut des lives inconnu, on réessaiera dans 10 min."); process.exit(0); }
    const names = live.map(nameOf).join(" et ");
    console.log(`🔴 En live : ${names} — radar lancé (max ${MINUTES} min)`);
    await push({ title: `🔴 ${names} en live`, message: "Le radar écoute le chat, tu seras prévenu dès qu'un code tombe.", priority: "high", tags: "red_circle", click: `https://www.twitch.tv/${live[0]}` });
    // s'arrête après ~12 min sans personne en live (évite de couper sur une petite coupure du stream)
    let offlineChecks = 0;
    setInterval(async () => {
      const r = await liveChannels();
      offlineChecks = (r.known && r.live.length === 0) ? offlineChecks + 1 : 0;
      if (offlineChecks >= 4) stop("plus personne en live");
    }, 3 * 60 * 1000);
  } else {
    console.log(`Radar démarré pour ${MINUTES} min sur ${CHANNELS.map(c => "#" + c).join(", ")}`);
    if (START_PING) await push({ title: "Radar actif", message: `J'écoute ${CHANNELS.map(nameOf).join(" et ")} pendant ${Math.round(MINUTES / 60 * 10) / 10} h.`, priority: "min", tags: "satellite" });
  }
  connect();
  setInterval(() => console.log(`… ${msgCount} messages lus`), 10 * 60 * 1000);
  setTimeout(() => stop("durée maximale atteinte"), MINUTES * 60 * 1000);
}
