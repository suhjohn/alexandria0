import * as React from 'react'

import { cn } from '@/lib/utils'
import { useCookie } from '@/hooks/use-cookie'

type ResizableWindowProps = React.HTMLAttributes<HTMLDivElement> & {
  defaultWidth?: number
  minWidth?: number
  storageKey?: string
  initialWidth?: number
  handleSide?: 'left' | 'right'
}

const toCssWidth = (value: number) => `${value}px`

export function ResizableWindow({
  defaultWidth = 240,
  minWidth = 160,
  storageKey = 'resizable-width',
  initialWidth,
  handleSide = 'right',
  className,
  style,
  children,
  ...props
}: ResizableWindowProps) {
  const [cookieValue, setCookie] = useCookie(
    storageKey,
    String(defaultWidth),
    initialWidth !== undefined ? String(initialWidth) : undefined,
  )
  const [dragging, setDragging] = React.useState(false)
  const [width, setWidth] = React.useState(() => {
    const parsed = Number(cookieValue)
    return !Number.isNaN(parsed) ? parsed : defaultWidth
  })

  const widthRef = React.useRef(width)
  const startX = React.useRef(0)
  const startWidth = React.useRef(width)

  widthRef.current = width

  const mergedStyle: React.CSSProperties = {
    ...style,
    width: toCssWidth(width),
    transition: dragging ? 'none' : 'width 150ms ease',
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    startX.current = event.clientX
    startWidth.current = width
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    const delta =
      handleSide === 'left'
        ? startX.current - event.clientX
        : event.clientX - startX.current
    const next = Math.max(minWidth, startWidth.current + delta)
    setWidth(next)
  }

  const handlePointerUp = () => {
    setDragging(false)
    setCookie(String(widthRef.current))
  }

  return (
    <div
      {...props}
      className={cn('relative shrink-0', className)}
      style={mergedStyle}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      {children}
      <div
        role="presentation"
        className={cn(
          'absolute inset-y-0 w-1 cursor-ew-resize hover:bg-blue-ios/50 active:bg-blue-ios transition-colors',
          handleSide === 'left' ? 'left-0' : 'right-0',
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  )
}
