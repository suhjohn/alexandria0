import { createFileRoute } from '@tanstack/react-router'
import { EpubReader } from '@/components/reader'
import { getBook, getBookFileUrl } from '@/data/books'

export const Route = createFileRoute('/books/$bookId')({
  component: BookReaderPage,
  loader: async ({ params }) => {
    const book = await getBook(params.bookId)
    if (!book) throw new Error('Book not found')
    return { book, bookUrl: getBookFileUrl(book.id) }
  },
})

function BookReaderPage() {
  const { book, bookUrl } = Route.useLoaderData()

  return (
    <div className="h-screen">
      <EpubReader
        bookUrl={bookUrl}
        bookId={book.id}
        className="h-full"
      />
    </div>
  )
}
