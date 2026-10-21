// Lê canais públicos do Telegram (t.me/s/canal), apanha as mensagens das
// últimas 24h e manda-te um resumo das melhores ofertas no Telegram.
// Precisa de Node 18 ou superior.

const CANAIS = (process.env.CANAIS || "").split(",").map(s => s.trim()).filter(Boolean);
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const GEMINI_KEY = process.env.GEMINI_API_KEY; // opcional (chave gratuita do Google AI Studio)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
const HORAS = 24;
const MAX_PAGINAS = 15; // cada página tem cerca de 20 mensagens

function limpar(html) {
  return html
    .replace(/<a [^>]*href="([^"]+)"[^>]*>[\s\S]*?<\/a>/g, " $1 ")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .trim();
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
      msgs.push(`[${canal}] ${limpar(texto[1])}${post ? `\nhttps://t.me/${post[1]}/${post[2]}` : ""}`);
    }

    // Se já chegámos a mensagens com mais de 24h, paramos
    if (maisAntigo < limite || !isFinite(menorId)) break;
    before = menorId;
  }
  return msgs;
}

function resumoSemIA(mensagens) {
  // Sem IA: ordena pelas percentagens de desconto mais altas
  const pontuadas = mensagens.map(m => {
    const pct = m.match(/(\d{2,3})\s?%/);
    return { m, pct: pct ? Number(pct[1]) : 0, cupao: /cup[aã]o|c[oó]digo/i.test(m) };
  }).filter(x => x.pct >= 40 || x.cupao);
  pontuadas.sort((a, b) => b.pct - a.pct);
  return pontuadas.slice(0, 15).map(x => x.m).join("\n\n");
}

async function resumir(mensagens) {
  if (!GEMINI_KEY) return resumoSemIA(mensagens);

  const texto = mensagens.join("\n---\n").slice(0, 150000);
  const prompt =
    "Estas são mensagens de canais portugueses de ofertas, leilões e cupões. " +
    "Escolhe só as 10 melhores (preço muito baixo, desconto grande ou cupão que compensa de verdade). " +
    "Para cada uma: nome do produto, preço antes e agora, desconto, e o link. " +
    "Português de Portugal, curto, sem enfeites, texto simples sem markdown. Ignora spam e repetições.\n\n" + texto;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );
    const json = await res.json();
    const out = json.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n");
    if (!out) throw new Error(JSON.stringify(json).slice(0, 300));
    return out;
  } catch (e) {
    // Se a IA falhar (quota, modelo mudou, etc.), usa o resumo simples
    return "(A IA falhou, aqui vai o resumo simples: " + e.message + ")\n\n" + resumoSemIA(mensagens);
  }
}

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
