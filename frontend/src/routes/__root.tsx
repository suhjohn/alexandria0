import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools'
import { TanStackDevtools } from '@tanstack/react-devtools'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'

import appCss from '../styles.css?url'
import { THEME_PRESETS } from '../components/epubreader_v2/types'
import { useReaderSettings } from '../lib/reader-settings'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1',
      },
      {
        title: 'Alexandria0',
      },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
    ],
  }),

  shellComponent: RootDocument,
})

function RootDocument({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 1000 * 60 * 5, // 5 minutes
            refetchOnWindowFocus: false,
          },
        },
      }),
  )

  const readerSettings = useReaderSettings()
  const preset = THEME_PRESETS[readerSettings.themePreset]
  const paper = preset.bg
  const ink = preset.fg
  // Derive all colors from paper/ink for natural harmony
  const isDark = readerSettings.theme === 'dark'

  // paperDeep: subtle depth layer (slightly toward ink)
  const paperDeep = mixHex(paper, ink, isDark ? 0.06 : 0.03)

  // accentSoft: subtle tint for borders, dividers (closer to paper)
  const accentSoft = mixHex(paper, ink, isDark ? 0.18 : 0.12)

  // accent: mid-tone for interactive elements, stronger presence
  const accent = mixHex(paper, ink, isDark ? 0.35 : 0.28)

  const themeStyle = {
    colorScheme: readerSettings.theme === 'dark' ? 'dark' : 'light',
    '--ink': ink,
    '--paper': paper,
    '--paper-deep': paperDeep,
    '--accent': accent,
    '--accent-soft': accentSoft,
    '--border': accentSoft,
    '--popover': paper,
    '--popover-foreground': ink,
  } as React.CSSProperties

  return (
    <html lang="en" suppressHydrationWarning style={themeStyle}>
      <head>
        <HeadContent />
      </head>
      <body suppressHydrationWarning>
        <QueryClientProvider client={queryClient}>
          {children}
          {/* <TanStackDevtools
            config={{
              position: 'bottom-right',
            }}
            plugins={[
              {
                name: 'Tanstack Router',
                render: <TanStackRouterDevtoolsPanel />,
              },
            ]}
          /> */}
        </QueryClientProvider>
        <Scripts />
      </body>
    </html>
  )
}

function clamp01(n: number) {
  return Math.max(0, Math.min(1, n))
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const raw = hex.replace('#', '').trim()
  const normalized =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => `${c}${c}`)
          .join('')
      : raw
  if (!/^[0-9a-f]{6}$/i.test(normalized)) return null
  const int = Number.parseInt(normalized, 16)
  return {
    r: (int >> 16) & 0xff,
    g: (int >> 8) & 0xff,
    b: int & 0xff,
  }
}

function rgbToHex(rgb: { r: number; g: number; b: number }) {
  const toHex = (n: number) => n.toString(16).padStart(2, '0')
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`
}

function mixHex(a: string, b: string, t: number) {
  const aa = hexToRgb(a)
  const bb = hexToRgb(b)
  if (!aa || !bb) return a
  const tt = clamp01(t)
  return rgbToHex({
    r: Math.round(aa.r + (bb.r - aa.r) * tt),
    g: Math.round(aa.g + (bb.g - aa.g) * tt),
    b: Math.round(aa.b + (bb.b - aa.b) * tt),
  })
}
