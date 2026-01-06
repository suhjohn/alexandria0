import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bot,
  Check,
  Chrome,
  ChevronLeft,
  History,
  KeyRound,
  LogIn,
  LogOut,
  Loader,
  Loader2,
  MessageSquarePlus,
  Palette,
  PanelLeft,
  PanelLeftOpen,
  PanelRight,
  PanelRightOpen,
  Search,
  Settings,
  X,
} from 'lucide-react'
import { IoLibraryOutline, IoLogoGoogle } from 'react-icons/io5'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { getBook, searchBooks, type Book } from '@/data/books'
import type {
  EpubReaderV2Handle,
  EpubReaderV2Status,
} from '@/components/epubreader_v2'
import type { EpubReaderV2BookMetadata } from '@/components/epubreader_v2/types'
import type { EpubReaderV2ThemePreset } from '@/components/epubreader_v2/types'
import { THEME_PRESETS } from '@/components/epubreader_v2/types'
import { apiBaseUrl, getMe, logout } from '@/data/auth'
import { EpubReaderV2 } from '@/components/epubreader_v2'
import { ResizableWindow } from '@/components/ui/resizable-window'
import { ChatSidePanel } from '@/components/chat/ChatSidePanel'
import { getChatDb } from '@/lib/chat-db'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  DEFAULT_READER_SETTINGS,
  setReaderSettings,
  updateReaderSettings,
  useReaderSettings,
} from '@/lib/reader-settings'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import { getCookieValue, safeDecodeCookieValue } from '@/lib/cookies'
import { useKeybindings } from '@/hooks/use-keybindings'
import { useInfiniteCursorQuery } from '@/hooks/use-infinite-cursor-query'

const LIBRARY_PANEL_WIDTH_COOKIE = 'library-panel-width'
const LIBRARY_PANEL_VISIBLE_COOKIE = 'library-panel-visible'
const CHAT_PANEL_WIDTH_COOKIE = 'chat-panel-width'
const CHAT_PANEL_VISIBLE_COOKIE = 'chat-panel-visible'
const SELECTED_BOOK_COOKIE = 'selected-book-id'
const DEFAULT_PANEL_WIDTH = 240
const DEFAULT_CHAT_PANEL_WIDTH = 360
const SELECTED_BOOK_MAX_AGE = 60 * 60 * 24 * 30
const PANEL_VISIBLE_MAX_AGE = 60 * 60 * 24 * 365 // 1 year

export const Route = createFileRoute('/')({
  component: App,
  loader: async () => {
    let initialWidth = DEFAULT_PANEL_WIDTH
    let initialSelectedBookId: string | null = null
    let initialPanelVisible = true
    let initialChatWidth = DEFAULT_CHAT_PANEL_WIDTH
    let initialChatVisible = false

    if (import.meta.env.SSR) {
      const { getRequest } = await import('@tanstack/react-start/server')
      const req = getRequest()
      const raw = getCookieValue(
        req.headers.get('cookie'),
        LIBRARY_PANEL_WIDTH_COOKIE,
      )
      if (raw) {
        const parsed = Number(safeDecodeCookieValue(raw))
        if (!Number.isNaN(parsed)) {
          initialWidth = parsed
        }
      }

      const visibleRaw = getCookieValue(
        req.headers.get('cookie'),
        LIBRARY_PANEL_VISIBLE_COOKIE,
      )
      if (visibleRaw) {
        const decoded = safeDecodeCookieValue(visibleRaw)
        initialPanelVisible = decoded !== 'false'
      }

      const chatWidthRaw = getCookieValue(
        req.headers.get('cookie'),
        CHAT_PANEL_WIDTH_COOKIE,
      )
      if (chatWidthRaw) {
        const parsed = Number(safeDecodeCookieValue(chatWidthRaw))
        if (!Number.isNaN(parsed)) {
          initialChatWidth = parsed
        }
      }

      const chatVisibleRaw = getCookieValue(
        req.headers.get('cookie'),
        CHAT_PANEL_VISIBLE_COOKIE,
      )
      if (chatVisibleRaw) {
        const decoded = safeDecodeCookieValue(chatVisibleRaw)
        initialChatVisible = decoded !== 'false'
      }

      const selectedRaw = getCookieValue(
        req.headers.get('cookie'),
        SELECTED_BOOK_COOKIE,
      )
      if (selectedRaw) {
        initialSelectedBookId = safeDecodeCookieValue(selectedRaw)
      }
    }

    return {
      initialWidth,
      initialSelectedBookId,
      initialPanelVisible,
      initialChatWidth,
      initialChatVisible,
    }
  },
})

