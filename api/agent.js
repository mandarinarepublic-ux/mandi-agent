// api/agent.js — MANDI Agent v4.1
// Arquitectura: Claude con tools → MANDI decide cuándo consultar Shopify
// v4.1: buscar_productos ahora intenta Shopify DIRECTO primero (más rápido,
// más datos: stock real, descuentos), y cae a Make como respaldo si falla.
// Log de decisiones → Google Sheets MANDI_LOGS

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from '../lib/systemPrompt.js';
import { getSession, saveSession } from '../lib/sessions.js';
import { logDecision, initSheet } from '../lib/logger.js';
import { isConfigured as shopifyDirectoConfigurado, buscarProductosDirecto } from '../lib/shopifyClient.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MAKE_SHOPIFY_WEBHOOK = 'https://hook.us2.make.com/irqcoe515xt1ijtn9w1nrp83xdmhn493';

// Inicializar headers de la hoja al arrancar
initSheet().catch(() => {});

// ── GUÍAS DE TALLAS ───────────────────────────────────────────────────────
const GUIAS_TALLAS = {
  hoodie:    'https://cdn.shopify.com/s/files/1/0689/5832/2781/files/MEDIDAS_CAMISETAS_NINOS_ADMINISTRADOR-02.png?v=1746666338',
  chaqueta:  'https://cdn.shopify.com/s/files/1/0689/5832/2781/files/MEDIDAS_CAMISETAS_NINOS_ADMINISTRADOR-02.png?v=1746666338',
  camiseta:  'https://cdn.shopify.com/s/files/1/0689/5832/2781/files/MEDIDAS_MANDARINA-01.png?v=1746666339',
  general:   'https://cdn.shopify.com/s/files/1/0689/5832/2781/files/MEDIDAS_CAMISETAS_NINOS_ADMINISTRADOR-02.png?v=1746666338'
};

// ── TOOLS QUE MANDI PUEDE USAR ─────────────────────────────────────────────
const MANDI_TOOLS = [
  {
    name: 'buscar_productos',
    description: `Busca productos en Shopify de Mandarina Republic en tiempo real.
Úsala cuando el cliente mencione una franquicia, personaje, tipo de prenda o quiera ver opciones.
Devuelve hasta 3 productos con nombre, precio, tallas disponibles con stock, imagen y URL.
CUÁNDO USAR: "tienen de naruto?", "qué hoodies tienen?", "busco algo de marvel", "quiero una chaqueta"
CUÁNDO NO USAR: saludos, preguntas sobre envíos/pagos, cuando ya tienes el producto en contexto`,
    input_schema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Término de búsqueda: nombre de franquicia, personaje o tipo de prenda. Ejemplos: "naruto", "spiderman", "x-men", "hoodie", "chaqueta power rangers"'
        }
      },
      required: ['keyword']
    }
  },
  {
    name: 'obtener_guia_tallas',
    description: `Devuelve la imagen correcta de guía de tallas según el tipo de prenda.
Usar cuando el cliente pregunta por medidas, tallas, cuál talla elegir, o cómo saber su talla.
Siempre úsala en contexto: si estaban hablando de hoodies, usa hoodie. Si de camisetas, usa camiseta.`,
    input_schema: {
      type: 'object',
      properties: {
        tipo: {
          type: 'string',
          enum: ['hoodie', 'chaqueta', 'camiseta', 'general'],
          description: 'Tipo de prenda: hoodie/chaqueta para sudaderas y chaquetas, camiseta para remeras, general si no está claro'
        }
      },
      required: ['tipo']
    }
  }
];

// ── BUSCAR PRODUCTOS VÍA MAKE (respaldo) ───────────────────────────────────
async function buscarProductosViaMake(keyword) {
  const res = await fetch(MAKE_SHOPIFY_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword, phone: 'mandi_tool' }),
    signal: AbortSignal.timeout(8000)
  });

  if (!res.ok) throw new Error(`Make webhook respondió ${res.status}`);

  const data = await res.json();
  if (!data?.productos) throw new Error('Make webhook sin productos');

  return data.productos;
}

