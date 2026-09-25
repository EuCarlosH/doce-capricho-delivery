const crypto = require('crypto');
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sistema-doce-capricho';
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '50ed9f81-4fa2-41e7-b470-b235bcefe85d';
const APP_URL = process.env.PUBLIC_APP_URL || 'https://docecaprichoatelier.vercel.app';
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let firebaseCertsCache = null;
let firebaseCertsExpiramEm = 0;

const MENSAGENS = {
  preparando: {
    title: 'Seu pedido foi confirmado! 👩‍🍳',
    body: nome => `${nome}, seu pedido entrou em preparo com todo o capricho.`
  },
  pronto: {
    title: 'Seu pedido ficou pronto! 🍕',
    body: nome => `${nome}, seu pedido está pronto e aguardando a saída para entrega.`
  },
  'saiu para entrega': {
    title: 'Seu pedido está a caminho! 🛵',
    body: nome => `${nome}, seu pedido saiu para entrega e logo chegará até você.`
  },
  'pronto para retirada': {
    title: 'Seu pedido está pronto! 🛍️',
    body: nome => `${nome}, seu pedido está pronto para retirada no Doce Capricho Ateliê.`
  },
  concluido: {
    title: 'Pedido concluído! 💛',
    body: nome => `Obrigado, ${nome}! Esperamos que aproveite. Toque para acompanhar ou pedir novamente.`
  },
  cancelado: {
    title: 'Atualização sobre seu pedido',
    body: nome => `${nome}, seu pedido foi cancelado. Se precisar de ajuda, fale com o Doce Capricho Ateliê.`
  }
};

function responder(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(payload);
}

function normalizar(valor) {
  return String(valor || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function lerValorFirestore(valor) {
  if (!valor || typeof valor !== 'object') return null;
  if ('stringValue' in valor) return valor.stringValue;
  if ('booleanValue' in valor) return valor.booleanValue;
  if ('integerValue' in valor) return Number(valor.integerValue);
  if ('doubleValue' in valor) return Number(valor.doubleValue);
  if ('timestampValue' in valor) return valor.timestampValue;
  if ('nullValue' in valor) return null;
  if (valor.arrayValue) return (valor.arrayValue.values || []).map(lerValorFirestore);
  if (valor.mapValue) return lerCamposFirestore(valor.mapValue.fields || {});
  return null;
}

function lerCamposFirestore(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([chave, valor]) => [chave, lerValorFirestore(valor)]));
}

