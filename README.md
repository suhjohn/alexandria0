# Alexandria

Alexandria is an intelligent digital library platform that transforms how you read and interact with books. It combines a modern EPUB reader with AI-powered conversation and advanced content transformation capabilities.

## What Problems Does It Solve?

### For Readers
- **Fragmented reading experience** → Unified EPUB reader with modern UI, customizable themes, and responsive design
- **Passive, isolated reading** → AI chat companion (powered by Gemini) for active engagement while reading specific passages
- **Archaic language barriers** → Transform books to modernize outdated prose, making classic literature more accessible
- **Book discovery complexity** → Full-text search across Project Gutenberg and personal libraries with cursor-based pagination
- **One-size-fits-all layouts** → Personalized reading: 6 theme presets, adjustable fonts, line heights, and collapsible panels

### For Content Creators & Librarians
- **Manual text rewriting** → Batch transformation of books using LLMs with async job processing
- **Translation barriers** → Automated book translation to different languages at scale
- **Metadata extraction overhead** → Automatic thumbnail and metadata extraction from EPUB files
- **Library management complexity** → Personal and shared libraries with fine-grained visibility controls
- **Format management** → Store and track original and transformed versions alongside each other

## Core Features

### Reading & Library Management

#### EPUB Reader with Advanced Controls
- **Progressive EPUB Rendering**: Powered by epubjs library for smooth, chapter-by-chapter content loading
- **Dual Pagination Modes**: Traditional page navigation and flow-based reading
- **Text Selection & Interaction**: Select any passage to copy, search, or send to chat
- **Table of Contents Navigation**: Jump to any chapter or section with interactive TOC sidebar
- **Bookmark Support**: Mark passages for later reference and review
- **Progress Tracking**: See your reading position and estimated time to completion
- **Font Rendering**: Supports embedded fonts from EPUB files with proper fallbacks

#### Dual Library Ecosystem
- **Public Library**: Access to thousands of books from Project Gutenberg
  - Automatically synchronized catalog with metadata and thumbnails
  - No authentication required to browse public collection
  - Full-text searchable across all 70,000+ available titles
  - Sorted by popularity, new additions, and custom collections

- **Personal Library**: Upload, organize, and share your own books
  - Support for EPUB2 and EPUB3 formats
  - Automatic metadata extraction from EPUB files
  - Private by default with optional sharing via unique links
  - Organize books into custom collections
  - Track reading progress across devices

#### Full-Text Search with Trigram Indexing
- **Advanced Query Support**: Search by title, author, or keywords within book metadata
- **Fuzzy Matching**: Find books even with partial or misspelled queries
- **Real-time Results**: Instant search feedback as you type
- **Filtering**: Filter results by library (public/personal), status (reading/completed), and transformation type
- **Search History**: Previous searches stored for quick re-access

#### Cursor-Based Pagination
- **Memory-Efficient Browsing**: Handle libraries with thousands of books without performance degradation
- **Consistent Ordering**: Deterministic pagination based on book ID and sort order
- **Seamless Infinite Scroll**: Load more books as you scroll without page transitions
- **Stable Cursor Positions**: Pagination state persists even when library updates (new books added)
- **Customizable Page Sizes**: Load 20, 50, or 100 books per request

#### Theme System - 6 Presets
- **Original**: Warm background with brown text, mimics physical book reading
- **Quiet**: Soft colors with reduced contrast for comfortable evening reading
- **Paper**: Light sepia tone with traditional typography
- **Bold**: High contrast for accessibility and reduced eye strain
- **Calm**: Cool color palette with blue tones
- **Focus**: Minimal design with centered text column and maximum readability

Each theme includes:
- Custom background and text colors
- Optimized line height and letter spacing
- Appropriate font selections for readability
- Reduced motion options for accessibility

