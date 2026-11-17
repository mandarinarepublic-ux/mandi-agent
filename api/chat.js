// api/chat.js — Chat del widget web. CERRADO con clave desde el 17-nov-2026.
//
// ☠️ Antes era público: sin clave, con CORS `*` y en un repo público. Cualquiera
// podía mandarle mensajes y gastar el saldo de Anthropic. Además el prompt traía
// las cuentas bancarias y la cédula del dueño a la vista en GitHub.
// Ahora exige la misma clave que /api/agent (x-mandi-key) y falla CERRADO.
// Un widget en el navegador no puede guardar una clave: si se quiere volver a
// tener chat en la web, tiene que pasar por un backend propio que la ponga.

import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || 'mandarina-republic.myshopify.com';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;

// Buscar productos en Shopify Admin API
async function buscarProductosShopify(query) {
  if (!SHOPIFY_TOKEN) return '';
  
  try {
    const url = `https://${SHOPIFY_DOMAIN}/admin/api/2024-01/products.json?title=${encodeURIComponent(query)}&status=active&limit=5&fields=id,title,variants,images`;
    const res = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    
    if (!res.ok) return '';
    const data = await res.json();
    const products = data.products || [];
    
    if (products.length === 0) return '';
    
    return products.map(p => {
      const precio = p.variants?.[0]?.price || '?';
      const tallas = p.variants?.map(v => v.option1).filter(Boolean).join(', ') || 'Disponible';
      const imagen = p.images?.[0]?.src || '';
      const stock = p.variants?.reduce((sum, v) => sum + (v.inventory_quantity || 0), 0);
      return `• ${p.title} — $${precio} | Tallas: ${tallas} | Stock: ${stock > 0 ? stock + ' unidades' : 'disponible'}\n  Imagen: ${imagen}`;
    }).join('\n\n');
    
  } catch (err) {
    console.error('Shopify error:', err.message);
    return '';
  }
}

// Extraer keywords del último mensaje del usuario
function extraerKeywords(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user');
  return typeof lastUser?.content === 'string' ? lastUser.content : '';
}

const limpia = (v) => String(v || '').replace(/[^\x21-\x7E]/g, '');
function igual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let dif = 0;
  for (let i = 0; i < a.length; i++) dif |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return dif === 0;
}
// Solo la clave NUEVA: la vieja quedó publicada y acá no hay transición que cuidar.
function autorizado(req) {
  const key = limpia(req.headers['x-mandi-key'] || req.headers['authorization']?.replace('Bearer ', ''));
  const esperada = limpia(process.env.MANDI_API_KEY);
  return Boolean(key && esperada && igual(key, esperada));
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!autorizado(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { messages, system } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Faltan messages' });
  }

  try {
    const userText = extraerKeywords(messages);
    
    // Buscar productos en Shopify
    const catalogContext = userText ? await buscarProductosShopify(userText) : '';

    // System prompt
    let systemPrompt = 'Eres Mandi, asistente de ventas de Mandarina Republic Ecuador. Anime streetwear, envío gratis en Quito. Responde siempre en español, de forma amigable y directa.\n';
    systemPrompt += 'REGLA CRÍTICA: Si el catálogo tiene productos = los TIENES. Nunca digas que no tienes algo si aparece aquí. NUNCA digas "déjame verificar stock".\n';
    systemPrompt += 'FLUJO: 1) Muestra productos disponibles con precio 2) Pregunta talla 3) Pide teléfono WhatsApp 4) Confirma pedido\n';
    // Los datos de pago NO van acá (repo público): salen de las respuestas rápidas del inbox.
    
    if (catalogContext) {
      systemPrompt += `\n## PRODUCTOS DISPONIBLES EN SHOPIFY (datos reales y actualizados):\n${catalogContext}\n`;
    } else {
      systemPrompt += '\nSi no hay productos específicos en el catálogo, menciona que tenemos: Dragon Ball, Naruto, One Piece, X-Men, Spider-Man, Power Rangers, Tortugas Ninja, Pokemon, Superman, Ben 10, Digimon, y más. Pide que especifiquen qué buscan.\n';
    }

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: messages
    });

    return res.status(200).json({ content: response.content });

  } catch (error) {
    console.error('Chat error:', error);
    return res.status(500).json({ error: 'Error interno', detail: error.message });
  }
}
