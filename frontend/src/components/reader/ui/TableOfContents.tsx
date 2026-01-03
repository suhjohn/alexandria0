// Table of Contents Component

import { useState } from 'react'
import { ChevronDown, ChevronRight, BookOpen } from 'lucide-react'
import type { TocItem, Location } from '../types'

interface TableOfContentsProps {
  toc: TocItem[]
  currentLocation?: Location
  onNavigate: (href: string) => void
  className?: string
}

export function TableOfContents({
  toc,
  currentLocation,
  onNavigate,
  className = '',
}: TableOfContentsProps) {
  return (
    <div className={`epub-toc ${className}`}>
      <div className="px-4 py-3 border-b border-current/10">
        <h2 className="text-sm font-semibold uppercase tracking-wider opacity-70 flex items-center gap-2">
          <BookOpen className="w-4 h-4" />
          Contents
        </h2>
      </div>
      <nav className="py-2 overflow-y-auto max-h-[60vh]">
        <TocList
          items={toc}
          currentLocation={currentLocation}
          onNavigate={onNavigate}
          level={0}
        />
      </nav>
    </div>
  )
}

interface TocListProps {
  items: TocItem[]
  currentLocation?: Location
  onNavigate: (href: string) => void
  level: number
}

function TocList({ items, currentLocation, onNavigate, level }: TocListProps) {
  return (
    <ul className="list-none m-0 p-0">
      {items.map((item) => (
        <TocEntry
          key={item.id}
          item={item}
          currentLocation={currentLocation}
          onNavigate={onNavigate}
          level={level}
        />
      ))}
    </ul>
  )
}

interface TocEntryProps {
  item: TocItem
  currentLocation?: Location
  onNavigate: (href: string) => void
  level: number
}

function TocEntry({ item, currentLocation, onNavigate, level }: TocEntryProps) {
  const [isExpanded, setIsExpanded] = useState(level < 1)
  const hasChildren = item.children.length > 0

  // Check if this item matches current location
  const isActive = currentLocation?.spineHref === item.href.split('#')[0]

  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    onNavigate(item.href)
  }

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation()
    setIsExpanded(!isExpanded)
  }

  return (
    <li className="m-0">
      <div
        className={`
          flex items-center gap-1 px-4 py-2 cursor-pointer
          hover:bg-current/5 transition-colors
          ${isActive ? 'bg-current/10 font-medium' : ''}
        `}
        style={{ paddingLeft: `${16 + level * 16}px` }}
      >
        {hasChildren ? (
          <button
            onClick={toggleExpand}
            className="p-1 -ml-1 hover:bg-current/10 rounded transition-colors"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </button>
        ) : (
          <span className="w-5" />
        )}

        <a
          href={`#${item.href}`}
          onClick={handleClick}
          className={`
            flex-1 text-sm truncate no-underline
            ${isActive ? 'opacity-100' : 'opacity-80 hover:opacity-100'}
          `}
        >
          {item.label}
        </a>
      </div>

      {hasChildren && isExpanded && (
        <TocList
          items={item.children}
          currentLocation={currentLocation}
          onNavigate={onNavigate}
          level={level + 1}
        />
      )}
    </li>
  )
}
