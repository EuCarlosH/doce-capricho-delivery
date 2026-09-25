const crypto = require('crypto');

const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sistema-doce-capricho';
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '50ed9f81-4fa2-41e7-b470-b235bcefe85d';
const APP_URL = process.env.PUBLIC_APP_URL || 'https://docecaprichoatelier.vercel.app';
const FIREBASE_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let firebaseCertsCache = null;
let firebaseCertsExpiramEm = 0;

function responder(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(payload);
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
  const assinaturaValida = crypto.verify('RSA-SHA256', Buffer.from(`${partes[0]}.${partes[1]}`), certificado, Buffer.from(partes[2], 'base64url'));
  if (!assinaturaValida) return null;
  const agora = Math.floor(Date.now() / 1000);
  if (usuario.aud !== FIREBASE_PROJECT_ID || usuario.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT_ID}`) return null;
  if (!usuario.sub || String(usuario.sub).length > 128 || !Number.isFinite(usuario.exp) || usuario.exp <= agora || !Number.isFinite(usuario.iat) || usuario.iat > agora + 300) return null;
  const permitidos = String(process.env.ADMIN_NOTIFICATION_EMAILS || process.env.ADMIN_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean);
  if (permitidos.length && !permitidos.includes(String(usuario.email || '').toLowerCase())) return null;
  return usuario;
}

function dataCampanha(valor) {
  if (!valor) return null;
  if (typeof valor === 'string' || typeof valor === 'number') return new Date(valor);
  if (valor.seconds != null) return new Date(Number(valor.seconds) * 1000 + Math.floor(Number(valor.nanoseconds || 0) / 1000000));
  if (valor._seconds != null) return new Date(Number(valor._seconds) * 1000 + Math.floor(Number(valor._nanoseconds || 0) / 1000000));
  return null;
}

function destinoSeguro(destino) {
  const valor = String(destino || '').trim();
  if (/^https:\/\//i.test(valor)) return valor;
  if (valor.startsWith('#')) return `${APP_URL}/${valor}`;
  return `${APP_URL}/`;
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
  try {
    if (!await validarAdministrador(token)) return responder(res, 401, { error:'Sessão administrativa inválida.' });
    const apiKey = process.env.ONESIGNAL_REST_API_KEY;
    if (!apiKey) return responder(res, 503, { error:'Serviço de notificações ainda não configurado.' });
    const acao = String(corpo.acao || 'enviar');
    const campanha = corpo.campanha && typeof corpo.campanha === 'object' ? corpo.campanha : {};

    if (acao === 'cancelar') {
      const notificationId = String(campanha.pushNotificationId || '').trim();
      if (!/^[a-zA-Z0-9-]{8,80}$/.test(notificationId)) return responder(res, 400, { error:'Notificação agendada inválida.' });
      const resposta = await fetch(`https://api.onesignal.com/notifications/${encodeURIComponent(notificationId)}?app_id=${encodeURIComponent(ONESIGNAL_APP_ID)}`, { method:'DELETE', headers:{ Authorization:`Key ${apiKey}` } });
      const resultado = await resposta.json().catch(() => ({}));
      if (!resposta.ok) return responder(res, 502, { error:'O provedor não permitiu cancelar a notificação.' });
      return responder(res, 200, { cancelled:true, result:resultado });
    }

    const id = String(campanha.id || '').trim();
    const titulo = String(campanha.titulo || '').trim().slice(0,80);
    const texto = String(campanha.descricao || titulo).trim().slice(0,180);
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(id) || !titulo || !texto || campanha.canais?.push !== true) return responder(res, 400, { error:'Dados da campanha inválidos.' });
    const inicio = dataCampanha(campanha.inicioEm);
    const agora = Date.now();
    const agendado = inicio && !Number.isNaN(inicio.getTime()) && inicio.getTime() > agora + 60000;
    const payload = {
      app_id:ONESIGNAL_APP_ID,
      target_channel:'push',
      filters:[
        { field:'tag', key:'role', relation:'=', value:'customer' },
        { operator:'AND' },
        { field:'tag', key:'store', relation:'=', value:'doce-capricho' }
      ],
      headings:{ en:titulo, pt:titulo },
      contents:{ en:texto, pt:texto },
      url:destinoSeguro(campanha.destino),
      chrome_web_icon:`${APP_URL}/icon-192.png`,
      chrome_web_badge:`${APP_URL}/icon-192.png`,
      data:{ tipo:'campanha_marketing', campanhaId:id },
      idempotency_key:id
    };
    const imagem = String(campanha.imagem || '').trim();
    if (/^https:\/\//i.test(imagem)) payload.chrome_web_image = imagem.slice(0,500);
    if (agendado) payload.send_after = inicio.toISOString();
    const resposta = await fetch('https://api.onesignal.com/notifications', { method:'POST', headers:{ Authorization:`Key ${apiKey}`, 'Content-Type':'application/json' }, body:JSON.stringify(payload) });
    const resultado = await resposta.json().catch(() => ({}));
    if (!resposta.ok) {
      console.error('[PUSH CAMPANHA]', resposta.status, resultado.errors || resultado);
      return responder(res, 502, { error:'O provedor de notificações recusou o envio.' });
    }
    if (!resultado.id) return responder(res, 200, { sent:false, scheduled:Boolean(agendado), reason:'no_customer_subscription' });
    return responder(res, 200, { sent:true, scheduled:Boolean(agendado), notificationId:resultado.id, recipients:Number(resultado.recipients)||0 });
  } catch (erro) {
    console.error('[PUSH CAMPANHA]', erro);
    return responder(res, 500, { error:'Não foi possível processar a notificação da campanha.' });
  }
};
