const SITE_ORIGIN = 'https://docecaprichoatelier.vercel.app';
const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '50ed9f81-4fa2-41e7-b470-b235bcefe85d';
const FIREBASE_API_KEY = 'AIzaSyCU5CFz3cbrpyk3dsJBR46m-0km3kYkjJA';

function responder(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(payload);
}

function urlHttpsValida(valor) {
  if (!valor) return '';
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function resolverDestino(valor) {
  const destino = String(valor || '').trim();
  if (!destino) return `${SITE_ORIGIN}/`;
  if (destino.startsWith('#')) return `${SITE_ORIGIN}/${destino}`;

  const url = urlHttpsValida(destino);
  return url || `${SITE_ORIGIN}/`;
}

async function validarAdministrador(token) {
  const resposta = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken: token })
    }
  );

  if (!resposta.ok) return null;
  const dados = await resposta.json();
  const usuario = Array.isArray(dados.users) ? dados.users[0] : null;
  if (!usuario?.email) return null;

  const permitidos = String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);

  if (permitidos.length && !permitidos.includes(usuario.email.toLowerCase())) return null;
  return usuario;
}

module.exports = async function enviarNotificacao(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return responder(res, 405, { error: 'Método não permitido.' });
  }

  const origem = String(req.headers.origin || '');
  if (origem && origem !== SITE_ORIGIN) {
    return responder(res, 403, { error: 'Origem não autorizada.' });
  }

  const chaveOneSignal = process.env.ONESIGNAL_REST_API_KEY;
  if (!chaveOneSignal) {
    return responder(res, 503, { error: 'O envio de notificações ainda não foi configurado no servidor.' });
  }

  const autorizacao = String(req.headers.authorization || '');
  const token = autorizacao.startsWith('Bearer ') ? autorizacao.slice(7).trim() : '';
  if (!token || !(await validarAdministrador(token))) {
    return responder(res, 401, { error: 'Sessão administrativa inválida ou expirada.' });
  }

  const titulo = String(req.body?.titulo || '').trim().slice(0, 80);
  const mensagem = String(req.body?.mensagem || '').trim().slice(0, 300);
  const imagemInformada = String(req.body?.imagem || '').trim();
  const imagem = urlHttpsValida(imagemInformada);

  if (!titulo || !mensagem) {
    return responder(res, 400, { error: 'Informe o título e a descrição da notificação.' });
  }
  if (imagemInformada && !imagem) {
    return responder(res, 400, { error: 'A imagem da notificação precisa usar uma URL HTTPS válida.' });
  }

  const notificacao = {
    app_id: ONESIGNAL_APP_ID,
    included_segments: ['Subscribed Users'],
    headings: { en: titulo, pt: titulo },
    contents: { en: mensagem, pt: mensagem },
    url: resolverDestino(req.body?.destino),
    chrome_web_icon: `${SITE_ORIGIN}/icon-192.png`,
    firefox_icon: `${SITE_ORIGIN}/icon-192.png`
  };

  if (imagem) notificacao.chrome_web_image = imagem;

  try {
    const resposta = await fetch('https://api.onesignal.com/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Key ${chaveOneSignal}`
      },
      body: JSON.stringify(notificacao)
    });

    const retorno = await resposta.json().catch(() => ({}));
    if (!resposta.ok || retorno.errors) {
      console.error('[ONESIGNAL]', retorno);
      return responder(res, 502, { error: 'O OneSignal recusou o envio. Verifique a configuração e tente novamente.' });
    }

    return responder(res, 200, {
      ok: true,
      id: retorno.id || null,
      recipients: retorno.recipients ?? null
    });
  } catch (erro) {
    console.error('[ONESIGNAL]', erro);
    return responder(res, 502, { error: 'Não foi possível conectar ao serviço de notificações.' });
  }
};
