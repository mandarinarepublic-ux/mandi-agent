// lib/shopify.js
// Integración real con Shopify Admin API

const SHOPIFY_STORE = process.env.SHOPIFY_STORE_DOMAIN; // tu-tienda.myshopify.com
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;  // shpat_...

const SHOPIFY_BASE = `https://${SHOPIFY_STORE}/admin/api/2024-10`;

async function shopifyFetch(endpoint) {
  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) return null;
  try {
    const res = await fetch(`${SHOPIFY_BASE}${endpoint}`, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// Buscar productos por query
export async function searchProducts(query) {
  const encoded = encodeURIComponent(query);
  const data = await shopifyFetch(`/products.json?title=${encoded}&limit=5&status=active`);
  if (!data?.products?.length) return null;
  return formatProducts(data.products);
}

// Buscar colección por tema
export async function searchByCollection(collectionQuery) {
  const encoded = encodeURIComponent(collectionQuery);
  const colData = await shopifyFetch(`/collections.json?title=${encoded}&limit=3`);
  if (!colData?.collections?.length) return null;

  const col = colData.collections[0];
  const prodData = await shopifyFetch(`/collections/${col.id}/products.json?limit=6`);
  if (!prodData?.products?.length) return null;

  return formatProducts(prodData.products, col.title);
}

// Obtener todos los productos activos (para contexto general)
export async function getAllProducts() {
  const data = await shopifyFetch('/products.json?limit=20&status=active');
  if (!data?.products?.length) return null;
  return formatProducts(data.products);
}

// Formatear productos para el system prompt
function formatProducts(products, collectionName = null) {
  const lines = products.map(p => {
    const variants = p.variants || [];
    const sizes = variants.map(v => v.title).filter(t => t !== 'Default Title').join(', ');
    const price = variants[0]?.price || '?';
    const available = variants.some(v => v.inventory_quantity > 0);
    const image = p.images?.[0]?.src || null;
    const stock = variants.map(v => `${v.title}:${v.inventory_quantity}`).join(' | ');

    return {
      title: p.title,
      price: `$${price}`,
      available,
      sizes: sizes || 'Talla única',
      stock,
      image,
      handle: p.handle,
      url: `https://${SHOPIFY_STORE}/products/${p.handle}`
    };
  });

  // Texto para el system prompt
  const context = (collectionName ? `Colección: ${collectionName}\n` : '') +
    lines.map(p =>
      `• ${p.title} — ${p.price} | ${p.available ? '✅ Disponible' : '❌ Agotado'} | Tallas: ${p.sizes}\n  Stock: ${p.stock}\n  Imagen: ${p.image || 'sin imagen'}\n  Link: ${p.url}`
    ).join('\n\n');

  return { context, products: lines };
}

// Formatear producto para respuesta directa con imagen
export function formatProductForWhatsApp(product) {
  let msg = `*${product.title}* — ${product.price}\n`;
  msg += product.available ? '✅ Disponible\n' : '⚠️ Stock limitado\n';
  if (product.sizes && product.sizes !== 'Talla única') {
    msg += `Tallas: ${product.sizes}\n`;
  }
  if (product.image) {
    msg += `\n${product.image}`;
  }
  return msg;
}