// ── EJECUTAR TOOL ───────────────────────────────────────────────────────────
async function executeTool(toolName, toolInput, tiendaId = 'MANDARINA') {
  if (toolName === 'buscar_productos') {
    const { keyword } = toolInput;

    // 1) Intentar Shopify DIRECTO primero, si está configurado para esta tienda
    if (shopifyDirectoConfigurado(tiendaId)) {
      try {
        const { productos, count } = await buscarProductosDirecto(keyword, tiendaId);
        if (productos) {
          console.log(`${tiendaId}: Shopify directo OK — ${count} productos para "${keyword}"`);
          return { productos, keyword, fuente: 'shopify_directo' };
        }
        return { error: 'Sin productos para: ' + keyword, fuente: 'shopify_directo' };
      } catch (err) {
        console.error(`${tiendaId}: Shopify directo falló, usando Make de respaldo:`, err.message);
      }
    }

    // 2) Respaldo: webhook de Make (comportamiento original — solo Mandarina)
    try {
      const productos = await buscarProductosViaMake(keyword);
      return { productos, keyword, fuente: 'make_webhook' };
    } catch (err) {
      return { error: 'Error consultando Shopify: ' + err.message };
    }
  }

  if (toolName === 'obtener_guia_tallas') {
    const { tipo } = toolInput;
    const url = GUIAS_TALLAS[tipo] || GUIAS_TALLAS.general;
    return { imagen_guia: url, tipo };
  }

  return { error: 'Tool desconocida: ' + toolName };
}