#### Customizable Reading Layout
- **Font Family Selection**: Choose from serif (Georgia, Garamond) and sans-serif (Open Sans, Inter) options
- **Font Size Control**: Adjust from 12px to 24px with live preview
- **Line Height Adjustment**: 1.4x to 2.0x for comfortable reading density
- **Text Width Control**: Narrow (50ch), medium (70ch), or wide (90ch) reading columns
- **Margin Adjustment**: Control whitespace around text for reduced visual clutter
- **Letter Spacing**: Fine-tune spacing between characters for dyslexia-friendly reading

#### Book Metadata & Thumbnails
- **Automatic Extraction**: Pulls title, author, publication date, and cover image from EPUB
- **Cover Thumbnails**: Displays book covers at multiple resolutions (150x225px for lists, 400x600px for detail)
- **Fallback Covers**: Generates styled placeholder covers for books without cover images
- **Metadata Display**: Shows book description, publisher, ISBN, and language information
- **Reading Statistics**: Track total books, pages read, time spent, and completion percentage

### AI-Powered Reading

#### Gemini-Powered Chat Sidebar
- **Streaming Responses**: Real-time chat responses as they're generated for immediate feedback
- **Contextual Awareness**: Chat maintains conversation history and references back to passages
- **Multi-Turn Conversations**: Build on previous questions without re-explaining context
- **Copy-Paste Integration**: Easily add book passages to conversations
- **Markdown Support**: Responses rendered with proper formatting, code blocks, and lists

#### Text Selection Integration
- **Direct Quote Addition**: Select text from the book and add it directly to chat with a single click
- **Automatic Attribution**: Quoted text includes chapter and page references
- **Multi-Selection Support**: Add multiple passages to a single message
- **Highlight Feedback**: Visual indication of selected text being sent to chat
- **Context Window**: Automatically includes surrounding sentences for better AI understanding

#### Chapter-Aware Suggestions
- **Smart Recommendations**: AI suggests related topics to discuss based on current chapter
- **Discussion Prompts**: Pre-written questions to deepen engagement with the material
- **Character Analysis**: Ask about character motivations and relationships with context awareness
- **Literary Themes**: Explore themes and symbolism in the current section
- **Historical Context**: Get information about the time period and setting (for historical books)

#### Local Chat History with SQL.js
- **Client-Side Storage**: All conversations stored in browser's local SQLite database
- **Privacy by Default**: No chat data sent to servers - complete conversational privacy
- **Persistent History**: Conversations saved across browser sessions
- **Searchable Chats**: Search through previous conversations by topic or keyword
- **Export Capability**: Download chat histories as JSON or markdown files
- **Chat Organization**: Tag and categorize conversations for easy retrieval

#### Keyboard Shortcuts for Chat
- **Cmd+I / Ctrl+I**: Toggle chat sidebar visibility
- **Cmd+Shift+I / Ctrl+Shift+I**: Open chat with selected text pre-filled
- **Cmd+Shift+H / Ctrl+Shift+H**: Open chat history sidebar
- **Escape**: Close chat or cancel ongoing request

### Book Transformation

#### Modernify - Language Transformation
- **Archaic to Contemporary**: Automatically rewrites prose using modern language conventions
  - Updates vocabulary: "thee/thou" → "you", "hath" → "has", etc.
  - Converts dated expressions to modern equivalents
  - Maintains narrative voice and character authenticity
  - Preserves metaphors and literary devices

- **Readability Improvements**:
  - Simplifies overly complex sentence structures where appropriate
  - Clarifies ambiguous references and pronouns
  - Updates cultural references to modern equivalents
  - Improves punctuation for modern standards

- **Examples**:
  - Input: "Hark! What light through yonder window breaks?"
  - Output: "Wait, what's that light coming through that window over there?"

#### Translation Engine
- **Multi-Language Support**: Translate books to any language supported by the LLM
  - Spanish, French, German, Chinese, Japanese, Arabic, and 50+ languages
  - Preserves formatting and chapter structure
  - Maintains special characters and Unicode properly

