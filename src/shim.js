/* Supabase backend for the setlist: provides window.claude.use(...) with the same shape the page uses on claude.ai,
   so one page source runs both here (crew, no Claude account) and on claude.ai. */
(() => {
const SB_URL = "https://etrkbuhifhnnzbcxyekt.supabase.co";
const SB_KEY = "sb_publishable_6nPNEGdhVIBnSQFF6GO4Lg_RgN8uTiy";
const OWNER_EMAIL = "brocki.adam@gmail.com";
const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
window.__sb = sb;
const CREW_DOMAIN = "@dreamgirlz-setlista.app";

/* music is private: each file plays through a signed link valid for a few hours */
const signed = new Map();   // assetId -> {url, exp}
let signing = null;
function signMissing(force) {
  const now = Date.now();
  const ids = [...new Set([...(cache.get("versions") || new Map()).values()].map(v => v && v.assetId).filter(Boolean))]
    .filter(a => force || !signed.has(a) || signed.get(a).exp - now < 30 * 60e3);
  if (!ids.length) return signing || Promise.resolve();
  const run = (async () => {
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      const { data } = await sb.storage.from("audio").createSignedUrls(part, 6 * 3600);
      (data || []).forEach((x, j) => { const u = x && (x.signedUrl || x.signedURL); if (u) signed.set(part[j], { url: u, exp: Date.now() + 6 * 3600e3 }); });
    }
  })();
  signing = run.finally(() => { if (signing === run) signing = null; });
  return run;
}
window.__blobUrl = a => signed.get(a)?.url || (SB_URL + "/storage/v1/object/authenticated/audio/" + a);
window.__blobReady = () => signMissing(false);
setInterval(() => signMissing(false), 10 * 60e3);

const rid = () => { const a = "abcdefghijklmnopqrstuvwxyz0123456789"; let s = ""; const r = crypto.getRandomValues(new Uint8Array(20)); for (const x of r) s += a[x % a.length]; return s; };
const err = (code, message) => Object.assign(new Error(message || code), { code });

/* ---------- live cache of the docs table ---------- */
const cache = new Map();           // collection -> Map(id -> data)
const loaded = new Map();          // collection -> Promise
const colSubs = new Map();         // collection -> Set(fn)
const docSubs = new Map();         // "c/id" -> Set(fn)
const snapOf = c => ({ docs: [...(cache.get(c) || new Map()).entries()].map(([id, d]) => ({ id, data: () => d })) });
const fireCol = c => (colSubs.get(c) || []).forEach(f => { try { f(snapOf(c)); } catch (e) { console.error(e); } });
const fireDoc = (c, id) => { const d = cache.get(c)?.get(id); (docSubs.get(c + "/" + id) || []).forEach(f => { try { f({ exists: !!d, id, data: () => d || {} }); } catch (e) { console.error(e); } }); };
const putLocal = (c, id, d) => { if (!cache.has(c)) cache.set(c, new Map()); if (d) cache.get(c).set(id, d); else cache.get(c).delete(id); if (c === "versions") signMissing(false); fireCol(c); fireDoc(c, id); };

function load(c) {
  if (loaded.has(c)) return loaded.get(c);
  const p = (async () => {
    const all = new Map(); let from = 0;
    for (;;) {
      const { data, error } = await sb.from("docs").select("id,data").eq("collection", c).range(from, from + 999);
      if (error) throw err("load_failed", error.message);
      data.forEach(r => all.set(r.id, r.data)); if (data.length < 1000) break; from += 1000;
    }
    cache.set(c, all);
    if (c === "versions") await signMissing(false);
  })();
  loaded.set(c, p); return p;
}
let live = null, liveState = "connecting";
function startLive() {
  if (live) return;
  live = sb.channel("docs-live").on("postgres_changes", { event: "*", schema: "public", table: "docs" }, ev => {
    const row = ev.eventType === "DELETE" ? ev.old : ev.new; if (!row || !row.collection) return;
    if (!loaded.has(row.collection)) return;
    putLocal(row.collection, row.id, ev.eventType === "DELETE" ? null : row.data);
  }).subscribe(st => {
    const was = liveState; liveState = st;
    // after a dropped connection, reload everything we watch so nothing is missed
    if (st === "SUBSCRIBED" && was !== "connecting" && was !== "SUBSCRIBED") { for (const c of [...loaded.keys()]) { loaded.delete(c); load(c).then(() => fireCol(c)); } }
    window.dispatchEvent(new CustomEvent("sb-live", { detail: st }));
  });
}

async function upsert(c, id, data) {
  putLocal(c, id, data);
  const { error } = await sb.from("docs").upsert({ collection: c, id, data });
  if (error) { loaded.delete(c); load(c).then(() => fireCol(c)); throw mapErr(error); }
}
async function patch(c, id, p) {
  const cur = cache.get(c)?.get(id);
  if (cur) { const n = { ...cur }; for (const [k, v] of Object.entries(p)) { if (v && typeof v === "object" && v.__delete__ === true) delete n[k]; else n[k] = v; } putLocal(c, id, n); }
  const { error } = await sb.rpc("docs_patch", { p_collection: c, p_id: id, p_patch: p });
  if (error) { loaded.delete(c); load(c).then(() => fireCol(c)); throw mapErr(error); }
}
async function remove(c, id) {
  const prev = cache.get(c)?.get(id);
  putLocal(c, id, null);
  const { error, count } = await sb.from("docs").delete({ count: "exact" }).eq("collection", c).eq("id", id);
  if (error || count === 0) { if (prev) putLocal(c, id, prev); throw err(count === 0 ? "denied" : "write_failed", error?.message || "Brak uprawnień do usunięcia."); }
}
const mapErr = e => err(/row-level security|permission/i.test(e.message || "") ? "denied" : "write_failed", e.message);

function docRef(c, id) {
  return {
    id,
    set: d => upsert(c, id, JSON.parse(JSON.stringify(d))),
    update: p => patch(c, id, JSON.parse(JSON.stringify(p))),
    delete: () => remove(c, id),
    get: async () => { await load(c); const d = cache.get(c).get(id); return { exists: !!d, id, data: () => d || {} }; },
    onSnapshot(fn, onErr) {
      const k = c + "/" + id; if (!docSubs.has(k)) docSubs.set(k, new Set()); docSubs.get(k).add(fn);
      load(c).then(() => fireDoc(c, id), e => onErr && onErr(e)); startLive();
      return () => docSubs.get(k).delete(fn);
    }
  };
}
const dbApi = {
  collection(c) {
    return {
      doc: id => docRef(c, id || rid()),
      add: async d => { const id = rid(); await upsert(c, id, JSON.parse(JSON.stringify(d))); return { id }; },
      onSnapshot(fn, onErr) {
        if (!colSubs.has(c)) colSubs.set(c, new Set()); colSubs.get(c).add(fn);
        load(c).then(() => fn(snapOf(c)), e => onErr && onErr(e)); startLive();
        return () => colSubs.get(c).delete(fn);
      }
    };
  },
  doc(path) { const [c, id] = path.split("/"); return docRef(c, id); }
};

/* ---------- who is editing ---------- */
let session = null;
const isOwner = () => (session?.user?.email || "").toLowerCase() === OWNER_EMAIL;
let localId = null; try { localId = localStorage.getItem("crewId"); if (!localId) { localId = "c_" + rid(); localStorage.setItem("crewId", localId); } } catch { localId = "c_" + rid(); }
const myId = () => isOwner() ? "owner" : localId;
const myName = () => { try { return localStorage.getItem("crewName") || ""; } catch { return ""; } };
const userApi = {
  id: async () => myId(),
  me: async () => ({ id: myId(), name: isOwner() ? "Adam" : myName() }),
  can: async () => true,
  isOwner: () => isOwner(),
  canEdit: () => true,
  profiles: async ids => {
    await load("people");
    const out = {}; const ppl = cache.get("people");
    for (const id of ids) {
      if (id === myId()) { out[id] = { id, name: isOwner() ? "Adam" : (myName() || "Ty"), isMe: true }; continue; }
      const p = ppl.get(id); out[id] = { id, name: p?.name || (id === "owner" ? "Adam" : ""), isMe: false };
    }
    return out;
  }
};

/* ---------- music files: only the owner uploads ---------- */
const assetsApi = {
  upload: async (blob, opts = {}) => {
    if (!isOwner()) throw err("not_granted");
    const type = opts.type || blob.type || "application/octet-stream";
    const ext = /mp4/.test(type) ? "mp4" : /webm/.test(type) ? "webm" : /mpeg|mp3/.test(type) ? "mp3" : "bin";
    const id = rid() + "." + ext;
    const { error } = await sb.storage.from("audio").upload(id, blob, { contentType: type, upsert: false });
    if (error) throw err(/too large|exceed/i.test(error.message) ? "too_large" : "upload_failed", error.message);
    const { data: su } = await sb.storage.from("audio").createSignedUrl(id, 6 * 3600);
    if (su?.signedUrl) signed.set(id, { url: su.signedUrl, exp: Date.now() + 6 * 3600e3 });
    return { id, url: window.__blobUrl(id), sizeBytes: blob.size, contentType: type };
  },
  delete: async id => { if (!isOwner()) throw err("not_granted"); await sb.storage.from("audio").remove([id]); },
  list: async () => ({ assets: [], usage: {} })
};
const downloadsApi = {
  save: async ({ filename, data }) => { const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data])); const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000); }
};

