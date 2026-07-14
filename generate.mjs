#!/usr/bin/env node
/**
 * Gera data.json do Painel de Leads FG a partir da API DigiSac.
 * Uso: DIGISAC_TOKEN=xxxx node generate.mjs
 * O token NUNCA vai para o repositório — fica em variável de ambiente / GitHub Secret.
 * Somente leitura. Telefones mascarados (LGPD).
 */
import { writeFileSync } from "node:fs";

const BASE = process.env.DIGISAC_BASE_URL || "https://fernandagehmadvogados.digisac.co/api/v1";
const TOKEN = process.env.DIGISAC_TOKEN;
if (!TOKEN) { console.error("Defina DIGISAC_TOKEN"); process.exit(1); }
const SLA_MIN = Number(process.env.SLA_MIN || 15);
const UA = "painel-fg-web/1.0";
const TZ = "America/Sao_Paulo";

async function api(path, params = {}) {
  const qs = new URLSearchParams(); for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const url = `${BASE}${path}?${qs}`;
  for (let a = 0; a < 4; a++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": UA, Accept: "application/json" } });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 4000 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} em ${path}`);
    return r.json();
  }
  throw new Error(`falha em ${path}`);
}
const rows = r => (r?.data ?? []);
const mask = n => { const s = String(n || "").replace(/\D/g, ""); return s.length < 7 ? s : s.slice(0, 4) + "*****" + s.slice(-3); };
const spParts = d => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
function spHourDow(d) { const p = spParts(d); const h = +p.find(x => x.type === "hour").value; const wd = p.find(x => x.type === "weekday").value; const biz = !/sáb|dom/i.test(wd) && h >= 8 && h < 19; return { h, biz }; }
const hhmm = d => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
// pseudonimiza: "ANA PAULA GRACA x BRADESCO" -> "A.P.G x BRADESCO" (iniciais do cliente, mantém a parte adversa)
const initials = name => {
  if (!name) return "—";
  const parts = String(name).split(/\s+[x×]\s+/i);
  const cli = (parts[0] || name).trim().split(/\s+/).filter(w => /[0-9A-Za-zÀ-ÿ]/.test(w)).map(w => w[0].toUpperCase()).join(".");
  const resto = parts.length > 1 ? " x " + parts.slice(1).join(" x ") : "";
  return (cli || "—") + resto;
};
function todaySP() { const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); return p; }
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10; };
const AREAS = [["Previdenciario", /\b(inss|aposentad|bpc|loas|aux[ií]lio|benef[ií]cio|previdenc)\b/i], ["Trabalhista", /(trabalh|resc|horas?\s+extra|ass[eé]dio|demiss|carteira|fgts|insalubr|periculos|justa\s+causa|v[ií]nculo|doen[çc]a)/i]];
const areaOf = t => (AREAS.find(([, re]) => re.test(t || "")) || [null])[0] || "Nao identificada";

