const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'sistema-doce-capricho';
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '50ed9f81-4fa2-41e7-b470-b235bcefe85d';
const APP_URL = process.env.PUBLIC_APP_URL || 'https://docecaprichoatelier.vercel.app';

function responder(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  return res.status(status).json(payload);
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

async function buscarPedido(pedidoId) {
  const caminho = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/pedidos/${encodeURIComponent(pedidoId)}`;
  const resposta = await fetch(caminho, { headers:{ Accept:'application/json' } });
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

  let corpo = req.body || {};
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); }
    catch (_) { return responder(res, 400, { error:'Corpo inválido.' }); }
  }

  const pedidoId = String(corpo.pedidoId || '').trim();
  const idempotencia = String(corpo.idempotencia || '').trim().toLowerCase();
  if (!/^[a-zA-Z0-9_-]{6,64}$/.test(pedidoId) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(idempotencia)) {
    return responder(res, 400, { error:'Pedido ou chave inválida.' });
  }

  try {
    const pedido = await buscarPedido(pedidoId);
    if (!pedido) return responder(res, 404, { error:'Pedido não encontrado.' });
    if (String(pedido.status || '') !== 'Novo') return responder(res, 409, { error:'O pedido não está aguardando atendimento.' });
    if (String(pedido.admin_notification_idempotency_key || '').toLowerCase() !== idempotencia) {
      return responder(res, 403, { error:'Chave de notificação inválida.' });
    }

    const criadoEm = new Date(pedido.data_pedido || 0).getTime();
    if (!Number.isFinite(criadoEm) || Math.abs(Date.now() - criadoEm) > 30 * 60 * 1000) {
      return responder(res, 409, { error:'A janela para alertar sobre este pedido terminou.' });
    }

    const apiKey = process.env.ONESIGNAL_REST_API_KEY;
    if (!apiKey) return responder(res, 503, { error:'Serviço de notificações ainda não configurado.' });

    const cliente = String(pedido.cliente_nome || 'Cliente').trim().slice(0, 60);
    const tipo = String(pedido.tipo_entrega || 'Pedido').trim().slice(0, 30);
    const total = (Number(pedido.total_centavos) || 0) / 100;
    const titulo = 'Novo pedido recebido! 🍕';
    const texto = `${cliente} · ${tipo} · ${total.toLocaleString('pt-BR', { style:'currency', currency:'BRL' })}`;
    const payload = {
      app_id:ONESIGNAL_APP_ID,
      target_channel:'push',
      filters:[
        { field:'tag', key:'role', relation:'=', value:'admin' },
        { operator:'AND' },
        { field:'tag', key:'store', relation:'=', value:'doce-capricho' }
      ],
      headings:{ en:titulo, pt:titulo },
      contents:{ en:texto, pt:texto },
      url:`${APP_URL}/admin/`,
      chrome_web_icon:`${APP_URL}/admin/icons/icon-192.png`,
      chrome_web_badge:`${APP_URL}/admin/icons/icon-192.png`,
      data:{ tipo:'novo_pedido_admin', pedidoId },
      idempotency_key:idempotencia
    };

    const respostaOneSignal = await fetch('https://api.onesignal.com/notifications', {
      method:'POST',
      headers:{ Authorization:`Key ${apiKey}`, 'Content-Type':'application/json' },
      body:JSON.stringify(payload)
    });
    const resultado = await respostaOneSignal.json().catch(() => ({}));
    if (!respostaOneSignal.ok) {
      console.error('[PUSH NOVO PEDIDO]', respostaOneSignal.status, resultado.errors || resultado);
      return responder(res, 502, { error:'O provedor de notificações recusou o envio.' });
    }
    if (!resultado.id) return responder(res, 200, { sent:false, reason:'no_admin_subscription' });
    return responder(res, 200, { sent:true, notificationId:resultado.id });
  } catch (erro) {
    console.error('[PUSH NOVO PEDIDO]', erro);
    return responder(res, 500, { error:'Não foi possível avisar sobre o novo pedido.' });
  }
};