/* nothing loads until someone signs in: the crew with the shared password, Adam with his own */
const ready = sb.auth.getSession().then(async r => {
  session = r.data.session;
  if (!session) await gate();
  document.documentElement.classList.toggle("crew-guest", !isOwner());
});
function gate() {
  return new Promise(done => {
    const show = () => {
      const m = document.createElement("div"); m.className = "crew-modal crew-gate";
      m.innerHTML = `<form class="crew-card"><h3>DREAM GIRLZ · setlista</h3><p class="hint">Wpisz login i hasło ekipy.</p>
        <input class="in" name="u" type="text" placeholder="Użytkownik" autocomplete="username" autocapitalize="off" spellcheck="false" required>
        <input class="in" name="p" type="password" placeholder="Hasło" autocomplete="current-password" required>
        <div class="crew-row"><button type="button" class="btn ghost" data-own>Jestem Adamem (muzyka)</button><button class="btn primary">Wejdź</button></div><p class="crew-msg"></p></form>`;
      document.body.append(m);
      const f = m.querySelector("form"), msg = m.querySelector(".crew-msg");
      setTimeout(() => f.u.focus(), 30);
      m.querySelector("[data-own]").onclick = () => { ownerLogin(); };
      f.onsubmit = async e => {
        e.preventDefault(); msg.textContent = "Sprawdzam…";
        const { data, error } = await sb.auth.signInWithPassword({ email: f.u.value.trim().toLowerCase().replace(/[^a-z0-9._-]/g,"") + CREW_DOMAIN, password: f.p.value });
        if (error) { msg.textContent = "Zły login lub hasło."; return; }
        session = data.session; m.remove(); done();
      };
    };
    if (document.body) show(); else document.addEventListener("DOMContentLoaded", show);
  });
}
sb.auth.onAuthStateChange((ev, s) => { const was = isOwner(); session = s; if (isOwner() !== was || ev === "SIGNED_OUT") location.reload(); });

