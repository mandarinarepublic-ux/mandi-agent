// api/agent.js — MANDI Agent v3.1
// Prioridad de catálogo: 1) shopify_context de Make  2) CSV local

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from '../lib/systemPrompt.js';
import { searchProducts } from '../lib/sheetsCatalog.js';
import { getSession, saveSession } from '../lib/sessions.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function isAuthorized(req) {
  const key = req.headers['x-mandi-key'] || req.headers['authorization']?.replace('Bearer ', '');
  return key === process.env.MANDI_API_KEY;
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!isAuthorized(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { phone, message, name, image_url, media_url, source, reset_session, tienda, shopify_context } = req.body || {};

  if (!phone || (!message && !image_url && !media_url)) {
    return res.status(400).json({ error: 'Faltan campos: phone y message (o image_url)' });
  }

  const startTime = Date.now();
  const tiendaId = (tienda || 'MANDARINA').toUpperCase();

  try {
    const session = reset_session ? { messages: [], meta: {} } : getSession(phone);
    const history = session.messages;

    // ── CATÁLOGO: prioridad al shopify_context que manda Make ──
    let catalogContext = '';
    if (shopify_context && shopify_context.trim()) {
      catalogContext = shopify_context.trim();
      console.log(`ShopifyContext de Make: ${catalogContext.slice(0, 80)}...`);
    } else if (message) {
      try {
        const result = await searchProducts(message, tiendaId);
        if (result) catalogContext = result.context;
      } catch (err) {
        console.error('SheetsCatalog error (no bloqueante):', err.message);
      }
    }

    // Construir contenido del usuario
    const imageUrl = image_url || media_url;
    let userContent;
    if (imageUrl) {
      userContent = [
        { type: 'image', source: { type: 'url', url: imageUrl } },
        { type: 'text', text: message || (name ? `${name} envió esta imagen` : 'El cliente envió esta imagen') }
      ];
    } else {
      userContent = message;
    }

    // System prompt
    let systemPrompt = buildSystemPrompt();
    if (name) systemPrompt += `\n\nNombre del cliente: ${name}`;

    if (catalogContext) {
      systemPrompt += `\n\n## 🛒 PRODUCTOS DISPONIBLES (datos reales de Shopify)\n${catalogContext}\n\n⚠️ REGLA ABSOLUTA: Si el producto aparece arriba = LO TENEMOS. NUNCA digas que no tienes algo que aparece aquí. NUNCA digas "déjame verificar".`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: [
        ...history,
        { role: 'user', content: userContent }
      ]
    });

    const reply = response.content[0]?.text || '';

    const newHistory = [
      ...history,
      { role: 'user', content: typeof userContent === 'string' ? userContent : (message || '[imagen]') },
      { role: 'assistant', content: reply }
    ];
    saveSession(phone, newHistory, { name, source, lastReply: reply.slice(0, 100) });

    return res.status(200).json({
      reply,
      reply_clean: reply,          // ← alias que usa el módulo 88 de Make
      content: [{ type: 'text', text: reply }],  // ← formato widget web
      phone,
      tienda: tiendaId,
      source: source || 'unknown',
      catalog_source: shopify_context ? 'shopify_make' : 'csv_local',
      catalog_matches: catalogContext ? catalogContext.split('\n').length : 0,
      context_turns: Math.floor(newHistory.length / 2),
      tokens: { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 },
      elapsed_ms: Date.now() - startTime
    });

  } catch (error) {
    console.error('MANDI error:', error);
    return res.status(500).json({ error: 'Error interno del agente', detail: error.message });
  }
}