// ── AUTH ────────────────────────────────────────────────────────────────────
function isAuthorized(req) {
  const key = req.headers['x-mandi-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return key === process.env.MANDI_API_KEY;
}

// ── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-mandi-key, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { phone, message, name, image_url, media_url, source, reset_session, tienda, store, shopify_context } = req.body || {};

  if (!phone || (!message && !image_url && !media_url)) {
    return res.status(400).json({ error: 'Faltan campos: phone y message (o image_url)' });
  }

  const startTime = Date.now();
  const tiendaId = (tienda || store || 'MANDARINA').toUpperCase();

  // Variables de log
  let toolUsada = '';
  let keywordShopify = '';
  let productosEncontrados = 0;
  let clasificacion = '';
  let fuenteProductos = '';

  try {
    const session = reset_session ? { messages: [], meta: {} } : getSession(phone);
    const history = session.messages;

    // Construir contenido del usuario
    const imageUrl = image_url || media_url;
    let userContent;
    if (imageUrl) {
      userContent = [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: message || 'El cliente envió esta imagen' }
      ];
    } else {
      userContent = message;
    }

    // System prompt
    let systemPrompt = buildSystemPrompt(tiendaId);
    if (name) systemPrompt += `\n\nNombre del cliente: ${name}`;
    // Inyectar contexto de Shopify si viene de Make (ya buscado por el escenario)
    if (shopify_context && shopify_context.trim()) {
      systemPrompt += `\n\n## 🛒 PRODUCTOS DISPONIBLES EN TIENDA (datos reales de Shopify):\n${shopify_context}\n\n⚠️ IMPORTANTE: Estos productos YA FUERON encontrados en Shopify. ÚSALOS DIRECTAMENTE sin llamar la tool buscar_productos. Si el cliente pregunta por uno de estos, confirma precio, tallas y cierra la venta YA.`;
    }

    // Mensajes para Claude
    const apiMessages = [
      ...history,
      { role: 'user', content: userContent }
    ];

    // ── PRIMERA LLAMADA A CLAUDE ────────────────────────────────────────────
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: systemPrompt,
      tools: MANDI_TOOLS,
      messages: apiMessages
    });

    let totalInputTokens = response.usage?.input_tokens || 0;
    let totalOutputTokens = response.usage?.output_tokens || 0;

    // ── AGENTIC LOOP: ejecutar tools si MANDI las pidió ────────────────────
    // Guardamos los mensajes intermedios para el historial completo
    const intermediateMessages = [];

    while (response.stop_reason === 'tool_use') {
      const toolUseBlock = response.content.find(b => b.type === 'tool_use');
      if (!toolUseBlock) break;

      toolUsada = toolUseBlock.name;
      keywordShopify = toolUseBlock.input?.keyword || '';
      clasificacion = 'PRODUCTO';

      console.log(`MANDI tool: ${toolUsada} → "${keywordShopify}"`);

      // Ejecutar la tool
      const toolResult = await executeTool(toolUseBlock.name, toolUseBlock.input, tiendaId);
      if (toolResult.productos) {
        productosEncontrados = toolResult.productos.split(' ||| ').length;
      }
      if (toolResult.fuente) {
        fuenteProductos = toolResult.fuente;
      }

      // Mensaje assistant con el tool_use
      const assistantToolMsg = { role: 'assistant', content: response.content };

      // Mensaje user con el tool_result
      const toolResultMessage = {
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: toolUseBlock.id,
          content: JSON.stringify(toolResult)
        }]
      };

      // Guardamos estos mensajes para el historial
      intermediateMessages.push(assistantToolMsg, toolResultMessage);

      // Segunda llamada con el resultado de la tool
      response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        system: systemPrompt,
        tools: MANDI_TOOLS,
        messages: [
          ...apiMessages,
          ...intermediateMessages
        ]
      });

      totalInputTokens += response.usage?.input_tokens || 0;
      totalOutputTokens += response.usage?.output_tokens || 0;
    }

    // ── RESPUESTA FINAL ──────────────────────────────────────────────────────
    const replyBlock = response.content.find(b => b.type === 'text');
    const reply = replyBlock?.text || '';

    if (!toolUsada) clasificacion = 'OTRO';

    // Guardar historial limpio — sin tool_use/tool_result blocks
    // En su lugar guardamos el catálogo consultado como contexto de texto plano
    // Así MANDI recuerda qué productos mostró sin romper el formato de la API
    const userMsg = { role: 'user', content: typeof userContent === 'string' ? userContent : (message || '[imagen]') };
    const assistantFinalMsg = { role: 'assistant', content: reply };

    const newHistory = [...history, userMsg];

    // Si hubo una tool call, inyectar el catálogo como contexto de sistema
    // en forma de mensaje user/assistant para que MANDI lo tenga en cuenta
    if (intermediateMessages.length > 0) {
      // Extraer el tool_result con los productos
      const toolResultMsg = intermediateMessages.find(m =>
        m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result'
      );
      if (toolResultMsg) {
        const toolContent = toolResultMsg.content[0]?.content || '';
        // Guardarlo como contexto limpio: user pregunta, assistant confirma catálogo
        newHistory.push({
          role: 'assistant',
          content: `[CATÁLOGO CONSULTADO EN SHOPIFY para esta conversación: ${toolContent}]`
        });
        newHistory.push({
          role: 'user',
          content: 'ok, basándote en ese catálogo responde mi pregunta anterior'
        });
      }
    }

    newHistory.push(assistantFinalMsg);
    saveSession(phone, newHistory, { name, source, lastReply: reply.slice(0, 100) });

    const elapsed = Date.now() - startTime;

    // Log a Google Sheets (fire and forget)
    logDecision({
      phone,
      mensaje: message || '[imagen]',
      clasificacion,
      tool_usada: toolUsada,
      keyword_shopify: keywordShopify,
      productos_encontrados: productosEncontrados,
      fuente_productos: fuenteProductos,
      respuesta: reply,
      tokens_in: totalInputTokens,
      tokens_out: totalOutputTokens,
      elapsed_ms: elapsed
    });

    return res.status(200).json({
      reply,
      reply_clean: reply,
      content: [{ type: 'text', text: reply }],
      phone,
      tienda: tiendaId,
      source: source || 'unknown',
      tool_used: toolUsada,
      keyword: keywordShopify,
      productos_encontrados: productosEncontrados,
      fuente_productos: fuenteProductos,
      context_turns: Math.floor(newHistory.length / 2),
      tokens: { input: totalInputTokens, output: totalOutputTokens },
      elapsed_ms: elapsed
    });

  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.error('MANDI error:', error);

    logDecision({
      phone,
      mensaje: message || '',
      clasificacion: 'ERROR',
      error: error.message,
      elapsed_ms: elapsed
    });

    return res.status(500).json({ error: 'Error interno del agente', detail: error.message });
  }
}
