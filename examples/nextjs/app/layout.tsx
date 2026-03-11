import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'ai-sdk-rate-limiter example',
  description: 'Next.js streaming chat with rate limiting, cost tracking, and budget caps.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#f9fafb' }}>
        {children}
      </body>
    </html>
  )
}