- **Professional Quality**:
  - Context-aware translation that respects narrative style
  - Consistency across chapters (same character names, places)
  - Idiomatic translations rather than word-for-word
  - Proper handling of wordplay and cultural references

- **Use Cases**:
  - Make classic English literature accessible to non-English speakers
  - Create multilingual reading experiences
  - Reach international audiences with personal writings

#### Async Job Processing System
- **Non-Blocking Requests**: Submit transformations without waiting for completion
- **Real-Time Status Updates**: Monitor progress of transformation (0-100%)
  - Extracting EPUB content
  - Processing chapters
  - Uploading results

- **Batch Processing Capability**: Queue multiple transformations in parallel
- **Timeout Handling**: Large books processed in 5-60 minute increments
- **Failure Recovery**: Automatic retry with exponential backoff on network issues

#### Intelligent Content Chunking
- **Sentence-Boundary Aware**: Splits content at natural sentence endings, not mid-sentence
- **Token Limit Respecting**: Respects LLM context windows (4k, 8k, 128k depending on model)
- **Paragraph Preservation**: Keeps paragraphs intact when possible
- **Metadata Preservation**: Retains chapter headers, section breaks, and formatting

**Example Flow**:
```
Original Book (500MB EPUB)
  ↓
Extract & Parse (10 min)
  ↓
Split into 1000 chunks (20-30 KB each)
  ↓
Process 4 chunks in parallel (respecting rate limits)
  ↓
LLM transforms content (5-10 min)
  ↓
Reconstruct EPUB (5 min)
  ↓
Upload to storage (2 min)
```

#### Result Storage & Version Management
- **S3 Compatible Storage**: Transformed books stored in Cloudflare R2 (or AWS S3)
- **Permanent URLs**: Get direct download links for transformed versions
- **Version Tracking**: Compare original vs. modernified vs. translated versions
- **Transformation Metadata**: Track which model was used, parameters, and completion time
- **Bandwidth Optimization**: Files compressed and cached for fast downloads

#### Transformation History
- **Variant Management**: Keep multiple transformations of the same book
  - Original version always preserved
  - Multiple translation variants (e.g., Spanish and French versions)
  - Different modernify levels (light, medium, heavy)

- **Comparison View**: Side-by-side comparison of original and transformed text
- **Rollback Capability**: Revert to original or previous transformations

### Authentication & Access Control

#### Google OAuth Integration
- **One-Click Login**: Sign in with existing Google account
- **Automatic Account Creation**: First-time users automatically get account
- **Secure Token Handling**: OAuth tokens stored securely in HTTP-only cookies
- **Profile Sync**: Automatically pulls user's display name and profile picture from Google
- **Account Recovery**: Easy account recovery via Google account if session expires

#### Magic Link Authentication
- **Email-Based Access**: Login without password using email-verified links
- **Token Generation**: Unique, single-use tokens generated for each login request
- **Time-Limited**: Links expire after 15 minutes for security
- **Fallback Option**: Available when Google OAuth is unavailable or user prefers
- **Easy Sharing**: Simplified sharing of library links without requiring Gmail account

#### Secure Session Management
- **HTTP-Only Cookies**: Session tokens not accessible to JavaScript (prevents XSS)
- **Secure Flag**: Cookies only sent over HTTPS connections
- **SameSite Protection**: CSRF attack prevention via SameSite cookie attribute
- **Session Timeout**: Automatic logout after 30 days of inactivity
- **Concurrent Session Limit**: Prevent account takeover by limiting active sessions

#### Granular Book Visibility Controls
- **Private by Default**: Books you upload are only visible to you
- **Sharing Options**:
  - Public (searchable in Alexandria, viewable by anyone with link)
  - Private (only you)
  - Shared with specific users (enter email addresses)
  - Read-only sharing (recipients can read but not modify)