function numeroPedidoExibicao(pedido, id) {
  const numeroSalvo = String(pedido?.numero_pedido || '').replace(/\D/g, '');
  if (numeroSalvo) return numeroSalvo;
  let hash = 2166136261;
  for (const caractere of String(id || '')) {
    hash ^= caractere.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return String(100000000 + ((hash >>> 0) % 900000000));
}

function decodificarParteJwt(parte) {
  try { return JSON.parse(Buffer.from(parte, 'base64url').toString('utf8')); }
  catch (_) { return null; }
}

async function buscarCertificadosFirebase() {
  if (firebaseCertsCache && Date.now() < firebaseCertsExpiramEm) return firebaseCertsCache;
  const resposta = await fetch(FIREBASE_CERTS_URL, { headers:{ Accept:'application/json' } });
  if (!resposta.ok) throw new Error(`firebase_certs_${resposta.status}`);
  const certificados = await resposta.json();
  const cacheControl = String(resposta.headers?.get?.('cache-control') || '');
  const maxAge = Number((cacheControl.match(/max-age=(\d+)/i) || [])[1]) || 3600;
  firebaseCertsCache = certificados;
  firebaseCertsExpiramEm = Date.now() + Math.max(300, maxAge - 60) * 1000;
  return certificados;
}

async function validarAdministrador(token) {
  const partes = String(token || '').split('.');
  if (partes.length !== 3) return null;
  const cabecalho = decodificarParteJwt(partes[0]);
  const usuario = decodificarParteJwt(partes[1]);
  if (!cabecalho || !usuario || cabecalho.alg !== 'RS256' || !cabecalho.kid) return null;

  const certificados = await buscarCertificadosFirebase();
  const certificado = certificados[cabecalho.kid];
  if (!certificado) return null;
  const assinaturaValida = crypto.verify(
    'RSA-SHA256',
    Buffer.from(`${partes[0]}.${partes[1]}`),
    certificado,
    Buffer.from(partes[2], 'base64url')
  );
  if (!assinaturaValida) return null;

  const agora = Math.floor(Date.now() / 1000);
  if (usuario.aud !== FIREBASE_PROJECT_ID) return null;
  if (usuario.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
  if (!usuario.sub || String(usuario.sub).length > 128) return null;
  if (!Number.isFinite(usuario.exp) || usuario.exp <= agora) return null;
  if (!Number.isFinite(usuario.iat) || usuario.iat > agora + 300) return null;

  const permitidos = String(process.env.ADMIN_NOTIFICATION_EMAILS || process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
  if (permitidos.length && !permitidos.includes(String(usuario.email || '').toLowerCase())) return null;
  return usuario;
}

async function buscarPedido(pedidoId, token) {
  const caminho = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/pedidos/${encodeURIComponent(pedidoId)}`;
  const resposta = await fetch(caminho, { headers:{ Authorization:`Bearer ${token}` } });
  if (resposta.status === 404) return null;
  if (!resposta.ok) throw new Error(`firestore_${resposta.status}`);
  const documento = await resposta.json();
  return lerCamposFirestore(documento.fields || {});
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return responder(res, 405, { error:'Método não permitido.' });
  }

  const cabecalho = String(req.headers.authorization || '');
  const token = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7).trim() : '';
  if (!token) return responder(res, 401, { error:'Autenticação obrigatória.' });

  let corpo = req.body || {};
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); }
    catch (_) { return responder(res, 400, { error:'Corpo inválido.' }); }
  }

  const pedidoId = String(corpo.pedidoId || '').trim();
  const statusInformado = String(corpo.status || '').trim();
  const statusNormalizado = normalizar(statusInformado);
  const mensagem = MENSAGENS[statusNormalizado];
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(pedidoId) || !mensagem) {
    return responder(res, 400, { error:'Pedido ou status inválido.' });
  }

  try {
    const administrador = await validarAdministrador(token);
    if (!administrador) {
      console.warn('[AUTH NOTIFICAÇÃO] Token Firebase rejeitado.');
      return responder(res, 401, { error:'Sessão administrativa inválida. Atualize o painel e entre novamente.' });
    }

    const pedido = await buscarPedido(pedidoId, token);
    if (!pedido) return responder(res, 404, { error:'Pedido não encontrado.' });
    if (normalizar(pedido.status) !== statusNormalizado) {
      return responder(res, 409, { error:'O status informado não corresponde ao pedido.' });
    }

    const externalId = String(pedido.push_external_id || '');
    if (!/^dca_[a-zA-Z0-9-]{16,80}$/.test(externalId)) {
      return responder(res, 200, { sent:false, reason:'not_subscribed' });
    }

    const apiKey = process.env.ONESIGNAL_REST_API_KEY;
    if (!apiKey) return responder(res, 503, { error:'Serviço de notificações ainda não configurado.' });

    const primeiroNomeBruto = String(pedido.cliente_nome || 'Cliente').trim().split(/\s+/)[0] || 'Cliente';
    const primeiroNome = primeiroNomeBruto.slice(0, 40);
    const numeroPedido = numeroPedidoExibicao(pedido, pedidoId);
    const titulo = mensagem.title;
    const texto = `Pedido #${numeroPedido} · ${mensagem.body(primeiroNome)}`;
    const urlPedido = `${APP_URL}/?pedido=${encodeURIComponent(pedidoId)}#acompanhar`;
    const payload = {
      app_id: ONESIGNAL_APP_ID,
      target_channel: 'push',
      include_aliases: { external_id:[externalId] },
      headings: { en:titulo, pt:titulo },
      contents: { en:texto, pt:texto },
      url: urlPedido,
      chrome_web_icon: `${APP_URL}/icon-192.png`,
      chrome_web_badge: `${APP_URL}/icon-192.png`,
      data: { tipo:'status_pedido', pedidoId, numeroPedido, status:statusInformado }
    };

    const respostaOneSignal = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        Authorization: `Key ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    const resultado = await respostaOneSignal.json().catch(() => ({}));
    if (!respostaOneSignal.ok) {
      console.error('[ONESIGNAL] Falha no envio:', respostaOneSignal.status, resultado.errors || resultado);
      return responder(res, 502, { error:'O provedor de notificações recusou o envio.' });
    }

    if (!resultado.id) return responder(res, 200, { sent:false, reason:'no_active_subscription' });
    return responder(res, 200, { sent:true, notificationId:resultado.id });
  } catch (erro) {
    console.error('[NOTIFICAÇÃO DE STATUS]', erro);
    return responder(res, 500, { error:'Não foi possível enviar a notificação.' });
  }
};