function App() {
  const {
    initialWidth,
    initialSelectedBookId,
    initialPanelVisible,
    initialChatWidth,
    initialChatVisible,
  } = Route.useLoaderData()
  const queryClient = useQueryClient()
  const isMac = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    const platform =
      (navigator as any).userAgentData?.platform ??
      navigator.platform ??
      navigator.userAgent
    return /mac/i.test(String(platform))
  }, [])
  const readerSettings = useReaderSettings()
  const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false)
  const [settingsView, setSettingsView] = useState<'menu' | 'reader' | 'ai'>(
    'menu',
  )
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)
  const [commandPaletteQuery, setCommandPaletteQuery] = useState('')

  const [geminiApiKey, setGeminiApiKey] = useState<string | null>(null)
  const [geminiKeyDraft, setGeminiKeyDraft] = useState('')
  const [geminiKeyError, setGeminiKeyError] = useState<string | null>(null)
  const [isSavingGeminiKey, setIsSavingGeminiKey] = useState(false)

  useEffect(() => {
    void (async () => {
      try {
        const db = await getChatDb()
        const stored = db.getApiKey()
        setGeminiApiKey(stored)
        setGeminiKeyDraft(stored ?? '')
      } catch {
        // ignore
      }
    })()
  }, [])

  const saveGeminiKey = async () => {
    setGeminiKeyError(null)
    setIsSavingGeminiKey(true)
    try {
      const nextKey = geminiKeyDraft.trim() || null
      const db = await getChatDb()
      db.setApiKey(nextKey)
      setGeminiApiKey(nextKey)
    } catch (err) {
      setGeminiKeyError(
        err instanceof Error ? err.message : 'Failed to save API key.',
      )
    } finally {
      setIsSavingGeminiKey(false)
    }
  }

  useEffect(() => {
    if (!settingsPopoverOpen) return

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target
      if (target instanceof HTMLIFrameElement) {
        setSettingsPopoverOpen(false)
      }
    }

    document.addEventListener('focusin', onFocusIn, true)
    return () => {
      document.removeEventListener('focusin', onFocusIn, true)
    }
  }, [settingsPopoverOpen])

  const { data: me } = useQuery({
    queryKey: ['me'],
    queryFn: getMe,
  })

  const logoutMutation = useMutation({
    mutationFn: logout,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['me'] })
    },
  })

  const redirectAfterLogin =
    typeof window === 'undefined'
      ? '/'
      : `${window.location.pathname}${window.location.search}`
  const googleLoginHref = `${apiBaseUrl()}/auth/google/start?redirect=${encodeURIComponent(redirectAfterLogin)}`

  const [libraryScope, setLibraryScope] = useState<'public' | 'personal'>(
    'public',
  )
  const [leftPanelView, setLeftPanelView] = useState<'library' | 'books'>(
    'books',
  )
  const [libraryQuery, setLibraryQuery] = useState('')
  const libraryLimit = 50
  const booksQuery = useInfiniteCursorQuery<Book>({
    queryKey: ['books', 'search', libraryScope, libraryQuery],
    limit: libraryLimit,
    enabled: libraryScope === 'public' || Boolean(me),
    queryFn: ({ cursor, limit }) =>
      searchBooks({ query: libraryQuery, cursor, limit, scope: libraryScope }),
  })
  const fetchNextBooksPage = booksQuery.fetchNextPage
  const hasNextBooksPage = booksQuery.hasNextPage
  const isFetchingNextBooksPage = booksQuery.isFetchingNextPage

  const books = booksQuery.items
  const listScrollRef = useRef<HTMLDivElement | null>(null)
  const listCount = books.length
  const showLoadMoreRow = hasNextBooksPage
  const loadMoreInFlightRef = useRef(false)
  const rowVirtualizer = useVirtualizer({
    count: showLoadMoreRow ? listCount + 1 : listCount,
    getScrollElement: () => listScrollRef.current,
    estimateSize: () => 24,
    overscan: 10,
  })
  const [selectedBookId, setSelectedBookId] = useState<string | null>(() => {
    if (initialSelectedBookId) {
      return initialSelectedBookId
    }

    if (typeof document === 'undefined') {
      return null
    }

    const selectedRaw = getCookieValue(document.cookie, SELECTED_BOOK_COOKIE)
    return selectedRaw ? safeDecodeCookieValue(selectedRaw) : null
  })
  const { data: selectedBook, isLoading: selectedBookLoading } =
    useQuery<Book | null>({
      queryKey: ['book', selectedBookId],
      enabled: Boolean(selectedBookId),
      queryFn: async () => (selectedBookId ? getBook(selectedBookId) : null),
    })
  const [readerStatus, setReaderStatus] = useState<EpubReaderV2Status>('idle')

  const [isPanelVisible, setIsPanelVisible] = useState<boolean>(() => {
    if (typeof initialPanelVisible === 'boolean') {
      return initialPanelVisible
    }

    if (typeof document === 'undefined') {
      return true
    }

    const visibleRaw = getCookieValue(
      document.cookie,
      LIBRARY_PANEL_VISIBLE_COOKIE,
    )
    return visibleRaw ? safeDecodeCookieValue(visibleRaw) !== 'false' : true
  })

  const [isChatPanelVisible, setIsChatPanelVisible] = useState<boolean>(() => {
    if (typeof initialChatVisible === 'boolean') {
      return initialChatVisible
    }

    if (typeof document === 'undefined') {
      return false
    }

    const visibleRaw = getCookieValue(
      document.cookie,
      CHAT_PANEL_VISIBLE_COOKIE,
    )
    return visibleRaw ? safeDecodeCookieValue(visibleRaw) !== 'false' : false
  })

  type ReaderSelectionToken = {
    bookId: string
    bookTitle: string
    spineIndex: number
    startPage: number
    startIndex: number
    endPage: number
    endIndex: number
    selectedText: string
  }

  const [readerSelectionToken, setReaderSelectionToken] =
    useState<ReaderSelectionToken | null>(null)
  const [readerTocToken, setReaderTocToken] = useState<{
    bookId: string
    bookTitle: string
    metadata?: EpubReaderV2BookMetadata
    chapters: Array<{
      title: string
      href: string
      spineIndex: number
      depth: number
    }>
  } | null>(null)
  const [chatPendingInsert, setChatPendingInsert] = useState<{
    id: string
    kind: 'bookRef'
    target?: 'current' | 'lastSelected' | 'newConversation'
    bookId: string
    bookTitle: string
    startPage: number
    startIndex: number
    endPage: number
    endIndex: number
    selectedText: string
    spineIndex: number
  } | null>(null)
  const [chatPendingConversationAction, setChatPendingConversationAction] =
    useState<{
      id: string
      action: 'lastSelected' | 'newConversation'
    } | null>(null)
  const [chatPendingHistoryToggle, setChatPendingHistoryToggle] = useState<{
    id: string
  } | null>(null)
  const [chatFocusRequestId, setChatFocusRequestId] = useState<string | null>(
    null,
  )
  const [pendingReaderNavigation, setPendingReaderNavigation] = useState<{
    id: string
    bookId: string
    spineIndex?: number
    textOffset?: number
    href?: string
  } | null>(null)
  const readerRef = useRef<EpubReaderV2Handle | null>(null)
  const getCurrentReaderPage = useCallback(
    () => readerRef.current?.getVisiblePage?.() ?? null,
    [],
  )

  const createInsertId = () => {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
      return crypto.randomUUID()
    }
    return `ins_${Math.random().toString(16).slice(2)}_${Date.now()}`
  }

  const setSelectedBookCookie = (bookId: string | null) => {
    if (typeof document === 'undefined') return

    if (!bookId) {
      document.cookie = `${SELECTED_BOOK_COOKIE}=; Max-Age=0; Path=/`
      return
    }

    const encoded = encodeURIComponent(bookId)
    document.cookie = `${SELECTED_BOOK_COOKIE}=${encoded}; Max-Age=${SELECTED_BOOK_MAX_AGE}; Path=/`
  }

  const updateSelectedBook = (bookId: string | null) => {
    if (bookId && bookId === selectedBookId) {
      // Avoid forcing the reader into a loading state when we're already on the
      // target book (e.g. navigating from a chat chapter chip).
      setSelectedBookCookie(bookId)
      return
    }
    setReaderStatus('idle')
    setSelectedBookId(bookId)
    setSelectedBookCookie(bookId)
  }

  const togglePanelVisibility = () => {
    const newValue = !isPanelVisible
    setIsPanelVisible(newValue)

    if (typeof document === 'undefined') return
    const encoded = encodeURIComponent(String(newValue))
    document.cookie = `${LIBRARY_PANEL_VISIBLE_COOKIE}=${encoded}; Max-Age=${PANEL_VISIBLE_MAX_AGE}; Path=/`
  }

  const toggleChatPanelVisibility = () => {
    const newValue = !isChatPanelVisible
    setIsChatPanelVisible(newValue)
    if (newValue) setChatFocusRequestId(createInsertId())

    if (typeof document === 'undefined') return
    const encoded = encodeURIComponent(String(newValue))
    document.cookie = `${CHAT_PANEL_VISIBLE_COOKIE}=${encoded}; Max-Age=${PANEL_VISIBLE_MAX_AGE}; Path=/`
  }

  const setChatPanelVisible = (nextVisible: boolean) => {
    setIsChatPanelVisible(nextVisible)
    if (nextVisible) setChatFocusRequestId(createInsertId())
    if (typeof document === 'undefined') return
    const encoded = encodeURIComponent(String(nextVisible))
    document.cookie = `${CHAT_PANEL_VISIBLE_COOKIE}=${encoded}; Max-Age=${PANEL_VISIBLE_MAX_AGE}; Path=/`
  }

  const closeCommandPalette = () => {
    setCommandPaletteOpen(false)
    setCommandPaletteQuery('')
  }

  const toggleCommandPalette = () => {
    if (commandPaletteOpen) {
      closeCommandPalette()
      return
    }
    setCommandPaletteQuery('')
    setCommandPaletteOpen(true)
  }

  const insertSelectionToChat = (
    selection: ReaderSelectionToken,
    target: 'current' | 'newConversation',
  ) => {
    const nextInsertId = createInsertId()
    setChatPanelVisible(true)
    setChatPendingInsert({
      id: nextInsertId,
      kind: 'bookRef',
      target,
      bookId: selection.bookId,
      bookTitle: selection.bookTitle,
      startPage: selection.startPage,
      startIndex: selection.startIndex,
      endPage: selection.endPage,
      endIndex: selection.endIndex,
      selectedText: selection.selectedText,
      spineIndex: selection.spineIndex,
    })
    setReaderSelectionToken(null)
  }

  const handleModI = () => {
    if (readerSelectionToken) {
      insertSelectionToChat(readerSelectionToken, 'current')
      return
    }

    if (isChatPanelVisible) {
      setChatPanelVisible(false)
      return
    }

    setChatPanelVisible(true)
  }

  const handleModShiftI = () => {
    if (readerSelectionToken) {
      insertSelectionToChat(readerSelectionToken, 'newConversation')
      return
    }

    if (isChatPanelVisible) {
      setChatPanelVisible(false)
      return
    }

    setChatPanelVisible(true)
    setChatPendingConversationAction({
      id: createInsertId(),
      action: 'newConversation',
    })
  }

  const startNewChat = () => {
    if (readerSelectionToken) {
      insertSelectionToChat(readerSelectionToken, 'newConversation')
      return
    }

    setChatPanelVisible(true)
    setChatPendingConversationAction({
      id: createInsertId(),
      action: 'newConversation',
    })
  }

  const handleModShiftH = () => {
    setChatPanelVisible(true)
    setChatPendingHistoryToggle({ id: createInsertId() })
  }

  const openGeminiApiKeySettings = () => {
    setSettingsPopoverOpen(true)
    setSettingsView('ai')
  }

  const openThemesAndSettings = () => {
    setSettingsPopoverOpen(true)
    setSettingsView('reader')
  }

  const handleNavigateBookRef = (
    payload:
      | { bookId: string; spineIndex: number; textOffset: number }
      | { bookId: string; href: string },
  ) => {
    const stripVariantSuffix = (raw: string) => {
      const id = raw.trim()
      const idx = id.lastIndexOf('@')
      if (idx < 0) return id
      const base = id.slice(0, idx)
      const variant = id.slice(idx + 1)
      if (!base) return id
      if (
        variant === 'original' ||
        variant === 'modernify' ||
        variant.startsWith('translate_')
      )
        return base
      return id
    }

    const resolveTargetBookId = (raw: string) => {
      const id = raw.trim()
      if (!id) return null

      const stripped = stripVariantSuffix(id)
      const candidates = [stripped, id]

      for (const candidate of candidates) {
        if (!candidate) continue
        if (books.some((b) => b.id === candidate)) return candidate
      }

      // Back-compat / defensive: some older chips may have stored a URL (original or transformed)
      // instead of the library book id.
      if (/^https?:\/\//i.test(id)) {
        const found = books.find((b) => {
          if (b.url === id) return true
          const urls = Object.values(b.transformation_data).flat()
          return urls.includes(id)
        })
        if (found) return found.id
      }

      return null
    }

    const resolveCanonicalVersionedBookId = (
      raw: string,
      resolvedId: string,
    ) => {
      const id = raw.trim()
      if (!id) return resolvedId

      // If this already looks like a versioned id for an existing book, keep it.
      const stripped = stripVariantSuffix(id)
      if (books.some((b) => b.id === stripped)) return id
      if (books.some((b) => b.id === id)) return id

      if (/^https?:\/\//i.test(id)) {
        const found = books.find((b) => b.id === resolvedId)
        if (found) {
          const transformData = found.transformation_data as Record<
            string,
            Array<string> | undefined
          >
          const match = Object.entries(transformData).find(([, urls]) =>
            (urls ?? []).includes(id),
          )
          const candidate = String(match?.[0] ?? '').trim()
          const variant =
            candidate === 'modernify' || candidate.startsWith('translate_')
              ? candidate
              : 'original'
          return `${found.id}@${variant}`
        }
      }

      return resolvedId
    }

    const targetBookId = resolveTargetBookId(payload.bookId)
    if (!targetBookId) return
    const canonicalBookId = resolveCanonicalVersionedBookId(
      payload.bookId,
      targetBookId,
    )

    updateSelectedBook(targetBookId)
    setPendingReaderNavigation({
      id: createInsertId(),
      bookId: canonicalBookId,
      ...(typeof (payload as any).href === 'string'
        ? { href: (payload as any).href as string }
        : {
            spineIndex: (payload as any).spineIndex as number,
            textOffset: (payload as any).textOffset as number,
          }),
    })
  }

  const runCommandPaletteAction = (action: () => void) => {
    closeCommandPalette()
    action()
  }

  useKeybindings(
    [
      {
        command: 'ui.toggleLeftPanel',
        keys: 'Mod+B',
        allowInInput: true,
        handler: () => togglePanelVisibility(),
      },
      {
        command: 'ui.toggleRightPanel',
        keys: 'Mod+I',
        allowWhenDefaultPrevented: true,
        stopPropagation: true,
        handler: () => handleModI(),
      },
      {
        command: 'ui.newChatFromSelection',
        keys: 'Mod+Shift+I',
        allowInInput: true,
        allowWhenDefaultPrevented: true,
        stopPropagation: true,
        handler: () => handleModShiftI(),
      },
      {
        command: 'ui.toggleChatHistory',
        keys: 'Mod+Shift+H',
        allowInInput: true,
        allowWhenDefaultPrevented: true,
        stopPropagation: true,
        handler: () => handleModShiftH(),
      },
      {
        command: 'ui.commandPalette',
        keys: 'Mod+K',
        allowInInput: true,
        allowWhenDefaultPrevented: true,
        stopPropagation: true,
        handler: () => toggleCommandPalette(),
      },
      {
        command: 'ui.closeCommandPalette',
        keys: 'Escape',
        allowInInput: true,
        when: () => commandPaletteOpen,
        handler: () => closeCommandPalette(),
      },
    ],
    { includeIframes: true },
  )

  const isLibraryLoading = booksQuery.isLoading && books.length === 0
  const isSelectedBookLoading =
    Boolean(selectedBookId) && selectedBookLoading && !selectedBook
  const isReaderLoading =
    Boolean(selectedBook) &&
    readerStatus !== 'ready' &&
    readerStatus !== 'error'
  const showBlockingLoader =
    isLibraryLoading || isSelectedBookLoading || isReaderLoading

  const requestNextBooksPage = useCallback(() => {
    if (!hasNextBooksPage || isFetchingNextBooksPage) return
    if (loadMoreInFlightRef.current) return
    loadMoreInFlightRef.current = true
    void fetchNextBooksPage().finally(() => {
      loadMoreInFlightRef.current = false
    })
  }, [fetchNextBooksPage, hasNextBooksPage, isFetchingNextBooksPage])

  return (
    <div className="min-h-screen bg-[color:var(--paper-deep)] text-[color:var(--ink)]">
      <CommandDialog
        open={commandPaletteOpen}
        onOpenChange={(open) => {
          setCommandPaletteOpen(open)
          if (!open) setCommandPaletteQuery('')
        }}
      >
        <CommandInput
          value={commandPaletteQuery}
          onValueChange={setCommandPaletteQuery}
          placeholder={
            isMac ? 'Type a command… (⌘K)' : 'Type a command… (Ctrl+K)'
          }
        />
        <CommandList>
          <CommandEmpty>No matches.</CommandEmpty>
          <CommandGroup heading="Panels">
            <CommandItem
              value="left panel library"
              onSelect={() => runCommandPaletteAction(togglePanelVisibility)}
            >
              <PanelLeft className="text-[color:var(--ink)]/70" />
              <span>
                {isPanelVisible ? 'Hide left panel' : 'Show left panel'}
              </span>
              <CommandShortcut>{isMac ? '⌘ B' : 'Ctrl B'}</CommandShortcut>
            </CommandItem>
            <CommandItem
              value="right panel chat"
              onSelect={() =>
                runCommandPaletteAction(toggleChatPanelVisibility)
              }
            >
              <PanelRight className="text-[color:var(--ink)]/70" />
              <span>
                {isChatPanelVisible ? 'Hide right panel' : 'Show right panel'}
              </span>
              <CommandShortcut>{isMac ? '⌘ I' : 'Ctrl I'}</CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Chat">
            <CommandItem
              value="new chat conversation"
              onSelect={() => runCommandPaletteAction(startNewChat)}
            >
              <MessageSquarePlus className="text-[color:var(--ink)]/70" />
              <span>New chat</span>
              <CommandShortcut>
                {isMac ? '⌘ ⇧ I' : 'Ctrl Shift I'}
              </CommandShortcut>
            </CommandItem>
            <CommandItem
              value="history chat conversations"
              onSelect={() => runCommandPaletteAction(handleModShiftH)}
            >
              <History className="text-[color:var(--ink)]/70" />
              <span>History</span>
              <CommandShortcut>
                {isMac ? '⌘ ⇧ H' : 'Ctrl Shift H'}
              </CommandShortcut>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Settings">
            <CommandItem
              value="gemini api key ai"
              onSelect={() => runCommandPaletteAction(openGeminiApiKeySettings)}
            >
              <KeyRound className="text-[color:var(--ink)]/70" />
              <span>Gemini API key</span>
            </CommandItem>
            <CommandItem
              value="themes settings reader"
              onSelect={() => runCommandPaletteAction(openThemesAndSettings)}
            >
              <Palette className="text-[color:var(--ink)]/70" />
              <span>Themes & settings</span>
            </CommandItem>
          </CommandGroup>
          <CommandGroup heading="Account">
            {me ? (
              <CommandItem
                value="logout sign out"
                onSelect={() =>
                  runCommandPaletteAction(() => logoutMutation.mutate())
                }
              >
                <LogOut className="text-[color:var(--ink)]/70" />
                <span>Log out</span>
              </CommandItem>
            ) : (
              <>
                <CommandItem
                  value="login google sign in oauth"
                  onSelect={() =>
                    runCommandPaletteAction(() => {
                      window.location.href = googleLoginHref
                    })
                  }
                >
                  <IoLogoGoogle className="text-[color:var(--ink)]/70" />
                  <span>Sign in with Google</span>
                </CommandItem>
              </>
            )}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
      <header className="h-9 px-4 flex items-center justify-between border-b border-[color:var(--accent-soft)] bg-[color:var(--paper)]">
        <div className="flex items-center gap-2 shrink-0">
          <IoLibraryOutline className="w-4 h-4 text-[color:var(--accent)]" />
          <span className="text-[10px] text-[color:var(--accent)]">
            Alexandria0
          </span>
        </div>
        <div className="flex-1 px-3">
          <div className="relative max-w-sm mx-auto">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[color:var(--ink)]/50" />
            <input
              value={libraryQuery}
              onChange={(e) => {
                const next = e.target.value
                setLibraryQuery(next)
                listScrollRef.current?.scrollTo({ top: 0 })
              }}
              placeholder="Search title or author…"
              className="w-full h-7 rounded-md border border-[color:var(--accent-soft)] bg-[color:var(--paper)] pl-7 pr-7 text-xs text-[color:var(--ink)] placeholder:text-[color:var(--ink)]/50 focus:outline-none focus:ring-2 focus:ring-[color:var(--accent-soft)]"
              type="search"
              spellCheck={false}
            />
            {libraryQuery.trim() !== '' && (
              <button
                type="button"
                onClick={() => {
                  setLibraryQuery('')
                  listScrollRef.current?.scrollTo({ top: 0 })
                }}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 hover:bg-[color:var(--paper-deep)]"
                aria-label="Clear search"
              >
                <X className="h-3.5 w-3.5 text-[color:var(--ink)]/60" />
              </button>
            )}
          </div>
        </div>
        <TooltipProvider delayDuration={250}>
          <div className="flex items-center">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={togglePanelVisibility}
                  className={[
                    'cursor-pointer p-1.5 rounded-lg transition-colors',
                    isPanelVisible
                      ? 'bg-[color:var(--paper-deep)]'
                      : 'hover:bg-[color:var(--paper-deep)]',
                  ].join(' ')}
                  aria-label="Toggle library panel"
                  aria-pressed={isPanelVisible}
                >
                  {isPanelVisible ? (
                    <PanelLeft className="w-4 h-4 text-[color:var(--ink)]" />
                  ) : (
                    <PanelLeftOpen className="w-4 h-4 text-[color:var(--ink)]/60" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="flex items-center gap-2">
                  <span>Left panel</span>
                  <kbd className="w-fit rounded border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)] px-1.5 py-0.5 font-mono text-xs text-[color:var(--ink)]/70">
                    {isMac ? '⌘ + B' : 'Ctrl+B'}
                  </kbd>
                </div>
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={toggleChatPanelVisibility}
                  className={[
                    'cursor-pointer p-1.5 rounded-lg transition-colors',
                    isChatPanelVisible
                      ? 'bg-[color:var(--paper-deep)]'
                      : 'hover:bg-[color:var(--paper-deep)]',
                  ].join(' ')}
                  aria-label="Toggle chat panel"
                  aria-pressed={isChatPanelVisible}
                >
                  {isChatPanelVisible ? (
                    <PanelRight className="w-4 h-4 text-[color:var(--ink)]" />
                  ) : (
                    <PanelRightOpen className="w-4 h-4 text-[color:var(--ink)]/60" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <div className="flex items-center gap-2">
                  <span>Right panel</span>
                  <kbd className="w-fit rounded border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)] px-1.5 py-0.5 font-mono text-xs text-[color:var(--ink)]/70">
                    {isMac ? '⌘ + I' : 'Ctrl+I'}
                  </kbd>
                </div>
              </TooltipContent>
            </Tooltip>
            <Popover
              open={settingsPopoverOpen}
              onOpenChange={(open) => {
                setSettingsPopoverOpen(open)
                if (!open) setSettingsView('menu')
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="cursor-pointer p-1.5 rounded-lg hover:bg-[color:var(--paper-deep)] transition-colors"
                  aria-label="Settings"
                >
                  <Settings className="w-4 h-4 text-[color:var(--ink)]/60" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                sideOffset={8}
                className="w-80 border-[color:var(--accent-soft)] bg-[color:var(--paper)] text-[color:var(--ink)] p-0"
              >
                {settingsView === 'menu' ? (
                  <div className="py-1">
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm hover:bg-[color:var(--paper-deep)] transition-colors"
                      onClick={() => setSettingsView('reader')}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Palette className="w-4 h-4" />
                          <span>Themes & Settings</span>
                        </div>
                        <span className="text-xs text-[color:var(--ink)]/60">
                          {THEME_PRESETS[readerSettings.themePreset].name}
                        </span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className="w-full px-3 py-2 text-left text-sm hover:bg-[color:var(--paper-deep)] transition-colors"
                      onClick={() => setSettingsView('ai')}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Bot className="w-4 h-4" />
                          <span>Gemini API Key</span>
                        </div>
                        <span className="text-xs text-[color:var(--ink)]/60">
                          {geminiApiKey ? 'key saved' : 'missing'}
                        </span>
                      </div>
                    </button>
                    <div className="mt-1 border-t border-[color:var(--accent-soft)] pt-1">
                      {me ? (
                        <>
                          <div className="px-3 py-2 text-xs text-[color:var(--ink)]/60">
                            Signed in as{' '}
                            <span className="font-medium text-[color:var(--ink)]/80">
                              {me.email}
                            </span>
                          </div>
                          <button
                            type="button"
                            className="w-full px-3 py-2 text-left text-sm hover:bg-[color:var(--paper-deep)] transition-colors"
                            onClick={() => {
                              setSettingsPopoverOpen(false)
                              logoutMutation.mutate()
                            }}
                          >
                            <div className="flex items-center gap-2">
                              <LogOut className="w-4 h-4" />
                              <span>Log out</span>
                            </div>
                          </button>
                        </>
                      ) : (
                        <>
                          <a
                            href={googleLoginHref}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-[color:var(--paper-deep)] transition-colors"
                            onClick={() => setSettingsPopoverOpen(false)}
                          >
                            <div className="flex items-center gap-2">
                              <IoLogoGoogle className="w-4 h-4" />
                              <span>Sign in with Google</span>
                            </div>
                          </a>
                        </>
                      )}
                    </div>
                  </div>
                ) : settingsView === 'reader' ? (
                  <div className="p-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="p-1 rounded-md hover:bg-[color:var(--paper-deep)] transition-colors"
                        onClick={() => setSettingsView('menu')}
                        aria-label="Back"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <div className="text-sm font-medium">
                        Themes &amp; Settings
                      </div>
                      <button
                        type="button"
                        className="ml-auto text-xs text-[color:var(--ink)]/60 hover:text-[color:var(--ink)] transition-colors"
                        onClick={() => {
                          setReaderSettings(DEFAULT_READER_SETTINGS)
                        }}
                      >
                        Reset
                      </button>
                    </div>

                    <div className="mt-3">
                      <div className="text-[10px] uppercase tracking-wider text-[color:var(--ink)]/60">
                        Theme
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        {(
                          Object.keys(
                            THEME_PRESETS,
                          ) as Array<EpubReaderV2ThemePreset>
                        ).map((preset) => {
                          const config = THEME_PRESETS[preset]
                          const active = readerSettings.themePreset === preset
                          return (
                            <button
                              key={preset}
                              type="button"
                              className={[
                                'relative rounded-lg border p-2 text-left transition-colors',
                                active
                                  ? 'border-[color:var(--accent)]'
                                  : 'border-[color:var(--accent-soft)] hover:border-[color:var(--accent)]',
                              ].join(' ')}
                              style={{
                                background: config.bg,
                                color: config.fg,
                              }}
                              onClick={() => {
                                updateReaderSettings({
                                  themePreset: preset,
                                  theme: config.theme,
                                  fontFamily: config.fontFamily,
                                })
                              }}
                              aria-pressed={active}
                            >
                              <div
                                className="text-sm leading-none"
                                style={{ fontWeight: config.fontWeight }}
                              >
                                Aa
                              </div>
                              <div className="mt-1 text-[10px] opacity-70">
                                {config.name}
                              </div>
                              {active && (
                                <Check className="absolute right-2 top-2 h-3.5 w-3.5 opacity-80" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-wider text-[color:var(--ink)]/60">
                        Text
                      </div>

                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <label className="block text-xs text-[color:var(--ink)]/70">
                            Font
                          </label>
                          <select
                            className="mt-1 w-full rounded-md border border-[color:var(--accent-soft)] bg-[color:var(--paper)] px-2 py-1 text-sm"
                            value={readerSettings.fontFamily}
                            onChange={(e) => {
                              const value = e.target
                                .value as typeof readerSettings.fontFamily
                              updateReaderSettings({ fontFamily: value })
                            }}
                          >
                            <option value="publisher">Publisher</option>
                            <option value="serif">Serif</option>
                            <option value="sans">Sans</option>
                          </select>
                        </div>

                        <div className="col-span-2">
                          <label className="block text-xs text-[color:var(--ink)]/70">
                            Font size
                          </label>
                          <div className="mt-1 flex items-center gap-2">
                            <button
                              type="button"
                              className="rounded-md border border-[color:var(--accent-soft)] px-2 py-1 text-sm hover:bg-[color:var(--paper-deep)] transition-colors"
                              onClick={() => {
                                const next = Math.max(
                                  0.7,
                                  readerSettings.fontScale - 0.05,
                                )
                                updateReaderSettings({ fontScale: next })
                              }}
                            >
                              A-
                            </button>
                            <div className="flex-1">
                              <input
                                className="w-full"
                                type="range"
                                min="0.7"
                                max="1.5"
                                step="0.05"
                                value={readerSettings.fontScale}
                                onChange={(e) =>
                                  updateReaderSettings({
                                    fontScale: Number(e.target.value),
                                  })
                                }
                              />
                            </div>
                            <button
                              type="button"
                              className="rounded-md border border-[color:var(--accent-soft)] px-2 py-1 text-sm hover:bg-[color:var(--paper-deep)] transition-colors"
                              onClick={() => {
                                const next = Math.min(
                                  1.5,
                                  readerSettings.fontScale + 0.05,
                                )
                                updateReaderSettings({ fontScale: next })
                              }}
                            >
                              A+
                            </button>
                          </div>
                        </div>

                        <div className="col-span-2">
                          <label className="block text-xs text-[color:var(--ink)]/70">
                            Line height
                          </label>
                          <div className="mt-1 flex items-center gap-2">
                            <input
                              className="w-full"
                              type="range"
                              min="1.2"
                              max="2.4"
                              step="0.05"
                              value={readerSettings.lineHeight}
                              onChange={(e) =>
                                updateReaderSettings({
                                  lineHeight: Number(e.target.value),
                                })
                              }
                            />
                            <div className="w-12 text-right text-xs text-[color:var(--ink)]/70 tabular-nums">
                              {readerSettings.lineHeight.toFixed(2)}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="mt-4">
                      <div className="text-[10px] uppercase tracking-wider text-[color:var(--ink)]/60">
                        Layout
                      </div>
                      <div className="mt-2 text-sm text-[color:var(--ink)]/70">
                        Fixed: paginated, left aligned, medium margins
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-3">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="p-1 rounded-md hover:bg-[color:var(--paper-deep)] transition-colors"
                        onClick={() => setSettingsView('menu')}
                        aria-label="Back"
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </button>
                      <div className="text-sm font-medium">AI (Gemini)</div>
                    </div>

                    <div className="mt-3 text-xs text-[color:var(--ink)]/70">
                      GEMINI_API_KEY is stored locally in SQLite.
                    </div>

                    {geminiKeyError && (
                      <div className="mt-2 text-xs text-[color:var(--accent)]">
                        {geminiKeyError}
                      </div>
                    )}

                    <div className="mt-3 flex gap-2">
                      <input
                        value={geminiKeyDraft}
                        onChange={(e) => setGeminiKeyDraft(e.target.value)}
                        placeholder="Paste your GEMINI_API_KEY…"
                        className="flex-1 min-w-0 rounded-md border border-[color:var(--accent-soft)] bg-[color:var(--paper)] px-2 py-1 text-sm"
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        onClick={() => void saveGeminiKey()}
                        disabled={isSavingGeminiKey}
                        className="shrink-0 rounded-md bg-[color:var(--accent-soft)] px-2 py-1 text-sm hover:brightness-95 disabled:opacity-60"
                      >
                        {isSavingGeminiKey ? 'Saving…' : 'Save'}
                      </button>
                    </div>

                    <div className="mt-2 text-[10px] text-[color:var(--ink)]/60">
                      Status: {geminiApiKey ? 'saved' : 'missing'}
                    </div>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </div>
        </TooltipProvider>
      </header>
      <div className="flex h-[calc(100vh-36px)]">
        {isPanelVisible && (
          <ResizableWindow
            storageKey={LIBRARY_PANEL_WIDTH_COOKIE}
            initialWidth={initialWidth}
            className="overflow-hidden border-r border-[color:var(--accent-soft)] bg-[color:var(--paper)]"
          >
            <div className="flex flex-col h-full">
              {leftPanelView === 'library' ? (
                <>
                  <div className="h-6 flex items-center px-2 text-[10px] text-[color:var(--ink)]/60 border-b border-[color:var(--accent-soft)]">
                    Library
                  </div>
                  <div className="p-1">
                    <button
                      type="button"
                      onClick={() => {
                        setLibraryScope('public')
                        setLeftPanelView('books')
                        listScrollRef.current?.scrollTo({ top: 0 })
                      }}
                      className={[
                        'w-full rounded-md px-2 py-1 text-left text-xs transition-colors',
                        libraryScope === 'public'
                          ? 'bg-[color:var(--paper-deep)] text-[color:var(--ink)]'
                          : 'text-[color:var(--ink)]/80 hover:bg-[color:var(--paper-deep)]',
                      ].join(' ')}
                      aria-pressed={libraryScope === 'public'}
                    >
                      Public
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (!me) return
                        setLibraryScope('personal')
                        setLeftPanelView('books')
                        listScrollRef.current?.scrollTo({ top: 0 })
                      }}
                      disabled={!me}
                      className={[
                        'mt-1 w-full rounded-md px-2 py-1 text-left text-xs transition-colors',
                        libraryScope === 'personal'
                          ? 'bg-[color:var(--paper-deep)] text-[color:var(--ink)]'
                          : 'text-[color:var(--ink)]/80 hover:bg-[color:var(--paper-deep)]',
                        !me ? 'opacity-50 cursor-not-allowed' : '',
                      ].join(' ')}
                      aria-pressed={libraryScope === 'personal'}
                    >
                      Personal
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="h-6 flex items-center justify-between gap-2 px-2 border-b border-[color:var(--accent-soft)] text-[10px] text-[color:var(--ink)]/60">
                    <button
                      type="button"
                      onClick={() => setLeftPanelView('library')}
                      className="flex items-center gap-1 hover:text-[color:var(--ink)] transition-colors"
                      aria-label="Back to Library"
                    >
                      <ChevronLeft className="w-3 h-3" />
                      <span className="min-w-0 truncate">
                        {libraryScope === 'public' ? 'Public' : 'Personal'}
                      </span>
                    </button>
                    <div className="flex items-center gap-2 shrink-0">
                      {booksQuery.isFetching && (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      )}
                    </div>
                  </div>

                  {libraryScope === 'personal' && !me ? (
                    <div className="px-3 py-2 text-xs text-[color:var(--ink)]/60">
                      Sign in to view your personal library.
                    </div>
                  ) : (
                    <div
                      ref={listScrollRef}
                      className="flex-1 overflow-y-auto"
                      onScroll={(e) => {
                        if (!hasNextBooksPage || isFetchingNextBooksPage) return
                        const el = e.currentTarget
                        const canScroll = el.scrollHeight > el.clientHeight + 1
                        if (!canScroll) return
                        const remaining =
                          el.scrollHeight - el.scrollTop - el.clientHeight
                        if (remaining < 140) {
                          requestNextBooksPage()
                        }
                      }}
                    >
                      {booksQuery.isLoading && books.length === 0 && (
                        <div className="flex items-center gap-2 px-3 text-[color:var(--ink)]/70 py-2 text-xs">
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Loading…
                        </div>
                      )}
                      {booksQuery.error && (
                        <div className="px-3 text-[color:var(--accent)] py-2 text-xs">
                          Failed to load books.
                        </div>
                      )}
                      {!booksQuery.isLoading &&
                        !booksQuery.error &&
                        books.length === 0 && (
                          <div className="px-3 text-[color:var(--ink)]/60 py-2 text-xs">
                            No books yet.
                          </div>
                        )}

                      {!booksQuery.isLoading && !booksQuery.error && (
                        <div
                          style={{
                            height: `${rowVirtualizer.getTotalSize()}px`,
                            width: '100%',
                            position: 'relative',
                          }}
                        >
                          {rowVirtualizer
                            .getVirtualItems()
                            .map((virtualRow) => {
                              const index = virtualRow.index
                              const isLoadMoreRow = index >= listCount

                              return (
                                <div
                                  key={virtualRow.key}
                                  ref={(el) => {
                                    if (!el) return
                                    rowVirtualizer.measureElement(el)
                                  }}
                                  data-index={index}
                                  style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    transform: `translateY(${virtualRow.start}px)`,
                                  }}
                                >
                                  {isLoadMoreRow ? (
                                    <div className="px-3 py-2 text-xs text-[color:var(--ink)]/60">
                                      {isFetchingNextBooksPage ? (
                                        <span className="inline-flex items-center gap-2">
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                          Loading more…
                                        </span>
                                      ) : hasNextBooksPage ? (
                                        <button
                                          type="button"
                                          className="text-left text-[color:var(--ink)]/70 hover:text-[color:var(--ink)] transition-colors"
                                          onClick={requestNextBooksPage}
                                        >
                                          Load more
                                        </button>
                                      ) : (
                                        'End of list.'
                                      )}
                                    </div>
                                  ) : (
                                    (() => {
                                      const book = books[index]
                                      if (!book) return null

                                      const title =
                                        book.title.trim() || 'Untitled'
                                      const authors =
                                        book.authors
                                          .filter(Boolean)
                                          .join(', ') || 'Unknown author'
                                      const hasThumbnail = Boolean(
                                        book.thumbnail_url.trim(),
                                      )
                                      const isSelected =
                                        selectedBookId === book.id

                                      return (
                                        <HoverCard
                                          openDelay={150}
                                          closeDelay={75}
                                        >
                                          <HoverCardTrigger asChild>
                                            <button
                                              type="button"
                                              onClick={() =>
                                                updateSelectedBook(book.id)
                                              }
                                              className={[
                                                'block w-full px-3 py-1 text-left text-xs transition-colors truncate',
                                                isSelected
                                                  ? 'bg-[color:var(--paper-deep)] text-[color:var(--ink)]'
                                                  : 'text-[color:var(--ink)]/90 hover:bg-[color:var(--paper-deep)]',
                                              ].join(' ')}
                                              aria-pressed={isSelected}
                                            >
                                              {title}
                                            </button>
                                          </HoverCardTrigger>
                                          <HoverCardContent
                                            side="right"
                                            align="start"
                                            sideOffset={8}
                                            className="w-80 border-[color:var(--accent-soft)] bg-[color:var(--paper)] text-[color:var(--ink)]"
                                          >
                                            <div className="flex gap-3">
                                              <div className="shrink-0">
                                                {hasThumbnail ? (
                                                  <img
                                                    src={book.thumbnail_url}
                                                    alt={title}
                                                    loading="lazy"
                                                    className="h-16 w-12 rounded-sm border border-[color:var(--accent-soft)] object-cover bg-[color:var(--paper-deep)]"
                                                  />
                                                ) : (
                                                  <div className="h-16 w-12 rounded-sm border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)]" />
                                                )}
                                              </div>
                                              <div className="min-w-0">
                                                <div className="text-sm font-medium leading-snug">
                                                  {title}
                                                </div>
                                                <div className="mt-1 text-xs text-[color:var(--ink)]/70 leading-snug">
                                                  {authors}
                                                </div>
                                              </div>
                                            </div>
                                          </HoverCardContent>
                                        </HoverCard>
                                      )
                                    })()
                                  )}
                                </div>
                              )
                            })}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>
          </ResizableWindow>
        )}
        <main className="relative flex-1 min-h-0 bg-[color:var(--paper-deep)]">
          {!isLibraryLoading && selectedBook ? (
            <div className="relative h-full">
              <EpubReaderV2
                ref={readerRef}
                storageId={selectedBook.id}
                bookUrl={selectedBook.url}
                transformationData={selectedBook.transformation_data}
                onSelectionChange={setReaderSelectionToken}
                onAddSelectionToChat={(sel) =>
                  insertSelectionToChat(sel, 'current')
                }
                onTocChange={setReaderTocToken}
                pendingNavigation={pendingReaderNavigation}
                onConsumePendingNavigation={(id) => {
                  setPendingReaderNavigation((prev) =>
                    prev?.id === id ? null : prev,
                  )
                }}
                onStatusChange={setReaderStatus}
                className="h-full"
              />
            </div>
          ) : (
            <></>
          )}
          {showBlockingLoader && (
            <div className="pointer-events-auto absolute inset-0 z-10 flex items-center justify-center bg-[color:var(--paper)]/90 backdrop-blur-sm">
              <div className="flex items-center gap-2 rounded-full bg-[color:var(--paper)]/95 px-4 py-2 text-sm text-[color:var(--ink)]/70 shadow-xl">
                <Loader className="h-4 w-4 animate-spin" />
              </div>
            </div>
          )}
        </main>
        <div className={isChatPanelVisible ? '' : 'hidden'}>
          <ResizableWindow
            storageKey={CHAT_PANEL_WIDTH_COOKIE}
            initialWidth={initialChatWidth}
            defaultWidth={DEFAULT_CHAT_PANEL_WIDTH}
            minWidth={200}
            handleSide="left"
            className="h-full overflow-hidden border-l border-[color:var(--accent-soft)] bg-[color:var(--paper)]"
          >
            <ChatSidePanel
              apiKey={geminiApiKey}
              onRequestApiKey={() => {
                setSettingsPopoverOpen(true)
                setSettingsView('ai')
              }}
              focusRequestId={chatFocusRequestId}
              pendingConversationAction={chatPendingConversationAction}
              onConsumePendingConversationAction={(id) => {
                setChatPendingConversationAction((prev) =>
                  prev?.id === id ? null : prev,
                )
              }}
              pendingHistoryToggle={chatPendingHistoryToggle}
              onConsumePendingHistoryToggle={(id) => {
                setChatPendingHistoryToggle((prev) =>
                  prev?.id === id ? null : prev,
                )
              }}
              pendingInsert={chatPendingInsert}
              onConsumePendingInsert={(id) => {
                setChatPendingInsert((prev) => (prev?.id === id ? null : prev))
              }}
              onModI={handleModI}
              onNewChat={handleModShiftI}
              onToggleHistory={handleModShiftH}
              onNavigateBookRef={handleNavigateBookRef}
              chapterSuggestions={readerTocToken?.chapters ?? []}
              currentBook={
                readerTocToken
                  ? {
                      bookId: readerTocToken.bookId,
                      bookTitle: readerTocToken.bookTitle,
                      metadata: readerTocToken.metadata,
                    }
                  : null
              }
              getCurrentReaderPage={getCurrentReaderPage}
            />
          </ResizableWindow>
        </div>
      </div>
    </div>
  )
}
