import * as React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { Extension, Node as TiptapNode } from '@tiptap/core'
import {
  EditorContent,
  NodeViewWrapper,
  ReactNodeViewRenderer,
  type ReactNodeViewProps,
  useEditor,
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { streamText, type ImagePart, type ModelMessage, type TextPart } from 'ai'
import {
  ArrowUp,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Image as ImageIcon,
  Plus,
  RotateCcw,
  Trash2,
} from 'lucide-react'
import { IoIosSquare } from 'react-icons/io'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

import type { ChatConversation, ChatMessage } from '@/lib/chat-db'
import { getChatDb } from '@/lib/chat-db'
import type {
  EpubReaderV2ChapterSuggestion,
  EpubReaderV2CurrentBook,
  EpubReaderV2VisiblePage,
} from '@/components/epubreader_v2/types'
import { cn } from '@/lib/utils'
import {
  buildReferenceMessage as buildEpubReferenceMessage,
  buildVisiblePageMessage as buildEpubVisiblePageMessage,
  currentBookSystemPrompt,
} from './epubChatContext'
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'

const MODEL_ID = 'gemini-3-flash-preview'

type ChapterSuggestionSession = { id: number; accept: () => boolean }
let chapterSuggestionSessionSeq = 0
let activeChapterSuggestionSession: ChapterSuggestionSession | null = null

function isChatMentionDebugEnabled() {
  if (typeof window === 'undefined') return false
  if ((window as any).__MFV2_DEBUG_CHAT_MENTIONS) return true
  try {
    return window.localStorage?.getItem('mfv2_debug_chat_mentions') === '1'
  } catch {
    return false
  }
}

function debugChatMentions(...args: Array<unknown>) {
  if (!isChatMentionDebugEnabled()) return
  // eslint-disable-next-line no-console
  console.log('[mfv2][chat][mentions]', ...args)
}

type BookRefInsert = {
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
}

type TiptapDoc = Record<string, any>

type BookRefAttrs = {
  mentionSuggestionChar?: string
  id?: string | null
  bookId?: string | null
  bookTitle?: string | null
  href?: string | null
  chapterTitle?: string | null
  startPage?: number | null
  startIndex?: number | null
  endPage?: number | null
  endIndex?: number | null
  selectedText?: string | null
  spineIndex?: number | null
}

type ChatImageAttrs = {
  id?: string | null
  filename?: string | null
  mediaType?: string | null
  dataBase64?: string | null
  sizeBytes?: number | null
}

type BookRefNavigatePayload =
  | {
      bookId: string
      spineIndex: number
      textOffset: number
      selectedText?: string
    }
  | { bookId: string; href: string }

type ChapterSuggestion = EpubReaderV2ChapterSuggestion
type CurrentBookInfo = EpubReaderV2CurrentBook
type CurrentReaderPage = EpubReaderV2VisiblePage

function createId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `id_${Math.random().toString(16).slice(2)}_${Date.now()}`
}

function titleFromFirstUserMessage(text: string) {
  const firstLine = text.trim().split('\n')[0] ?? ''
  return (firstLine || 'New chat').slice(0, 48)
}

function bookRefDisplayLabel(attrs: any) {
  const title = String(attrs?.bookTitle ?? '').trim() || 'Book'
  const chapterTitle = String(attrs?.chapterTitle ?? '').trim()
  if (chapterTitle) return `@${title}(chapter:${chapterTitle})`
  const startPage = Number(attrs?.startPage ?? 0)
  const startIndex = Number(attrs?.startIndex ?? 0)
  const endPage = Number(attrs?.endPage ?? 0)
  const endIndex = Number(attrs?.endIndex ?? 0)
  return `@${title}(${startPage}:${startIndex}-${endPage}:${endIndex})`
}

function bookRefTextValue(attrs: any) {
  const selected = String(attrs?.selectedText ?? '').trim()
  if (selected) return selected
  return bookRefDisplayLabel(attrs)
}

function visitTiptapDoc(
  node: any,
  visit: (n: any) => void,
): void {
  if (!node || typeof node !== 'object') return
  visit(node)
  const content = Array.isArray(node.content) ? node.content : []
  for (const child of content) visitTiptapDoc(child, visit)
}

function extractBookRefsFromDoc(doc: TiptapDoc): Array<BookRefAttrs> {
  const refs: Array<BookRefAttrs> = []
  visitTiptapDoc(doc, (n) => {
    if (n?.type !== 'bookRef') return
    const attrs = (n.attrs ?? {}) as BookRefAttrs
    refs.push(attrs)
  })
  return refs
}

function extractChatImagesFromDoc(doc: TiptapDoc): Array<ChatImageAttrs> {
  const imgs: Array<ChatImageAttrs> = []
  visitTiptapDoc(doc, (n) => {
    if (n?.type !== 'chatImage') return
    const attrs = (n.attrs ?? {}) as ChatImageAttrs
    imgs.push(attrs)
  })
  return imgs
}

function toModelMessages(
  messages: Array<ChatMessage>,
  systemPrompt?: string | null,
  options?: { prefaceMessages?: Array<ModelMessage> },
): Array<ModelMessage> {
  const prompt = String(systemPrompt ?? '').trim()
  const preface = options?.prefaceMessages ?? []
  const base = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      if (m.role !== 'user') {
        return { role: m.role, content: m.content }
      }

      const doc = parseTiptapDoc(m.contentJson ?? null, m.content)
      const images = extractChatImagesFromDoc(doc).filter(
        (img) => Boolean(String(img.dataBase64 ?? '').trim()) && Boolean(String(img.mediaType ?? '').trim()),
      )

      if (images.length === 0) {
        return { role: m.role, content: m.content }
      }

      const parts: Array<TextPart | ImagePart> = []
      const text = String(m.content ?? '')
      if (text.trim()) parts.push({ type: 'text', text })
      for (const img of images) {
        parts.push({
          type: 'image',
          image: String(img.dataBase64 ?? ''),
          mediaType: String(img.mediaType ?? '') || undefined,
        })
      }
      return { role: m.role, content: parts }
    })

  if (!prompt) return [...preface, ...base]
  return [{ role: 'system', content: prompt }, ...preface, ...base]
}

function formatRelativeDate(timestampMs: number) {
  try {
    const date = new Date(timestampMs)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

    const time = date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })

    if (diffDays === 0) {
      // Check if actually today
      if (date.toDateString() === now.toDateString()) {
        return `Today, ${time}`
      }
      return `Yesterday, ${time}`
    }
    if (
      diffDays === 1 ||
      date.toDateString() === new Date(now.getTime() - 86400000).toDateString()
    ) {
      return `Yesterday, ${time}`
    }
    if (diffDays < 7) {
      return `${date.toLocaleDateString([], { weekday: 'short' })}, ${time}`
    }
    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ''
  }
}

const BookRefMention = (Mention as any).extend({
  name: 'bookRef',
  addOptions() {
    return {
      ...this.parent?.(),
      onNavigate: null as null | ((payload: BookRefNavigatePayload) => void),
    }
  },
  addAttributes() {
    return {
      mentionSuggestionChar: {
        default: '@',
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-mention-suggestion-char') ?? '@',
        renderHTML: (attributes: Record<string, any>) => ({
          'data-mention-suggestion-char':
            attributes.mentionSuggestionChar ?? '@',
        }),
      },
      id: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-id'),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.id ? { 'data-id': attributes.id } : {},
      },
      bookId: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-book-id'),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.bookId ? { 'data-book-id': attributes.bookId } : {},
      },
      bookTitle: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-book-title'),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.bookTitle
            ? { 'data-book-title': attributes.bookTitle }
            : {},
      },
      href: {
        default: null,
        parseHTML: (element: HTMLElement) => element.getAttribute('data-href'),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.href ? { 'data-href': attributes.href } : {},
      },
      chapterTitle: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-chapter-title'),
        renderHTML: (attributes: Record<string, any>) =>
          attributes.chapterTitle
            ? { 'data-chapter-title': attributes.chapterTitle }
            : {},
      },
      startPage: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute('data-start-page') ?? 'NaN'),
        renderHTML: (attributes: Record<string, any>) => ({
          'data-start-page': attributes.startPage,
        }),
      },
      startIndex: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute('data-start-index') ?? 'NaN'),
        renderHTML: (attributes: Record<string, any>) => ({
          'data-start-index': attributes.startIndex,
        }),
      },
      endPage: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute('data-end-page') ?? 'NaN'),
        renderHTML: (attributes: Record<string, any>) => ({
          'data-end-page': attributes.endPage,
        }),
      },
      endIndex: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute('data-end-index') ?? 'NaN'),
        renderHTML: (attributes: Record<string, any>) => ({
          'data-end-index': attributes.endIndex,
        }),
      },
      selectedText: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute('data-selected-text'),
        renderHTML: (attributes: Record<string, any>) => ({
          'data-selected-text': attributes.selectedText,
        }),
      },
      spineIndex: {
        default: null,
        parseHTML: (element: HTMLElement) =>
          Number(element.getAttribute('data-spine-index') ?? 'NaN'),
        renderHTML: (attributes: Record<string, any>) => ({
          'data-spine-index': attributes.spineIndex,
        }),
      },
    }
  },
  addNodeView() {
    return ReactNodeViewRenderer(BookRefNodeView)
  },
})

const ChatImageNode = TiptapNode.create({
  name: 'chatImage',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: null },
      filename: { default: null },
      mediaType: { default: null },
      dataBase64: { default: null },
      sizeBytes: { default: null },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-chat-image]' }]
  },
  renderText({ node }: { node: any }) {
    const filename = String(node?.attrs?.filename ?? '').trim()
    return filename ? `[Image: ${filename}]` : '[Image]'
  },
  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, any> }) {
    return ['span', { ...HTMLAttributes, 'data-chat-image': '1' }]
  },
  addNodeView() {
    return ReactNodeViewRenderer(ChatImageNodeView)
  },
})

