import { randomBytes } from 'node:crypto'

import purescienceLogoSvg from './purescience-logo.svg?raw'

import { nativeStringsFor, resolveNativeLocaleCode, type NativeLocaleCode } from '../native-locale'

// The pairing page is drawn by the browser the user approves from, not by the renderer, so it cannot
// read the renderer's dictionary: it carries its own nine-language copy and follows the app locale
// the same way the native dialogs do (see ../native-locale.ts). English values are kept byte-for-byte
// with the literals they replaced, because a certification spec and two main tests assert on them.
type PairingPageStrings = {
  documentTitle: string
  heading: string
  intro: string
  codeLabel: string
  shareNote: string
  waiting: string
  approved: string
  rejected: string
  expired: string
}

const PAIRING_PAGE_STRINGS: Record<NativeLocaleCode, PairingPageStrings> = {
  en: {
    documentTitle: 'Connect to PureScience',
    heading: 'Approve this browser',
    intro:
      'On your home computer, open PureScience → Settings → Remote control, then verify and approve the pairing code below.',
    codeLabel: 'Pairing code',
    shareNote:
      'Choose “Allow once” or “Always trust this browser”. Do not share this pairing code with anyone.',
    waiting: 'Waiting for approval…',
    approved: 'Approved. Opening PureScience…',
    rejected: 'This request was rejected.',
    expired: 'This pairing code has expired. Refresh the page to try again.'
  },
  zh: {
    documentTitle: '连接到 PureScience',
    heading: '批准此浏览器',
    intro: '在家里的电脑上打开 PureScience → 设置 → 远程控制，然后核对并批准下方的配对码。',
    codeLabel: '配对码',
    shareNote: '选择「仅允许一次」或「始终信任此浏览器」。请不要把配对码告诉任何人。',
    waiting: '等待批准…',
    approved: '已批准，正在打开 PureScience…',
    rejected: '此请求已被拒绝。',
    expired: '此配对码已过期。刷新页面后重试。'
  },
  'zh-Hant': {
    documentTitle: '連線到 PureScience',
    heading: '批准此瀏覽器',
    intro: '在家中的電腦上開啟 PureScience → 設定 → 遠端控制，然後核對並批准下方的配對碼。',
    codeLabel: '配對碼',
    shareNote: '選擇「僅允許一次」或「永遠信任此瀏覽器」。請勿將配對碼告知任何人。',
    waiting: '等待批准…',
    approved: '已批准，正在開啟 PureScience…',
    rejected: '此請求已被拒絕。',
    expired: '此配對碼已過期。重新整理頁面後再試。'
  },
  ja: {
    documentTitle: 'PureScience に接続',
    heading: 'このブラウザーを承認',
    intro:
      '自宅のパソコンで PureScience → 設定 → リモートコントロールを開き、下のペアリングコードを確認して承認してください。',
    codeLabel: 'ペアリングコード',
    shareNote:
      '「今回のみ許可」または「このブラウザーを常に信頼」を選びます。ペアリングコードは誰とも共有しないでください。',
    waiting: '承認を待っています…',
    approved: '承認されました。PureScience を開いています…',
    rejected: 'このリクエストは拒否されました。',
    expired: 'このペアリングコードは期限切れです。ページを再読み込みしてください。'
  },
  ko: {
    documentTitle: 'PureScience 연결',
    heading: '이 브라우저 승인',
    intro:
      '집 컴퓨터에서 PureScience → 설정 → 원격 제어를 열고 아래 페어링 코드를 확인한 뒤 승인하세요.',
    codeLabel: '페어링 코드',
    shareNote:
      '‘한 번만 허용’ 또는 ‘이 브라우저를 항상 신뢰’를 선택하세요. 페어링 코드를 다른 사람과 공유하지 마세요.',
    waiting: '승인을 기다리는 중…',
    approved: '승인되었습니다. PureScience를 여는 중…',
    rejected: '이 요청은 거부되었습니다.',
    expired: '이 페어링 코드는 만료되었습니다. 페이지를 새로 고쳐 다시 시도하세요.'
  },
  es: {
    documentTitle: 'Conectar con PureScience',
    heading: 'Aprueba este navegador',
    intro:
      'En tu ordenador de casa, abre PureScience → Ajustes → Control remoto y luego verifica y aprueba el código de emparejamiento de abajo.',
    codeLabel: 'Código de emparejamiento',
    shareNote:
      'Elige «Permitir una vez» o «Confiar siempre en este navegador». No compartas este código con nadie.',
    waiting: 'Esperando aprobación…',
    approved: 'Aprobado. Abriendo PureScience…',
    rejected: 'Esta solicitud se rechazó.',
    expired: 'Este código ha caducado. Recarga la página para volver a intentarlo.'
  },
  de: {
    documentTitle: 'Mit PureScience verbinden',
    heading: 'Diesen Browser genehmigen',
    intro:
      'Öffne auf deinem Heimcomputer PureScience → Einstellungen → Fernsteuerung und prüfe und genehmige dann den unten stehenden Kopplungscode.',
    codeLabel: 'Kopplungscode',
    shareNote:
      'Wähle „Einmal erlauben“ oder „Diesem Browser immer vertrauen“. Gib diesen Code nicht weiter.',
    waiting: 'Warte auf Genehmigung…',
    approved: 'Genehmigt. PureScience wird geöffnet…',
    rejected: 'Diese Anfrage wurde abgelehnt.',
    expired: 'Dieser Kopplungscode ist abgelaufen. Lade die Seite neu, um es erneut zu versuchen.'
  },
  fr: {
    documentTitle: 'Se connecter à PureScience',
    heading: 'Approuver ce navigateur',
    intro:
      'Sur votre ordinateur, ouvrez PureScience → Réglages → Contrôle à distance, puis vérifiez et approuvez le code d’appairage ci-dessous.',
    codeLabel: 'Code d’appairage',
    shareNote:
      'Choisissez « Autoriser une fois » ou « Toujours faire confiance à ce navigateur ». Ne partagez ce code avec personne.',
    waiting: 'En attente de l’approbation…',
    approved: 'Approuvé. Ouverture de PureScience…',
    rejected: 'Cette demande a été refusée.',
    expired: 'Ce code d’appairage a expiré. Rechargez la page pour réessayer.'
  },
  ru: {
    documentTitle: 'Подключение к PureScience',
    heading: 'Подтвердите этот браузер',
    intro:
      'На домашнем компьютере откройте PureScience → Настройки → Удалённое управление, затем проверьте и подтвердите код сопряжения ниже.',
    codeLabel: 'Код сопряжения',
    shareNote:
      'Выберите «Разрешить один раз» или «Всегда доверять этому браузеру». Не передавайте этот код никому.',
    waiting: 'Ожидание подтверждения…',
    approved: 'Подтверждено. Открываем PureScience…',
    rejected: 'В этом запросе отказано.',
    expired: 'Срок действия этого кода сопряжения истёк. Обновите страницу и попробуйте снова.'
  }
}

