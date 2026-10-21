// Lê canais públicos do Telegram (t.me/s/canal), apanha as mensagens das
// últimas 24h e manda-te um resumo das melhores ofertas no Telegram.
// Precisa de Node 18 ou superior.
//
// Como funciona a IA: o Gemini só ESCOLHE as melhores mensagens (devolve os
// números delas e os dados do produto). Os links vêm sempre das mensagens
// originais, copiados pelo script, por isso a IA nunca consegue estragá-los.

const CANAIS = (process.env.CANAIS || "").split(",").map(s => s.trim()).filter(Boolean);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const GEMINI_KEY = process.env.GEMINI_API_KEY; // opcional (chave gratuita do Google AI Studio)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const GEMINI_MODEL_RESERVA = process.env.GEMINI_MODEL_RESERVA || "gemini-flash-lite-latest";
const HORAS = 24;
const MAX_PAGINAS = 15; // cada página tem cerca de 20 mensagens
const MAX_OFERTAS = 10;
// Lista opcional do que te interessa, separada por vírgulas (segredo INTERESSES no GitHub).
const INTERESSES = (process.env.INTERESSES || "").split(",").map(s => s.trim()).filter(Boolean);

// Domínios que reconheces. Links de outros domínios aparecem com um aviso.
const DOMINIOS_OK = (process.env.DOMINIOS_OK ||
  "descontosainanas.com,amzn.to,amzn.eu,amazon.es,amazon.com,amazon.pt,chollometro.com,pcdiga.com,worten.pt,fnac.pt,aliexpress.com,zalando.pt,kuantokusta.pt,radiopopular.pt,pccomponentes.pt,mediamarkt.pt,primor.eu,notino.pt,decathlon.pt,prozis.com,cupoestafixe.com,chollo.to"
).split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

// ---------- Leitura dos canais ----------

function limpar(html) {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g, " $1 ")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function extrairLinks(texto) {
  return (texto.match(/https?:\/\/[^\s)\]>"']+/g) || []).map(u => u.replace(/[.,;:!?]+$/, ""));
}

async function lerCanal(canal) {
  const limite = Date.now() - HORAS * 3600 * 1000;
  const msgs = [];
  let before = null;

  for (let pag = 0; pag < MAX_PAGINAS; pag++) {
    const url = `https://t.me/s/${canal}` + (before ? `?before=${before}` : "");
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) throw new Error(`${canal}: erro ${res.status}`);
    const html = await res.text();
    const blocos = html.split("tgme_widget_message_wrap").slice(1);
    if (!blocos.length) {
      if (pag === 0) throw new Error(`${canal}: não deu para ler (não é um canal público?)`);
      break;
    }

    let maisAntigo = Infinity;
    let menorId = Infinity;
    for (const b of blocos) {
      const data = b.match(/datetime="([^"]+)"/);
      const post = b.match(/data-post="([^"]+)\/(\d+)"/);
      if (post) menorId = Math.min(menorId, Number(post[2]));
      if (!data) continue;
      const t = new Date(data[1]).getTime();
      maisAntigo = Math.min(maisAntigo, t);
      const texto = b.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
      if (!texto || t < limite) continue;
      msgs.push({
        canal,
        texto: limpar(texto[1]),
        postUrl: post ? `https://t.me/${post[1]}/${post[2]}` : null,
      });
    }

    if (maisAntigo < limite || !isFinite(menorId)) break;
    before = menorId;
  }
  return msgs;
}

// ---------- Links ----------

