// Reader Settings Panel Component

import { Sun, Moon, Type, AlignLeft, AlignJustify, Minus, Plus, BookOpen, ScrollText } from 'lucide-react'
import type { ReaderSettings, ThemeName } from '../types'

interface ReaderSettingsProps {
  settings: ReaderSettings
  onSettingsChange: (settings: Partial<ReaderSettings>) => void
  className?: string
}

export function ReaderSettingsPanel({
  settings,
  onSettingsChange,
  className = '',
}: ReaderSettingsProps) {
  return (
    <div className={`epub-settings ${className}`}>
      <div className="px-4 py-3 border-b border-current/10">
        <h2 className="text-sm font-semibold uppercase tracking-wider opacity-70">
          Reading Settings
        </h2>
      </div>

      <div className="p-4 space-y-6">
        {/* Theme */}
        <div>
          <label className="text-xs font-medium uppercase tracking-wider opacity-60 block mb-2">
            Theme
          </label>
          <div className="flex gap-2">
            <ThemeButton
              theme="light"
              currentTheme={settings.theme}
              onClick={() => onSettingsChange({ theme: 'light' })}
              label="Light"
              icon={<Sun className="w-4 h-4" />}
            />
            <ThemeButton
              theme="sepia"
              currentTheme={settings.theme}
              onClick={() => onSettingsChange({ theme: 'sepia' })}
              label="Sepia"
              icon={<div className="w-4 h-4 rounded-full bg-amber-100 border border-amber-300" />}
            />
            <ThemeButton
              theme="dark"
              currentTheme={settings.theme}
              onClick={() => onSettingsChange({ theme: 'dark' })}
              label="Dark"
              icon={<Moon className="w-4 h-4" />}
            />
          </div>
        </div>

        {/* Reading Mode */}
        <div>
          <label className="text-xs font-medium uppercase tracking-wider opacity-60 block mb-2">
            Reading Mode
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => onSettingsChange({ mode: 'paginated' })}
              className={`
                flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                border transition-colors text-sm
                ${settings.mode === 'paginated'
                  ? 'border-current bg-current/10'
                  : 'border-current/20 hover:border-current/40'}
              `}
            >
              <BookOpen className="w-4 h-4" />
              Paginated
            </button>
            <button
              onClick={() => onSettingsChange({ mode: 'scrolled' })}
              className={`
                flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                border transition-colors text-sm
                ${settings.mode === 'scrolled'
                  ? 'border-current bg-current/10'
                  : 'border-current/20 hover:border-current/40'}
              `}
            >
              <ScrollText className="w-4 h-4" />
              Scrolled
            </button>
          </div>
        </div>

        {/* Font Family */}
        <div>
          <label className="text-xs font-medium uppercase tracking-wider opacity-60 block mb-2">
            Font
          </label>
          <select
            value={settings.fontFamily}
            onChange={(e) => onSettingsChange({ fontFamily: e.target.value as ReaderSettings['fontFamily'] })}
            className="w-full px-3 py-2 rounded-lg border border-current/20 bg-transparent text-sm"
          >
            <option value="publisher">Publisher Default</option>
            <option value="serif">Serif (Georgia)</option>
            <option value="sans-serif">Sans-serif (System)</option>
            <option value="monospace">Monospace</option>
          </select>
        </div>

        {/* Font Size */}
        <div>
          <label className="text-xs font-medium uppercase tracking-wider opacity-60 block mb-2">
            Font Size
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onSettingsChange({ fontSize: Math.max(0.6, settings.fontSize - 0.1) })}
              className="p-2 rounded-lg border border-current/20 hover:bg-current/5 transition-colors"
              aria-label="Decrease font size"
            >
              <Minus className="w-4 h-4" />
            </button>
            <div className="flex-1 text-center font-mono text-sm">
              {Math.round(settings.fontSize * 100)}%
            </div>
            <button
              onClick={() => onSettingsChange({ fontSize: Math.min(2.0, settings.fontSize + 0.1) })}
              className="p-2 rounded-lg border border-current/20 hover:bg-current/5 transition-colors"
              aria-label="Increase font size"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
          <input
            type="range"
            min="0.6"
            max="2.0"
            step="0.1"
            value={settings.fontSize}
            onChange={(e) => onSettingsChange({ fontSize: parseFloat(e.target.value) })}
            className="w-full mt-2"
          />
        </div>

        {/* Line Height */}
        <div>
          <label className="text-xs font-medium uppercase tracking-wider opacity-60 block mb-2">
            Line Height
          </label>
          <div className="flex items-center gap-3">
            <button
              onClick={() => onSettingsChange({ lineHeight: Math.max(1.2, settings.lineHeight - 0.1) })}
              className="p-2 rounded-lg border border-current/20 hover:bg-current/5 transition-colors"
              aria-label="Decrease line height"
            >
              <Minus className="w-4 h-4" />
            </button>
            <div className="flex-1 text-center font-mono text-sm">
              {settings.lineHeight.toFixed(1)}
            </div>
            <button
              onClick={() => onSettingsChange({ lineHeight: Math.min(2.5, settings.lineHeight + 0.1) })}
              className="p-2 rounded-lg border border-current/20 hover:bg-current/5 transition-colors"
              aria-label="Increase line height"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Margins */}
        <div>
          <label className="text-xs font-medium uppercase tracking-wider opacity-60 block mb-2">
            Margins
          </label>
          <div className="flex gap-2">
            {(['small', 'medium', 'large'] as const).map((size) => (
              <button
                key={size}
                onClick={() => onSettingsChange({ marginSize: size })}
                className={`
                  flex-1 px-3 py-2 rounded-lg border transition-colors text-sm capitalize
                  ${settings.marginSize === size
                    ? 'border-current bg-current/10'
                    : 'border-current/20 hover:border-current/40'}
                `}
              >
                {size}
              </button>
            ))}
          </div>
        </div>

        {/* Text Alignment */}
        <div>
          <label className="text-xs font-medium uppercase tracking-wider opacity-60 block mb-2">
            Text Alignment
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => onSettingsChange({ textAlign: 'left' })}
              className={`
                flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                border transition-colors text-sm
                ${settings.textAlign === 'left'
                  ? 'border-current bg-current/10'
                  : 'border-current/20 hover:border-current/40'}
              `}
            >
              <AlignLeft className="w-4 h-4" />
              Left
            </button>
            <button
              onClick={() => onSettingsChange({ textAlign: 'justify' })}
              className={`
                flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg
                border transition-colors text-sm
                ${settings.textAlign === 'justify'
                  ? 'border-current bg-current/10'
                  : 'border-current/20 hover:border-current/40'}
              `}
            >
              <AlignJustify className="w-4 h-4" />
              Justify
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

interface ThemeButtonProps {
  theme: ThemeName
  currentTheme: ThemeName
  onClick: () => void
  label: string
  icon: React.ReactNode
}

function ThemeButton({ theme, currentTheme, onClick, label, icon }: ThemeButtonProps) {
  const isActive = theme === currentTheme

  return (
    <button
      onClick={onClick}
      className={`
        flex-1 flex flex-col items-center gap-1 px-3 py-2 rounded-lg
        border transition-colors
        ${isActive
          ? 'border-current bg-current/10'
          : 'border-current/20 hover:border-current/40'}
      `}
    >
      {icon}
      <span className="text-xs">{label}</span>
    </button>
  )
}