function BookRefNodeView(props: ReactNodeViewProps) {
  const attrs = (props.node.attrs ?? {}) as BookRefAttrs
  const bookTitle = String(attrs.bookTitle ?? '').trim() || 'Book'
  const titleLabel = `@${bookTitle}` // this is where the book title is displayed for the bookRef chip
  const chapterTitle = String(attrs.chapterTitle ?? '').trim()
  const isChapter = Boolean(chapterTitle)

  const startPage = Number(attrs.startPage ?? 0)
  const startIndex = Number(attrs.startIndex ?? 0)
  const endPage = Number(attrs.endPage ?? 0)
  const endIndex = Number(attrs.endIndex ?? 0)
  const locLabel = isChapter
    ? `(chapter:${chapterTitle})`
    : `(${startPage}:${startIndex}-${endPage}:${endIndex})`
  const label = `${titleLabel}${locLabel}`
  const selectedText = String(attrs.selectedText ?? '')
  const snippet = truncateSnippet(selectedText, 500)
  const [copied, setCopied] = React.useState(false)

  const hasBookId = typeof attrs.bookId === 'string' && attrs.bookId.length > 0
  const hasHref = typeof attrs.href === 'string' && attrs.href.length > 0
  // Stored attrs can come back as strings depending on how the chat message was
  // serialized (HTML vs JSON). Coerce before checking so we don't accidentally
  // fall back to href navigation (which typically lands at the chapter start).
  const spineIndexNum = Number((attrs as any).spineIndex)
  const startIndexNum = Number((attrs as any).startIndex)
  const canNavigateByOffset =
    Number.isFinite(spineIndexNum) && Number.isFinite(startIndexNum)
  const canNavigate = hasBookId && (hasHref || canNavigateByOffset)
  const canCopy = Boolean(selectedText.trim())

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!canCopy) return
    try {
      await navigator.clipboard.writeText(selectedText)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    } catch {
      // ignore
    }
  }

  const handleNavigate = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!canNavigate) {
      debugChatMentions('chip:navigate:blocked', {
        bookId: attrs.bookId,
        hasBookId,
        href: attrs.href,
        hasHref,
        spineIndex: attrs.spineIndex,
        startIndex: attrs.startIndex,
        canNavigateByOffset,
      })
      return
    }
    const onNavigate = (props.extension.options as any)?.onNavigate as
      | ((payload: BookRefNavigatePayload) => void)
      | null
    const bookId = String(attrs.bookId ?? '')
    const href = String(attrs.href ?? '')
    const spineIndex = spineIndexNum
    const textOffset = startIndexNum
    const selectedTextForNav =
      selectedText.length > 2000 ? selectedText.slice(0, 2000) : selectedText

    // Prefer href navigation when we have an explicit fragment; otherwise we'd
    // drop the anchor and jump to the start of the spine item.
    if (hasHref && href.includes('#')) {
      debugChatMentions('chip:navigate:href', { bookId, href })
      onNavigate?.({ bookId, href })
      return
    }

    // Prefer offset navigation because it reliably loads the correct spine,
    // even if href resolution fails.
    if (canNavigateByOffset) {
      debugChatMentions('chip:navigate:offset', {
        bookId,
        spineIndex,
        textOffset,
      })
      onNavigate?.({
        bookId,
        spineIndex,
        textOffset,
        selectedText: selectedTextForNav,
      })
      return
    }
    if (hasHref) {
      debugChatMentions('chip:navigate:href', { bookId, href })
      onNavigate?.({ bookId, href })
    }
  }

  return (
    <NodeViewWrapper as="span">
      <HoverCard openDelay={250}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            onClick={handleNavigate}
            contentEditable={false}
            className={cn(
              'mfv2-bookRef inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] leading-tight shadow-sm',
              'bg-[color:var(--paper)] border-[color:var(--accent-soft)] text-[color:var(--accent)]',
              'hover:bg-[color:var(--paper-deep)] hover:text-[color:var(--ink)]',
            )}
            title={canNavigate ? 'Jump to passage' : undefined}
          >
            <span className="min-w-0 max-w-[240px] truncate font-semibold">
              {titleLabel}
            </span>
            <span className="truncate text-[10px] text-[color:var(--ink)]/60">
              {locLabel}
            </span>
          </button>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(520px,calc(100vw-32px))] border-[color:var(--accent-soft)] bg-[color:var(--paper)] text-[color:var(--ink)]"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="text-[10px] text-[color:var(--ink)]/60">
              {label}
            </div>
            {canCopy ? (
              <button
                type="button"
                onClick={handleCopy}
                contentEditable={false}
                className={cn(
                  'shrink-0 rounded-md border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)] px-2 py-1 text-[10px]',
                  'hover:brightness-95',
                )}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            ) : null}
          </div>
          <div className="mt-2 max-h-56 select-text overflow-auto whitespace-pre-wrap rounded-md border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)] p-2 text-xs leading-relaxed">
            {snippet ||
              (isChapter ? 'Chapter reference (no text captured).' : '(empty)')}
          </div>
          <div className="mt-2 text-[10px] text-[color:var(--ink)]/50">
            Click chip to jump · Copy copies full selection
          </div>
        </HoverCardContent>
      </HoverCard>
    </NodeViewWrapper>
  )
}

function ChatImageNodeView(props: ReactNodeViewProps) {
  const attrs = (props.node.attrs ?? {}) as ChatImageAttrs
  const filename = String(attrs.filename ?? '').trim() || 'image'
  const mediaType = String(attrs.mediaType ?? '').trim()
  const dataBase64 = String(attrs.dataBase64 ?? '').trim()
  const canPreview = Boolean(mediaType && dataBase64)
  const previewSrc = canPreview ? `data:${mediaType};base64,${dataBase64}` : ''

  return (
    <NodeViewWrapper as="span">
      <HoverCard openDelay={250}>
        <HoverCardTrigger asChild>
          <span
            contentEditable={false}
            className={cn(
              'inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 text-[12px] leading-tight shadow-sm',
              'bg-[color:var(--paper)] border-[color:var(--accent-soft)] text-[color:var(--accent)]',
              'select-none',
            )}
            title={filename}
          >
            <ImageIcon className="h-3.5 w-3.5 text-[color:var(--ink)]/60" />
            <span className="min-w-0 max-w-[220px] truncate font-semibold text-[color:var(--ink)]/80">
              {filename}
            </span>
          </span>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="start"
          sideOffset={8}
          className="w-[min(520px,calc(100vw-32px))] border-[color:var(--accent-soft)] bg-[color:var(--paper)] text-[color:var(--ink)]"
        >
          <div className="text-[10px] text-[color:var(--ink)]/60">
            {filename}
          </div>
          {canPreview ? (
            <div className="mt-2 max-h-56 overflow-auto rounded-md border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)] p-2">
              <img
                src={previewSrc}
                alt={filename}
                className="max-h-52 w-auto max-w-full rounded"
              />
            </div>
          ) : (
            <div className="mt-2 text-xs text-[color:var(--ink)]/60">
              (No preview available)
            </div>
          )}
        </HoverCardContent>
      </HoverCard>
    </NodeViewWrapper>
  )
}