function melhorLink(m) {
  // Primeiro link da mensagem original que não seja do próprio Telegram
  const links = extrairLinks(m.texto)
    .filter(u => !/^https?:\/\/(t\.me|telegram\.me)\//i.test(u))
    .filter(u => !/\.(png|jpe?g|gif|webp)(\?|$)/i.test(u));
  return links[0] || m.postUrl || "(sem link)";
}

function avisoDominio(link) {
  try {
    const host = new URL(link).hostname.replace(/^www\./, "").toLowerCase();
    const ok = DOMINIOS_OK.some(d => host === d || host.endsWith("." + d));
    return ok ? "" : ` ⚠ domínio desconhecido (${host}), confirma antes de clicar`;
  } catch {
    return "";
  }
}

// ---------- Resumo ----------

function prepararMensagens(msgs) {
  // Só mensagens com preço, percentagem ou cupão; sem esgotadas; sem repetidas entre canais
  const vistos = new Set();
  return msgs.filter(m => {
    if (!/[€%]|cup[aã]o|c[oó]digo/i.test(m.texto)) return false;
    if (/agotado|esgot(ou|ad[oa])|sold out/i.test(m.texto)) return false;
    const chave = m.texto.toLowerCase().replace(/[^a-z0-9à-ú]+/g, " ").trim().slice(0, 80);
    if (vistos.has(chave)) return false;
    vistos.add(chave);
    return true;
  });
}

function resumoSemIA(msgs) {
  // Sem IA: ordena pelas percentagens de desconto mais altas
  const pontuadas = prepararMensagens(msgs).map(m => {
    const pct = m.texto.match(/(\d{2,3})\s?%/);
    return { m, pct: pct ? Number(pct[1]) : 0, cupao: /cup[aã]o|c[oó]digo/i.test(m.texto) };
  }).filter(x => x.pct >= 40 || x.cupao);
  pontuadas.sort((a, b) => b.pct - a.pct);
  return pontuadas.slice(0, 15).map(({ m }) => {
    const l = melhorLink(m);
    return `[${m.canal}] ${m.texto.slice(0, 300)}\n${l}${avisoDominio(l)}`;
  }).join("\n\n");
}

const BLOCO_INTERESSES = INTERESSES.length
  ? "PRIORIDADE MÁXIMA: se aparecer alguma oferta destes produtos ou categorias a bom preço, inclui-a e põe-na no topo, mesmo com desconto percentual menor: " +
    INTERESSES.join("; ") + ".\n\n"
  : "";

const INSTRUCOES =
  "És um assistente que filtra ofertas para um consumidor português. " +
  "Recebes mensagens de canais de ofertas, leilões e cupões, cada uma com um número entre parênteses retos, por exemplo [12]. " +
  `Escolhe no máximo ${MAX_OFERTAS} mensagens que compensam mesmo, da melhor para a pior.\n\n` +
  BLOCO_INTERESSES +
  "O que conta como oferta que compensa:\n" +
  "- desconto real grande (a partir de uns 40%) OU poupança grande em euros num produto que as pessoas querem;\n" +
  "- preço final muito baixo para o que é;\n" +
  "- cupões ou códigos que baixam mesmo o preço (indica o código no campo cupao);\n" +
  "- produtos úteis ou de marca conhecida valem mais do que artigos obscuros com a mesma percentagem.\n\n" +
  "Regras:\n" +
  "- Usa só informação que está na mensagem. Nunca inventes preços, descontos, códigos ou nomes. Se não vier, deixa vazio.\n" +
  "- Se o mesmo produto aparecer em várias mensagens ou canais, escolhe só a mais barata.\n" +
  "- Ignora anúncios, publicidade, sorteios, conversa e mensagens sem preço claro.\n" +
  "- Não devolvas links. O programa junta os links originais a partir do número da mensagem.\n" +
  "- Escreve em português de Portugal. Preços no formato 13,51€.\n" +
  "- No campo motivo, uma frase curta e factual (máximo 12 palavras) sobre porque compensa.";

const ESQUEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: {
      id: { type: "INTEGER", description: "Número da mensagem original" },
      produto: { type: "STRING" },
      preco_antes: { type: "STRING", nullable: true },
      preco_agora: { type: "STRING", nullable: true },
      desconto_percent: { type: "INTEGER", nullable: true },
      cupao: { type: "STRING", nullable: true },
      motivo: { type: "STRING" },
    },
    required: ["id", "produto", "motivo"],
  },
};

function lerJSON(texto) {
  const limpo = texto.replace(/```json|```/g, "").trim();
  return JSON.parse(limpo);
}

