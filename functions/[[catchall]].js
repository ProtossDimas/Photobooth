/**
 * functions/[[catchall]].js
 * Wedding Video Booth — Cloudflare Pages Function
 *
 * MIGRASI: Google Drive + Google Sheets  ->  Cloudflare R2 + D1 (SQLite)
 *
 * Kenapa migrasi ini lebih simpel & cepat:
 *  - Tidak perlu Service Account JWT / OAuth ke Google sama sekali.
 *  - Upload file langsung ke R2 (tidak perlu resumable upload 3 step).
 *  - Baca galeri dari D1 (SQL biasa) — jauh lebih cepat dari Sheets API.
 *  - Streaming media (foto/video/VN) langsung dari R2 lewat /api/media,
 *    termasuk dukungan Range header (untuk seek video & audio).
 *
 * Bindings yang WAJIB di-set di Cloudflare Pages → Settings → Functions:
 *   D1 database binding   : DB             (nama database bebas)
 *   R2 bucket binding     : MEDIA_BUCKET   (nama bucket bebas)
 *
 * Tabel D1 "entries" dibuat otomatis saat pertama kali endpoint API dipanggil
 * (lihat ensureSchema). Skemanya:
 *   id          INTEGER PRIMARY KEY AUTOINCREMENT
 *   timestamp   TEXT
 *   name        TEXT
 *   message     TEXT
 *   media_key   TEXT   -- R2 object key untuk foto/video
 *   media_type  TEXT   -- 'photo' | 'video'
 *   vn_key      TEXT   -- R2 object key untuk voice note (boleh NULL)
 *
 * Cara setup (wrangler / dashboard):
 *   wrangler d1 create wedding-booth-db
 *   wrangler r2 bucket create wedding-booth-media
 *   # lalu bind keduanya ke Pages project lewat dashboard atau wrangler.toml:
 *   #   [[d1_databases]]
 *   #   binding = "DB"
 *   #   database_name = "wedding-booth-db"
 *   #   database_id = "..."
 *   #
 *   #   [[r2_buckets]]
 *   #   binding = "MEDIA_BUCKET"
 *   #   bucket_name = "wedding-booth-media"
 */

// ── Shared dispatcher ────────────────────────────────────────────────────────
async function dispatch({ request, env, next }) {
  const { pathname } = new URL(request.url);
  const method = request.method;

  try {
    if (method === 'OPTIONS')                              return cors204();
    if (pathname === '/api/submit'   && method === 'POST') return await handleSubmit(request, env);
    if (pathname === '/api/gallery'  && method === 'GET')  return await handleGallery(env);
    if (pathname === '/api/debug'    && method === 'GET')  return await handleDebug(env);
    // Serve foto/video/voice-note langsung dari R2, dengan dukungan Range (seek)
    if (pathname === '/api/media'    && method === 'GET')  return await handleMedia(request, env);

    // Semua request non-API di-pass ke Cloudflare static asset handler
    return next();
  } catch (err) {
    console.error('[dispatch]', err);
    return jsonRes({ ok: false, error: err.message, trace: err.stack?.slice(0, 400) }, 500);
  }
}

export const onRequestGet     = (ctx) => dispatch(ctx);
export const onRequestPost    = (ctx) => dispatch(ctx);
export const onRequestOptions = (ctx) => dispatch(ctx);
export const onRequest        = (ctx) => dispatch(ctx);