function ChatComposer(props: {
  mode: 'new' | 'edit'
  initialDoc: TiptapDoc
  onDocChange: (next: { text: string; doc: TiptapDoc }) => void
  disabled: boolean
  placeholder: string
  autoFocus?: boolean
  focusRequestId?: string | null
  pendingInsert?: BookRefInsert | null
  onConsumePendingInsert?: (id: string) => void
  onModI?: () => void
  onNewChat?: () => void
  onToggleHistory?: () => void
  onNavigateBookRef?: (payload: BookRefNavigatePayload) => void
  chapterSuggestions?: Array<ChapterSuggestion>
  currentBook?: CurrentBookInfo | null
  canSubmit: boolean
  isStreaming: boolean
  onStopStreaming: () => void
  onSubmit: () => void
}) {
  const onDocChangeRef = React.useRef(props.onDocChange)
  const onSubmitRef = React.useRef(props.onSubmit)
  const onModIRef = React.useRef(props.onModI)
  const onNewChatRef = React.useRef(props.onNewChat)
  const onToggleHistoryRef = React.useRef(props.onToggleHistory)
  const onNavigateBookRefRef = React.useRef(props.onNavigateBookRef)
  const chapterSuggestionsRef = React.useRef<Array<ChapterSuggestion>>(
    props.chapterSuggestions ?? [],
  )
  const currentBookRef = React.useRef<CurrentBookInfo | null>(
    props.currentBook ?? null,
  )
  onDocChangeRef.current = props.onDocChange
  onSubmitRef.current = props.onSubmit
  onModIRef.current = props.onModI
  onNewChatRef.current = props.onNewChat
  onToggleHistoryRef.current = props.onToggleHistory
  onNavigateBookRefRef.current = props.onNavigateBookRef
  chapterSuggestionsRef.current = props.chapterSuggestions ?? []
  currentBookRef.current = props.currentBook ?? null

  const handleNavigateBookRef = React.useCallback(
    (payload: BookRefNavigatePayload) =>
      onNavigateBookRefRef.current?.(payload),
    [],
  )

  const chapterSuggestionRenderer = React.useMemo(
    () => createChapterSuggestionRenderer,
    [],
  )

  const fileInputRef = React.useRef<HTMLInputElement | null>(null)

  const editor = useEditor(
    {
      immediatelyRender: false,
      extensions: [
        Extension.create({
          name: 'mfv2ChatBindings',
          addKeyboardShortcuts() {
            return {
              'Mod-i': () => {
                onModIRef.current?.()
                return true
              },
              'Mod-Shift-i': () => {
                onNewChatRef.current?.()
                return true
              },
              'Mod-Shift-h': () => {
                onToggleHistoryRef.current?.()
                return true
              },
            }
          },
        }),
        BookRefMention.configure({
          onNavigate: handleNavigateBookRef,
          suggestion: {
            char: '@',
            items: ({ query }: any) =>
              filterChapterSuggestions(chapterSuggestionsRef.current, query),
            render: chapterSuggestionRenderer,
            command: ({ editor, range, props: item }: any) => {
              const currentBook = currentBookRef.current
              const bookId = String(currentBook?.bookId ?? '').trim()
              const bookTitle = String(currentBook?.bookTitle ?? '').trim()
              const title = String(item?.title ?? '').trim()
              const href = String(item?.href ?? '').trim()
              const spineIndex = Number(item?.spineIndex ?? NaN)
              if (!bookId) {
                debugChatMentions('insert:chapter:missingBook', {
                  title,
                  href,
                  spineIndex,
                  range,
                })
                return
              }
              if (!title || !href || !Number.isFinite(spineIndex)) return
              debugChatMentions('insert:chapter', {
                bookId,
                bookTitle,
                title,
                href,
                spineIndex,
                range,
              })
              editor
                .chain()
                .focus()
                .insertContentAt(range, {
                  type: 'bookRef',
                  attrs: {
                    id: createId(),
                    bookId,
                    bookTitle,
                    href,
                    chapterTitle: title,
                    spineIndex,
                    startIndex: 0,
                  },
                })
                .insertContent(' ')
                .run()
            },
          },
          renderText({ node }: { node: any }) {
            return bookRefTextValue((node.attrs as any) ?? {})
          },
          renderHTML({ options, node }: { options: any; node: any }) {
            const htmlAttrs = (options as any)?.HTMLAttributes ?? {}
            return ['span', htmlAttrs, bookRefDisplayLabel(node.attrs ?? {})]
          },
        }),
        ChatImageNode,
        StarterKit.configure({
          bold: false,
          heading: false,
          blockquote: false,
          codeBlock: false,
          italic: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          horizontalRule: false,
        }),
        Placeholder.configure({
          placeholder: props.placeholder,
          showOnlyWhenEditable: false,
        }),
      ],
      autofocus: props.autoFocus ? 'end' : false,
      editorProps: {
        attributes: {
          class: cn(
            'w-full bg-transparent px-2.5 pt-2 text-xs leading-relaxed outline-none',
            'placeholder:text-[color:var(--ink)]/40',
          ),
        },
        handleKeyDown: (view, event) => {
          if (event.key === 'Enter') {
            debugChatMentions('composer:key', {
              key: event.key,
              shiftKey: event.shiftKey,
              hasSession: Boolean(activeChapterSuggestionSession),
              sessionId: activeChapterSuggestionSession?.id ?? null,
            })
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            // When the chapter suggestion menu is open, Enter should accept the
            // highlighted item (insert chip) rather than submit the message.
            if (activeChapterSuggestionSession) {
              debugChatMentions('composer:enter:passthrough', {
                sessionId: activeChapterSuggestionSession.id,
              })
              return false
            }
            debugChatMentions('composer:enter:submit')
            event.preventDefault()
            onSubmitRef.current()
            return true
          }
          return false
        },
      },
      content: props.initialDoc,
      onUpdate: ({ editor: updatedEditor }) => {
        onDocChangeRef.current({
          text: updatedEditor.getText({ blockSeparator: '\n' }),
          doc: updatedEditor.getJSON() as TiptapDoc,
        })
      },
    },
    [props.placeholder],
  )

  const handleAttachImageClick = () => {
    if (props.disabled) return
    fileInputRef.current?.click()
  }

  const handleImageFiles = async (files: FileList | null) => {
    if (!editor) return
    if (props.disabled) return
    if (!files || files.length === 0) return

    const accepted = Array.from(files).filter((f) =>
      String(f.type ?? '').toLowerCase().startsWith('image/'),
    )
    if (accepted.length === 0) return

    const readAsDataUrl = (file: File) =>
      new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result ?? ''))
        reader.onerror = () => reject(reader.error ?? new Error('Read failed'))
        reader.readAsDataURL(file)
      })

    for (const file of accepted) {
      try {
        const dataUrl = await readAsDataUrl(file)
        const match = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl)
        if (!match) continue
        const mediaType = match[1] ?? ''
        const dataBase64 = match[2] ?? ''
        if (!mediaType || !dataBase64) continue

        editor
          .chain()
          .focus()
          .insertContent({
            type: 'chatImage',
            attrs: {
              id: createId(),
              filename: file.name,
              mediaType,
              dataBase64,
              sizeBytes: file.size,
            } satisfies ChatImageAttrs,
          })
          .insertContent(' ')
          .run()
      } catch {
        // ignore
      }
    }
  }

  React.useEffect(() => {
    if (!editor) return
    if (props.disabled) return
    if (!props.autoFocus) return
    if (!props.focusRequestId) return
    editor.commands.focus('end')
  }, [editor, props.autoFocus, props.disabled, props.focusRequestId])

  React.useEffect(() => {
    if (!editor) return
    editor.setEditable(!props.disabled)
  }, [editor, props.disabled])

  React.useEffect(() => {
    if (!editor) return
    const pending = props.pendingInsert
    if (!pending) return
    if (pending.kind === 'bookRef') {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'bookRef',
          attrs: {
            id: pending.id,
            bookId: pending.bookId,
            bookTitle: pending.bookTitle,
            startPage: pending.startPage,
            startIndex: pending.startIndex,
            endPage: pending.endPage,
            endIndex: pending.endIndex,
            selectedText: pending.selectedText,
            spineIndex: pending.spineIndex,
          },
        })
        .insertContent(' ')
        .run()
    }
    props.onConsumePendingInsert?.(pending.id)
  }, [editor, props.pendingInsert?.id])

  return (
    <div
      className={cn(
        'flex flex-col rounded-xl border border-[color:var(--accent-soft)] bg-[color:var(--accent-soft)]',
        props.disabled && 'opacity-60',
      )}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          void handleImageFiles(e.currentTarget.files)
          e.currentTarget.value = ''
        }}
      />
      <style>{`
        .mfv2-chatComposer .ProseMirror {
          outline: none;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .mfv2-chatComposer .ProseMirror .is-empty.is-editor-empty:first-child::before {
          content: attr(data-placeholder);
          float: left;
          color: color-mix(in srgb, var(--ink) 40%, transparent);
          pointer-events: none;
          height: 0;
        }
      `}</style>
      <div className="max-h-28 overflow-y-auto">
        {editor ? (
          <EditorContent editor={editor} className="mfv2-chatComposer" />
        ) : (
          <div className="h-7" />
        )}
      </div>

      <div className="flex items-center justify-end gap-2 px-2.5 pb-2">
        <button
          type="button"
          onClick={handleAttachImageClick}
          disabled={props.disabled}
          className={cn(
            'rounded-full bg-[color:var(--accent-soft)] cursor-pointer p-1.5 transition-colors',
            'hover:bg-[color:var(--paper-deep)]',
            'disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label="Attach image"
          title="Attach image"
        >
          <ImageIcon className="w-4 h-4 text-[color:var(--ink)]/70" />
        </button>
        {props.isStreaming ? (
          <button
            type="button"
            onClick={props.onStopStreaming}
            className={cn(
              'rounded-full bg-[color:var(--accent-soft)] cursor-pointer p-1.5 transition-colors',
              'hover:bg-[color:var(--paper-deep)]',
            )}
            aria-label="Stop generation"
            title="Stop generation"
          >
            <IoIosSquare className="w-4 h-4 text-[color:var(--ink)]/70" />
          </button>
        ) : (
          <button
            type="button"
            onClick={props.onSubmit}
            disabled={props.disabled || !props.canSubmit}
            className={cn(
              'rounded-full bg-[color:var(--accent-soft)] cursor-pointer p-1.5 transition-colors',
              'hover:bg-[color:var(--paper-deep)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            aria-label={props.mode === 'edit' ? 'Save edit' : 'Send message'}
            title={props.mode === 'edit' ? 'Save edit' : 'Send message'}
          >
            <ArrowUp className="w-4 h-4 text-[color:var(--ink)]/70" />
          </button>
        )}
      </div>
    </div>
  )
}

function ChatMessageRichContent(props: {
  contentJson: string
  fallbackText: string
  onNavigateBookRef?: (payload: BookRefNavigatePayload) => void
}) {
  const doc = React.useMemo(
    () => parseTiptapDoc(props.contentJson, props.fallbackText),
    [props.contentJson, props.fallbackText],
  )

  const onNavigateBookRefRef = React.useRef(props.onNavigateBookRef)
  onNavigateBookRefRef.current = props.onNavigateBookRef
  const handleNavigateBookRef = React.useCallback(
    (payload: BookRefNavigatePayload) =>
      onNavigateBookRefRef.current?.(payload),
    [],
  )

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions: [
        BookRefMention.configure({
          onNavigate: handleNavigateBookRef,
          suggestion: {
            char: '@',
            items: () => [],
          },
          renderText({ node }: { node: any }) {
            return bookRefTextValue((node.attrs as any) ?? {})
          },
          renderHTML({ options, node }: { options: any; node: any }) {
            const htmlAttrs = (options as any)?.HTMLAttributes ?? {}
            return ['span', htmlAttrs, bookRefDisplayLabel(node.attrs ?? {})]
          },
        }),
        ChatImageNode,
        StarterKit.configure({
          bold: false,
          heading: false,
          blockquote: false,
          codeBlock: false,
          italic: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          horizontalRule: false,
        }),
      ],
      editorProps: {
        attributes: {
          class: cn(
            'mfv2-chatMessage w-full bg-transparent whitespace-pre-wrap break-words outline-none',
          ),
        },
      },
      content: doc,
    },
    [doc],
  )

  return (
    <div>
      <style>{`
        .mfv2-chatMessage .ProseMirror {
          outline: none;
          white-space: pre-wrap;
          word-break: break-word;
        }
      `}</style>
      <EditorContent editor={editor} />
    </div>
  )
}

function isMacPlatform() {
  if (typeof navigator === 'undefined') return false
  const platform =
    (navigator as any).userAgentData?.platform ??
    navigator.platform ??
    navigator.userAgent
  return /mac/i.test(String(platform))
}