async function resumirComIA(msgs) {
  const lista = prepararMensagens(msgs);
  if (!lista.length) throw new Error("Nenhuma mensagem com preço ou cupão");
  const corpo = lista
    .map((m, i) => `[${i}] (${m.canal}) ${m.texto.slice(0, 450)}`)
    .join("\n---\n")
    .slice(0, 250000);

  const pedido = {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: INSTRUCOES }] },
      contents: [{ parts: [{ text: "Mensagens:\n\n" + corpo }] }],
      generationConfig: { responseMimeType: "application/json", responseSchema: ESQUEMA },
    }),
  };
  // Tenta o modelo principal e, se estiver sobrecarregado, um modelo de reserva
  const modelos = [...new Set([GEMINI_MODEL, GEMINI_MODEL_RESERVA])];
  const espera = Number(process.env.ESPERA_MS || 30000);
  let res;
  tudo: for (const modelo of modelos) {
    const urlGemini = `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`;
    for (let tentativa = 1; tentativa <= 3; tentativa++) {
      res = await fetch(urlGemini, pedido);
      if (res.ok) break tudo;
      if (![429, 500, 503].includes(res.status)) break; // erro que repetir não resolve: passa ao modelo seguinte
      if (tentativa < 3) await new Promise(r => setTimeout(r, espera * tentativa)); // espera 30s, 60s
    }
  }
  const json = await res.json();
  const bruto = json.candidates?.[0]?.content?.parts?.filter(p => !p.thought)?.map(p => p.text || "").join("");
  if (!bruto) throw new Error(JSON.stringify(json).slice(0, 300));
  const itens = lerJSON(bruto);

  const vistos = new Set();
  const linhas = [];
  for (const it of itens) {
    const m = lista[it.id];
    if (!m || vistos.has(it.id)) continue; // ignora números inventados ou repetidos
    vistos.add(it.id);
    const link = melhorLink(m);
    const partes = [];
    if (it.preco_antes || it.preco_agora) {
      partes.push(`${it.preco_antes ? "Antes: " + it.preco_antes : ""}${it.preco_antes && it.preco_agora ? " | " : ""}${it.preco_agora ? "Agora: " + it.preco_agora : ""}`);
    }
    if (it.desconto_percent) partes.push(`Desconto: ${it.desconto_percent}%`);
    if (it.cupao) partes.push(`Cupão: ${it.cupao}`);
    linhas.push(
      `${linhas.length + 1}. ${it.produto}\n` +
      (partes.length ? partes.join(" | ") + "\n" : "") +
      `${it.motivo}\n` +
      `Canal: ${m.canal}\n` +
      `${link}${avisoDominio(link)}`
    );
    if (linhas.length >= MAX_OFERTAS) break;
  }
  if (!linhas.length) throw new Error("A IA não devolveu ofertas válidas");
  return linhas.join("\n\n");
}

async function resumir(msgs) {
  if (!GEMINI_KEY) return resumoSemIA(msgs);
  try {
    return await resumirComIA(msgs);
  } catch (e) {
    // Se a IA falhar (quota, modelo mudou, etc.), usa o resumo simples
    return `(A IA falhou, aqui vai o resumo simples: ${e.message})\n\n` + resumoSemIA(msgs);
  }
}

// ---------- Envio ----------

async function enviar(texto) {
  const partes = texto.match(/[\s\S]{1,3900}/g) || ["Sem ofertas hoje."];
  for (const p of partes) {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHAT, text: p, disable_web_page_preview: true }),
    });
    if (!r.ok) console.error("Erro a enviar para o Telegram:", await r.text());
  }
}

(async () => {
  let todas = [];
  const erros = [];
  for (const c of CANAIS) {
    try { todas = todas.concat(await lerCanal(c)); }
    catch (e) { erros.push(e.message); }
  }
  let resumo = todas.length ? await resumir(todas) : "Nenhuma mensagem nas últimas 24h.";
  if (erros.length) resumo += "\n\nCanais com problema:\n" + erros.join("\n");
  await enviar(`Ofertas do dia (${todas.length} mensagens lidas)\n\n${resumo}`);
})();
