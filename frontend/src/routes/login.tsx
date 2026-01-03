import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { requestMagicLink } from '@/data/auth'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

function LoginPage() {
  const [email, setEmail] = useState('')
  const [sentTo, setSentTo] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => requestMagicLink(email),
    onSuccess: () => {
      setSentTo(email)
    },
  })

  return (
    <div className="min-h-screen bg-[color:var(--paper-deep)] text-[color:var(--ink)]">
      <header className="h-12 px-6 flex items-center border-b border-[color:var(--accent-soft)] bg-[color:var(--paper)]">
        <Link to="/" className="text-xs uppercase tracking-[0.3em] text-[color:var(--accent)]">
          alexandria0
        </Link>
      </header>

      <main className="max-w-lg mx-auto px-6 py-16">
        <h1 className="text-2xl font-semibold mb-4">Sign in</h1>
        <p className="text-sm text-[color:var(--ink)]/70 mb-8">
          Enter your email and we will send you a magic link to sign in.
        </p>

        {sentTo ? (
          <div className="rounded-xl border border-[color:var(--accent-soft)] bg-[color:var(--paper)] p-6">
            <p className="text-sm text-[color:var(--ink)]/80">
              We sent a sign-in link to <span className="font-semibold">{sentTo}</span>.
            </p>
            <p className="text-xs text-[color:var(--ink)]/60 mt-2">
              Check your inbox and click the link to finish signing in.
            </p>
            <button
              type="button"
              onClick={() => setSentTo(null)}
              className="mt-4 text-xs uppercase tracking-[0.2em] text-[color:var(--accent)]"
            >
              Send another
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => {
              event.preventDefault()
              mutation.mutate()
            }}
            className="space-y-4"
          >
            <label className="block">
              <span className="text-xs uppercase tracking-[0.2em] text-[color:var(--ink)]/60">
                Email
              </span>
              <input
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="mt-2 w-full rounded-lg border border-[color:var(--accent-soft)] bg-[color:var(--paper)] px-4 py-3 text-sm"
                placeholder="you@example.com"
              />
            </label>
            <button
              type="submit"
              disabled={mutation.isPending}
              className="w-full rounded-lg bg-[color:var(--accent)] px-4 py-3 text-sm text-[color:var(--paper)] hover:bg-[color:var(--ink)] transition-colors disabled:opacity-60"
            >
              {mutation.isPending ? 'Sending link…' : 'Send magic link'}
            </button>
            {mutation.isError && (
              <p className="text-xs text-[color:var(--accent)]">
                Failed to send the magic link. Try again.
              </p>
            )}
          </form>
        )}
      </main>
    </div>
  )
}