export const REMOTE_PAIR_STATUS_PATH = '/__purescience_remote/pair/status'

const purescienceLogo = purescienceLogoSvg.replace(
  '<svg ',
  '<svg class="brand-logo" aria-hidden="true" focusable="false" '
)

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

export const renderPairingPage = (params: {
  code: string
  browser: string
  platform: string
  expiresAt: number
}): { html: string; nonce: string } => {
  const nonce = randomBytes(18).toString('base64')
  const code = escapeHtml(params.code)
  const browser = escapeHtml(params.browser)
  const platform = escapeHtml(params.platform)
  // Resolved per render: the page is served fresh on every pairing request, so a reader whose
  // locale changed since the app started is not pinned to the old one.
  const locale = resolveNativeLocaleCode()
  const s = nativeStringsFor(PAIRING_PAGE_STRINGS)

  return {
    nonce,
    html: `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="color-scheme" content="light dark" />
    <title>${escapeHtml(s.documentTitle)}</title>
    <style>
      :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { min-height: 100dvh; margin: 0; display: grid; place-items: center; padding: 24px; background: #f5f6f4; color: #1d211f; }
      .card { width: min(100%, 440px); padding: 30px; border: 1px solid #d9ddda; border-radius: 20px; background: #fff; box-shadow: 0 24px 70px rgba(22, 31, 27, .12); }
      .brand { display: flex; align-items: center; gap: 10px; }
      .brand-logo { width: 42px; height: 41px; flex: none; color: #2a2a28; }
      .brand-name { font-family: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif; font-size: 26px; font-weight: 500; line-height: 1; letter-spacing: -.02em; }
      h1 { margin: 22px 0 8px; font-size: 24px; line-height: 1.25; }
      p { margin: 0; color: #66716c; font-size: 14px; line-height: 1.6; }
      .code { margin: 24px 0 12px; padding: 18px; border: 1px solid #cfd6d2; border-radius: 14px; background: #f7faf8; text-align: center; font: 700 30px/1.1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .16em; color: #075f50; }
      .device { margin-top: 16px; padding-top: 16px; border-top: 1px solid #e5e8e6; font-size: 12px; color: #7b847f; }
      .status { display: flex; align-items: center; gap: 8px; margin-top: 20px; font-size: 13px; color: #53605a; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #d69e2e; box-shadow: 0 0 0 5px rgba(214, 158, 46, .13); }
      .status.approved .dot { background: #0d9a75; box-shadow: 0 0 0 5px rgba(13, 154, 117, .13); }
      .status.rejected .dot { background: #d14545; box-shadow: 0 0 0 5px rgba(209, 69, 69, .13); }
      @media (prefers-color-scheme: dark) {
        body { background: #101412; color: #edf2ef; }
        .card { background: #171c19; border-color: #303834; box-shadow: 0 24px 70px rgba(0, 0, 0, .35); }
        p, .status { color: #aab5af; }
        .brand-logo { color: #edf2ef; }
        .code { background: #111714; border-color: #36423c; color: #66d7b7; }
        .device { border-color: #303834; color: #89958f; }
      }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="brand">
        ${purescienceLogo}
        <div class="brand-name">PureScience</div>
      </div>
      <h1>${escapeHtml(s.heading)}</h1>
      <p>${escapeHtml(s.intro)}</p>
      <div class="code" aria-label="${escapeHtml(s.codeLabel)}">${code}</div>
      <p>${escapeHtml(s.shareNote)}</p>
      <div class="device">${browser} · ${platform}</div>
      <div id="status" class="status"><span class="dot"></span><span>${escapeHtml(s.waiting)}</span></div>
    </main>
    <script nonce="${nonce}">
      const statusNode = document.getElementById('status');
      const expiry = ${params.expiresAt};
      let stopped = false;
      const setStatus = (kind, message) => {
        statusNode.className = 'status ' + kind;
        statusNode.querySelector('span:last-child').textContent = message;
      };
      const poll = async () => {
        if (stopped) return;
        if (Date.now() >= expiry) {
          setStatus('rejected', ${JSON.stringify(s.expired)});
          return;
        }
        try {
          const response = await fetch('${REMOTE_PAIR_STATUS_PATH}', { cache: 'no-store', credentials: 'same-origin' });
          const result = await response.json();
          if (result.status === 'approved') {
            stopped = true;
            setStatus('approved', ${JSON.stringify(s.approved)});
            window.setTimeout(() => window.location.replace('/'), 300);
            return;
          }
          if (result.status === 'rejected') {
            stopped = true;
            setStatus('rejected', ${JSON.stringify(s.rejected)});
            return;
          }
          if (result.status === 'expired') {
            stopped = true;
            setStatus('rejected', ${JSON.stringify(s.expired)});
            return;
          }
        } catch { /* retry while the home computer reconnects */ }
        window.setTimeout(poll, 1200);
      };
      poll();
    </script>
  </body>
</html>`
  }
}