window.claude = {
  use: async name => {
    await ready;
    if (name === "db") return dbApi;
    if (name === "user") return userApi;
    if (name === "assets") return isOwner() ? assetsApi : null;
    if (name === "downloads") return downloadsApi;
    return null;   // mcp (Drive), permissions, comments: not available outside claude.ai
  }
};

/* ---------- small header controls: your name for notes, owner login for music ---------- */
function ui() {
  const host = document.querySelector(".top .stats"); if (!host) return;
  const box = document.createElement("div"); box.className = "crew-box"; host.prepend(box);
  const live = document.createElement("span"); live.className = "crew-live"; live.title = "Połączenie na żywo z bazą";
  const setLive = st => { const ok = st === "SUBSCRIBED"; live.classList.toggle("ok", ok); live.title = ok ? "Na żywo: zmiany innych pojawiają się od razu" : "Łączę się… (zmiany zapiszą się, ale cudze mogą dojść z opóźnieniem)"; };
  setLive(liveState);
  window.addEventListener("sb-live", e => { const ok = e.detail === "SUBSCRIBED"; live.classList.toggle("ok", ok); live.title = ok ? "Na żywo: zmiany innych pojawiają się od razu" : "Łączę się… (zmiany zapiszą się, ale cudze mogą dojść z opóźnieniem)"; });
  const render = () => {
    box.innerHTML = "";
    box.append(live);
    const who = document.createElement("button"); who.className = "crew-btn";
    if (isOwner()) { who.textContent = "Adam · wyloguj"; who.title = "Zalogowany: możesz wgrywać muzykę i trwale usuwać"; who.onclick = async () => { await sb.auth.signOut(); }; }
    else { who.textContent = myName() ? "✎ " + myName() : "✎ Podpisz się"; who.title = "Twoje imię przy notatkach i uwagach"; who.onclick = askName; }
    box.append(who);
    if (!isOwner()) { const lg = document.createElement("button"); lg.className = "crew-btn ghost"; lg.textContent = "Muzyka ↪"; lg.title = "Logowanie dla osoby, która wgrywa nagrania"; lg.onclick = ownerLogin; box.append(lg); }
  };
  render();
  if (!isOwner() && !myName()) setTimeout(askName, 600);
}
function modal(html, onOk) {
  const m = document.createElement("div"); m.className = "crew-modal"; m.style.zIndex = 210; m.innerHTML = `<form class="crew-card">${html}<div class="crew-row"><button type="button" class="btn ghost" data-x>Anuluj</button><button class="btn primary">OK</button></div><p class="crew-msg"></p></form>`;
  document.body.append(m);
  const f = m.querySelector("form"), msg = m.querySelector(".crew-msg");
  m.querySelector("[data-x]").onclick = () => m.remove();
  f.onsubmit = async e => { e.preventDefault(); const r = await onOk(f, t => { msg.textContent = t; }); if (r !== false) m.remove(); };
  setTimeout(() => f.querySelector("input")?.focus(), 30);
}
function askName() {
  modal(`<h3>Jak się podpisać?</h3><p class="hint">Twoje imię pojawi się przy notatkach i uwagach.</p><input class="in" name="n" maxlength="30" value="${(myName() || "").replace(/"/g, "&quot;")}" placeholder="np. Kasia" required>`,
    async f => { const n = f.n.value.trim(); if (!n) return false; try { localStorage.setItem("crewName", n); } catch {} try { await dbApi.doc("people/" + localId).set({ name: n, at: Date.now() }); } catch {} document.querySelector(".crew-box")?.remove(); ui(); });
}
function ownerLogin() {
  modal(`<h3>Logowanie: muzyka</h3><p class="hint">Tylko dla osoby, która wgrywa nagrania (${OWNER_EMAIL}).</p><input class="in" name="p" type="password" placeholder="Hasło" autocomplete="current-password" required><label class="hint"><input type="checkbox" name="first"> Pierwszy raz: ustaw to hasło (przyjdzie mail z potwierdzeniem)</label>`,
    async (f, say) => {
      const password = f.p.value;
      if (f.first.checked) {
        const { error } = await sb.auth.signUp({ email: OWNER_EMAIL, password, options: { emailRedirectTo: location.origin + location.pathname } });
        if (error) { say(error.message); return false; }
        say("Wysłano mail. Kliknij link w mailu, potem wróć tu i zaloguj się tym hasłem (bez zaznaczania tego pola)."); return false;
      }
      const { error } = await sb.auth.signInWithPassword({ email: OWNER_EMAIL, password });
      if (error) { say(/confirm/i.test(error.message) ? "Najpierw kliknij link w mailu z potwierdzeniem." : "Złe hasło."); return false; }
    });
}
const css = document.createElement("style");
css.textContent = `.crew-box{display:flex;align-items:center;gap:6px}.crew-live{width:8px;height:8px;border-radius:50%;background:var(--warn,#E3A04C)}.crew-live.ok{background:var(--ok,#6CC08B)}
.crew-btn{border:1px solid var(--line);background:transparent;color:var(--fg);border-radius:999px;padding:3px 10px;font-size:12px;white-space:nowrap}.crew-btn.ghost{color:var(--muted)}.crew-btn:hover{border-color:var(--muted)}
html.crew-guest #askDelS,html.crew-guest [data-askdelv]{display:none!important}
.crew-modal.crew-gate{background:var(--bg,#1C1D20)}
.crew-modal{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:16px}.crew-card{background:var(--surface);border:1px solid var(--line);border-radius:var(--r,8px);padding:20px;max-width:380px;width:100%;display:flex;flex-direction:column;gap:10px}.crew-card h3{margin:0;font-size:18px}.crew-card p{margin:0}.crew-row{display:flex;justify-content:flex-end;gap:8px}.crew-msg{font-size:13px;color:var(--warn,#E3A04C)}`;
document.head.append(css);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => ready.then(ui)); else ready.then(ui);
})();