async function main() {
  const today = todaySP();
  const users = {}; for (const u of rows(await api("/users", { perPage: 100 }))) users[u.id] = u.name;
  // leads de hoje
  let leads = [], page = 1, last = 1;
  do { const r = await api("/contacts", { perPage: 500, page, "where[isGroup]": false, "where[hadChat]": true, "where[createdAt][$gte]": `${today}T00:00:00.000Z` }); leads.push(...rows(r)); last = r.lastPage || 1; page++; } while (page <= last && page <= 6);
  const recs = leads.map(c => ({ c, firstUser: null, uid: null, ad: null, texts: [] }));
  for (let i = 0; i < recs.length; i += 20) {
    const batch = recs.slice(i, i + 20); const where = {}; batch.forEach((r, j) => where[`where[contactId][$in][${j}]`] = r.c.id);
    let mp = 1, ml = 1;
    do {
      const r = await api("/messages", { perPage: 500, page: mp, "order[0][0]": "timestamp", "order[0][1]": "ASC", ...where });
      for (const m of rows(r)) {
        if (m.type === "ticket") continue;
        const rec = recs.find(x => x.c.id === m.contactId); if (!rec) continue;
        if (m.origin === "user") { const ts = Date.parse(m.timestamp); if (!rec.firstUser || ts < rec.firstUser) { rec.firstUser = ts; rec.uid = m.userId; } }
        else if (!m.isFromMe && !m.isFromBot) { if (m.text && rec.texts.length < 4) rec.texts.push(m.text); const cw = m.data?.ctwaContext?.sourceUrl; if (cw && !rec.ad) rec.ad = cw.replace(/^https?:\/\//, ""); }
      }
      ml = r.lastPage || 1; mp++;
    } while (mp <= ml && mp <= 3);
  }
  const L = recs.map(r => {
    const created = Date.parse(r.c.createdAt); const { biz } = spHourDow(new Date(created));
    const wait = r.firstUser ? Math.round((r.firstUser - created) / 6000) / 10 : null;
    let status = !r.firstUser ? "SEM_RESPOSTA" : (!biz ? "FORA_HORARIO" : (wait <= SLA_MIN ? "NO_SLA" : "FORA_SLA"));
    return { nome: r.c.name || "(sem nome)", tel: mask(r.c.data?.number || r.c.number), criado: hhmm(new Date(created)), atendente: r.uid ? (users[r.uid] || "—") : "—", espera_min: wait, status, origem: r.ad ? "Anuncio" : "Direto/Indicacao", criativo: r.ad, area: areaOf(r.texts.join(" ")) };
  });
  const per = {}, waits = [];
  for (const l of L) { if (l.atendente !== "—") { (per[l.atendente] ??= { leads: 0, waits: [] }).leads++; if (l.espera_min != null && l.status !== "FORA_HORARIO") per[l.atendente].waits.push(l.espera_min); } if (l.espera_min != null && l.status !== "FORA_HORARIO") waits.push(l.espera_min); }
  const cnt = s => L.filter(l => l.status === s).length;
  const nosla = cnt("NO_SLA"), fora = cnt("FORA_SLA"), sem = cnt("SEM_RESPOSTA"), offh = cnt("FORA_HORARIO"), resp = nosla + fora;
  const crit = {}; L.forEach(l => { if (l.criativo) crit[l.criativo] = (crit[l.criativo] || 0) + 1; });
  const areas = {}; L.forEach(l => areas[l.area] = (areas[l.area] || 0) + 1);

  // ---- Jurídico: grupos de processo (últimos 7 dias) ----
  const GDAYS = Number(process.env.GRUPO_DIAS || 7);
  const gFromMs = Date.parse(`${today}T00:00:00.000Z`) - (GDAYS - 1) * 864e5;
  const gFromISO = new Date(gFromMs).toISOString();
  let grupos = [], gpg = 1, glast = 1;
  do { const r = await api("/contacts", { perPage: 500, page: gpg, "where[isGroup]": true, "where[hadChat]": true }); grupos.push(...rows(r)); glast = r.lastPage || 1; gpg++; } while (gpg <= glast && gpg <= 5);
  const gAtivos = grupos.filter(g => g.lastMessageAt && Date.parse(g.lastMessageAt) >= gFromMs)
    .sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)).slice(0, 400);
  const gturns = []; const gUnanswered = [];
  for (let i = 0; i < gAtivos.length; i += 20) {
    const lote = gAtivos.slice(i, i + 20); const where = {}; lote.forEach((g, j) => where[`where[contactId][$in][${j}]`] = g.id);
    const byId = {}; lote.forEach(g => byId[g.id] = []);
    let mp = 1, ml = 1;
    do { const r = await api("/messages", { perPage: 500, page: mp, "order[0][0]": "timestamp", "order[0][1]": "ASC", "where[timestamp][$gte]": gFromISO, ...where });
      for (const m of rows(r)) { if (m.type === "ticket") continue; if (byId[m.contactId]) byId[m.contactId].push(m); } ml = r.lastPage || 1; mp++; } while (mp <= ml && mp <= 3);
    for (const g of lote) {
      const ms = byId[g.id].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)); let awaiting = null;
      for (const m of ms) {
        const cli = (m.origin !== "user" && !m.isFromMe && !m.isFromBot);
        if (cli) { if (awaiting == null) awaiting = Date.parse(m.timestamp); }
        else if (m.origin === "user" && awaiting != null) { gturns.push({ min: Math.round((Date.parse(m.timestamp) - awaiting) / 6000) / 10, uid: m.userId }); awaiting = null; }
      }
      if (awaiting != null) { gturns.push({ min: null, uid: null }); gUnanswered.push({ grupo: initials(g.name), desde: hhmm(new Date(awaiting)) }); }
    }
  }
  const gResp = gturns.filter(t => t.min != null);
  const gPer = {}; gResp.forEach(t => { const n = users[t.uid] || "—"; (gPer[n] ??= []).push(t.min); });
  const juridico = {
    dias: GDAYS, grupos_ativos: gAtivos.length, turnos: gturns.length, respondidos: gResp.length,
    sem_resposta: gturns.length - gResp.length, sem_resposta_grupos: gUnanswered.length,
    mediana_min: median(gResp.map(t => t.min)),
    atendentes: Object.entries(gPer).map(([nome, a]) => ({ nome, respostas: a.length, mediana_min: median(a) })).sort((x, y) => y.respostas - x.respostas),
    sem_resposta_lista: gUnanswered,
  };

  const out = {
    gerado_em: new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(new Date()),
    data_ref: new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, dateStyle: "short" }).format(new Date()), sla_min: SLA_MIN,
    kpi: { total: L.length, no_sla: nosla, fora_sla: fora, sem_resposta: sem, fora_horario: offh, pct_sla: resp ? Math.round(100 * nosla / resp) : 0, mediana_geral: median(waits) },
    atendentes: Object.entries(per).map(([nome, v]) => ({ nome, leads: v.leads, mediana_min: median(v.waits) })).sort((a, b) => b.leads - a.leads),
    origem: { Anuncio: L.filter(l => l.origem === "Anuncio").length, "Direto/Indicacao": L.filter(l => l.origem !== "Anuncio").length },
    criativos: Object.entries(crit).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([url, leads]) => ({ url, leads })),
    areas,
    sem_resposta_lista: L.filter(l => l.status === "SEM_RESPOSTA").map(l => ({ nome: l.nome, tel: l.tel, criado: l.criado, area: l.area })),
    fora_sla_lista: L.filter(l => l.status === "FORA_SLA").map(l => ({ nome: l.nome, tel: l.tel, criado: l.criado, espera_min: l.espera_min, atendente: l.atendente })),
    juridico,
    leads: L,
  };
  writeFileSync(new URL("./data.json", import.meta.url), JSON.stringify(out, null, 1));
  console.log(`OK: ${L.length} leads | ${nosla} no SLA | ${fora} fora | ${sem} sem resposta | grupos ${juridico.grupos_ativos} med ${juridico.mediana_min} semResp ${juridico.sem_resposta}`);
}
main().catch(e => { console.error(e); process.exit(1); });
