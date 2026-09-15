import { useState } from 'react'
import type { Components } from 'streamdown'

import { useLanguage } from '@/i18n'
import { isRemoteMediaSource, remoteMediaHost } from './remote-media-source'

// Agent Markdown can reference an image by URL, and a browser fetches it the moment it renders — which
// tells that third-party host who is reading this conversation (IP, user agent, timing). A remote image
// therefore waits for a deliberate click; what the reader needs to decide is shown instead: the host and
// the fact that loading it is what discloses the visit.
//
// Sources that never leave this process — the app's own preview scheme, data: payloads, blobs, local
// files — load straight away: blocking those would hide the app's own figures for no privacy gain.
// eslint-disable-next-line react/prop-types -- the props are Streamdown's `Components['img']` shape.
const RemoteMediaImage: NonNullable<Components['img']> = ({ src, alt, ...rest }) => {
  const { t } = useLanguage()
  const [requested, setRequested] = useState(false)
  const source = typeof src === 'string' ? src : undefined

  if (requested || !isRemoteMediaSource(source)) {
    return <img src={src} alt={alt} {...rest} />
  }

  const host = remoteMediaHost(source ?? '')
  return (
    <span
      data-remote-media="awaiting-activation"
      title={alt}
      className="my-2 inline-flex max-w-full flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      <span className="[text-wrap:pretty]">
        {t('streamdown.remoteImageHeld').replace('{host}', host)}
      </span>
      <button
        type="button"
        className="shrink-0 rounded-md border border-border bg-background px-2 py-0.5 text-xs font-medium text-foreground hover:bg-accent"
        onClick={() => setRequested(true)}
      >
        {t('streamdown.loadRemoteImage')}
      </button>
    </span>
  )
}

export { RemoteMediaImage }