export function ChatSidePanel(
  props: {
    apiKey?: string | null
    onRequestApiKey?: () => void
    focusRequestId?: string | null
    pendingConversationAction?: {
      id: string
      action: 'lastSelected' | 'newConversation'
    } | null
    onConsumePendingConversationAction?: (id: string) => void
    pendingHistoryToggle?: { id: string } | null
    onConsumePendingHistoryToggle?: (id: string) => void
    pendingInsert?: BookRefInsert | null
    onConsumePendingInsert?: (id: string) => void
    onModI?: () => void
    onNewChat?: () => void
    onToggleHistory?: () => void
    onNavigateBookRef?: (payload: BookRefNavigatePayload) => void
    chapterSuggestions?: Array<ChapterSuggestion>
    currentBook?: CurrentBookInfo | null
    getCurrentReaderPage?: () => CurrentReaderPage | null
    getCurrentReaderPageStable?: (options?: {
      timeoutMs?: number
    }) => Promise<CurrentReaderPage | null>
    getCurrentReaderPageParts?: (options?: {
      maxChars?: number
      maxImages?: number
      maxImageBytes?: number
    }) => Promise<Array<TextPart | ImagePart> | null>
    getCurrentReaderPagePartsStable?: (options?: {
      maxChars?: number
      maxImages?: number
      maxImageBytes?: number
      timeoutMs?: number
    }) => Promise<Array<TextPart | ImagePart> | null>
    getSpineItemText?: (options: {
      spineIndex: number
      maxChars?: number
    }) => Promise<string | null>
    getSpineItemParts?: (options: {
      spineIndex: number
      maxChars?: number
      maxImages?: number
      maxImageBytes?: number
    }) => Promise<Array<TextPart | ImagePart> | null>
  } = {},
) {
  const isMac = React.useMemo(() => isMacPlatform(), [])
  const [status, setStatus] = React.useState<
    'idle' | 'loading' | 'ready' | 'error'
  >('idle')
  const [error, setError] = React.useState<string | null>(null)

  const [conversations, setConversations] = React.useState<
    Array<ChatConversation>
  >([])
  const [selectedConversationId, setSelectedConversationId] = React.useState<
    string | null
  >(null)
  const [messages, setMessages] = React.useState<Array<ChatMessage>>([])
  const [threadHeads, setThreadHeads] = React.useState<Array<ChatMessage>>([])
  const [activeHeadId, setActiveHeadId] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<'chat' | 'history'>('chat')
  const apiKey = props.apiKey ?? null

  const [composerKey, setComposerKey] = React.useState(0)
  const [draftText, setDraftText] = React.useState('')
  const [draftDoc, setDraftDoc] = React.useState<TiptapDoc>(() =>
    emptyTiptapDoc(),
  )
  const [queuedInsert, setQueuedInsert] = React.useState<BookRefInsert | null>(
    null,
  )
  const [isStreaming, setIsStreaming] = React.useState(false)
  const [editingMessageId, setEditingMessageId] = React.useState<string | null>(
    null,
  )
  const [editText, setEditText] = React.useState('')
  const [editDoc, setEditDoc] = React.useState<TiptapDoc>(() =>
    emptyTiptapDoc(),
  )
  const [isThreadPickerOpen, setIsThreadPickerOpen] = React.useState(false)
  const [siblingOptionsByParentKey, setSiblingOptionsByParentKey] =
    React.useState<Partial<Record<string, Array<ChatMessage>>>>({})
  const [copiedMessageId, setCopiedMessageId] = React.useState<string | null>(
    null,
  )

  const abortRef = React.useRef<AbortController | null>(null)
  const scrollRef = React.useRef<HTMLDivElement | null>(null)
  const scrollPinnedRef = React.useRef(true)
  const cancelledRef = React.useRef(false)
  const editingComposerRef = React.useRef<HTMLDivElement | null>(null)

  const selectedConversation = React.useMemo(
    () => conversations.find((c) => c.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  )

  const docHasImages = React.useCallback((doc: TiptapDoc) => {
    return extractChatImagesFromDoc(doc).some(
      (img) => Boolean(String(img.dataBase64 ?? '').trim()),
    )
  }, [])

  const buildSystemPrompt = () => {
    return currentBookSystemPrompt(props.currentBook ?? null).trim()
  }

  const buildVisiblePageMessage = async (): Promise<ModelMessage | null> => {
    return await buildEpubVisiblePageMessage({
      getCurrentReaderPage: props.getCurrentReaderPage,
      getCurrentReaderPageStable: props.getCurrentReaderPageStable,
      getCurrentReaderPageParts: props.getCurrentReaderPageParts,
      getCurrentReaderPagePartsStable: props.getCurrentReaderPagePartsStable,
    })
  }

  const buildReferenceMessage = async (
    promptMessages: Array<ChatMessage>,
  ): Promise<ModelMessage | null> => {
    const refs: Array<BookRefAttrs> = []
    for (const msg of promptMessages) {
      if (msg.role !== 'user') continue
      const doc = parseTiptapDoc(msg.contentJson ?? null, msg.content)
      refs.push(...extractBookRefsFromDoc(doc))
    }
    const currentBookId = String(props.currentBook?.bookId ?? '').trim()
    return await buildEpubReferenceMessage({
      refs,
      currentBookId,
      getSpineItemParts: props.getSpineItemParts,
      getSpineItemText: props.getSpineItemText,
    })
  }

  const setScrollPinned = React.useCallback((next: boolean) => {
    if (scrollPinnedRef.current === next) return
    scrollPinnedRef.current = next
  }, [])

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior) => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }, [])

  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current
    if (!el) return

    const thresholdPx = 64
    const atBottom =
      el.scrollTop + el.clientHeight >= el.scrollHeight - thresholdPx
    setScrollPinned(atBottom)
  }, [setScrollPinned])

  const parentKey = (parentId: string | null | undefined) =>
    parentId ?? '__root__'

  const currentDraftSnapshot = () => ({
    text: draftText,
    doc: draftDoc,
  })

  const refreshConversationState = async (
    conversationId: string,
    options?: { headMessageId?: string | null },
  ) => {
    const db = await getChatDb()
    const heads = db.listThreadHeads(conversationId)
    const storedHead = db.getActiveMessageId(conversationId)
    const preferredHead = options ? options.headMessageId : undefined
    let nextHead: string | null = storedHead
    if (!nextHead) nextHead = heads.length > 0 ? heads[0].id : null
    if (preferredHead !== undefined) nextHead = preferredHead

    if (nextHead && storedHead !== nextHead) {
      db.setActiveMessageId(conversationId, nextHead)
    }

    const nextMessages = db.listMessages(conversationId, nextHead)
    const parentIds: Array<string | null> = nextMessages.map(
      (m) => m.parentId ?? null,
    )
    const nextSiblingOptions = db.listChildrenForParents(
      conversationId,
      parentIds,
    )
    setThreadHeads(heads)
    setActiveHeadId(nextHead)
    setMessages(nextMessages)
    setSiblingOptionsByParentKey(nextSiblingOptions)
  }

  const ensureConversationSelected = async (): Promise<string> => {
    const db = await getChatDb()
    const list = db.listConversations()
    const existingSelected =
      (selectedConversationId &&
        list.some((c) => c.id === selectedConversationId) &&
        selectedConversationId) ||
      null

    if (existingSelected) return existingSelected

    const created = db.createConversation({ id: createId(), title: 'New chat' })
    db.setSelectedConversationId(created.id)
    setConversations([created, ...list])
    setSelectedConversationId(created.id)
    setMessages([])
    setThreadHeads([])
    setActiveHeadId(null)
    setSiblingOptionsByParentKey({})
    return created.id
  }

  const selectLastSelectedConversation = async (): Promise<string> => {
    const db = await getChatDb()
    const list = db.listConversations()
    const storedSelectedId = db.getSelectedConversationId()
    if (storedSelectedId && list.some((c) => c.id === storedSelectedId)) {
      await selectConversation(storedSelectedId)
      return storedSelectedId
    }

    if (list.length > 0) {
      const fallbackId = list[0].id
      await selectConversation(fallbackId)
      return fallbackId
    }

    const created = db.createConversation({ id: createId(), title: 'New chat' })
    db.setSelectedConversationId(created.id)
    setConversations([created])
    setSelectedConversationId(created.id)
    setMessages([])
    setThreadHeads([])
    setActiveHeadId(null)
    setSiblingOptionsByParentKey({})
    setComposerKey((k) => k + 1)
    setDraftText('')
    setDraftDoc(emptyTiptapDoc())
    return created.id
  }

  const createAndSelectConversation = async (options?: {
    carryDraft?: boolean
  }): Promise<string> => {
    const carriedDraft = options?.carryDraft ? currentDraftSnapshot() : null
    const db = await getChatDb()

    const list = db.listConversations()
    const selectedId = selectedConversationId ?? db.getSelectedConversationId()

    if (selectedId && db.countMessages(selectedId) === 0) {
      if (selectedConversationId !== selectedId) {
        await selectConversation(selectedId, { carriedDraft })
      }
      return selectedId
    }

    const mostRecentEmptyId =
      list.find((c) => db.countMessages(c.id) === 0)?.id ?? null
    if (mostRecentEmptyId) {
      await selectConversation(mostRecentEmptyId, { carriedDraft })
      return mostRecentEmptyId
    }

    const created = db.createConversation({ id: createId(), title: 'New chat' })
    db.setSelectedConversationId(created.id)
    setConversations((prev) => [created, ...prev])
    await selectConversation(created.id, { carriedDraft })
    return created.id
  }

  const lastHandledInsertIdRef = React.useRef<string | null>(null)
  const lastHandledConversationActionIdRef = React.useRef<string | null>(null)
  const lastHandledHistoryToggleIdRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (typeof window === 'undefined') return

    cancelledRef.current = false
    setStatus('loading')
    setError(null)

    void (async () => {
      try {
        const db = await getChatDb()
        const storedSelectedId = db.getSelectedConversationId()

        let nextConversations = db.listConversations()
        if (nextConversations.length === 0) {
          const created = db.createConversation({
            id: createId(),
            title: 'New chat',
          })
          nextConversations = [created]
          db.setSelectedConversationId(created.id)
        }

        const initialSelected =
          (storedSelectedId &&
            nextConversations.some((c) => c.id === storedSelectedId) &&
            storedSelectedId) ||
          nextConversations[0]?.id ||
          null

        if (initialSelected) db.setSelectedConversationId(initialSelected)

        const initialMessages = initialSelected
          ? db.listMessages(initialSelected)
          : []
        const initialHeads = initialSelected
          ? db.listThreadHeads(initialSelected)
          : []
        const storedHead = initialSelected
          ? db.getActiveMessageId(initialSelected)
          : null
        let inferredHead: string | null = null
        if (storedHead) {
          inferredHead = storedHead
        } else if (initialMessages.length > 0) {
          inferredHead = initialMessages[initialMessages.length - 1].id
        } else {
          inferredHead = initialHeads.length > 0 ? initialHeads[0].id : null
        }

        if (cancelledRef.current) return

        setConversations(nextConversations)
        setSelectedConversationId(initialSelected)
        setMessages(initialMessages)
        setThreadHeads(initialHeads)
        setActiveHeadId(inferredHead)
        if (initialSelected) {
          const parentIds: Array<string | null> = initialMessages.map(
            (m) => m.parentId ?? null,
          )
          setSiblingOptionsByParentKey(
            db.listChildrenForParents(initialSelected, parentIds),
          )
        } else {
          setSiblingOptionsByParentKey({})
        }
        setStatus('ready')
      } catch (err) {
        if (cancelledRef.current) return
        setError(
          err instanceof Error ? err.message : 'Failed to initialize chat.',
        )
        setStatus('error')
      }
    })()

    return () => {
      cancelledRef.current = true
      abortRef.current?.abort()
    }
  }, [])

  const lastMessageKey = React.useMemo(() => {
    const last = messages[messages.length - 1]
    if (!last) return ''
    return `${last.id}:${String(last.content ?? '').length}`
  }, [messages])

  React.useEffect(() => {
    if (!scrollPinnedRef.current) return
    // Keep the latest generated text in view while streaming.
    scrollToBottom('auto')
  }, [lastMessageKey, isStreaming, scrollToBottom])

  React.useEffect(() => {
    if (!editingMessageId) return

    const handleClickOutside = (event: MouseEvent) => {
      if (
        editingComposerRef.current &&
        !editingComposerRef.current.contains(event.target as Node)
      ) {
        cancelEditMessage()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [editingMessageId])

  React.useEffect(() => {
    const pending = props.pendingConversationAction
    if (!pending) return
    if (status !== 'ready') return
    if (
      pending.id &&
      lastHandledConversationActionIdRef.current === pending.id
    ) {
      return
    }
    lastHandledConversationActionIdRef.current = pending.id

    void (async () => {
      try {
        if (pending.action === 'newConversation') {
          await createAndSelectConversation({ carryDraft: true })
        } else {
          await selectLastSelectedConversation()
        }
      } finally {
        props.onConsumePendingConversationAction?.(pending.id)
      }
    })()
  }, [props.pendingConversationAction?.id, status])

  React.useEffect(() => {
    const pending = props.pendingInsert
    if (!pending) return
    if (status !== 'ready') return
    if (pending.id && lastHandledInsertIdRef.current === pending.id) return
    lastHandledInsertIdRef.current = pending.id

    void (async () => {
      try {
        if (pending.target === 'newConversation') {
          await createAndSelectConversation({ carryDraft: true })
        } else if (pending.target === 'lastSelected') {
          await selectLastSelectedConversation()
        } else {
          await ensureConversationSelected()
        }
      } finally {
        setQueuedInsert(pending)
      }
    })()
  }, [props.pendingInsert?.id, status])

  React.useEffect(() => {
    const pending = props.pendingHistoryToggle
    if (!pending) return
    if (pending.id && lastHandledHistoryToggleIdRef.current === pending.id)
      return
    lastHandledHistoryToggleIdRef.current = pending.id
    setTab((prev) => (prev === 'history' ? 'chat' : 'history'))
    props.onConsumePendingHistoryToggle?.(pending.id)
  }, [props.pendingHistoryToggle?.id])

  const selectConversation = async (
    conversationId: string,
    options?: { carriedDraft?: { text: string; doc: TiptapDoc } | null },
  ) => {
    const carriedDraft = options?.carriedDraft ?? null
    setScrollPinned(true)
    setSelectedConversationId(conversationId)
    setError(null)
    setTab('chat')
    setEditingMessageId(null)
    setComposerKey((k) => k + 1)
    setDraftText(carriedDraft ? carriedDraft.text : '')
    setDraftDoc(carriedDraft ? carriedDraft.doc : emptyTiptapDoc())

    try {
      const db = await getChatDb()
      db.setSelectedConversationId(conversationId)
      await refreshConversationState(conversationId)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load messages.')
    }
  }

  const createConversation = () => {
    setError(null)
    setScrollPinned(true)
    setSelectedConversationId(null)
    setMessages([])
    setThreadHeads([])
    setActiveHeadId(null)
    setSiblingOptionsByParentKey({})
    setTab('chat')
    setEditingMessageId(null)
    setComposerKey((k) => k + 1)
    setDraftText('')
    setDraftDoc(emptyTiptapDoc())
  }

  const deleteConversation = async (conversationId: string) => {
    setError(null)
    try {
      const db = await getChatDb()
      db.deleteConversation(conversationId)
      let next = db.listConversations()
      if (next.length === 0) {
        const created = db.createConversation({
          id: createId(),
          title: 'New chat',
        })
        next = [created]
      }

      const nextSelected =
        (selectedConversationId &&
          next.some((c) => c.id === selectedConversationId) &&
          selectedConversationId) ||
        next[0]?.id ||
        null

      setConversations(next)
      setSelectedConversationId(nextSelected)
      if (nextSelected) {
        setScrollPinned(true)
        db.setSelectedConversationId(nextSelected)
        await refreshConversationState(nextSelected)
      } else {
        setMessages([])
        setThreadHeads([])
        setActiveHeadId(null)
        setSiblingOptionsByParentKey({})
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to delete conversation.',
      )
    }
  }

  const stopStreaming = () => {
    abortRef.current?.abort()
  }

  const copyMessageContent = async (messageId: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedMessageId(messageId)
      setTimeout(() => setCopiedMessageId(null), 2000)
    } catch {
      // Fallback for older browsers
      const textArea = document.createElement('textarea')
      textArea.value = content
      document.body.appendChild(textArea)
      textArea.select()
      document.execCommand('copy')
      document.body.removeChild(textArea)
      setCopiedMessageId(messageId)
      setTimeout(() => setCopiedMessageId(null), 2000)
    }
  }

  const startEditMessage = (message: ChatMessage) => {
    if (message.role !== 'user') return
    setEditingMessageId(message.id)
    setEditText(message.content)
    setEditDoc(parseTiptapDoc(message.contentJson ?? null, message.content))
    setComposerKey((k) => k + 1)
    setDraftText('')
    setDraftDoc(emptyTiptapDoc())
  }

  const cancelEditMessage = () => {
    setEditingMessageId(null)
    setEditText('')
    setEditDoc(emptyTiptapDoc())
  }

  const saveEditMessage = async () => {
    if (!editingMessageId) return
    const nextText = editText.trim()
    const hasImages = docHasImages(editDoc)
    if (!nextText && !hasImages) return

    const conversationId =
      selectedConversationId ?? (await ensureConversationSelected())

    setError(null)

    const storedKey = apiKey?.trim() || null
    if (!storedKey) {
      props.onRequestApiKey?.()
      setError('Set your GEMINI_API_KEY in Settings to regenerate messages.')
      return
    }

    const editedIndex = messages.findIndex((m) => m.id === editingMessageId)
    if (editedIndex < 0) return

    const parentId = messages[editedIndex]?.parentId ?? null
    const baseMessages = messages.slice(0, editedIndex)

    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController

    const newUserMessage: ChatMessage = {
      id: createId(),
      conversationId,
      parentId,
      role: 'user',
      content: nextText,
      contentJson: JSON.stringify(editDoc),
      createdAt: Date.now(),
      editedAt: null,
    }

    const assistantMessageId = createId()
    const assistantPlaceholder: ChatMessage = {
      id: assistantMessageId,
      conversationId,
      parentId: newUserMessage.id,
      role: 'assistant',
      content: '',
      createdAt: Date.now() + 1,
      editedAt: null,
    }

    cancelEditMessage()
    setMessages([...baseMessages, newUserMessage, assistantPlaceholder])
    setActiveHeadId(assistantMessageId)
    setScrollPinned(true)
    scrollToBottom('auto')

    let assistantText = ''
    let wasAborted = false

    try {
      const db = await getChatDb()
      db.addMessage(newUserMessage)
      db.setActiveMessageId(conversationId, newUserMessage.id)

      const provider = createGoogleGenerativeAI({ apiKey: storedKey })
      const systemPrompt = buildSystemPrompt()
      const visiblePageMessage = await buildVisiblePageMessage()
      const referenceMessage = await buildReferenceMessage([
        ...baseMessages,
        newUserMessage,
      ])
      const prefaceMessages = [visiblePageMessage, referenceMessage].filter(
        Boolean,
      ) as ModelMessage[]
      const promptMessages = toModelMessages(
        [...baseMessages, newUserMessage],
        systemPrompt,
        prefaceMessages.length > 0 ? { prefaceMessages } : undefined,
      )

      setIsStreaming(true)

      const result = await streamText({
        model: provider(
          MODEL_ID as unknown as Parameters<
            ReturnType<typeof createGoogleGenerativeAI>
          >[0],
        ),
        messages: promptMessages,
        abortSignal: abortController.signal,
      })

      for await (const delta of result.textStream) {
        assistantText += delta
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId ? { ...m, content: assistantText } : m,
          ),
        )
      }

      const assistantFinal: ChatMessage = {
        ...assistantPlaceholder,
        content: assistantText.trim(),
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMessageId ? assistantFinal : m)),
      )
      db.addMessage(assistantFinal)
      db.setActiveMessageId(conversationId, assistantFinal.id)
      setActiveHeadId(assistantFinal.id)
      setThreadHeads(db.listThreadHeads(conversationId))
      setConversations(db.listConversations())
      await refreshConversationState(conversationId, {
        headMessageId: assistantFinal.id,
      })
    } catch (err) {
      wasAborted =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted/i.test(err.message))

      if (!wasAborted) {
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to regenerate a response.',
        )
        setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId))
        setActiveHeadId(newUserMessage.id)
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId ? { ...m, content: assistantText } : m,
          ),
        )
      }
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }

  const regenerateAssistantMessage = async (assistantMessageId: string) => {
    const idx = messages.findIndex((m) => m.id === assistantMessageId)
    const assistantMessage = idx >= 0 ? messages[idx] : null
    if (!assistantMessage || assistantMessage.role !== 'assistant') return
    const conversationId = assistantMessage.conversationId

    const storedKey = apiKey?.trim() || null
    if (!storedKey) {
      props.onRequestApiKey?.()
      setError('Set your GEMINI_API_KEY in Settings to regenerate messages.')
      return
    }

    const parentId = assistantMessage.parentId ?? null
    if (!parentId) return

    const baseMessages = messages.slice(0, idx)

    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController

    const newAssistantId = createId()
    const assistantPlaceholder: ChatMessage = {
      id: newAssistantId,
      conversationId,
      parentId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      editedAt: null,
    }

    setEditingMessageId(null)
    setMessages([...baseMessages, assistantPlaceholder])
    setActiveHeadId(newAssistantId)
    setScrollPinned(true)
    scrollToBottom('auto')

    let assistantText = ''
    let wasAborted = false

    try {
      const db = await getChatDb()
      const provider = createGoogleGenerativeAI({ apiKey: storedKey })
      const systemPrompt = buildSystemPrompt()
      const visiblePageMessage = await buildVisiblePageMessage()
      const referenceMessage = await buildReferenceMessage(baseMessages)
      const prefaceMessages = [visiblePageMessage, referenceMessage].filter(
        Boolean,
      ) as ModelMessage[]
      const promptMessages = toModelMessages(
        baseMessages,
        systemPrompt,
        prefaceMessages.length > 0 ? { prefaceMessages } : undefined,
      )

      setIsStreaming(true)

      const result = await streamText({
        model: provider(
          MODEL_ID as unknown as Parameters<
            ReturnType<typeof createGoogleGenerativeAI>
          >[0],
        ),
        messages: promptMessages,
        abortSignal: abortController.signal,
      })

      for await (const delta of result.textStream) {
        assistantText += delta
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newAssistantId ? { ...m, content: assistantText } : m,
          ),
        )
      }

      const assistantFinal: ChatMessage = {
        ...assistantPlaceholder,
        content: assistantText.trim(),
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === newAssistantId ? assistantFinal : m)),
      )
      db.addMessage(assistantFinal)
      db.setActiveMessageId(conversationId, assistantFinal.id)
      setActiveHeadId(assistantFinal.id)
      setThreadHeads(db.listThreadHeads(conversationId))
      setConversations(db.listConversations())
      await refreshConversationState(conversationId, {
        headMessageId: assistantFinal.id,
      })
    } catch (err) {
      wasAborted =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted/i.test(err.message))

      if (!wasAborted) {
        setError(
          err instanceof Error
            ? err.message
            : 'Failed to regenerate a response.',
        )
        setMessages((prev) => prev.filter((m) => m.id !== newAssistantId))
        setActiveHeadId(parentId)
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === newAssistantId ? { ...m, content: assistantText } : m,
          ),
        )
      }
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }

  const selectSiblingOption = async (childId: string) => {
    if (!selectedConversationId) return
    setError(null)
    try {
      const db = await getChatDb()
      const leaf =
        db.getLatestLeafDescendant(selectedConversationId, childId) ?? childId
      db.setActiveMessageId(selectedConversationId, leaf)
      await refreshConversationState(selectedConversationId, {
        headMessageId: leaf,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to switch branch.')
    }
  }

  const navigateSibling = async (message: ChatMessage, direction: -1 | 1) => {
    if (!selectedConversationId) return
    const key = parentKey(message.parentId)
    const siblings = siblingOptionsByParentKey[key] ?? []
    const currentIndex = siblings.findIndex((s) => s.id === message.id)
    if (currentIndex < 0) return

    const nextIndex = currentIndex + direction
    if (nextIndex < 0 || nextIndex >= siblings.length) return

    const nextSibling = siblings[nextIndex]
    await selectSiblingOption(nextSibling.id)
  }

  const selectThreadHead = async (headMessageId: string) => {
    if (!selectedConversationId) return
    setError(null)
    setIsThreadPickerOpen(false)
    setEditingMessageId(null)
    try {
      const db = await getChatDb()
      db.setActiveMessageId(selectedConversationId, headMessageId)
      await refreshConversationState(selectedConversationId, {
        headMessageId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load thread.')
    }
  }

  const generateTitleWithAI = async (
    userMessage: string,
    storedKey: string,
  ): Promise<string | null> => {
    try {
      const provider = createGoogleGenerativeAI({ apiKey: storedKey })
      const result = await streamText({
        model: provider(
          MODEL_ID as unknown as Parameters<
            ReturnType<typeof createGoogleGenerativeAI>
          >[0],
        ),
        messages: [
          {
            role: 'user',
            content: `Generate a concise 3-6 word title for a conversation that starts with this message: "${userMessage}". Return only the title, nothing else.`,
          },
        ],
      })

      let title = ''
      for await (const delta of result.textStream) {
        title += delta
      }

      const cleanTitle = title.trim().replace(/^["']|["']$/g, '')
      return cleanTitle.slice(0, 48)
    } catch {
      return null
    }
  }

  const sendMessage = async () => {
    const text = draftText.trim()
    const hasImages = docHasImages(draftDoc)
    if (!text && !hasImages) return
    const conversationId =
      selectedConversationId ?? (await ensureConversationSelected())

    setError(null)
    setEditingMessageId(null)

    const storedKey = apiKey?.trim() || null
    if (!storedKey) {
      props.onRequestApiKey?.()
      setError('Set your GEMINI_API_KEY in Settings to send messages.')
      return
    }

    setComposerKey((k) => k + 1)
    setDraftText('')
    setDraftDoc(emptyTiptapDoc())

    setScrollPinned(true)
    abortRef.current?.abort()
    const abortController = new AbortController()
    abortRef.current = abortController

    const baseMessages = messages
    const parentId = activeHeadId

    const userMessage: ChatMessage = {
      id: createId(),
      conversationId,
      parentId,
      role: 'user',
      content: text,
      contentJson: JSON.stringify(draftDoc),
      createdAt: Date.now(),
      editedAt: null,
    }

    const assistantMessageId = createId()
    const assistantPlaceholder: ChatMessage = {
      id: assistantMessageId,
      conversationId,
      parentId: userMessage.id,
      role: 'assistant',
      content: '',
      createdAt: Date.now() + 1,
      editedAt: null,
    }

    setMessages([...baseMessages, userMessage, assistantPlaceholder])
    setActiveHeadId(assistantMessageId)
    scrollToBottom('auto')

    let assistantText = ''
    let wasAborted = false

    try {
      const db = await getChatDb()
      const isFirstMessage = db.countMessages(conversationId) === 0

      db.addMessage(userMessage)
      db.setActiveMessageId(conversationId, userMessage.id)

      const provider = createGoogleGenerativeAI({ apiKey: storedKey })
      const systemPrompt = buildSystemPrompt()
      const visiblePageMessage = await buildVisiblePageMessage()
      const referenceMessage = await buildReferenceMessage([
        ...baseMessages,
        userMessage,
      ])
      const prefaceMessages = [visiblePageMessage, referenceMessage].filter(
        Boolean,
      ) as ModelMessage[]
      const promptMessages = toModelMessages(
        [...baseMessages, userMessage],
        systemPrompt,
        prefaceMessages.length > 0 ? { prefaceMessages } : undefined,
      )

      setIsStreaming(true)

      const result = await streamText({
        model: provider(
          MODEL_ID as unknown as Parameters<
            ReturnType<typeof createGoogleGenerativeAI>
          >[0],
        ),
        messages: promptMessages,
        abortSignal: abortController.signal,
      })

      for await (const delta of result.textStream) {
        assistantText += delta
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId ? { ...m, content: assistantText } : m,
          ),
        )
      }

      const assistantFinal: ChatMessage = {
        ...assistantPlaceholder,
        content: assistantText.trim(),
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === assistantMessageId ? assistantFinal : m)),
      )
      db.addMessage(assistantFinal)
      db.setActiveMessageId(conversationId, assistantFinal.id)
      setActiveHeadId(assistantFinal.id)
      setThreadHeads(db.listThreadHeads(conversationId))
      setConversations(db.listConversations())

      if (isFirstMessage) {
        // Show generating state
        const tempTitle = 'Generating title...'
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId ? { ...c, title: tempTitle } : c,
          ),
        )

        const generatedTitle = await generateTitleWithAI(text, storedKey)
        const nextTitle = generatedTitle ?? titleFromFirstUserMessage(text)

        db.renameConversation(conversationId, nextTitle)
        setConversations((prev) =>
          prev.map((c) =>
            c.id === conversationId ? { ...c, title: nextTitle } : c,
          ),
        )
      }
    } catch (err) {
      wasAborted =
        err instanceof Error &&
        (err.name === 'AbortError' || /aborted/i.test(err.message))

      if (!wasAborted) {
        setError(
          err instanceof Error ? err.message : 'Failed to generate a response.',
        )
        setMessages((prev) => prev.filter((m) => m.id !== assistantMessageId))
        setActiveHeadId(userMessage.id)
      } else {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMessageId ? { ...m, content: assistantText } : m,
          ),
        )
      }
    } finally {
      setIsStreaming(false)
      abortRef.current = null
    }
  }

  return (
    <div className="h-full flex flex-col bg-[color:var(--paper)] text-[color:var(--ink)]">
      <div className="h-9 px-3 flex items-center justify-between border-b border-[color:var(--accent-soft)]">
        <div className="flex items-center justify-between gap-1 w-full">
          <div className="min-w-0 text-[10px] text-[color:var(--ink)]/60 truncate">
            {tab === 'history' ? (
              <div className="flex items-center gap-2 text-[color:var(--ink)]">
                <Clock className="w-3 h-3" /> History
              </div>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <div className="truncate">
                  {selectedConversation?.title ?? 'New chat'}
                </div>
              </div>
            )}
          </div>
          <TooltipProvider delayDuration={250}>
            <div className="flex items-center">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => {
                      void createConversation()
                      props.onNewChat?.()
                    }}
                    className="cursor-pointer p-1.5 rounded-lg transition-colors hover:bg-[color:var(--paper-deep)]"
                    aria-label="New chat"
                  >
                    <Plus className="w-4 h-4 text-[color:var(--ink)]/70" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex flex-col gap-1">
                    <span>New chat</span>
                    <kbd className="w-fit rounded border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--ink)]/70">
                      {isMac ? '⌘⇧I' : 'Ctrl+Shift+I'}
                    </kbd>
                  </div>
                </TooltipContent>
              </Tooltip>
	              <Tooltip>
	                <TooltipTrigger asChild>
	                  <button
	                    type="button"
	                    onClick={() => {
	                      setTab((prev) => (prev === 'history' ? 'chat' : 'history'))
	                    }}
	                    className={cn(
	                      'cursor-pointer p-1.5 rounded-lg transition-colors',
	                      tab === 'history'
	                        ? 'bg-[color:var(--paper-deep)]'
                        : 'hover:bg-[color:var(--paper-deep)]',
                    )}
                    aria-pressed={tab === 'history'}
                    aria-label="History"
                  >
                    <Clock className="w-4 h-4 text-[color:var(--ink)]/70" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  <div className="flex flex-col gap-1">
                    <span>History</span>
                    <kbd className="w-fit rounded border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--ink)]/70">
                      {isMac ? '⌘⇧H' : 'Ctrl+Shift+H'}
                    </kbd>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
        </div>
      </div>
      {error && (
        <div className="px-3 py-2 text-xs text-[color:var(--accent)] border-b border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)]">
          {error}
        </div>
      )}
      {tab === 'history' ? (
        <div className="flex-1 h-full flex flex-col">
          <div className="flex-1 h-full overflow-y-auto">
            {status === 'loading' && (
              <div className="px-3 py-2 text-xs text-[color:var(--ink)]/60">
                Loading…
              </div>
            )}
            {status !== 'loading' && conversations.length === 0 && (
              <div className="px-3 py-2 text-xs text-[color:var(--ink)]/60">
                No conversations.
              </div>
            )}
            {conversations.map((c) => {
              return (
                <div
                  key={c.id}
                  className={cn(
                    'group flex items-center gap-2 px-2 py-2 border-b border-[color:var(--accent-soft)]/60',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => void selectConversation(c.id)}
                    className={cn('flex-1 min-w-0 text-left')}
                    title={c.title}
                  >
                    <div className="text-xs truncate">{c.title}</div>
                    <div className="text-[10px] text-[color:var(--ink)]/50 mt-0.5">
                      {formatRelativeDate(c.updatedAt)}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => void deleteConversation(c.id)}
                    className={cn(
                      'cursor-pointer p-1 rounded-md transition-colors',
                      'text-[color:var(--ink)]/40 hover:text-[color:var(--accent)]',
                      'opacity-0 group-hover:opacity-100',
                    )}
                    aria-label={`Delete ${c.title}`}
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 h-full overflow-y-auto flex flex-col bg-[color:var(--paper-deep)]"
        >
          <div className="flex-1 px-3 py-3">
            {messages.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <div className="text-center">
                  <div className="text-xs text-[color:var(--ink)]/70">
                    Start chatting…
                  </div>
                  <div className="mt-1 text-[10px] text-[color:var(--ink)]/50">
                    Enter to send · Shift+Enter for newline
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4 pb-8">
                {messages.map((m) => {
                  const isUser = m.role === 'user'
                  const key = parentKey(m.parentId)
                  const siblings = siblingOptionsByParentKey[key] ?? []
                  const siblingIndex = siblings.findIndex((s) => s.id === m.id)
                  const siblingCount = siblings.length
                  const siblingLabel =
                    siblingCount > 1 && siblingIndex >= 0
                      ? `${siblingIndex + 1}/${siblingCount}`
                      : null
                  const isEditing = isUser && m.id === editingMessageId
                  if (isEditing) {
                    return (
                      <div key={m.id} ref={editingComposerRef}>
                        <ChatComposer
                          key={editingMessageId}
                          mode="edit"
                          initialDoc={editDoc}
                          onDocChange={({ text, doc }) => {
                            setEditText(text)
                            setEditDoc(doc)
                          }}
                          disabled={status !== 'ready'}
                          placeholder="Edit your message..."
                          autoFocus
                          onNavigateBookRef={props.onNavigateBookRef}
                          chapterSuggestions={props.chapterSuggestions ?? []}
                          currentBook={props.currentBook ?? null}
                          canSubmit={
                            Boolean(editText.trim()) || docHasImages(editDoc)
                          }
                          isStreaming={isStreaming}
                          onStopStreaming={stopStreaming}
                          onSubmit={() => void saveEditMessage()}
                        />
                      </div>
                    )
                  }
                  return (
                    <div
                      key={m.id}
                      className={cn('group flex flex-col', isUser && 'gap-2')}
                    >
                      <div
                        className={cn(
                          'w-full max-w-[100%] rounded-lg py-1 text-xs leading-relaxed',
                          isUser
                            ? 'px-2.5 hover:bg-[color:var(--paper-deep)] border border-[color:var(--accent-soft)] bg-[color:var(--accent-soft)] hover:bg-[color:var(--accent)]'
                            : 'w-full max-w-[100%] px-2',
                          m.id === editingMessageId &&
                            'ring-1 ring-[color:var(--accent)]/30',
                        )}
                        onClick={(e) => {
                          const target = e.target as HTMLElement | null
                          const clickedLink = Boolean(target?.closest('a'))
                          if (clickedLink) return
                          if (
                            isUser &&
                            !isStreaming &&
                            status === 'ready' &&
                            m.id !== editingMessageId
                          ) {
                            e.stopPropagation()
                            startEditMessage(m)
                          }
                        }}
                      >
                        <div className={cn('max-w-none')}>
                          {isUser && m.contentJson ? (
                            <ChatMessageRichContent
                              contentJson={m.contentJson}
                              fallbackText={m.content}
                              onNavigateBookRef={props.onNavigateBookRef}
                            />
                          ) : (
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={{
                                p: ({ children }) => (
                                  <p className="text-sm my-2 first:mt-0 last:mb-0 leading-relaxed whitespace-pre-wrap">
                                    {children}
                                  </p>
                                ),
                                code: ({ className, children, ...rest }) => {
                                  const isInline = !className
                                  return (
                                    <code
                                      className={cn(
                                        isInline
                                          ? 'rounded bg-[color:var(--paper-deep)] px-1.5 py-0.5 text-[0.9em] font-medium'
                                          : 'text-[0.9em]',
                                        className,
                                      )}
                                      {...rest}
                                    >
                                      {children}
                                    </code>
                                  )
                                },
                                pre: ({ children }) => (
                                  <pre className="my-3 overflow-x-auto rounded-md bg-[color:var(--paper-deep)] p-3 text-sm leading-relaxed">
                                    {children}
                                  </pre>
                                ),
                                a: ({ children, href }) => (
                                  <a
                                    href={href}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="underline decoration-1 underline-offset-2 text-[color:var(--ink)] hover:text-[color:var(--accent)] transition-colors"
                                  >
                                    {children}
                                  </a>
                                ),
                                ul: ({ children }) => (
                                  <ul className="my-2 ml-4 list-disc space-y-1 first:mt-0 last:mb-0">
                                    {children}
                                  </ul>
                                ),
                                ol: ({ children }) => (
                                  <ol className="my-2 ml-4 list-decimal space-y-1 first:mt-0 last:mb-0 text-sm">
                                    {children}
                                  </ol>
                                ),
                                li: ({ children }) => (
                                  <li className="leading-relaxed pl-1 text-sm">
                                    {children}
                                  </li>
                                ),
                                blockquote: ({ children }) => (
                                  <blockquote className="my-3 border-l-2 border-[color:var(--accent)] pl-4 italic text-[color:var(--ink)]/80">
                                    {children}
                                  </blockquote>
                                ),
                                h1: ({ children }) => (
                                  <h1 className="mt-4 mb-2 first:mt-0 text-xl font-semibold">
                                    {children}
                                  </h1>
                                ),
                                h2: ({ children }) => (
                                  <h2 className="mt-4 mb-2 first:mt-0 text-lg font-semibold">
                                    {children}
                                  </h2>
                                ),
                                h3: ({ children }) => (
                                  <h3 className="mt-3 mb-1.5 first:mt-0 text-base font-semibold">
                                    {children}
                                  </h3>
                                ),
                                strong: ({ children }) => (
                                  <strong className="font-semibold">
                                    {children}
                                  </strong>
                                ),
                                em: ({ children }) => (
                                  <em className="italic">{children}</em>
                                ),
                                hr: () => (
                                  <hr className="my-4 border-t border-[color:var(--accent-soft)]" />
                                ),
                                table: ({ children }) => (
                                  <div className="my-3 overflow-x-auto">
                                    <table className="min-w-full text-sm border-collapse">
                                      {children}
                                    </table>
                                  </div>
                                ),
                                th: ({ children }) => (
                                  <th className="border border-[color:var(--accent-soft)] bg-[color:var(--paper-deep)] px-3 py-1.5 text-left font-semibold">
                                    {children}
                                  </th>
                                ),
                                td: ({ children }) => (
                                  <td className="border border-[color:var(--accent-soft)] px-3 py-1.5">
                                    {children}
                                  </td>
                                ),
                              }}
                            >
                              {m.content || (m.role === 'assistant' ? '…' : '')}
                            </ReactMarkdown>
                          )}
                        </div>
                      </div>
                      {/** Bottom options */}
                      <div
                        className={cn(
                          'flex items-center gap-1',
                          !isUser && 'px-1',
                          isUser && 'justify-end',
                          isUser &&
                            'opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
                          isStreaming &&
                            'opacity-0 group-hover:opacity-0 group-focus-within:opacity-0',
                        )}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            void copyMessageContent(m.id, m.content)
                          }}
                          className={cn(
                            'text-[color:var(--ink)]/50 hover:text-[color:var(--ink)]/80',
                            'cursor-pointer p-1 rounded-md',
                            'hover:bg-[color:var(--paper-deep)]',
                          )}
                          aria-label="Copy message"
                          title="Copy"
                        >
                          {copiedMessageId === m.id ? (
                            <Check className="w-3.5 h-3.5 text-green-500" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                        {!isUser && (
                          <button
                            type="button"
                            onClick={() =>
                              void regenerateAssistantMessage(m.id)
                            }
                            disabled={status !== 'ready' || isStreaming}
                            className={cn(
                              'text-[color:var(--ink)]/50 hover:text-[color:var(--ink)]/80',
                              'cursor-pointer p-1 rounded-md',
                              'hover:bg-[color:var(--paper-deep)]',
                              'disabled:cursor-not-allowed disabled:opacity-50',
                            )}
                            aria-label="Regenerate response"
                            title="Regenerate"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                        )}
                        {selectedConversationId && siblingCount > 1 && (
                          <div
                            className="flex items-center"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <button
                              type="button"
                              disabled={status !== 'ready' || siblingIndex <= 0}
                              onClick={() => void navigateSibling(m, -1)}
                              className={cn(
                                'cursor-pointer rounded transition-colors',
                                'text-[color:var(--ink)]/50 hover:text-[color:var(--ink)]/80',
                                'disabled:cursor-not-allowed disabled:opacity-30',
                              )}
                              aria-label="Previous branch"
                              title="Previous branch"
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </button>
                            <span className="text-[10px] text-[color:var(--ink)]/60 tabular-nums text-center">
                              {siblingLabel}
                            </span>
                            <button
                              type="button"
                              disabled={
                                status !== 'ready' ||
                                siblingIndex >= siblingCount - 1
                              }
                              onClick={() => void navigateSibling(m, 1)}
                              className={cn(
                                'cursor-pointer rounded transition-colors',
                                'text-[color:var(--ink)]/50 hover:text-[color:var(--ink)]/80',
                                'disabled:cursor-not-allowed disabled:opacity-30',
                              )}
                              aria-label="Next branch"
                              title="Next branch"
                            >
                              <ChevronRight className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="p-2 bg-[color:var(--paper-deep)]">
        <ChatComposer
          key={composerKey}
          mode="new"
          initialDoc={draftDoc}
          onDocChange={({ text, doc }) => {
            setDraftText(text)
            setDraftDoc(doc)
          }}
          disabled={status !== 'ready'}
          placeholder={
            apiKey ? 'Ask anything...' : 'Set GEMINI_API_KEY in Settings…'
          }
          autoFocus={!editingMessageId}
          focusRequestId={props.focusRequestId ?? null}
          pendingInsert={queuedInsert ?? null}
          onConsumePendingInsert={(id) => {
            setQueuedInsert((prev) => (prev?.id === id ? null : prev))
            props.onConsumePendingInsert?.(id)
          }}
          onModI={props.onModI}
          onNewChat={props.onNewChat}
          onToggleHistory={props.onToggleHistory}
          onNavigateBookRef={props.onNavigateBookRef}
          chapterSuggestions={props.chapterSuggestions ?? []}
          currentBook={props.currentBook ?? null}
          canSubmit={Boolean(draftText.trim()) || docHasImages(draftDoc)}
          isStreaming={isStreaming}
          onStopStreaming={stopStreaming}
          onSubmit={() => void sendMessage()}
        />
      </div>
    </div>
  )
}

function filterChapterSuggestions(
  chapters: Array<ChapterSuggestion>,
  query: string,
): Array<ChapterSuggestion> {
  const normalized = String(query ?? '')
    .trim()
    .toLowerCase()
  const list = normalized
    ? chapters.filter((c) => String(c.title).toLowerCase().includes(normalized))
    : chapters
  return list.slice(0, 12)
}

function ChapterSuggestionMenu(props: {
  items: Array<ChapterSuggestion>
  selectedIndex: number
  onSelect: (index: number) => void
  onHover: (index: number) => void
}) {
  const scrollContainerRef = React.useRef<HTMLDivElement>(null)
  const itemRefs = React.useRef<Map<number, HTMLButtonElement>>(new Map())

  // Scroll selected item into view when selection changes
  React.useLayoutEffect(() => {
    const el = itemRefs.current.get(props.selectedIndex)
    if (el) {
      el.scrollIntoView({ block: 'nearest' })
    }
  }, [props.selectedIndex])

  if (props.items.length === 0) return null
  return (
    <div
      className={cn('min-w-[260px] max-w-[min(420px,calc(100vw-24px))]')}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div className="px-3 py-2 text-[10px] font-semibold text-[color:var(--ink)]/60">
        Chapters
      </div>
      <div ref={scrollContainerRef} className="max-h-64 overflow-auto py-1">
        {props.items.map((item, index) => {
          const isActive = index === props.selectedIndex
          return (
            <button
              key={`${item.href}:${index}`}
              ref={(el) => {
                if (el) {
                  itemRefs.current.set(index, el)
                } else {
                  itemRefs.current.delete(index)
                }
              }}
              type="button"
              onMouseEnter={() => props.onHover(index)}
              onClick={() => props.onSelect(index)}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-2 text-left text-xs',
                isActive
                  ? 'bg-[color:var(--paper-deep)] text-[color:var(--ink)]'
                  : 'text-[color:var(--ink)]/80 hover:bg-[color:var(--paper-deep)]',
              )}
              style={{ paddingLeft: 12 + item.depth * 14 }}
            >
              <span className="min-w-0 truncate">{item.title}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function createChapterSuggestionRenderer() {
  let container: HTMLDivElement | null = null
  let root: Root | null = null
  let selectedIndex = 0
  let latestFull: any = null
  let latestRect: DOMRect | null = null
  let latestItems: Array<ChapterSuggestion> = []
  let sessionId: number | null = null

  const virtualRef = {
    current: {
      getBoundingClientRect: () =>
        latestRect ??
        new DOMRect(window.innerWidth / 2, window.innerHeight / 2, 0, 0),
    },
  }

  const destroy = () => {
    if (
      sessionId !== null &&
      activeChapterSuggestionSession?.id === sessionId
    ) {
      debugChatMentions('suggestions:destroy', { sessionId })
      activeChapterSuggestionSession = null
    }
    try {
      root?.unmount()
    } catch {
      // ignore
    }
    root = null
    if (container) {
      container.remove()
      container = null
    }
    latestFull = null
    latestRect = null
    latestItems = []
    selectedIndex = 0
  }

  const updateRect = () => {
    if (!latestFull?.clientRect) return
    const rect = latestFull.clientRect()
    latestRect = rect ? (rect as DOMRect) : null
  }

  const render = () => {
    if (!root || !latestFull) return
    updateRect()
    const items = latestItems
    if (items.length === 0) {
      destroy()
      return
    }
    if (selectedIndex >= items.length) selectedIndex = 0
    debugChatMentions('suggestions:render', {
      sessionId,
      selectedIndex,
      selectedTitle: items[selectedIndex]?.title,
      itemCount: items.length,
      query: latestFull?.query,
    })

    root.render(
      <Popover open modal={false}>
        <PopoverAnchor virtualRef={virtualRef as any} />
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="w-auto p-0 border-[color:var(--accent-soft)] bg-[color:var(--paper)] text-[color:var(--ink)]"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <ChapterSuggestionMenu
            items={items}
            selectedIndex={selectedIndex}
            onHover={(index) => {
              selectedIndex = index
              render()
            }}
            onSelect={(index) => {
              const item = items[index]
              if (!item) return
              debugChatMentions('suggestions:click', {
                sessionId,
                index,
                title: item.title,
                query: latestFull?.query,
              })
              latestFull.command?.(item)
              latestFull.editor?.commands?.focus?.()
              destroy()
            }}
          />
        </PopoverContent>
      </Popover>,
    )
  }

  return {
    onStart: (props: any) => {
      latestFull = props
      latestItems = Array.isArray(props.items) ? props.items : []
      selectedIndex = 0
      updateRect()
      sessionId = chapterSuggestionSessionSeq += 1
      activeChapterSuggestionSession = {
        id: sessionId,
        accept: () => {
          const items = latestItems
          const item = items[selectedIndex]
          debugChatMentions('suggestions:accept', {
            sessionId,
            selectedIndex,
            title: item?.title,
            query: latestFull?.query,
            hasCommand: Boolean(latestFull?.command),
          })
          if (!item) return false
          latestFull?.command?.(item)
          latestFull?.editor?.commands?.focus?.()
          destroy()
          return true
        },
      }
      debugChatMentions('suggestions:start', {
        sessionId,
        itemCount: latestItems.length,
        query: props?.query,
      })
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      render()
    },
    onUpdate: (props: any) => {
      latestFull = props
      latestItems = Array.isArray(props.items) ? props.items : []
      debugChatMentions('suggestions:update', {
        sessionId,
        itemCount: latestItems.length,
        query: props?.query,
      })
      render()
    },
    onKeyDown: (props: any) => {
      // Use latestItems which is reliably set during onStart/onUpdate
      const items = latestItems
      if (items.length === 0) return false
      if (!latestFull) return false
      debugChatMentions('suggestions:key', {
        sessionId,
        key: props.event.key,
        selectedIndex,
        itemCount: items.length,
        query: latestFull?.query,
      })
      if (props.event.key === 'ArrowDown') {
        props.event.preventDefault()
        selectedIndex = (selectedIndex + 1) % items.length
        render()
        return true
      }
      if (props.event.key === 'ArrowUp') {
        props.event.preventDefault()
        selectedIndex = (selectedIndex - 1 + items.length) % items.length
        render()
        return true
      }
      if (props.event.key === 'Enter' || props.event.key === 'Tab') {
        props.event.preventDefault()
        const item = items[selectedIndex]
        if (!item) return true
        debugChatMentions('suggestions:enter', {
          sessionId,
          selectedIndex,
          title: item.title,
          query: latestFull?.query,
        })
        latestFull.command?.(item)
        latestFull.editor?.commands?.focus?.()
        destroy()
        return true
      }
      if (props.event.key === 'Escape') {
        props.event.preventDefault()
        destroy()
        return true
      }
      return false
    },
    onExit: () => {
      destroy()
    },
  }
}

function truncateSnippet(text: string, maxChars: number) {
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized) return ''
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars))}…`
}

function emptyTiptapDoc(): TiptapDoc {
  return {
    type: 'doc',
    content: [{ type: 'paragraph' }],
  }
}

function textToTiptapDoc(text: string): TiptapDoc {
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const content = lines.map((line) => {
    const trimmed = line.replace(/\s+$/g, '')
    return {
      type: 'paragraph',
      content: trimmed ? [{ type: 'text', text: trimmed }] : [],
    }
  })
  return {
    type: 'doc',
    content: content.length ? content : [{ type: 'paragraph' }],
  }
}

function parseTiptapDoc(json: string | null, fallbackText: string): TiptapDoc {
  if (!json) return textToTiptapDoc(fallbackText)
  try {
    const parsed = JSON.parse(json) as any
    if (!parsed || typeof parsed !== 'object')
      return textToTiptapDoc(fallbackText)
    if (parsed.type !== 'doc') return textToTiptapDoc(fallbackText)
    return parsed as TiptapDoc
  } catch {
    return textToTiptapDoc(fallbackText)
  }
}