- **Visibility Inheritance**: Shared collections inherit parent visibility settings
- **Access Revocation**: Remove access to shared books at any time
- **Activity Logging**: Track who accessed your shared books and when

### Power User Features

#### Command Palette (Cmd+K / Ctrl+K)
Quick access to all major functions without navigating menus:
- **Search Commands**: "Go to book", "Search library", "Start new chat"
- **Settings Access**: "Adjust font size", "Change theme", "Export chat history"
- **Actions**: "Download book", "Start transformation", "Share library"
- **Navigation**: Jump to any chapter or recent book

#### Comprehensive Keyboard Shortcuts
**Navigation**:
- `J` / `K`: Previous / Next page in reader
- `G`: Go to specific page number
- `/`: Start search in reader
- `?`: Show all keybindings

**Reader Controls**:
- `+` / `-`: Increase / Decrease font size
- `T`: Cycle through themes
- `M`: Toggle dark/light mode
- `|`: Toggle left/right sidebar

**Chat & Selection**:
- `Cmd+I`: Toggle chat sidebar
- `Cmd+Shift+I`: Add selected text to chat
- `Cmd+Enter`: Send chat message
- `Escape`: Cancel ongoing action

**Library**:
- `Cmd+F`: Search library
- `L`: Go to library view
- `N`: Go to next unread book

#### Resizable UI Panels with Persistence
- **Drag to Resize**: Left panel (library), center (reader), right panel (chat) all resizable
- **Width Persistence**: Panel sizes saved in cookies and restored on next session
- **Collapse to Minimize**: Panels collapse to thin bars to maximize reading space
- **Responsive Breakpoints**: Auto-collapse panels on mobile for single-column layout
- **Smooth Animations**: Resize transitions are smooth and performant

#### Dark/Light Theme Support
- **System Preference Detection**: Automatically matches OS dark/light mode
- **Manual Override**: Toggle between dark and light independent of system
- **Per-Theme Variants**: Each reading theme (Original, Quiet, etc.) has dark variant
- **Eye Comfort**: Dark mode reduces blue light emission for evening reading
- **High Contrast Mode**: Accessible high-contrast variant for vision impairments

## Technology Stack

### Frontend
- **React 19** with TypeScript for type-safe components
- **TanStack Router** for file-based routing
- **TanStack React Query** for server state management
- **Tailwind CSS 4** + **Radix UI** for styling and components
- **epubjs** for EPUB rendering and parsing
- **Tiptap** for rich text editing in chat
- **@ai-sdk/google** for streaming AI responses
- **SQL.js** for client-side SQLite chat history
- **Vite 7** for build tooling
- **Vitest** for testing

### Backend (Go)
- **Go 1.24** with **Chi** web framework
- **PostgreSQL** with pgx/v5 driver for data persistence
- **OAuth 2.0** for authentication
- **AWS S3 (Cloudflare R2)** for transformed book storage
- **Project Gutenberg Integration** for public library sync

### Book Transformation (Python)
- **Python 3.12** with **UV** package manager
- **FastAPI** for transformation service API
- **LiteLLM** for unified LLM provider interface (supports Claude, GPT, Gemini, etc.)
- **Modal.com** for serverless transformation execution
- **lxml** for EPUB XML parsing
- **aiosqlite** for async database operations

### Infrastructure
- **PostgreSQL** database
- **Cloudflare Workers** + **Wrangler** for edge deployment
- **Cloudflare R2** for object storage
- **Modal.com** for serverless workers

## Architecture

### Three-Tier Service Design
```
Frontend (React 19 + TanStack)
    ↓
Backend API (Go/Chi)
    ↓
Data Layer (PostgreSQL + S3/R2) + Async Workers (Python/Modal)
```

