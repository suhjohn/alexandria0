import { createFileRoute } from '@tanstack/react-router'
import { EpubReader } from '@/components/reader'
import { getBooks } from '@/data/books'

export const Route = createFileRoute('/books/$bookId')({
  component: BookReaderPage,
  loader: async ({ params }) => {
    const books = await getBooks()
    const book = books.find((b) => b.id === params.bookId)

    if (!book) {
      throw new Error('Book not found')
    }

    return { book }
  },
})

function BookReaderPage() {
  const { book } = Route.useLoaderData()

  // Get the book URL - prefer transformed version if available
  const bookUrl = book.transformation_data?.modernify?.[0] || book.url

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
