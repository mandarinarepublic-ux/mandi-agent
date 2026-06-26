// lib/sheetsCatalog.js — Catálogo dinámico desde Google Sheets
// Lee la hoja de productos publicada como CSV.
// Soporta columnas: TIENDA, SHOPIFY_ID, NOMBRE, PRECIO, TALLAS, IMAGEN_URL, ACTIVO, STOCK

const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRAAs3Xh4u3mRDrm_NRTId3sW80xlTZSFBNfaMzHeqgjzWPAyShAdfSsK-peJfCMWwduCBrfLRj3ymj/pub?output=csv';

const TIENDAS_VALIDAS = ['MANDARINA', 'INDSTORE'];
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

let cache = { products: null, fetchedAt: 0 };

// Parser CSV — soporta campos entre comillas con comas (ej: "XS, S, M, L")
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === '"' && next === '"') { field += '"'; i++; }
      else if (char === '"') { inQuotes = false; }
      else { field += char; }
    } else {
      if (char === '"') inQuotes = true;
      else if (char === ',') { row.push(field); field = ''; }
      else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (char === '\r') { /* ignorar */ }
      else { field += char; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

async function fetchProducts() {
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error(`No se pudo leer la hoja de productos: HTTP ${res.status}`);
  }
  const text = await res.text();
  const rows = parseCSV(text);
  if (rows.length < 2) return [];

  // Detectar columnas dinámicamente por nombre — así no importa el orden
  const headers = rows[0].map(h => h.trim().toUpperCase());
  const idx = {
    tienda:  headers.indexOf('TIENDA'),
    nombre:  headers.indexOf('NOMBRE'),
    precio:  headers.indexOf('PRECIO'),
    tallas:  headers.indexOf('TALLAS'),
    imagen:  headers.indexOf('IMAGEN_URL'),
    activo:  headers.indexOf('ACTIVO'),
    stock:   headers.indexOf('STOCK'),       // ← columna nueva
  };

  const products = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;

    const tienda = (r[idx.tienda] || '').trim().toUpperCase();
    if (!TIENDAS_VALIDAS.includes(tienda)) continue;

    const activo = (r[idx.activo] || '').trim().toUpperCase();
    if (activo !== 'TRUE') continue;

    const nombre = (r[idx.nombre] || '').trim();
    if (!nombre) continue;

    products.push({
      tienda,
      nombre,
      precio: (r[idx.precio] || '').trim(),
      tallas: (r[idx.tallas] || '').trim(),
      imagen: (r[idx.imagen] || '').trim(),
      stock:  (r[idx.stock]  || '10').trim(),  // ← default 10 si no tiene columna aún
    });
  }
  return products;
}

async function getCatalog() {
  const now = Date.now();
  if (cache.products && (now - cache.fetchedAt) < CACHE_TTL) {
    return cache.products;
  }
  try {
    const products = await fetchProducts();
    cache = { products, fetchedAt: now };
    const porTienda = TIENDAS_VALIDAS.map(t =>
      `${t}=${products.filter(p => p.tienda === t).length}`
    ).join(', ');
    console.log(`SheetsCatalog: ${products.length} productos activos (${porTienda})`);
    return products;
  } catch (err) {
    console.error('SheetsCatalog error:', err.message);
    if (cache.products) return cache.products; // usa caché vieja si falla
    return [];
  }
}

// Stopwords para búsqueda por keywords
const STOPWORDS = new Set([
  'de', 'la', 'el', 'en', 'con', 'para', 'que', 'y', 'o', 'un', 'una', 'los', 'las',
  'hola', 'quiero', 'tienen', 'hay', 'tienes', 'busco', 'ver', 'foto', 'info',
  'precio', 'cuanto', 'cuesta', 'vale', 'disponible', 'color', 'colores', 'talla',
  'tallas', 'si', 'dale', 'ok', 'porfa', 'por', 'favor', 'me', 'lo', 'del', 'mi',
  'buzo', 'buzos', 'chompa', 'chompas',
  'camiseta', 'camisetas', 'pantaloneta', 'pantalonetas', 'gorra', 'gorras',
  'pijama', 'pijamas', 'jacket', 'sueter', 'sueteres', 'sweater', 'sweaters'
]);

function normalize(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/-/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(message) {
  return normalize(message)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w));
}

export async function searchProducts(message, tienda = 'MANDARINA') {
  const tiendaNorm = (tienda || 'MANDARINA').toUpperCase();
  const tokens = tokenize(message);
  if (tokens.length === 0) return null;

  const catalog = await getCatalog();
  const deLaTienda = catalog.filter(p => p.tienda === tiendaNorm);
  if (deLaTienda.length === 0) return null;

  const scored = deLaTienda
    .map(p => {
      const nombreNorm = normalize(p.nombre);
      let score = 0;
      for (const t of tokens) {
        if (nombreNorm.includes(t)) score += 2;
        else if (t.length > 4 && nombreNorm.split(' ').some(w => w.startsWith(t))) score += 1;
      }
      return { product: p, score };
    })
    .filter(s => s.score > 0);

  if (scored.length === 0) return null;

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 5).map(s => s.product);

  return formatProducts(top);
}

function formatProducts(products) {
  const context = products.map(p =>
    `• ${p.nombre} — $${parseFloat(p.precio || 0).toFixed(2)} | Tallas: ${p.tallas || 'Disponible'} | Stock: ${p.stock} unidades\n  Imagen: ${p.imagen || 'sin imagen'}`
  ).join('\n\n');

  return {
    context,
    products: products.map(p => ({
      title:     p.nombre,
      price:     `$${parseFloat(p.precio || 0).toFixed(2)}`,
      available: true,
      sizes:     p.tallas || 'Disponible',
      stock:     p.stock,
      image:     p.imagen || null
    }))
  };
}

export async function refreshCatalog() {
  cache = { products: null, fetchedAt: 0 };
  return getCatalog();
}
