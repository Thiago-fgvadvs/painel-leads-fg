#!/usr/bin/env node
/**
 * Relatório Semanal de Leads FG — gera report.html (para virar PDF).
 * Uso: DIGISAC_TOKEN=xxx FROM=2026-07-06 TO=2026-07-13 node relatorio_semanal.mjs
 * Somente leitura. Saída: ./report.html
 * PDF é privado (Google Drive) → pode conter nomes/telefones completos.
 */
import { writeFileSync } from "node:fs";
const BASE = process.env.DIGISAC_BASE_URL || "https://fernandagehmadvogados.digisac.co/api/v1";
const TOKEN = process.env.DIGISAC_TOKEN; if (!TOKEN) { console.error("DIGISAC_TOKEN ausente"); process.exit(1); }
const TZ = "America/Sao_Paulo", SLA = 15, UA = "relatorio-fg/1.0";
const FROM = process.env.FROM || "2026-07-06", TO = process.env.TO || "2026-07-13";
const COMERCIAL = "e01ba077-d285-445f-bf20-1c3966960d71", JURIDICO = "7a981014-e9d7-4b73-b1d0-d3cc609bdc0d";

async function api(path, params = {}) {
  const qs = new URLSearchParams(); for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const url = `${BASE}${path}?${qs}`;
  for (let a = 0; a < 5; a++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}`, "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(60000) });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 3000 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${path}`); return r.json();
  } throw new Error("falha " + path);
}
const rows = r => (r?.data ?? []);
const cnt = async (p, q) => Number((await api(p, { perPage: 1, ...q }))?.total || 0);
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10; };
const minLabel = m => m == null ? "—" : (m < 60 ? m + " min" : (m / 60).toFixed(1).replace(".", ",") + " h");
const mask = n => { const s = String(n || "").replace(/\D/g, ""); return s.length < 7 ? s : s.slice(0, 4) + "*****" + s.slice(-3); };
const diaMes = d => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, day: "2-digit", month: "2-digit" }).format(d);
const hhmm = d => new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
function biz(ts) { const p = new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, weekday: "short", hour: "2-digit", hour12: false }).formatToParts(new Date(ts)); const h = +p.find(x => x.type === "hour").value, wd = p.find(x => x.type === "weekday").value; return !/sáb|dom/i.test(wd) && h >= 8 && h < 19; }
const AREAS = [["Previdenciário", /\b(inss|aposentad|bpc|loas|aux[ií]lio|benef[ií]cio|previdenc)\b/i], ["Trabalhista", /(trabalh|resc|horas?\s+extra|ass[eé]dio|demiss|carteira|fgts|insalubr|periculos|justa\s+causa|v[ií]nculo|doen[çc]a)/i], ["Cível", /(indeniz|consumidor|banc|im[óo]vel|aluguel|div[óo]rcio|fam[ií]lia|heran[çc]a|contrato|c[íi]vel)/i]];
const areaOf = t => (AREAS.find(([, re]) => re.test(t || "")) || [null])[0] || "Não identificada";

