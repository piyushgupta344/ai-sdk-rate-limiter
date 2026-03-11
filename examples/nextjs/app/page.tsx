'use client'

import { useChat } from 'ai/react'
import { useEffect, useState } from 'react'

interface CostReport {
  hour: { requests: number; costUsd: number }
  day: { requests: number; costUsd: number }
  month: { requests: number; costUsd: number }
  byModel: Record<string, { requests: number; costUsd: number }>
}

export default function ChatPage() {
  const { messages, input, handleInputChange, handleSubmit, isLoading, error } = useChat()
  const [cost, setCost] = useState<CostReport | null>(null)

  // Poll cost report every 5 seconds
  useEffect(() => {
    const load = () =>
      fetch('/api/cost')
        .then(r => r.json())
        .then(setCost)
        .catch(() => {})
    load()
    const id = setInterval(load, 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '24px 16px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
        ai-sdk-rate-limiter — Next.js example
      </h1>
      <p style={{ color: '#6b7280', marginBottom: 24, fontSize: 14 }}>
        Streaming chat with rate limiting, queue management, and live cost tracking.
      </p>

      {/* Cost panel */}
      {cost && (
        <div
          style={{
            background: '#fff',
            border: '1px solid #e5e7eb',
            borderRadius: 8,
            padding: '12px 16px',
            marginBottom: 20,
            fontSize: 13,
          }}
        >
          <strong>Cost this session</strong>
          <div style={{ display: 'flex', gap: 24, marginTop: 8, color: '#374151' }}>
            <span>Hour: ${cost.hour.costUsd.toFixed(4)} ({cost.hour.requests} req)</span>
            <span>Day: ${cost.day.costUsd.toFixed(4)} ({cost.day.requests} req)</span>
            <span>Month: ${cost.month.costUsd.toFixed(4)} ({cost.month.requests} req)</span>
          </div>
          {Object.keys(cost.byModel).length > 0 && (
            <div style={{ marginTop: 6, color: '#6b7280' }}>
              {Object.entries(cost.byModel).map(([model, s]) => (
                <span key={model} style={{ marginRight: 16 }}>
                  {model}: ${s.costUsd.toFixed(4)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Chat messages */}
      <div
        style={{
          background: '#fff',
          border: '1px solid #e5e7eb',
          borderRadius: 8,
          minHeight: 300,
          maxHeight: 480,
          overflowY: 'auto',
          padding: 16,
          marginBottom: 12,
        }}
      >
        {messages.length === 0 && (
          <p style={{ color: '#9ca3af', fontSize: 14, textAlign: 'center', marginTop: 80 }}>
            No messages yet. Ask something below.
          </p>
        )}
        {messages.map(m => (
          <div key={m.id} style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: m.role === 'user' ? '#2563eb' : '#059669',
                marginBottom: 2,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              {m.role === 'user' ? 'You' : 'AI'}
            </div>
            <div style={{ fontSize: 15, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
              {m.content}
            </div>
          </div>
        ))}
        {isLoading && (
          <div style={{ color: '#9ca3af', fontSize: 14, fontStyle: 'italic' }}>Thinking…</div>
        )}
        {error && (
          <div
            style={{
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 6,
              padding: '8px 12px',
              color: '#dc2626',
              fontSize: 14,
            }}
          >
            {error.message}
          </div>
        )}
      </div>

      {/* Input form */}
      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8 }}>
        <input
          value={input}
          onChange={handleInputChange}
          placeholder="Ask something…"
          disabled={isLoading}
          style={{
            flex: 1,
            padding: '10px 14px',
            border: '1px solid #d1d5db',
            borderRadius: 8,
            fontSize: 15,
            outline: 'none',
          }}
        />
        <button
          type="submit"
          disabled={isLoading || !input.trim()}
          style={{
            padding: '10px 20px',
            background: '#2563eb',
            color: '#fff',
            border: 'none',
            borderRadius: 8,
            fontSize: 15,
            cursor: isLoading ? 'not-allowed' : 'pointer',
            opacity: isLoading ? 0.6 : 1,
          }}
        >
          Send
        </button>
      </form>

      <p style={{ marginTop: 16, fontSize: 12, color: '#9ca3af' }}>
        Set <code>OPENAI_API_KEY</code> in <code>.env.local</code> to run this example.
        Rate limits, queue depth, and cost are logged to the server console.
      </p>
    </main>
  )
}