### Frontend Architecture
- **Single Page Application** with file-based routing
- **Three-panel layout**: Library (left), Reader (center), Chat (right)
- **Server state** managed by React Query (books, auth, pagination)
- **Client state** for UI toggles and reader settings
- **Persistent state** in cookies (panel widths, preferences)
- **Offline support** via SQL.js for chat history

### Backend API Design
- **RESTful endpoints** organized by resource (books, auth, transform)
- **Handler-based routing** with middleware stack
- **Repository pattern** for data access abstraction
- **Key endpoints**:
  - `GET/POST /books` - Library operations
  - `GET/POST /books/{id}/transform` - Transformation requests
  - `POST/GET /auth/*` - Authentication flows

### Transformation Pipeline
1. User requests book transformation (modernify/translate)
2. Backend creates job in PostgreSQL
3. Polling worker picks up pending jobs
4. Modal serverless function:
   - Downloads and extracts EPUB
   - Intelligently chunks content by sentences
   - Sends batches to LLM respecting rate limits
   - Reconstructs EPUB with transformed text
5. Uploads result to S3/R2
6. Updates job status and storage URL
7. Frontend fetches and displays download link

### Key Design Patterns
- **Cursor-based pagination** for scalable list browsing
- **Async job processing** for non-blocking transformations
- **Polymorphic storage** for multiple book variants (original + transforms)
- **Client-side SQLite** for offline chat history
- **Cookie-based preferences** for stateless backend

## Development Status

This is an actively developed project combining:
- Modern web frontend (React 19, TypeScript)
- Performant backend (Go with clean architecture)
- Advanced content transformation (Python with LLM integration)

**Recent work**: Google OAuth integration, core feature development

**Code Quality**: TypeScript throughout, ESLint + Prettier configured, Vitest test suite

## Getting Started

### Prerequisites
- Node.js 18+ (frontend)
- Go 1.24+ (backend)
- Python 3.12+ (transformations)
- PostgreSQL database
- Cloudflare R2 account (or AWS S3)

### Installation

```bash
# Frontend
cd frontend
pnpm install
pnpm dev

# Backend
cd backend
go run main.go

# Transformations (optional)
cd epubtransform
uv sync
```

For detailed setup instructions, see the individual directory READMEs.

## Key Endpoints

### Library API
- `GET /books?search=...&limit=...&cursor=...` - Search library with pagination
- `GET /books/{id}` - Get book metadata
- `POST /books` - Upload new book

### Transformation API
- `POST /books/{id}/transform` - Request transformation (modernify/translate)
- `GET /books/{id}/transform/{variant}` - Get transformation status/link

### Auth API
- `POST /auth/oauth/google` - Google OAuth callback
- `POST /auth/magic-link` - Request magic link
- `GET /auth/user` - Get current user info
- `POST /auth/logout` - Clear session

## Configuration

Environment variables and configuration files:
- Frontend: `frontend/.env` (Gemini API key, backend URL)
- Backend: `backend/.env` (database, OAuth, R2 credentials)
- Transformations: Modal.com project configuration

See `.env.example` files in each directory for details.

## Project Structure

```
.
├── frontend/           # React SPA with TanStack ecosystem
├── backend/            # Go API server
├── epubtransform/      # Python transformation workers
├── docs/               # Documentation
└── README.md           # This file
```

## Performance Considerations

- **Search optimization**: Trigram indexing on book titles/authors
- **Pagination strategy**: Cursor-based for memory efficiency with large datasets
- **Transformation scaling**: Serverless workers handle unlimited concurrent jobs
- **Frontend rendering**: React Query manages server state efficiently
- **Reader performance**: epubjs handles large EPUB files smoothly

## Privacy & Security

- Authentication via OAuth or magic links (no password storage)
- User-owned books are private by default
- Shared book visibility is explicit and user-controlled
- Chat history stored client-side only (not persisted on server)
- Transformation jobs processed in isolated serverless functions

---

**Alexandria** combines the joy of reading with modern AI capabilities, making literature more accessible and interactive.
