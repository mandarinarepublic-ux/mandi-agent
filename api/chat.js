// api/chat.js — Endpoint público para el widget del sitio web mandarinaec.com
// Acepta el formato del widget: { system, messages }
// Sin autenticación (es llamado desde el browser del cliente)

import Anthropic from '@anthropic-ai/sdk';
import { searchProducts } from '../lib/sheetsCatalog.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, system } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Faltan messages' });
  }

  try {
    // Obtener el último mensaje del usuario para buscar productos
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';

    // Buscar productos en el catálogo CSV local
    let catalogContext = '';
    if (userText) {
      try {
        const result = await searchProducts(userText, 'MANDARINA');
        if (result) catalogContext = result.context;
      } catch (err) {
        console.error('SheetsCatalog error:', err.message);
      }
    }

    // Construir system prompt: usar el del widget + inyectar catálogo real
    let systemPrompt = system || 'Eres Mandi, asistente de ventas de Mandarina Republic Ecuador.';

    if (catalogContext) {
      systemPrompt += `\n\n## 🛒 PRODUCTOS REALES DEL CATÁLOGO (fuente de verdad)\nEstos son los productos que tenemos y coinciden con lo que pregunta el cliente. Usa estos datos exactos — precio, tallas y stock son reales:\n\n${catalogContext}\n\nSi el producto aparece aquí = LO TENEMOS con esos datos exactos. NUNCA digas "no tenemos" si aparece aquí. NUNCA digas "déjame verificar stock".`;
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: systemPrompt,
      messages: messages
    });

    // Devolver en el formato exacto que espera el widget
    return res.status(200).json({
      content: response.content
    });

  } catch (error) {
    console.error('Chat endpoint error:', error);
    return res.status(500).json({ error: 'Error interno', detail: error.message });
  }
}