// ═══════════════════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════════════════
async function ensureSchema(env) {
  checkBindings(env);
  await env.DB.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp  TEXT NOT NULL,
      name       TEXT NOT NULL,
      message    TEXT,
      media_key  TEXT NOT NULL,
      media_type TEXT NOT NULL,
      vn_key     TEXT
    );
  `);
}

function checkBindings(env) {
  if (!env.DB)           throw new Error('D1 binding "DB" belum di-set di Pages Settings → Functions');
  if (!env.MEDIA_BUCKET) throw new Error('R2 binding "MEDIA_BUCKET" belum di-set di Pages Settings → Functions');
}

// ═══════════════════════════════════════════════════════════
// SUBMIT  POST /api/submit
// ═══════════════════════════════════════════════════════════
async function handleSubmit(request, env) {
  await ensureSchema(env);

  let form;
  try { form = await request.formData(); }
  catch (e) { return jsonRes({ ok: false, error: 'FormData error: ' + e.message }, 400); }

  const name      = (form.get('name') || '').trim();
  const message   = (form.get('message') || '').trim();
  const photoFile = form.get('photo');
  const videoFile = form.get('video');
  const vnFile    = form.get('vn');
  const mediaFile = photoFile || videoFile;
  const isPhoto   = !!photoFile;
  const mediaType = isPhoto ? 'photo' : 'video';
  const mediaMime = mediaFile?.type || (isPhoto ? 'image/jpeg' : 'video/webm');
  const mediaExt  = extFromMime(mediaMime, isPhoto ? 'jpg' : 'webm');

  if (!name)      return jsonRes({ ok: false, error: 'Nama wajib diisi' }, 400);
  if (!mediaFile) return jsonRes({ ok: false, error: 'File foto/video tidak ada' }, 400);

  const stamp    = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = name.replace(/[^\w\- ]/g, '_').slice(0, 30);
  const prefix   = `entries/${stamp}_${safeName}`;

  // Upload media ke R2
  const mediaKey = `${prefix}/media.${mediaExt}`;
  try {
    await env.MEDIA_BUCKET.put(mediaKey, mediaFile.stream(), {
      httpMetadata: { contentType: mediaMime },
    });
  } catch (e) {
    return jsonRes({ ok: false, error: 'R2 upload gagal: ' + e.message }, 500);
  }
  const mediaUrl = mediaApiUrl(mediaKey);

  // Upload voice note (opsional)
  let vnKey = null, vnUrl = '';
  if (vnFile && vnFile.size > 0) {
    const vnMime = vnFile.type || 'audio/webm';
    const vnExt  = extFromMime(vnMime, 'webm');
    vnKey = `${prefix}/vn.${vnExt}`;
    try {
      await env.MEDIA_BUCKET.put(vnKey, vnFile.stream(), {
        httpMetadata: { contentType: vnMime },
      });
      vnUrl = mediaApiUrl(vnKey);
    } catch (e) {
      console.error('[Submit] VN upload gagal:', e.message);
      vnKey = null; // gagal upload VN tidak menggagalkan submit utama
    }
  }

  // Simpan ke D1
  const isoNow = new Date().toISOString();
  let insertedId;
  try {
    const res = await env.DB
      .prepare(`INSERT INTO entries (timestamp, name, message, media_key, media_type, vn_key)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
      .bind(isoNow, name, message, mediaKey, mediaType, vnKey)
      .run();
    insertedId = res.meta?.last_row_id;
  } catch (e) {
    return jsonRes({ ok: false, error: 'D1 insert gagal: ' + e.message }, 500);
  }

  return jsonRes({
    ok: true,
    id:          insertedId,
    media_url:   mediaUrl,
    video_url:   mediaUrl,
    photo_url:   mediaUrl,
    vn_url:      vnUrl,
    media_type:  mediaType,
  });
}

// ═══════════════════════════════════════════════════════════
// GALLERY  GET /api/gallery
// ═══════════════════════════════════════════════════════════
async function handleGallery(env) {
  await ensureSchema(env);

  let rows;
  try {
    const res = await env.DB
      .prepare(`SELECT id, timestamp, name, message, media_key, media_type, vn_key
                FROM entries ORDER BY id DESC`)
      .all();
    rows = res.results || [];
  } catch (e) {
    return jsonRes({ ok: false, error: 'D1 read gagal: ' + e.message }, 500);
  }

  const entries = rows.map(r => ({
    timestamp:  r.timestamp || '',
    name:       r.name || 'Tamu',
    message:    r.message || '',
    video_url:  mediaApiUrl(r.media_key),
    vn_url:     r.vn_key ? mediaApiUrl(r.vn_key) : '',
    media_type: r.media_type || 'video',
  }));

  return jsonRes({ ok: true, entries });
}