async function main() {
  const fromISO = `${FROM}T00:00:00.000Z`, toISO = `${TO}T23:59:59.999Z`;
  const users = {}; for (const u of rows(await api("/users", { perPage: 100 }))) users[u.id] = u.name;

  // 1) Volume + evolução mensal
  const totalPeriodo = await cnt("/contacts", { "where[isGroup]": false, "where[hadChat]": true, "where[createdAt][$gte]": fromISO, "where[createdAt][$lte]": toISO });
  const mesLabels = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
  const now = new Date(); const meses = [];
  for (let m = 0; m <= now.getMonth(); m++) { const s = new Date(Date.UTC(2026, m, 1)), e = new Date(Date.UTC(2026, m + 1, 0)); meses.push({ lab: mesLabels[m], from: s.toISOString(), to: e.toISOString() }); }
  const mesVals = []; for (const mm of meses) mesVals.push(await cnt("/contacts", { "where[isGroup]": false, "where[hadChat]": true, "where[createdAt][$gte]": mm.from, "where[createdAt][$lte]": mm.to }));

  // 2) Funil + tickets
  const contatosCriados = await cnt("/contacts", { "where[isGroup]": false, "where[createdAt][$gte]": fromISO, "where[createdAt][$lte]": toISO });
  const ticketsPeriodo = await cnt("/tickets", { "where[createdAt][$gte]": fromISO, "where[createdAt][$lte]": toISO });
  const ticketsAbertos = await cnt("/tickets", { "where[isOpen]": true });

  // 3) Scan dos leads do período (SLA, atendente comercial, origem, área, pendência)
  let leads = [], p = 1, l = 1;
  do { const r = await api("/contacts", { perPage: 500, page: p, "where[isGroup]": false, "where[hadChat]": true, "where[createdAt][$gte]": fromISO, "where[createdAt][$lte]": toISO }); leads.push(...rows(r)); l = r.lastPage || 1; p++; } while (p <= l && p <= 3);
  const amostraLeads = leads.slice(0, 400);
  const recs = amostraLeads.map(c => ({ c, fc: Date.parse(c.createdAt), fu: null, uid: null, ad: null, texts: [], lastMsg: null }));
  for (let i = 0; i < recs.length; i += 20) {
    const lote = recs.slice(i, i + 20); const where = {}; lote.forEach((r, j) => where[`where[contactId][$in][${j}]`] = r.c.id);
    let mp = 1, ml = 1;
    do { const r = await api("/messages", { perPage: 500, page: mp, "order[0][0]": "timestamp", "order[0][1]": "ASC", ...where }); for (const m of rows(r)) { if (m.type === "ticket") continue; const rc = recs.find(x => x.c.id === m.contactId); if (!rc) continue; if (m.origin === "user") { const t = Date.parse(m.timestamp); if (!rc.fu || t < rc.fu) { rc.fu = t; rc.uid = m.userId; } } else if (!m.isFromMe && !m.isFromBot) { if (m.text && rc.texts.length < 4) rc.texts.push(m.text); if (m.text) rc.lastMsg = m.text; const cw = m.data?.ctwaContext?.sourceUrl; if (cw && !rc.ad) rc.ad = cw.replace(/^https?:\/\//, ""); } } ml = r.lastPage || 1; mp++; } while (mp <= ml && mp <= 2);
  }
  const waits = [], perAt = {}, crit = {}, areas = {}, pendLeads = []; let anuncio = 0, sem = 0, nosla = 0, fora = 0, offh = 0;
  for (const r of recs) {
    const area = areaOf(r.texts.join(" ")); areas[area] = (areas[area] || 0) + 1;
    if (r.ad) { anuncio++; crit[r.ad] = (crit[r.ad] || 0) + 1; }
    if (r.fu == null) { sem++; pendLeads.push({ nome: r.c.name || "(sem nome)", tel: r.c.data?.number || r.c.number, dia: diaMes(new Date(r.fc)), ts: r.fc, msg: (r.lastMsg || "(mídia/sem texto)").slice(0, 90) }); }
    else { const w = Math.round((r.fu - r.fc) / 6000) / 10; const nome = users[r.uid] || "—"; (perAt[nome] ??= { n: 0, w: [] }).n++; if (biz(r.fc)) { waits.push(w); perAt[nome].w.push(w); if (w <= SLA) nosla++; else fora++; } else offh++; }
  }
  pendLeads.sort((a, b) => a.ts - b.ts);
  const resp = nosla + fora;
  const atendComercial = Object.entries(perAt).map(([nome, v]) => ({ nome, leads: v.n, med: med(v.w) })).sort((a, b) => b.leads - a.leads);
  const criativos = Object.entries(crit).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // 4) Jurídico — grupos (todos os ativos no período)
  let grupos = [], gp = 1, gl = 1;
  do { const r = await api("/contacts", { perPage: 500, page: gp, "where[isGroup]": true, "where[hadChat]": true }); grupos.push(...rows(r)); gl = r.lastPage || 1; gp++; } while (gp <= gl && gp <= 5);
  const gAtivos = grupos.filter(g => g.lastMessageAt && Date.parse(g.lastMessageAt) >= Date.parse(fromISO)).sort((a, b) => Date.parse(b.lastMessageAt) - Date.parse(a.lastMessageAt)).slice(0, 400);
  const gturns = [], gPer = {}, gPend = [];
  for (let i = 0; i < gAtivos.length; i += 20) {
    const lote = gAtivos.slice(i, i + 20); const where = {}; lote.forEach((g, j) => where[`where[contactId][$in][${j}]`] = g.id);
    const byId = {}; lote.forEach(g => byId[g.id] = { name: g.name, ms: [] });
    let mp = 1, ml = 1;
    do { const r = await api("/messages", { perPage: 500, page: mp, "order[0][0]": "timestamp", "order[0][1]": "ASC", "where[timestamp][$gte]": fromISO, ...where }); for (const m of rows(r)) { if (m.type !== "ticket" && byId[m.contactId]) byId[m.contactId].ms.push(m); } ml = r.lastPage || 1; mp++; } while (mp <= ml && mp <= 2);
    for (const g of lote) { const ms = byId[g.id].ms.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)); let aw = null, lastCli = null; for (const m of ms) { const cli = m.origin !== "user" && !m.isFromMe && !m.isFromBot; if (cli) { if (aw == null) aw = Date.parse(m.timestamp); if (m.text) lastCli = m.text; } else if (m.origin === "user" && aw != null) { const w = Math.round((Date.parse(m.timestamp) - aw) / 6000) / 10; gturns.push({ min: w, nome: users[m.userId] || "—", grupo: g.name }); const n = users[m.userId] || "—"; (gPer[n] ??= []).push(w); aw = null; lastCli = null; } } if (aw != null) gPend.push({ grupo: g.name, dia: diaMes(new Date(aw)), ts: aw, msg: (lastCli || "(mídia/sem texto)").slice(0, 80) }); }
  }
  gPend.sort((a, b) => a.ts - b.ts);
  const gAt = Object.entries(gPer).map(([nome, a]) => ({ nome, n: a.length, med: med(a) })).sort((a, b) => b.n - a.n);
  const gLentos = [...gturns].sort((a, b) => b.min - a.min).slice(0, 12);

  // 5) Conversão por tag de fechamento (pendente se não houver)
  const tags = rows(await api("/tags", { perPage: 200 }));
  const wonRe = /(contrato|assinad|fechad|convertid|ganho|cliente)/i, lostRe = /(recus|sem\s+perfil|perdid|descart)/i;
  const tagFech = tags.filter(t => wonRe.test(t.label || "") || lostRe.test(t.label || ""));
  const conversao = tagFech.length ? { modo: "tags", itens: tagFech.map(t => ({ label: t.label, n: Number(t.linkedContacts || 0), tipo: wonRe.test(t.label) ? "ganho" : "perda" })) } : { modo: "pendente" };

  // 5b) Contratos fechados (CRM · funil · status Ganho) no período — fonte de verdade do fechamento
  let wonCards = [], wp = 1, wl = 1;
  do { const r = await api("/cards", { perPage: 500, page: wp, "where[success]": "true", "where[finishedAt][$gte]": fromISO, "where[finishedAt][$lte]": toISO, "order[0][0]": "finishedAt", "order[0][1]": "DESC" }); wonCards.push(...rows(r)); wl = r.lastPage || 1; wp++; } while (wp <= wl && wp <= 5);
  const wonIds = [...new Set(wonCards.map(c => c.contactId).filter(Boolean))]; const wonNames = {};
  for (let i = 0; i < wonIds.length; i += 20) { const lote = wonIds.slice(i, i + 20); if (!lote.length) break; const where = {}; lote.forEach((id, j) => where[`where[id][$in][${j}]`] = id); for (const c of rows(await api("/contacts", { perPage: 500, ...where }))) wonNames[c.id] = c.name || "(sem nome)"; }
  const contratos = wonCards.filter(c => c.finishedAt).map(c => ({ vendedor: users[c.ownerId] || "—", cliente: wonNames[c.contactId] || "(sem nome)", ts: Date.parse(c.finishedAt), dia: diaMes(new Date(c.finishedAt)), hora: hhmm(new Date(c.finishedAt)), titulo: c.title || "", campanha: c.originCampaign || "" })).sort((a, b) => b.ts - a.ts);
  const contratosPorVend = {}; contratos.forEach(x => { contratosPorVend[x.vendedor] = (contratosPorVend[x.vendedor] || 0) + 1; });

  const dados = {
    from: FROM, to: TO, geradoEm: new Intl.DateTimeFormat("pt-BR", { timeZone: TZ, dateStyle: "short", timeStyle: "short" }).format(new Date()),
    totalPeriodo, meses: meses.map((m, i) => ({ lab: m.lab, v: mesVals[i] })),
    funil: { contatosCriados, comConversa: totalPeriodo, tickets: ticketsPeriodo, abertos: ticketsAbertos },
    amostra: recs.length, sla: { nosla, fora, sem, offh, pct: resp ? Math.round(100 * nosla / resp) : 0, mediana: med(waits) },
    atendComercial, origem: { anuncio, direto: recs.length - anuncio }, criativos, areas, pendLeads,
    juridico: { ativos: gAtivos.length, turnos: gturns.length, semResposta: gPend.length, mediana: med(gturns.map(t => t.min)), atendentes: gAt, lentos: gLentos, pend: gPend },
    conversao, contratos, contratosPorVend,
  };
  writeFileSync(new URL("./report.html", import.meta.url), render(dados));
  console.log(`OK relatório ${FROM}..${TO}: ${totalPeriodo} leads | SLA ${dados.sla.pct}% | pend leads ${pendLeads.length} | grupos ${gAtivos.length} pend ${gPend.length}`);
}

function render(d) {
  const tbl = (head, rowsArr) => `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rowsArr.join("") || `<tr><td colspan="${head.length}">—</td></tr>`}</tbody></table>`;
  const maxMes = Math.max(1, ...d.meses.map(m => m.v));
  const barMes = d.meses.map(m => `<div class="mb"><span class="ml">${m.lab}</span><span class="mbar" style="width:${Math.round(180 * m.v / maxMes)}px"></span><span class="mv">${m.v.toLocaleString("pt-BR")}</span></div>`).join("");
  const conv = d.conversao.modo === "pendente"
    ? `<p class="pend">Conversão <b>pendente</b>: ainda não há tags de fechamento no DigiSac. Assim que forem criadas (“Contrato assinado”, “Recusado”, “Sem perfil”) e aplicadas, a taxa de conversão passa a ser calculada aqui automaticamente, por canal e por atendente.</p>`
    : tbl(["Tag de fechamento", "Contatos", "Tipo"], d.conversao.itens.map(t => `<tr><td>${esc(t.label)}</td><td class="n">${t.n}</td><td>${t.tipo}</td></tr>`));
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><style>
  @page{size:A4;margin:16mm 14mm}
  *{box-sizing:border-box} body{font:12px/1.5 -apple-system,"Segoe UI",Arial,sans-serif;color:#1b2130;margin:0}
  h1{font-size:20px;color:#16233f;margin:0} h2{font-size:14px;color:#223458;border-left:4px solid #3a5a9a;padding-left:8px;margin:22px 0 8px} h3{font-size:12.5px;color:#223458;margin:14px 0 6px}
  .hd{background:linear-gradient(135deg,#16233f,#223458);color:#fff;padding:18px 20px;border-radius:8px}
  .hd .sub{color:#c9d4ea;font-size:11px;margin-top:4px}
  .kpis{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px}
  .kpi{border:1px solid #e6e9f0;border-radius:8px;padding:8px 12px;min-width:120px}
  .kpi .l{font-size:9.5px;color:#667085;text-transform:uppercase;letter-spacing:.4px} .kpi .v{font-size:20px;font-weight:700;color:#16233f}
  table{width:100%;border-collapse:collapse;font-size:11px;margin-top:6px} th,td{border-bottom:1px solid #e6e9f0;padding:5px 6px;text-align:left} th{color:#667085;font-size:9.5px;text-transform:uppercase} td.n,th.n{text-align:right}
  .mb{display:flex;align-items:center;gap:8px;margin:2px 0} .ml{width:32px;color:#667085} .mbar{height:10px;background:#3a5a9a;border-radius:3px;display:inline-block} .mv{font-variant-numeric:tabular-nums}
  .alert{background:#fff7f7;border:1px solid #f2c9ce;border-radius:8px;padding:8px 12px;color:#a3212f}
  .pend{background:#fff3e0;border:1px solid #f0d8a8;border-radius:8px;padding:8px 12px;color:#7a4a00}
  .muted{color:#667085;font-size:10px} ul{margin:6px 0 6px 18px} li{margin:3px 0}
  .foot{margin-top:16px;color:#667085;font-size:9.5px;border-top:1px solid #e6e9f0;padding-top:6px}
  .pb{page-break-before:always}
  </style></head><body>
  <div class="hd"><h1>FG Advogados Associados</h1><div>Relatório Semanal de Captação e Atendimento de Leads (WhatsApp/DigiSac)</div>
  <div class="sub">Período: ${d.from.split("-").reverse().join("/")} a ${d.to.split("-").reverse().join("/")} · Gerado em ${d.geradoEm} (BRT) · SLA de 1ª resposta: ${15} min · Confidencial</div></div>

  <h2>1. Sumário do período</h2>
  <div class="kpis">
    <div class="kpi"><div class="l">Leads recebidos</div><div class="v">${d.totalPeriodo.toLocaleString("pt-BR")}</div></div>
    <div class="kpi"><div class="l">Dentro do SLA (≤15min)</div><div class="v">${d.sla.pct}%</div></div>
    <div class="kpi"><div class="l">Sem resposta</div><div class="v">${d.sla.sem}</div></div>
    <div class="kpi"><div class="l">Mediana 1ª resposta</div><div class="v">${minLabel(d.sla.mediana)}</div></div>
    <div class="kpi"><div class="l">Grupos ativos (Jur.)</div><div class="v">${d.juridico.ativos}</div></div>
  </div>
  <p class="muted">Métricas de captação e atendimento medidas diretamente do DigiSac (amostra de ${d.amostra} leads do período). Conversão para cliente: ver seção 7.</p>

  <h2>2. Evolução mensal de leads (2026)</h2>${barMes}

  <h2>3. Funil de captação</h2>
  ${tbl(["Etapa", "Total"], [
    `<tr><td>Contatos criados</td><td class="n">${d.funil.contatosCriados}</td></tr>`,
    `<tr><td>Com conversa (leads)</td><td class="n">${d.funil.comConversa}</td></tr>`,
    `<tr><td>Atendimentos (tickets) no período</td><td class="n">${d.funil.tickets}</td></tr>`,
    `<tr><td>Em atendimento aberto agora</td><td class="n">${d.funil.abertos}</td></tr>`])}

  <h2>4. Origem dos leads</h2>
  ${tbl(["Origem", "Leads", "%"], [
    `<tr><td>Anúncio Meta (CTWA)</td><td class="n">${d.origem.anuncio}</td><td class="n">${d.amostra ? Math.round(100 * d.origem.anuncio / d.amostra) : 0}%</td></tr>`,
    `<tr><td>Direto / Indicação</td><td class="n">${d.origem.direto}</td><td class="n">${d.amostra ? Math.round(100 * d.origem.direto / d.amostra) : 0}%</td></tr>`])}
  <h3>4.1 Top criativos (anúncio Meta)</h3>
  ${tbl(["Criativo (sourceUrl)", "Leads"], d.criativos.map(([u, n]) => `<tr><td>${esc(u)}</td><td class="n">${n}</td></tr>`))}
  <h3>4.2 Leads por área (heurística)</h3>
  ${tbl(["Área", "Leads"], Object.entries(d.areas).sort((a, b) => b[1] - a[1]).map(([a, n]) => `<tr><td>${esc(a)}</td><td class="n">${n}</td></tr>`))}

  <div class="pb"></div>
  <h2>5. Comercial — qualidade do atendimento (leads)</h2>
  <p>Dentro do SLA de 15 min: <b>${d.sla.nosla}</b> · Fora do SLA: <b>${d.sla.fora}</b> · Sem resposta: <b>${d.sla.sem}</b> · Fora de horário: ${d.sla.offh}. Mediana de 1ª resposta: <b>${minLabel(d.sla.mediana)}</b>.</p>
  <h3>5.1 Por atendente (Comercial)</h3>
  ${tbl(["Atendente", "Leads", "Mediana 1ª resposta"], d.atendComercial.map(a => `<tr><td>${esc(a.nome)}</td><td class="n">${a.leads}</td><td class="n">${minLabel(a.med)}</td></tr>`))}

  <h2>6. Jurídico — atendimento em grupos de processo (clientes)</h2>
  <p>Grupos ativos no período: <b>${d.juridico.ativos}</b> · Turnos do cliente: ${d.juridico.turnos} · Sem resposta: <b>${d.juridico.pend.length}</b> · Mediana de resposta: <b>${minLabel(d.juridico.mediana)}</b>.</p>
  <h3>6.1 Por atendente (Jurídico / grupos)</h3>
  ${tbl(["Atendente", "Respostas", "Mediana"], d.juridico.atendentes.map(a => `<tr><td>${esc(a.nome)}</td><td class="n">${a.n}</td><td class="n">${minLabel(a.med)}</td></tr>`))}
  <h3>6.2 Turnos mais lentos (grupos)</h3>
  ${tbl(["Grupo (processo)", "Espera", "Atendente"], d.juridico.lentos.map(t => `<tr><td>${esc((t.grupo || "").slice(0, 48))}</td><td class="n">${minLabel(t.min)}</td><td>${esc(t.nome)}</td></tr>`))}

  <div class="pb"></div>
  <h2>7. Contratos fechados (Ganho) por vendedor</h2>
  <div class="kpis"><div class="kpi"><div class="l">Contratos fechados</div><div class="v">${d.contratos.length}</div></div>${Object.entries(d.contratosPorVend).sort((a, b) => b[1] - a[1]).map(([v, n]) => `<div class="kpi"><div class="l">${esc(v)}</div><div class="v">${n}</div></div>`).join("")}</div>
  ${d.contratos.length
      ? tbl(["Vendedor", "Cliente", "Data", "Hora"], d.contratos.map(x => `<tr><td>${esc(x.vendedor)}</td><td>${esc(x.cliente)}</td><td>${x.dia}</td><td class="n">${x.hora}</td></tr>`))
      : `<p class="pend">Nenhum contrato marcado como <b>Ganho</b> no funil do DigiSac neste período. O comercial passou a sinalizar o fechamento (status <b>Ganho</b>); assim que houver marcações, os contratos fechados aparecem aqui automaticamente — dispensando busca no Projuris/Notion.</p>`}
  <p class="muted">Fonte: funil de vendas do DigiSac (cards com status <b>Ganho</b>), pela data de fechamento no período. Substitui a conversão estimada por tag.</p>
  ${d.conversao.modo === "tags" ? `<h3>7.1 Tags de fechamento (referência)</h3>${conv}` : ""}

  <h2>8. Fila de pendências — SEM resposta (janela do período)</h2>
  <div class="alert">Leads sem resposta: <b>${d.pendLeads.length}</b> · Grupos sem resposta: <b>${d.juridico.pend.length}</b></div>
  <h3>8.1 Leads sem resposta (nome · telefone · desde · última mensagem)</h3>
  ${tbl(["Nome", "Telefone", "Desde", "Última mensagem do lead"], d.pendLeads.map(x => `<tr><td>${esc(x.nome)}</td><td>${esc(x.tel || "—")}</td><td>${x.dia}</td><td>${esc(x.msg || "—")}</td></tr>`))}
  <h3>8.2 Grupos de processo sem resposta (cliente × parte · desde · última fala)</h3>
  ${tbl(["Grupo (processo)", "Desde", "Última fala do cliente"], d.juridico.pend.map(x => `<tr><td>${esc((x.grupo || "").slice(0, 56))}</td><td>${x.dia}</td><td>${esc(x.msg || "—")}</td></tr>`))}

  <h2>9. Recomendações</h2>
  <ul>
    <li><b>SLA 15 min:</b> ${d.sla.pct}% dos leads respondidos dentro do prazo — ${d.sla.pct < 60 ? "abaixo do ideal; priorizar resposta rápida (a alavanca com maior correlação com fechamento)." : "bom patamar; manter."}</li>
    <li><b>Resgate:</b> ${d.pendLeads.length} leads e ${d.juridico.pend.length} grupos seguem sem resposta na janela — usar a Fila de Pendências (seções 8.1 e 8.2) para redistribuir.</li>
    <li><b>Tags de fechamento:</b> ${d.conversao.modo === "pendente" ? "criar as tags no DigiSac para medir conversão exata por canal e atendente." : "conversão já medida via tags — acompanhar por canal."}</li>
    <li><b>Dependência de anúncio:</b> ${d.amostra ? Math.round(100 * d.origem.anuncio / d.amostra) : 0}% dos leads vieram de anúncio Meta — reforçar indicação (canal historicamente de maior conversão).</li>
  </ul>

  <div class="foot">Fonte: API DigiSac (somente leitura). Documento confidencial — uso interno FG Advogados. Conversão via cruzamento externo (Projuris/Notion) não incluída; será exata quando as tags de fechamento existirem. Telefones e nomes completos por se tratar de documento interno (Google Drive privado).</div>
  </body></html>`;
}
main().catch(e => { console.error(e); process.exit(1); });
