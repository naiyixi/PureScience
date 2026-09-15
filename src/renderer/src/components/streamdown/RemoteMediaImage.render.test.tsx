// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { RemoteMediaImage } from './RemoteMediaImage'
import { isRemoteMediaSource, remoteMediaHost } from './remote-media-source'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const render = (src: string | undefined, alt = 'figure'): void => {
  act(() => {
    root.render(<RemoteMediaImage src={src} alt={alt} />)
  })
}

describe('RemoteMediaImage', () => {
  it('treats only http(s) sources as a disclosure to another host', () => {
    expect(isRemoteMediaSource('https://evil.example/track.png')).toBe(true)
    expect(isRemoteMediaSource('  http://evil.example/track.png  ')).toBe(true)
    // Anything already inside this process is not a disclosure.
    expect(isRemoteMediaSource('purescience-preview://artifact/figure.png')).toBe(false)
    expect(isRemoteMediaSource('data:image/png;base64,AAAA')).toBe(false)
    expect(isRemoteMediaSource('blob:app/1234')).toBe(false)
    // A scheme-less source resolves against the app page, not the network.
    expect(isRemoteMediaSource('./relative/figure.png')).toBe(false)
    expect(isRemoteMediaSource(undefined)).toBe(false)
    expect(isRemoteMediaSource('   ')).toBe(false)
  })

  it('does not fetch a remote image until the reader asks, and names the host', () => {
    render('https://evil.example/track.png?u=1')

    expect(container.querySelector('img')).toBeNull()
    const held = container.querySelector('[data-remote-media="awaiting-activation"]')
    expect(held).not.toBeNull()
    // What the reader needs to decide is on screen: whose host, and that loading is the disclosure.
    expect(held?.textContent).toContain('evil.example')
    expect(held?.textContent).toContain('Remote image from evil.example')
    expect(container.querySelector('button')?.textContent).toBe('Load remote image')
  })

  it('loads that image unchanged once the reader clicks', () => {
    render('https://evil.example/track.png')

    act(() => container.querySelector<HTMLButtonElement>('button')?.click())

    const image = container.querySelector<HTMLImageElement>('img')
    expect(image?.getAttribute('src')).toBe('https://evil.example/track.png')
    expect(image?.getAttribute('alt')).toBe('figure')
    expect(container.querySelector('[data-remote-media]')).toBeNull()
  })

  it("renders the app's own media immediately, without a hold", () => {
    render('purescience-preview://artifact/figure.png')

    expect(container.querySelector<HTMLImageElement>('img')).not.toBeNull()
    expect(container.querySelector('[data-remote-media]')).toBeNull()
  })

  it('names an unparseable source instead of inventing a host', () => {
    expect(remoteMediaHost('https://[bad')).toBe('https://[bad')
    expect(remoteMediaHost('https://good.example/x.png')).toBe('good.example')
  })
})