// ═══════════════════════════════════════════════════════════
// MEDIA  GET /api/media?key=<r2 object key>
// Streaming foto/video/voice-note dari R2, dengan dukungan Range
// (dipakai untuk seek video & audio scrubbing).
// ═══════════════════════════════════════════════════════════
async function handleMedia(request, env) {
  checkBindings(env);

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!key) return new Response('Missing key parameter', { status: 400 });

  // Validasi: hanya boleh akses object di dalam folder "entries/"
  // supaya endpoint ini tidak bisa dipakai untuk akses sembarang object di bucket.
  if (!key.startsWith('entries/')) {
    return new Response('Invalid key', { status: 400 });
  }

  const rangeHdr = request.headers.get('Range');
  const range    = rangeHdr ? parseRangeHeader(rangeHdr) : undefined;

  let object;
  try {
    object = await env.MEDIA_BUCKET.get(key, range ? { range } : {});
  } catch (e) {
    return new Response('R2 fetch error: ' + e.message, { status: 500 });
  }

  if (!object) return new Response('Not found', { status: 404 });

  const headers = {
    'Content-Type':  object.httpMetadata?.contentType || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000, immutable',
    'ETag':          object.httpEtag,
    ...corsHeaders(),
  };

  const totalSize = object.size;
  let status = 200;

  if (range && object.range) {
    const { offset, length } = object.range;
    const end = offset + length - 1;
    headers['Content-Range']  = `bytes ${offset}-${end}/${totalSize}`;
    headers['Content-Length'] = String(length);
    status = 206;
  } else {
    headers['Content-Length'] = String(totalSize);
  }

  return new Response(object.body, { status, headers });
}

// Parse header "Range: bytes=START-END" jadi { offset, length } untuk R2.get()
function parseRangeHeader(rangeHdr) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHdr.trim());
  if (!m) return undefined;
  const start = m[1] === '' ? undefined : parseInt(m[1], 10);
  const end   = m[2] === '' ? undefined : parseInt(m[2], 10);
  if (start === undefined && end === undefined) return undefined;
  if (start === undefined) {
    // suffix range: bytes=-500  -> 500 byte terakhir
    return { suffix: end };
  }
  if (end === undefined) {
    // open-ended: bytes=500-  -> dari offset 500 sampai akhir
    return { offset: start };
  }
  return { offset: start, length: end - start + 1 };
}

// ═══════════════════════════════════════════════════════════
// DEBUG  GET /api/debug
// ═══════════════════════════════════════════════════════════
async function handleDebug(env) {
  const r = {
    ts:           new Date().toISOString(),
    version:      'v3-r2-d1',
    has_d1:       !!env.DB,
    has_r2:       !!env.MEDIA_BUCKET,
  };
  try {
    await ensureSchema(env);
    const c = await env.DB.prepare('SELECT COUNT(*) AS n FROM entries').first();
    r.db = 'OK';
    r.row_count = c?.n ?? 0;
  } catch (e) {
    r.db = 'FAILED';
    r.error = e.message;
  }
  return jsonRes(r);
}

// ═══════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════
function mediaApiUrl(key) {
  if (!key) return '';
  return `/api/media?key=${encodeURIComponent(key)}`;
}

function extFromMime(mime, fallback) {
  const map = {
    'image/jpeg':      'jpg',
    'image/png':       'png',
    'image/webp':      'webp',
    'video/webm':      'webm',
    'video/mp4':       'mp4',
    'audio/webm':      'webm',
    'audio/ogg':       'ogg',
    'audio/mpeg':      'mp3',
    'audio/mp4':       'm4a',
  };
  return map[mime] || fallback;
}

function cors204() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Range',
  };
}
function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}
