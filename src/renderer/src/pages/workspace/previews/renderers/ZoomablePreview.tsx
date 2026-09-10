import { useState } from 'react'
import { Shrink, ZoomIn, ZoomOut } from 'lucide-react'
import {
  TransformComponent,
  TransformWrapper,
  useControls,
  useTransformEffect
} from 'react-zoom-pan-pinch'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const prefersReducedMotion = (): boolean =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true

const PreviewZoomControls = ({ reduceMotion }: { reduceMotion: boolean }): React.JSX.Element => {
  const { zoomIn, zoomOut, resetTransform } = useControls()
  const [scalePercent, setScalePercent] = useState(100)
  useTransformEffect(({ state }) => {
    // Keep the readout in lockstep with every interaction (wheel, pan inertia, double-click reset).
    setScalePercent(Math.round(state.scale * 100))
  })
  const actions = [
    { label: 'Zoom in', icon: ZoomIn, onClick: () => zoomIn() },
    { label: 'Zoom out', icon: ZoomOut, onClick: () => zoomOut() },
    {
      label: 'Reset zoom',
      icon: Shrink,
      onClick: () => resetTransform(reduceMotion ? 0 : undefined)
    }
  ]

  return (
    <TooltipProvider delayDuration={300}>
      <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 rounded-md border border-border-300/50 bg-bg-000/90 p-1 shadow-sm backdrop-blur">
        <span
          aria-live="polite"
          aria-label="Zoom level"
          data-testid="zoom-level"
          className="px-1 text-[11px] tabular-nums text-text-100"
        >
          {scalePercent}%
        </span>
        {actions.map(({ label, icon: Icon, onClick }) => (
          <Tooltip key={label}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-text-100 hover:text-text-000"
                aria-label={label}
                onClick={onClick}
              >
                <Icon aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}

const ZoomablePreview = ({
  children,
  resetKey
}: {
  children: React.ReactNode
  // Changing this (e.g. switching files) remounts the transform wrapper so zoom/pan never carries
  // over from the previous figure.
  resetKey?: string
}): React.JSX.Element => {
  const reduceMotion = prefersReducedMotion()

  return (
    <TransformWrapper
      key={resetKey}
      minScale={1}
      maxScale={8}
      centerOnInit
      zoomAnimation={{ disabled: reduceMotion }}
      doubleClick={reduceMotion ? { mode: 'reset', animationTime: 0 } : { mode: 'reset' }}
      wheel={{
        step: 0.2,
        activationKeys: (keys) => keys.includes('Control') || keys.includes('Meta')
      }}
      panning={{ velocityDisabled: true }}
    >
      <PreviewZoomControls reduceMotion={reduceMotion} />
      <TransformComponent
        wrapperClass="!size-full cursor-grab active:cursor-grabbing"
        contentClass="!size-full"
      >
        {children}
      </TransformComponent>
    </TransformWrapper>
  )
}

export { ZoomablePreview }
